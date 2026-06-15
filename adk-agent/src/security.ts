/**
 * Least-privilege tool authorization for the TunzAI ADK agent.
 *
 * This implements ADK's `BasePolicyEngine` interface and is wired into ADK's
 * built-in `SecurityPlugin` (see `src/plugins.ts`). Every tool call the model
 * tries to make is evaluated here BEFORE the tool runs.
 *
 * Security model (defense-in-depth, "deny by default"):
 *   • Only the three READ-ONLY tools are explicitly allow-listed. They reach
 *     Tunzafy's PUBLIC API or local constants only — never the database, never
 *     secrets, never a write/mutation path.
 *   • Anything not on the allow-list is DENIED, so if a future state-changing
 *     tool (e.g. auto-apply, payments) is ever added, it is blocked until it is
 *     consciously classified and added here. The agent cannot silently gain new
 *     powers.
 *   • Arguments are sanity-checked (length caps, control-char rejection) to blunt
 *     prompt-injection / abuse before a request ever leaves the process.
 */
import type { BaseTool } from "@google/adk";
import { PolicyOutcome } from "@google/adk";

/** Tools the agent is permitted to call. Read-only, public-surface only. */
export const ALLOWED_TOOLS = new Set<string>([
  // TunzAI business tools — read-only (public API or local constants).
  "search_live_jobs",
  "get_job_market_data",
  "find_resume_templates",
  // ADK memory tools (read-only recall of the user's own prior context).
  "preload_memory",
  "load_memory",
  // ADK built-in orchestration/control tools (no external side effects).
  "transfer_to_agent",
]);

/** Hard caps to keep tool inputs bounded regardless of what the model emits. */
const MAX_STRING_ARG_LENGTH = 600;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

interface ToolCallPolicyContext {
  tool: BaseTool;
  toolArgs: Record<string, unknown>;
}

interface PolicyCheckResult {
  outcome: string;
  reason?: string;
}

/**
 * Allow-list policy engine. Plugged into ADK's `SecurityPlugin`, which calls
 * `evaluate` before every tool invocation and blocks the call on `DENY`.
 */
export class TunzafyToolPolicyEngine {
  async evaluate(context: ToolCallPolicyContext): Promise<PolicyCheckResult> {
    const name = context.tool.name;

    if (!ALLOWED_TOOLS.has(name)) {
      return {
        outcome: PolicyOutcome.DENY,
        reason:
          `Tool '${name}' is not on the TunzAI allow-list. New tools must be ` +
          `explicitly classified and added in src/security.ts before use.`,
      };
    }

    // Bound every string argument; reject control characters.
    for (const [key, value] of Object.entries(context.toolArgs ?? {})) {
      if (typeof value !== "string") continue;
      if (value.length > MAX_STRING_ARG_LENGTH) {
        return {
          outcome: PolicyOutcome.DENY,
          reason: `Argument '${key}' exceeds ${MAX_STRING_ARG_LENGTH} chars.`,
        };
      }
      if (CONTROL_CHARS.test(value)) {
        return {
          outcome: PolicyOutcome.DENY,
          reason: `Argument '${key}' contains disallowed control characters.`,
        };
      }
    }

    return { outcome: PolicyOutcome.ALLOW };
  }
}
