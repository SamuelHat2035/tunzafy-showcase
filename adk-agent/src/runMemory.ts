/**
 * Multi-turn MEMORY demo for the TunzAI ADK agent.
 *
 * Demonstrates ADK's memory subsystem end-to-end:
 *   1. Build a `Runner` with an explicit `InMemorySessionService` +
 *      `InMemoryMemoryService` (the persistence seams you'd later swap for
 *      `VertexAiSessionService` / a Vertex RAG memory bank in production).
 *   2. Turn 1 runs in session A, where the user states their context.
 *   3. We ingest session A into the memory service (`addSessionToMemory`).
 *   4. Turn 2 runs in a BRAND-NEW session B. Because the root agent carries a
 *      `PreloadMemoryTool`, ADK retrieves the relevant memory and the agent can
 *      answer using context from the earlier, separate session.
 *
 * Usage:  npm run demo:memory
 * Requires Gemini credentials (see .env.example).
 */
import {
  InMemoryMemoryService,
  InMemorySessionService,
  Runner,
  SecurityPlugin,
  getFunctionCalls,
  isFinalResponse,
} from "@google/adk";
import { rootAgent } from "./agent.js";
import { APP_NAME } from "./config.js";
import { TelemetryPlugin } from "./plugins.js";
import { TunzafyToolPolicyEngine } from "./security.js";

const USER_ID = "memory-demo-user";

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
  const sessionService = new InMemorySessionService();
  const memoryService = new InMemoryMemoryService();

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

  // ── Ingest session A into long-term memory ──────────────────────────────
  const completedA = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: sessionA.id,
  });
  if (completedA) {
    await memoryService.addSessionToMemory(completedA);
    console.log("\n💾 Session A ingested into memory.");
  }

  // ── Turn 2: a NEW session B — agent should recall the nurse/Nairobi/remote
  //    context from memory rather than asking again. The phrasing shares
  //    keywords ("nursing", "remote") with session A so ADK's keyword-based
  //    InMemoryMemoryService retrieves it (a Vertex RAG memory bank would match
  //    semantically without needing the overlap). ────────────────────────────
  const sessionB = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  await runTurn(
    runner,
    sessionB.id,
    "I'm back — based on my nursing background and the remote preference I told " +
      "you earlier, find me suitable roles.",
  );
}

main().catch((err) => {
  console.error("Memory demo failed:", err);
  process.exit(1);
});
