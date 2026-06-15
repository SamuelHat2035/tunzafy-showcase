/**
 * Programmatic demo runner for the TunzAI ADK agent.
 *
 * Usage:
 *   npm run demo "find me remote data analyst jobs in Kenya"
 *   npm run demo            # uses a default prompt
 *
 * Requires Gemini credentials in the environment (see .env.example):
 *   • Vertex AI:  GOOGLE_GENAI_USE_VERTEXAI=true + GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION
 *   • AI Studio:  GEMINI_API_KEY (or GOOGLE_API_KEY)
 */
import {
  InMemoryRunner,
  SecurityPlugin,
  isFinalResponse,
  getFunctionCalls,
} from "@google/adk";
import { rootAgent } from "./agent.js";
import { APP_NAME } from "./config.js";
import { TelemetryPlugin } from "./plugins.js";
import { TunzafyToolPolicyEngine } from "./security.js";

async function main(): Promise<void> {
  const prompt =
    process.argv.slice(2).join(" ").trim() ||
    "Hi! Can you find me remote data analyst jobs and tell me about the market in Kenya?";

  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName: APP_NAME,
    // Global ADK plugins: structured telemetry + least-privilege tool policy.
    plugins: [
      new TelemetryPlugin(),
      new SecurityPlugin({ policyEngine: new TunzafyToolPolicyEngine() }),
    ],
  });

  console.log(`\n👤 User: ${prompt}\n`);

  let finalText = "";
  for await (const event of runner.runEphemeral({
    userId: "demo-user",
    newMessage: { role: "user", parts: [{ text: prompt }] },
  })) {
    // Surface tool calls so the demo shows the agent's reasoning/grounding.
    for (const call of getFunctionCalls(event)) {
      console.log(
        `🔧 [${event.author ?? "agent"}] tool → ${call.name}(${JSON.stringify(
          call.args ?? {},
        )})`,
      );
    }
    if (isFinalResponse(event)) {
      const text = (event.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      if (text) finalText = text;
    }
  }

  console.log(`\n🤖 TunzAI: ${finalText || "(no text response)"}\n`);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
