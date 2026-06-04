import OpenAI from "openai";
import { getActiveProvider, createChatCompletion } from "./provider";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
  );
}

export const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

/* ------------------------------------------------------------------ */
/*  Additive dual-provider failover layer.                             */
/*                                                                     */
/*  Everything above this banner (the legacy `openai` client and its   */
/*  env guards) is intentionally left untouched. The code below is     */
/*  purely additive: it introduces an OPTIONAL second provider         */
/*  (Google Vertex AI via its OpenAI-compatible Chat Completions       */
/*  endpoint) and a failover wrapper.                                  */
/*                                                                     */
/*  Behavior contract:                                                 */
/*    - When no Vertex env vars are present, the Vertex client is null */
/*      and `createChatCompletionWithFailover` collapses to a single   */
/*      call against the legacy `openai` client — i.e. identical to    */
/*      the system's current behavior.                                 */
/*    - Provider order is env-toggorable via AI_PRIMARY_PROVIDER       */
/*      ("vertex" | "openai"; default "openai") with NO code changes.  */
/* ------------------------------------------------------------------ */

type ChatCreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionResult = OpenAI.Chat.Completions.ChatCompletion;

type ProviderName = "vertex" | "openai";

/**
 * Optional Vertex AI client. Built ONLY when both Vertex env vars are
 * provided; otherwise `null`, in which case the failover wrapper behaves
 * exactly like a direct call to the legacy `openai` client.
 *
 * Auth (Option A — manual token injection): `AI_INTEGRATIONS_VERTEX_API_KEY`
 * carries a short-lived Google OAuth access token. No extra dependency is
 * pulled in; refreshing the token is an operational concern handled via env.
 */
export const vertexClient: OpenAI | null =
  process.env.AI_INTEGRATIONS_VERTEX_BASE_URL &&
  process.env.AI_INTEGRATIONS_VERTEX_API_KEY
    ? new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_VERTEX_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_VERTEX_BASE_URL,
      })
    : null;

/** Primary provider. Defaults to "openai" so absent config = current behavior. */
const PRIMARY_PROVIDER: ProviderName =
  process.env.AI_PRIMARY_PROVIDER?.trim().toLowerCase() === "vertex"
    ? "vertex"
    : "openai";

/** Per-attempt timeout before failing over to the secondary provider. */
const FAILOVER_TIMEOUT_MS: number = (() => {
  const raw = Number(process.env.AI_FAILOVER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 12_000;
})();

function clientFor(provider: ProviderName): OpenAI | null {
  return provider === "vertex" ? vertexClient : openai;
}

async function callWithTimeout(
  client: OpenAI,
  params: ChatCreateParams,
): Promise<ChatCompletionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAILOVER_TIMEOUT_MS);
  try {
    return await client.chat.completions.create(params, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drop-in replacement for `openai.chat.completions.create(params)` (non-stream).
 *
 * Tries the configured primary provider first; on any error OR timeout it
 * automatically retries the same request against the secondary provider.
 * Unconfigured providers (e.g. Vertex when its env vars are absent) are
 * transparently skipped, so the common single-provider case is preserved.
 */
export async function createChatCompletionWithFailover(
  params: ChatCreateParams,
): Promise<ChatCompletionResult> {
  // When the explicit provider switch selects GEMINI, route through the
  // native Vertex AI factory (which returns an OpenAI-shaped result). This
  // keeps a single source of truth for the OPENAI/GEMINI toggle.
  if (getActiveProvider() === "GEMINI") {
    return createChatCompletion(params);
  }

  const order: ProviderName[] =
    PRIMARY_PROVIDER === "vertex"
      ? ["vertex", "openai"]
      : ["openai", "vertex"];

  let firstError: unknown = null;

  for (const provider of order) {
    const client = clientFor(provider);
    if (!client) continue; // skip provider that is not configured
    try {
      return await callWithTimeout(client, params);
    } catch (err) {
      if (firstError === null) firstError = err;
      // eslint-disable-next-line no-console
      console.warn(
        `[ai-failover] provider "${provider}" failed; trying next provider if available.`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  throw (
    firstError ??
    new Error(
      "createChatCompletionWithFailover: no AI provider is configured.",
    )
  );
}
