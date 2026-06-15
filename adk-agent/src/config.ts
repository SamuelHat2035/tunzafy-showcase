/**
 * Runtime configuration for the TunzAI ADK agent.
 *
 * Everything is environment-driven so the same code runs locally (Gemini API
 * key), on Vertex AI Agent Engine, or against a fine-tuned endpoint without code
 * changes.
 */

/** Trim + strip a trailing slash from a URL-ish env value. */
function cleanUrl(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}

/**
 * The model the agents use. Defaults to a fast, widely-available Gemini model.
 *
 * To point at Tunzafy's fine-tuned endpoint instead, set:
 *   GOOGLE_GENAI_USE_VERTEXAI=true
 *   GOOGLE_CLOUD_PROJECT=tunzafy
 *   GOOGLE_CLOUD_LOCATION=us-central1
 *   TUNZAI_AGENT_MODEL=projects/tunzafy/locations/us-central1/endpoints/<id>
 */
export const AGENT_MODEL: string =
  process.env.TUNZAI_AGENT_MODEL?.trim() || "gemini-2.5-flash";

/**
 * Base URL of Tunzafy's public API. The job-search tool calls the live
 * `/api/jobs/semantic-search` endpoint here, so the agent grounds its results
 * in the same ~20k-job Vertex AI Search corpus the product already uses — no
 * data duplication and no direct database access from the agent.
 */
export const TUNZAI_API_BASE: string = cleanUrl(
  process.env.TUNZAI_API_BASE,
  "https://api.tunzafy.com",
);

/**
 * SSRF guard. The agent may only ever call an HTTPS host on this allow-list, so
 * a tampered `TUNZAI_API_BASE` (or a prompt-injected URL) can never point the
 * agent at an attacker-controlled or internal endpoint. Override the list with
 * a comma-separated `TUNZAI_API_ALLOWED_HOSTS` only for staging/self-hosting.
 */
const DEFAULT_ALLOWED_HOSTS = ["api.tunzafy.com"];

export const ALLOWED_API_HOSTS: string[] = (
  process.env.TUNZAI_API_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean) ?? []
).length
  ? process.env
      .TUNZAI_API_ALLOWED_HOSTS!.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  : DEFAULT_ALLOWED_HOSTS;

/**
 * Validate that `TUNZAI_API_BASE` is an HTTPS URL on the allow-list and return a
 * safe absolute URL for a given path + query. Throws on any violation, so tools
 * fail closed rather than calling an untrusted host.
 *
 * `localhost`/`127.0.0.1` over plain HTTP is permitted ONLY when the host is
 * explicitly allow-listed via `TUNZAI_API_ALLOWED_HOSTS` (local dev).
 */
export function buildApiUrl(path: string, params?: URLSearchParams): string {
  let base: URL;
  try {
    base = new URL(TUNZAI_API_BASE);
  } catch {
    throw new Error(`TUNZAI_API_BASE is not a valid URL: ${TUNZAI_API_BASE}`);
  }

  const host = base.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const allowed = ALLOWED_API_HOSTS.includes(host);

  if (!allowed) {
    throw new Error(
      `Refusing to call non-allow-listed API host '${host}'. ` +
        `Allowed: ${ALLOWED_API_HOSTS.join(", ")}.`,
    );
  }
  if (base.protocol !== "https:" && !isLocal) {
    throw new Error(`Refusing non-HTTPS API base: ${TUNZAI_API_BASE}`);
  }

  const suffix = params ? `?${params.toString()}` : "";
  return `${TUNZAI_API_BASE}${path}${suffix}`;
}

/** App name reported to the ADK runner / Agent Engine. */
export const APP_NAME = "tunzai-resourcing-agent";
