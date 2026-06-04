import OpenAI from "openai";
import { openai } from "./client";

/* ------------------------------------------------------------------ */
/*  AI Provider Switcher (factory pattern)                             */
/*                                                                     */
/*  Single toggle:  AI_PROVIDER = "OPENAI" | "GEMINI"  (default OPENAI)*/
/*                                                                     */
/*  - OPENAI  → uses the existing `openai` client + logic unchanged.   */
/*  - GEMINI  → uses the native Google Vertex AI SDK, pointed at our   */
/*              fine-tuned model / endpoint (set later via env).       */
/*                                                                     */
/*  Both branches accept the SAME OpenAI-shaped request and return the */
/*  SAME OpenAI-shaped `ChatCompletion`, so every existing call site,  */
/*  its error handling, and its input/output parsing keep working with */
/*  zero changes other than swapping the call to `createChatCompletion`*/
/* ------------------------------------------------------------------ */

export type AIProvider = "OPENAI" | "GEMINI";

type ChatCreateParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionResult = OpenAI.Chat.Completions.ChatCompletion;

/** Reads the active provider at call-time (runtime), defaulting to OPENAI. */
export function getActiveProvider(): AIProvider {
  return process.env.AI_PROVIDER?.trim().toUpperCase() === "GEMINI"
    ? "GEMINI"
    : "OPENAI";
}

/* ------------------------- OpenAI strategy ------------------------- */

async function createWithOpenAI(
  params: ChatCreateParams,
): Promise<ChatCompletionResult> {
  // Identical to the legacy direct call — no behavior change.
  return openai.chat.completions.create(params);
}

/* ------------------------- Gemini strategy ------------------------- */

/**
 * Lazily-built Vertex AI generative model. We cache it across calls but
 * build it on first use so that:
 *   - the OPENAI path never touches the Vertex SDK, and
 *   - the (heavier) @google-cloud/vertexai dependency is only loaded when
 *     GEMINI is actually selected.
 */
let cachedVertexModel: unknown = null;

async function getVertexModel(): Promise<{
  generateContent: (req: unknown) => Promise<any>;
}> {
  if (cachedVertexModel) {
    return cachedVertexModel as {
      generateContent: (req: unknown) => Promise<any>;
    };
  }

  const project = process.env.AI_GEMINI_PROJECT?.trim();
  const location = process.env.AI_GEMINI_LOCATION?.trim() || "us-central1";
  // The fine-tuned model id OR full endpoint resource path. Supplied once
  // training finishes, e.g.
  //   projects/<proj>/locations/<loc>/endpoints/<endpointId>
  const model = process.env.AI_GEMINI_MODEL?.trim();

  if (!project) {
    throw new Error(
      "[ai-provider] AI_PROVIDER=GEMINI but AI_GEMINI_PROJECT is not set.",
    );
  }
  if (!model) {
    throw new Error(
      "[ai-provider] AI_PROVIDER=GEMINI but AI_GEMINI_MODEL (fine-tuned " +
        "model id or endpoint URI) is not set. Provide it once training finishes.",
    );
  }

  // Dynamic import keeps this out of the OPENAI code path and lets the build
  // succeed even before the SDK is installed in environments that only use
  // OpenAI. Install with: pnpm --filter @workspace/integrations-openai-ai-server add @google-cloud/vertexai
  // @ts-ignore — optional dependency, resolved only when GEMINI is active.
  const { VertexAI } = await import("@google-cloud/vertexai");
  const vertex = new VertexAI({ project, location });
  cachedVertexModel = vertex.getGenerativeModel({ model });
  return cachedVertexModel as {
    generateContent: (req: unknown) => Promise<any>;
  };
}

/** Maps OpenAI chat messages → Vertex `contents` + `systemInstruction`. */
function toVertexRequest(params: ChatCreateParams) {
  const systemTexts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: { text: string }[] }> =
    [];

  for (const msg of params.messages) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((p: any) => (typeof p === "string" ? p : (p?.text ?? "")))
              .join("")
          : "";

    if (msg.role === "system") {
      systemTexts.push(text);
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text }] });
    } else if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text }] });
    }
    // tool/function roles are intentionally ignored for now.
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof params.temperature === "number")
    generationConfig.temperature = params.temperature;
  if (typeof params.top_p === "number")
    generationConfig.topP = params.top_p;
  const maxOut =
    (typeof params.max_completion_tokens === "number"
      ? params.max_completion_tokens
      : undefined) ??
    (typeof params.max_tokens === "number" ? params.max_tokens : undefined);
  if (typeof maxOut === "number") generationConfig.maxOutputTokens = maxOut;

  const request: Record<string, unknown> = { contents };
  if (systemTexts.length > 0) {
    request.systemInstruction = {
      role: "system",
      parts: [{ text: systemTexts.join("\n") }],
    };
  }
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }
  return request;
}

/** Maps a Vertex `generateContent` response → OpenAI `ChatCompletion` shape. */
function toOpenAIShape(
  vertexResponse: any,
  model: string,
): ChatCompletionResult {
  const candidate = vertexResponse?.response?.candidates?.[0];
  const text: string =
    candidate?.content?.parts
      ?.map((p: any) => p?.text ?? "")
      .join("") ?? "";

  const finishReason = candidate?.finishReason;
  const usage = vertexResponse?.response?.usageMetadata ?? {};

  return {
    id: `gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          refusal: null,
        },
        logprobs: null,
        finish_reason:
          finishReason === "MAX_TOKENS" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    },
  } as ChatCompletionResult;
}

async function createWithGemini(
  params: ChatCreateParams,
): Promise<ChatCompletionResult> {
  const model = await getVertexModel();
  const vertexResponse = await model.generateContent(toVertexRequest(params));
  return toOpenAIShape(
    vertexResponse,
    process.env.AI_GEMINI_MODEL?.trim() || "gemini",
  );
}

/* --------------------------- The factory -------------------------- */

/**
 * Drop-in replacement for `openai.chat.completions.create(params)` (non-stream).
 *
 * Routes to OpenAI or Gemini based on the `AI_PROVIDER` env var, evaluated at
 * runtime on every call. Returns an OpenAI-shaped `ChatCompletion` regardless
 * of provider, so downstream output parsing and error handling are unchanged.
 */
export async function createChatCompletion(
  params: ChatCreateParams,
): Promise<ChatCompletionResult> {
  return getActiveProvider() === "GEMINI"
    ? createWithGemini(params)
    : createWithOpenAI(params);
}

/**
 * Drop-in routing proxy that mirrors the surface used across the codebase
 * (`openai.chat.completions.create(params)`), but dispatches through the
 * AI_PROVIDER switch. Call sites can swap their import from `openai` to this
 * proxy with no other changes, preserving error handling and I/O formatting.
 */
export const aiChat = {
  chat: {
    completions: {
      create(params: ChatCreateParams): Promise<ChatCompletionResult> {
        return createChatCompletion(params);
      },
    },
  },
};
