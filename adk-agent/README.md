# TunzAI Resourcing Agent (Google ADK-TS)

An [Agent Development Kit (ADK)](https://github.com/google/adk) re-implementation
of **TunzAI**, Tunzafy's AI resourcing agent. Tunzafy is a live job platform
serving 60+ countries with a verified, fraud-gated corpus of ~20,000 active
jobs. This package ports TunzAI to Google's ADK for the **Google for Startups
AI Agents Challenge** and is designed to deploy cleanly to **Vertex AI Agent
Engine**.

> **Isolation guarantee.** This is a **standalone artifact**, deliberately
> excluded from the pnpm workspace (`!artifacts/tunzai-agent` in
> `pnpm-workspace.yaml`) and managed with its own `npm install`. It does **not**
> touch the live `api-server` bundle, the shared `lib/` packages, or production
> images. It only *reuses* the live public API over HTTP. Building/deploying this
> agent has **zero impact** on anything already running in production.

## 🎥 Demo videos

- **Founder's presentation** — the problem, the business case, and how Tunzafy
  uses Google Cloud + the ADK: https://youtu.be/Fb3v07efaTg
- **Product demo (TunzAI in action)** — the live agent answering real seekers:
  https://youtu.be/1dUzNRDfJoA

## What it demonstrates (ADK core concepts)

| ADK concept | Where |
|---|---|
| `LlmAgent` (Gemini-backed declarative agents) | `src/agent.ts` |
| `FunctionTool` (typed, Zod-validated tools) | `src/tools/*.ts` |
| **Multi-agent routing** via `subAgents` + built-in LLM transfer | `rootAgent` in `src/agent.ts` |
| **Agent callbacks** (before/after tool hooks) | `src/callbacks.ts` |
| **Plugins** (global runner lifecycle hooks) | `src/plugins.ts` |
| **Security plugin + policy engine** (least-privilege tool authz) | `src/security.ts` |
| **Memory** (`PreloadMemoryTool` + memory service) | `src/agent.ts`, `src/runMemory.ts` |
| **Production memory** (Vertex AI Memory Bank, semantic RAG recall) | `src/runMemoryVertex.ts` |
| **Grounding** in real product data | `search_live_jobs` → live Vertex AI Search API |
| **Evaluation** (trajectory + response scoring) | `src/eval.ts`, `eval/tunzai.evalset.json` |
| Runner / sessions (`InMemoryRunner`, explicit `Runner`) | `src/run.ts`, `src/runMemory.ts` |

### Architecture

```
                ┌──────────────────────────────┐
                │  rootAgent (coordinator)     │
                │  tunzai_resourcing_agent     │
                └───────────┬──────────────────┘
            transfer ▲      │      ▲ transfer
                     │      │      │
        ┌────────────┘      │      └────────────┐
        ▼                                       ▼
┌────────────────────┐              ┌────────────────────────┐
│ job_search_agent   │              │ career_coach_agent     │
│  • search_live_jobs│              │  • find_resume_templates│
│  • get_job_market_ │              │    (5 real CV styles,   │
│    data            │              │     premium-aware)      │
└─────────┬──────────┘              └────────────────────────┘
          │ HTTP
          ▼
 GET api.tunzafy.com/api/jobs/semantic-search
 (Vertex AI Search over ~20k live, fraud-gated jobs)
```

The root agent handles greetings/small talk itself and delegates job and CV
requests to the right specialist — the same separation of concerns the
production TunzAI uses.

## Tools

- **`search_live_jobs`** — calls Tunzafy's live, public `GET
  /api/jobs/semantic-search` (Vertex AI Search over the real job corpus,
  re-validated through the product's liveness/fraud gates). Fail-soft.
- **`get_job_market_data`** — labour-market snapshot (pay, demand, growth, top
  skills). Deterministic synthetic stub; swap in a real source without changing
  the schema.
- **`find_resume_templates`** — Tunzafy's five canonical CV styles
  (`professional`, `creative`, `technical`, `executive`, `minimalist`), kept in
  sync with the api-server's `CV_TEMPLATE_INSTRUCTIONS`. Premium-aware: the
  automated CV builder and auto-apply are **TunzAI Pro** features.

## Run locally

```bash
cd adk-agent
npm install
cp .env.example .env   # then fill in Gemini credentials
```

```bash
# Programmatic demo (prints tool calls + final answer)
npm run demo "find me remote data analyst jobs in Kenya"

# Multi-turn MEMORY demo (recall across two separate sessions)
npm run demo:memory

# Production MEMORY demo — Vertex AI Memory Bank (semantic RAG recall)
npm run demo:memory:vertex

# Evaluation — trajectory + response scoring, gates CI (exit 1 on regression)
npm run eval

# ADK dev web UI
npm run agent:web

# ADK terminal chat
npm run agent:run

# Type-check
npm run typecheck
```

## Credentials

Pick one in `.env` (see `.env.example`):

- **Vertex AI** — `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_LOCATION`, plus ADC (`gcloud auth application-default login`).
- **AI Studio** — `GEMINI_API_KEY`.

## Memory: prototype vs. production

The agent demonstrates ADK memory at two levels:

- **`npm run demo:memory`** — local prototype using `InMemoryMemoryService`.
  Recall is *keyword*-based, so turn 2 has to share words with turn 1.
- **`npm run demo:memory:vertex`** — production path using ADK's
  `VertexAiMemoryBankService`, a managed **Vertex AI Memory Bank** that recalls
  prior context *semantically*. In the demo, turn 1 says *"registered nurse in
  Nairobi, remote only"* and turn 2 — a **brand-new session** — asks as an *"ICU
  practitioner who needs to work from home near the Kenyan capital."* With almost
  no shared keywords, the Memory Bank still surfaces the earlier context by
  meaning. Set `TUNZAI_AGENT_ENGINE_ID` (+ Vertex project/location + ADC) to run
  it; it self-skips cleanly when unset.

This is the same long-term-memory backbone TunzAI uses to remember a seeker's
profile, preferences, and history across visits — not just within one chat.

## Live deployment (Google Cloud Run)

This agent is **already deployed** and serving the ADK runtime over a public HTTP
API \u2014 no install required:

**Base URL:** `https://tunzai-agent-m2po7a42jq-uc.a.run.app`

```bash
BASE="https://tunzai-agent-m2po7a42jq-uc.a.run.app"

curl "$BASE/list-apps"                                          # -> ["agent"]

curl -X POST "$BASE/apps/agent/users/judge/sessions/s1" \
  -H "Content-Type: application/json" -d '{}'

curl -X POST "$BASE/run" -H "Content-Type: application/json" -d '{
  "appName": "agent", "userId": "judge", "sessionId": "s1",
  "newMessage": { "role": "user",
    "parts": [{ "text": "find me remote data analyst jobs in Kenya" }] }
}'
```

It runs the exported `rootAgent` as a container on Cloud Run (region
`us-central1`, port `8000`, Vertex AI / Gemini backed). The `/run` response
returns the full ADK event trace: `transfer_to_agent` \u2192 `search_live_jobs` \u2192 a
grounded answer with a real open job.

## Deploy to Vertex AI Agent Engine

The agent is also Agent-Engine-ready. With the ADK CLI / devtools:

```bash
# Authenticate + select project
gcloud auth application-default login
gcloud config set project tunzafy

# Deploy the exported `rootAgent` to Agent Engine
npx adk deploy agent_engine \
  --project tunzafy \
  --region us-central1 \
  --staging_bucket gs://tunzafy-agent-engine \
  src/agent.ts
```

(Exact flags depend on the installed `@google/adk-devtools` version — run
`npx adk deploy --help`.)

## Why this is a strong agentic system

- **Real grounding, not a toy.** The job tool hits Tunzafy's production Vertex
  AI Search corpus — the same data real users search.
- **True multi-agent delegation** using ADK's native transfer, not hand-rolled
  if/else routing.
- **Faithful to the product.** CV templates and premium gating mirror the live
  TunzAI exactly.
- **Observable & evaluated.** A telemetry plugin emits structured run/tool
  events, and `npm run eval` scores the agent's tool trajectory + routing +
  response so regressions fail CI.
- **Safe by construction.** Standalone, workspace-excluded, read-only against
  production — building or deploying it cannot affect anything live.

## Security model

This agent is built to be safe to share and safe to run:

- **Least-privilege tools.** ADK's `SecurityPlugin` is driven by a custom
  deny-by-default policy engine (`src/security.ts`). Only a small allow-list of
  **read-only** tools can ever run; any new or unrecognised tool is blocked
  until it is consciously classified. The agent cannot silently gain write or
  payment powers.
- **SSRF guard.** Outbound calls are pinned to an HTTPS host allow-list
  (`src/config.ts` → `buildApiUrl`). A tampered base URL or a prompt-injected
  link can't redirect the agent to an internal or attacker-controlled endpoint.
- **Input hardening.** Tool arguments are trimmed, length-capped, control-char
  filtered, and numeric ranges are clamped (`src/callbacks.ts` + `security.ts`).
- **No secrets, no database, no internals.** The agent reaches Tunzafy **only**
  through the same `/api/jobs/semantic-search` endpoint the public website uses.
  It holds no DB credentials, no admin keys, and no private data paths.

## What this repository exposes (and what it does not)

This folder is the **only** thing intended for public/judge sharing. It is a
clean, self-contained presentation of the agent:

- ✅ **Included:** the ADK agent source, tools, callbacks, plugins, security
  policy, eval set, README, and `.env.example` (placeholders only).
- 🚫 **Not included / never shared:** the Tunzafy monorepo — `api-server`,
  `lib/db`, ingestion jobs, government-feed adapters, fraud/KYC logic, Stripe
  wiring, deployment scripts, and all secrets. None of those are referenced by
  or reachable from this artifact. Real credentials live only in a local
  `.env` (git-ignored) or in Secret Manager at deploy time.
