/**
 * Production-grade MEMORY demo for the TunzAI ADK agent — Vertex AI Memory Bank.
 *
 * This is the production counterpart to `runMemory.ts`. Where the local demo
 * uses `InMemoryMemoryService` (keyword matching, prototype-only), this one
 * backs long-term memory with ADK's `VertexAiMemoryBankService` — a managed
 * Vertex AI Memory Bank that retrieves prior context *semantically* (RAG).
 *
 * The difference matters: in turn 2 below the user describes the same situation
 * using DIFFERENT words ("ICU practitioner", "work from home", "Kenyan
 * capital") with almost no keyword overlap with turn 1. A keyword store would
 * miss it; the Memory Bank recalls it by meaning.
 *
 * Safe + additive: this file is independent of `runMemory.ts` and the live
 * agent. It self-skips (exit 0) unless a Vertex AI Memory Bank is configured,
 * so it never breaks CI or local runs without cloud access.
 *
 * Configure (all via env / .env):
 *   GOOGLE_GENAI_USE_VERTEXAI=true
 *   GOOGLE_CLOUD_PROJECT=tunzafy
 *   GOOGLE_CLOUD_LOCATION=us-central1
 *   TUNZAI_AGENT_ENGINE_ID=<your Vertex AI Agent Engine / Memory Bank id>
 *   + Application Default Credentials (gcloud auth application-default login)
 *
 * Usage:  npm run demo:memory:vertex
 */
import {
  InMemorySessionService,
  Runner,
  SecurityPlugin,
  VertexAiMemoryBankService,
  getFunctionCalls,
  isFinalResponse,
} from "@google/adk";
import { rootAgent } from "./agent.js";
import { AGENT_ENGINE_ID, APP_NAME } from "./config.js";
import { TelemetryPlugin } from "./plugins.js";
import { TunzafyToolPolicyEngine } from "./security.js";

const USER_ID = "memory-bank-demo-user";

async function runTurn(
  runner: Runner,
  sessionId: string,
  text: string,
): Promise<string> {
  console.log(`\n👤 [${sessionId}] ${text}`);
  let finalText = "";
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId,
    newMessage: { role: "user", parts: [{ text }] },
  })) {
    for (const call of getFunctionCalls(event)) {
      console.log(
        `🔧 [${event.author ?? "agent"}] tool → ${call.name}(${JSON.stringify(
          call.args ?? {},
        )})`,
      );
    }
    if (isFinalResponse(event)) {
      const out = (event.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      if (out) finalText = out;
    }
  }
  console.log(`🤖 ${finalText || "(no text response)"}`);
  return finalText;
}

async function main(): Promise<void> {
  // ── Self-skip when no Memory Bank is configured (keeps CI/local green) ────
  if (!AGENT_ENGINE_ID) {
    console.log(
      "⏭  Skipping Vertex Memory Bank demo: set TUNZAI_AGENT_ENGINE_ID " +
        "(+ GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION + ADC) to run it.\n" +
        "   The local prototype equivalent is:  npm run demo:memory",
    );
    return;
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
  const location = process.env.GOOGLE_CLOUD_LOCATION?.trim();

  const sessionService = new InMemorySessionService();
  const memoryService = new VertexAiMemoryBankService({
    projectId,
    location,
    agentEngineId: AGENT_ENGINE_ID,
  });

  const runner = new Runner({
    appName: APP_NAME,
    agent: rootAgent,
    sessionService,
    memoryService,
    plugins: [
      new TelemetryPlugin(),
      new SecurityPlugin({ policyEngine: new TunzafyToolPolicyEngine() }),
    ],
  });

  // ── Turn 1: user states their context in session A ──────────────────────
  const sessionA = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  await runTurn(
    runner,
    sessionA.id,
    "I'm a registered nurse based in Nairobi and I only want remote roles.",
  );

  // ── Ingest session A into the Vertex AI Memory Bank ─────────────────────
  //    Use waitForCompletion so the Memory Bank finishes consolidating session
  //    A into durable facts BEFORE turn 2 queries it (the generate step is
  //    otherwise asynchronous and the new session would race ahead of it).
  const completedA = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: sessionA.id,
  });
  if (completedA) {
    await memoryService.addEventsToMemory({
      appName: APP_NAME,
      userId: USER_ID,
      events: completedA.events,
      customMetadata: { waitForCompletion: true },
    });
    console.log("\n💾 Session A consolidated into Vertex AI Memory Bank.");
    // Small settle so the freshly-written facts are indexed for retrieval.
    await new Promise((r) => setTimeout(r, 3000));
  }

  // ── Turn 2: NEW session B, DIFFERENT words, near-zero keyword overlap.
  //    Semantic RAG recall should still surface the nurse / Nairobi / remote
  //    context — something the keyword prototype could not do. ───────────────
  const sessionB = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  await runTurn(
    runner,
    sessionB.id,
    "Hi again — I'm an ICU practitioner who needs to work from home, ideally " +
      "near the Kenyan capital. What openings fit me?",
  );
}

main().catch((err) => {
  console.error("Vertex Memory Bank demo failed:", err);
  process.exit(1);
});
