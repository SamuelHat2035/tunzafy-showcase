/**
 * ADK Plugins for the TunzAI agent.
 *
 * A Plugin is an ADK concept that hooks GLOBALLY into the runner lifecycle
 * (before/after a run, every tool call, every event) — unlike agent callbacks,
 * which are scoped to a single agent. We use one here to emit structured
 * observability telemetry without touching any agent's business logic.
 *
 * Security note: this plugin only READS and logs. It never mutates tool args or
 * model output (it always returns `undefined`, i.e. "pass through unchanged").
 */
import { BasePlugin } from "@google/adk";
import type { BaseTool, Context, InvocationContext } from "@google/adk";

/** Structured, greppable telemetry line. */
function emit(record: Record<string, unknown>): void {
  // One JSON object per line → easy to ship to Cloud Logging / BigQuery.
  console.log(JSON.stringify({ src: "tunzai-telemetry", ...record }));
}

/**
 * Emits one structured event per run boundary and per tool call, and tracks how
 * many tools each invocation used. Demonstrates ADK's global Plugin hooks.
 */
export class TelemetryPlugin extends BasePlugin {
  private toolCalls = 0;
  private startedAt = 0;

  constructor() {
    super("tunzai_telemetry");
  }

  async beforeRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    this.toolCalls = 0;
    this.startedAt = Date.now();
    emit({ event: "run_start" });
    return undefined;
  }

  async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<undefined> {
    this.toolCalls += 1;
    emit({ event: "tool_call", tool: params.tool.name, args: params.toolArgs });
    return undefined;
  }

  async afterRunCallback(_params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    emit({
      event: "run_end",
      tool_calls: this.toolCalls,
      duration_ms: Date.now() - this.startedAt,
    });
  }
}
