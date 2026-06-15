/**
 * ADK-style evaluation harness for the TunzAI agent.
 *
 * ADK-TS (v1.2) does not ship the Python eval runner, so this is a faithful,
 * lightweight port of its scoring model:
 *
 *   • tool_trajectory_score — did the expected tools fire (and forbidden ones
 *     stay silent)? This checks the agent's REASONING PATH, not just its words.
 *   • response_match_score  — does the final answer contain expected content?
 *   • routing_score         — did the correct specialist sub-agent handle it?
 *
 * Cases live in `eval/tunzai.evalset.json`. The harness runs each case through
 * the SAME runner + plugins (telemetry + security policy) used in production,
 * collects the real trajectory, scores it, prints a report, and exits non-zero
 * if any case regresses — so it can gate CI.
 *
 * Usage:  npm run eval
 * Requires Gemini credentials (see .env.example). Without them it prints setup
 * instructions and exits 0 (skipped, not failed).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  InMemoryRunner,
  SecurityPlugin,
  getFunctionCalls,
  isFinalResponse,
} from "@google/adk";
import { rootAgent } from "./agent.js";
import { APP_NAME } from "./config.js";
import { TelemetryPlugin } from "./plugins.js";
import { TunzafyToolPolicyEngine } from "./security.js";

interface EvalCase {
  id: string;
  prompt: string;
  expectedTools?: string[];
  forbiddenTools?: string[];
  expectedAuthor?: string;
  responseIncludesAny?: string[];
}

interface EvalSet {
  evalSetId: string;
  description?: string;
  cases: EvalCase[];
}

interface Trajectory {
  tools: string[];
  authors: Set<string>;
  finalText: string;
}

const PASS_THRESHOLD = 0.99;

function hasCredentials(): boolean {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return true;
  return (
    process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" &&
    !!process.env.GOOGLE_CLOUD_PROJECT
  );
}

async function collectTrajectory(prompt: string): Promise<Trajectory> {
  const runner = new InMemoryRunner({
    agent: rootAgent,
    appName: APP_NAME,
    plugins: [
      new TelemetryPlugin(),
      new SecurityPlugin({ policyEngine: new TunzafyToolPolicyEngine() }),
    ],
  });

  const tools: string[] = [];
  const authors = new Set<string>();
  let finalText = "";

  for await (const event of runner.runEphemeral({
    userId: "eval-user",
    newMessage: { role: "user", parts: [{ text: prompt }] },
  })) {
    if (event.author) authors.add(event.author);
    for (const call of getFunctionCalls(event)) {
      if (call.name) tools.push(call.name);
    }
    if (isFinalResponse(event)) {
      const out = (event.content?.parts ?? []).map((p) => p.text ?? "").join("");
      if (out) finalText = out;
    }
  }
  return { tools, authors, finalText };
}

function scoreCase(c: EvalCase, t: Trajectory): { score: number; notes: string[] } {
  const notes: string[] = [];
  const checks: number[] = [];

  // Tool trajectory.
  if (c.expectedTools) {
    const missing = c.expectedTools.filter((x) => !t.tools.includes(x));
    checks.push(c.expectedTools.length === 0 ? 1 : missing.length ? 0 : 1);
    if (missing.length) notes.push(`missing tools: ${missing.join(", ")}`);
  }
  if (c.forbiddenTools) {
    const fired = c.forbiddenTools.filter((x) => t.tools.includes(x));
    checks.push(fired.length ? 0 : 1);
    if (fired.length) notes.push(`forbidden tools fired: ${fired.join(", ")}`);
  }

  // Routing.
  if (c.expectedAuthor) {
    const ok = t.authors.has(c.expectedAuthor);
    checks.push(ok ? 1 : 0);
    if (!ok) notes.push(`expected handler '${c.expectedAuthor}' not reached`);
  }

  // Response match (case-insensitive substring, any-of).
  if (c.responseIncludesAny && c.responseIncludesAny.length) {
    const hay = t.finalText.toLowerCase();
    const ok = c.responseIncludesAny.some((s) => hay.includes(s.toLowerCase()));
    checks.push(ok ? 1 : 0);
    if (!ok) notes.push("response matched none of the expected phrases");
  }

  const score = checks.length ? checks.reduce((a, b) => a + b, 0) / checks.length : 1;
  return { score, notes };
}

async function main(): Promise<void> {
  if (!hasCredentials()) {
    console.log(
      "⏭  Skipping eval: no Gemini credentials found.\n" +
        "   Set GEMINI_API_KEY, or GOOGLE_GENAI_USE_VERTEXAI=true + " +
        "GOOGLE_CLOUD_PROJECT (see .env.example), then re-run `npm run eval`.",
    );
    process.exit(0);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const evalPath = join(here, "..", "eval", "tunzai.evalset.json");
  const evalSet = JSON.parse(readFileSync(evalPath, "utf8")) as EvalSet;

  console.log(`\n▶ Eval set: ${evalSet.evalSetId} (${evalSet.cases.length} cases)\n`);

  let total = 0;
  let failures = 0;
  for (const c of evalSet.cases) {
    let traj: Trajectory;
    try {
      traj = await collectTrajectory(c.prompt);
    } catch (err) {
      console.log(`✗ ${c.id} — run error: ${(err as Error).message}`);
      failures += 1;
      continue;
    }
    const { score, notes } = scoreCase(c, traj);
    total += score;
    const pass = score >= PASS_THRESHOLD;
    if (!pass) failures += 1;
    console.log(
      `${pass ? "✓" : "✗"} ${c.id} — score ${score.toFixed(2)} ` +
        `[tools: ${traj.tools.join(", ") || "none"}]` +
        (notes.length ? ` — ${notes.join("; ")}` : ""),
    );
  }

  const avg = evalSet.cases.length ? total / evalSet.cases.length : 1;
  console.log(
    `\nAverage score: ${avg.toFixed(2)} — ${
      evalSet.cases.length - failures
    }/${evalSet.cases.length} cases passed.\n`,
  );

  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("Eval harness failed:", err);
  process.exit(1);
});
