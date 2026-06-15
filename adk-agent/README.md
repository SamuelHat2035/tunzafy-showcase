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
| **Vertex AI Agent Engine — Memory Bank** (managed semantic RAG memory) | `src/runMemoryVertex.ts` |
| **Grounding** in real product data | `search_live_jobs` → live Vertex AI Search API |
| **Evaluation** (trajectory + routing + response scoring) | `src/eval.ts`, `eval/tunzai.evalset.json` |
| **Agent Engine deploy** (corrected REST deploy; ADK-TS 1.2 CLI is broken) | `src/deployAgentEngine.ts` |
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
- **`get_job_market_data`** — labour-market snapshot for a role + location. The
  open-role **count**, **demand level**, and **top requested skills** are
  derived live from Tunzafy's corpus (real counts + keywords mined from the
  titles of currently-open matching jobs); only the salary band and YoY growth
  are clearly-labelled illustrative heuristics (no verified salary series).
- **`find_resume_templates`** — Tunzafy's five canonical CV styles
  (`professional`, `creative`, `technical`, `executive`, `minimalist`), kept in
  sync with the api-server's `CV_TEMPLATE_INSTRUCTIONS`. Premium-aware: the
  automated CV builder and auto-apply are **TunzAI Pro** features.

## Run locally

```bash
cd artifacts/tunzai-agent
npm install
cp .env.example .env   # then fill in Gemini credentials
```

```bash
# Programmatic demo (prints tool calls + final answer)
npm run demo "find me remote data analyst jobs in Kenya"

# Multi-turn MEMORY demo (recall across two separate sessions)
npm run demo:memory

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

## Deployment & Vertex AI Agent Engine

TunzAI runs on Google Cloud across two complementary planes:

- **Live ADK runtime (Cloud Run).** The agent is deployed and serving on Cloud
  Run as the ADK runtime (`adk api_server`), which is the zero-auth endpoint
  judges can call directly (see the showcase README for the `curl` flow). This
  is the same `rootAgent` defined in this repo.
- **Vertex AI Agent Engine — Memory Bank.** Long-term, cross-session **semantic**
  memory is backed by a real Vertex AI Agent Engine resource (a managed
  `reasoningEngine`), wired in via `VertexAiMemoryBankService` (see
  `src/runMemoryVertex.ts`). This is a genuine Agent Engine integration, not a
  local stub — recall works across sessions with zero keyword overlap.

### Deploying the container runtime to Agent Engine

The bundled `adk deploy agent_engine` command in **ADK-TS 1.2 cannot run as
shipped** — I root-caused two defects from its source
(`@google/adk-devtools/.../cli_deploy_agent_engine.js`):

1. It imports `@google-cloud/vertexai/build/src/genai/client.js`, but
   `@google-cloud/vertexai` is **not a declared dependency or peer** of
   `@google/adk-devtools`, so the import throws `ERR_MODULE_NOT_FOUND`.
2. Even past that, it hardcodes the build image as
   `gcr.io/<project>/agent-engine-<app>:latest` and passes that to the
   reasoning-engine create call. **Vertex AI rejects a non-Artifact-Registry
   URI** (`FAILED_PRECONDITION`); the Cloud Build succeeds, only the final
   create call fails.

This repo ships a corrected, dependency-free replacement that talks to the
Vertex AI `reasoningEngines` REST API directly (using a short-lived `gcloud`
access token), builds from a **valid Artifact Registry** image, and polls the
deployment operation:

```bash
# Build + push a container that implements Agent Engine's serving contract,
# then create the reasoning engine from that Artifact Registry image:
TUNZAI_AGENT_IMAGE=us-central1-docker.pkg.dev/<project>/<repo>/tunzai-agent:v1 \
GOOGLE_CLOUD_PROJECT=<project> GOOGLE_CLOUD_LOCATION=us-central1 \
npm run deploy:agent-engine        # → src/deployAgentEngine.ts
```

> **Container contract.** A container deployed to Agent Engine must implement
> Agent Engine's serving contract (health + query protocol on the injected
> `$PORT`). ADK-TS's `api_server` image targets Cloud Run's routes, which is why
> the live judge-facing runtime is on Cloud Run while the Memory Bank reasoning
> engine provides the Agent Engine-managed memory plane.


## Why this is a strong agentic system

- **Real grounding, not a toy.** The job tool hits Tunzafy's production Vertex
  AI Search corpus — the same data real users search.
- **True multi-agent delegation** using ADK's native transfer, not hand-rolled
  if/else routing.
- **Faithful to the product.** CV templates and premium gating mirror the live
  TunzAI exactly.
- **Observable & evaluated.** A telemetry plugin emits structured run/tool
  events, and `npm run eval` scores the agent's tool trajectory + routing +
  response across 12 cases (multilingual, salary, premium-gating, and
  prompt-injection) so regressions fail CI (GitHub Actions runs it on every
  change to the agent).
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
  or reachable from this artifact. Real credentials live only in your local
  `.env` (git-ignored) or in Secret Manager at deploy time.

> If you publish this for the hackathon, publish **only** `artifacts/tunzai-agent/`
> as a standalone repo. Keep the main monorepo private. The agent will run
> against the public API exactly the same way.
