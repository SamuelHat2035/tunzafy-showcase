/**
 * Agent-level ADK callbacks for the TunzAI agents.
 *
 * Callbacks are an ADK core concept: typed hooks the framework fires around the
 * model call and each tool call for a SPECIFIC agent. We use them for two
 * things production agents always need:
 *
 *   1. Input hardening (beforeToolCallback) — normalise/clamp tool arguments so
 *      the model can't push out-of-range or oversized requests. This runs in
 *      addition to the global SecurityPlugin allow-list (defence in depth).
 *   2. Grounding telemetry (afterToolCallback) — record, in the session state,
 *      how many live results each tool returned, so we can later assert the
 *      agent answered from real data rather than hallucinating.
 *
 * All callbacks return `undefined` on the happy path, meaning "proceed with the
 * (possibly adjusted) value" — they never fabricate model output.
 */
import type {
  SingleAfterToolCallback,
  SingleBeforeToolCallback,
} from "@google/adk";

const STATE_TOOL_CALLS = "tunzai:toolCalls";
const STATE_LIVE_RESULTS = "tunzai:liveResults";

/**
 * Normalises tool arguments before a tool runs:
 *   • trims string args,
 *   • clamps `limit` into the supported 1–25 range,
 * and increments a per-session tool-call counter in state.
 */
export const beforeToolGuard: SingleBeforeToolCallback = ({ args, context }) => {
  if (args && typeof args === "object") {
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") args[key] = value.trim();
    }
    if (typeof args.limit === "number") {
      args.limit = Math.min(25, Math.max(1, Math.trunc(args.limit)));
    }
  }

  const count = context.state.get<number>(STATE_TOOL_CALLS, 0) ?? 0;
  context.state.set(STATE_TOOL_CALLS, count + 1);

  // Return undefined → run the tool with the normalised args.
  return undefined;
};

/**
 * After a tool returns, records how many live job results were grounded into the
 * answer. Pure bookkeeping — the tool's result is returned unchanged.
 */
export const afterToolGrounding: SingleAfterToolCallback = ({
  response,
  context,
}) => {
  let added = 0;
  if (response && typeof response === "object") {
    const jobs = (response as { jobs?: unknown }).jobs;
    if (Array.isArray(jobs)) added = jobs.length;
  }
  if (added > 0) {
    const prev = context.state.get<number>(STATE_LIVE_RESULTS, 0) ?? 0;
    context.state.set(STATE_LIVE_RESULTS, prev + added);
  }
  // Return undefined → use the tool's real response unchanged.
  return undefined;
};
