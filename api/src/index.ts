import {
  ModelValidationError,
  screenplayExtractionInstructions,
  screenplayJsonSchema,
  validateModelImport,
  type ScreenplayImport,
} from "./schema";
import type {
  DurableObjectNamespace,
  DurableObjectState,
} from "@cloudflare/workers-types";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_SPEECH_REQUEST_BYTES = 16 * 1024;
const MAX_SPEECH_TEXT_CHARACTERS = 2_000;
const MAX_SPEECH_TEXT_BYTES = 8 * 1024;
const MAX_SPEECH_AUDIO_BYTES = 8 * 1024 * 1024;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const RATE_LIMITER_INSTANCE = "screenplay-import-global-v1";
const RATE_LIMITER_URL = "https://rate-limiter.internal/check";
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const OPENAI_FILES_URL = "https://api.openai.com/v1/files";
const FILE_EXPIRATION_SECONDS = 3_600;
const DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
const SPEECH_RESPONSE_FORMAT = "aac";
const SPEECH_CONTENT_TYPE = "audio/aac";
const SPEECH_INSTRUCTIONS =
  "Speak exactly the provided dialogue without adding, omitting, or paraphrasing words. Use a natural, clear performance suitable for actor rehearsal.";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_GEMINI_SPEECH_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GEMINI_LLM_MODEL = "gemini-3.1-flash";
const GEMINI_PCM_SAMPLE_RATE = 24_000;
const GEMINI_AUDIO_CONTENT_TYPE = "audio/wav";
const GEMINI_STAGE_TAG_LIMIT = 4;
const MAX_STAGE_NOTE_BYTES = 4_000;
const MAX_GEMINI_PCM_BYTES = 32 * 1024 * 1024;
const MAX_GEMINI_TTS_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_GEMINI_LLM_RESPONSE_BYTES = 64 * 1024;
const MAX_SPEECH_BATCH_REQUEST_BYTES = 96 * 1024;
const MAX_SPEECH_BATCH_LINES = 12;
const SPEECH_BATCH_CONCURRENCY = 4;

export const OPENAI_SPEECH_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

const OPENAI_SPEECH_MODELS = new Set([
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
  "tts-1",
  "tts-1-hd",
]);
const LEGACY_SPEECH_VOICES = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
]);

export interface Env {
  OPENAI_API_KEY?: string;
  RATE_LIMITER?: DurableObjectNamespace;
  OPENAI_VISION_MODEL?: string;
  OPENAI_SPEECH_MODEL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  RATE_LIMIT_REQUESTS?: string;
  GLOBAL_RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  MAX_CONCURRENT_REQUESTS?: string;
  OPENAI_TIMEOUT_MS?: string;
  OPENAI_MAX_OUTPUT_TOKENS?: string;
  OPENAI_SPEECH_TIMEOUT_MS?: string;
  GEMINI_API_KEY?: string;
  GEMINI_SPEECH_ENABLED?: string;
  GEMINI_SPEECH_MODEL?: string;
  GEMINI_LLM_MODEL?: string;
  GEMINI_BASE_URL?: string;
  GEMINI_SPEECH_TIMEOUT_MS?: string;
}

interface HandlerDependencies {
  fetch: typeof fetch;
  takeRateLimit: typeof takeDurableRateLimit;
  logProviderError: typeof logProviderError;
}

export interface RateWindow {
  count: number;
  resetAt: number;
}

interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

let activeOpenAiRequests = 0;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

export async function handleRequest(
  request: Request,
  env: Env,
  dependencies: Partial<HandlerDependencies> = {},
): Promise<Response> {
  const fetchImplementation = dependencies.fetch ?? fetch;
  const takeRateLimit = dependencies.takeRateLimit ?? takeDurableRateLimit;
  const providerErrorLogger = dependencies.logProviderError ?? logProviderError;
  const requestId = crypto.randomUUID();
  const cors = resolveCors(request, env);
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  const route =
    pathname === "/v1/screenplays/import"
      ? "screenplay_import"
      : pathname === "/v1/audio/speech/batch"
        ? "speech_batch"
        : pathname === "/v1/audio/speech"
          ? "speech"
          : null;

  if (request.method === "OPTIONS") {
    return cors.allowed
      ? new Response(null, { status: 204, headers: cors.headers })
      : errorResponse(403, "origin_not_allowed", "Origin is not allowed", requestId);
  }
  if (!route) {
    return withCors(
      errorResponse(404, "not_found", "Endpoint not found", requestId),
      cors,
    );
  }
  if (request.method !== "POST") {
    return withCors(
      errorResponse(405, "method_not_allowed", "Use POST for this endpoint", requestId, {
        Allow: "POST, OPTIONS",
      }),
      cors,
    );
  }
  if (!cors.allowed) {
    return errorResponse(403, "origin_not_allowed", "Origin is not allowed", requestId);
  }
  if ((route === "speech" || route === "speech_batch") && isGeminiSpeechEnabled(env)) {
    if (!env.GEMINI_API_KEY?.trim()) {
      return withCors(
        errorResponse(
          503,
          "service_not_configured",
          "Gemini speech is not configured",
          requestId,
        ),
        cors,
      );
    }
  } else if (!env.OPENAI_API_KEY?.trim()) {
    return withCors(
      errorResponse(503, "service_not_configured", "OpenAI service is not configured", requestId),
      cors,
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  const validContentType =
    route === "screenplay_import"
      ? contentType.toLowerCase().startsWith("multipart/form-data;")
      : /^application\/json(?:\s*;|$)/i.test(contentType);
  if (!validContentType) {
    return withCors(
      errorResponse(
        415,
        "unsupported_content_type",
        route === "screenplay_import"
          ? "Content-Type must be multipart/form-data"
          : "Content-Type must be application/json",
        requestId,
      ),
      cors,
    );
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  const requestLimit =
    route === "screenplay_import"
      ? MAX_REQUEST_BYTES
      : route === "speech_batch"
        ? MAX_SPEECH_BATCH_REQUEST_BYTES
        : MAX_SPEECH_REQUEST_BYTES;
  if (contentLength !== null && contentLength > requestLimit) {
    return withCors(
      errorResponse(
        413,
        "request_too_large",
        route === "screenplay_import"
          ? "Request body exceeds 10 MiB"
          : route === "speech_batch"
            ? "Request body exceeds 96 KiB"
            : "Request body exceeds 16 KiB",
        requestId,
      ),
      cors,
    );
  }

  // The batch body is validated before the rate limit: the durable limiter
  // charges a batch as lines.length requests, and an invalid batch must not
  // consume budget.
  let validatedBatch: ValidatedSpeechBatch | null = null;
  if (route === "speech_batch") {
    let value: unknown;
    try {
      const body = await readBodyWithLimit(request, MAX_SPEECH_BATCH_REQUEST_BYTES);
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (error) {
      const tooLarge = error instanceof RequestTooLargeError;
      return withCors(
        errorResponse(
          tooLarge ? 413 : 400,
          tooLarge ? "request_too_large" : "invalid_json",
          tooLarge ? "Request body exceeds 96 KiB" : "Request body must be valid JSON",
          requestId,
        ),
        cors,
      );
    }
    try {
      validatedBatch = validateSpeechBatchRequest(value);
    } catch (error) {
      if (error instanceof ClientInputError) {
        return withCors(
          errorResponse(error.status, error.code, error.message, requestId),
          cors,
        );
      }
      throw error;
    }
  }
  const rateLimitQuantity = validatedBatch ? validatedBatch.lines.length : 1;

  const rateLimit = positiveInteger(env.RATE_LIMIT_REQUESTS, 10, 1, 60);
  const globalRateLimit = positiveInteger(env.GLOBAL_RATE_LIMIT_REQUESTS, 100, 1, 10_000);
  const windowSeconds = positiveInteger(env.RATE_LIMIT_WINDOW_SECONDS, 60, 1, 3_600);
  let rateDecision: RateLimitDecision;
  try {
    rateDecision = await takeRateLimit(
      env,
      request.headers.get("cf-connecting-ip") ?? "unknown",
      rateLimit,
      globalRateLimit,
      windowSeconds,
      rateLimitQuantity,
    );
  } catch {
    return withCors(
      errorResponse(
        503,
        "rate_limit_unavailable",
        "AI rate limiting is unavailable",
        requestId,
        { "Retry-After": "30" },
      ),
      cors,
    );
  }
  if (!rateDecision.allowed) {
    return withCors(
      errorResponse(429, "rate_limited", "Too many AI requests", requestId, {
        "Retry-After": String(rateDecision.retryAfterSeconds),
      }),
      cors,
    );
  }

  const concurrencyLimit = positiveInteger(env.MAX_CONCURRENT_REQUESTS, 4, 1, 32);
  if (activeOpenAiRequests >= concurrencyLimit) {
    return withCors(
      errorResponse(503, "capacity_exceeded", "AI processing is temporarily busy", requestId, {
        "Retry-After": "5",
      }),
      cors,
    );
  }

  activeOpenAiRequests += 1;
  try {
    return route === "screenplay_import"
      ? await processImport(
          request,
          env,
          contentType,
          requestId,
          cors,
          fetchImplementation,
          providerErrorLogger,
        )
      : route === "speech_batch" && validatedBatch
        ? await processSpeechBatch(
            validatedBatch,
            env,
            requestId,
            cors,
            fetchImplementation,
            providerErrorLogger,
          )
        : await processSpeech(
            request,
            env,
            requestId,
            cors,
            fetchImplementation,
            providerErrorLogger,
          );
  } finally {
    activeOpenAiRequests -= 1;
  }
}

export interface RateWindowEvaluation {
  allowed: boolean;
  retryAfterSeconds: number;
  globalWindow: RateWindow;
  clientWindow: RateWindow;
}

export function evaluateRateWindows(
  globalWindow: RateWindow | undefined,
  clientWindow: RateWindow | undefined,
  globalLimit: number,
  clientLimit: number,
  windowMs: number,
  now: number,
  quantity: number = 1,
): RateWindowEvaluation {
  const nextGlobal =
    !globalWindow || globalWindow.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : globalWindow;
  const nextClient =
    !clientWindow || clientWindow.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : clientWindow;
  const blockedUntil = Math.max(
    nextGlobal.count + quantity > globalLimit ? nextGlobal.resetAt : now,
    nextClient.count + quantity > clientLimit ? nextClient.resetAt : now,
  );

  if (blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1_000)),
      globalWindow: nextGlobal,
      clientWindow: nextClient,
    };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    globalWindow: { ...nextGlobal, count: nextGlobal.count + quantity },
    clientWindow: { ...nextClient, count: nextClient.count + quantity },
  };
}

export class RateLimiter {
  constructor(private readonly state: DurableObjectState) {
    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_windows (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        )
      `);
    });
  }

  fetch(request: Request): Response {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/check") {
      return new Response(null, { status: 404 });
    }

    const clientKey = request.headers.get("X-Rate-Limit-Key");
    const clientLimit = parseInternalPositiveInteger(
      request.headers.get("X-Client-Limit"),
      60,
    );
    const globalLimit = parseInternalPositiveInteger(
      request.headers.get("X-Global-Limit"),
      10_000,
    );
    const windowMs = parseInternalPositiveInteger(
      request.headers.get("X-Window-Ms"),
      3_600_000,
    );
    const quantity = parseRateQuantity(request.headers.get("X-Quantity"));
    if (
      !clientKey ||
      !/^[a-f0-9]{64}$/.test(clientKey) ||
      !clientLimit ||
      !globalLimit ||
      !windowMs ||
      quantity === null
    ) {
      return new Response(null, { status: 400 });
    }

    const now = Date.now();
    const decision = this.state.storage.transactionSync(() => {
      const sql = this.state.storage.sql;
      sql.exec("DELETE FROM rate_windows WHERE reset_at <= ?", now);
      const globalWindow = readRateWindow(sql, "global");
      const clientWindow = readRateWindow(sql, `client:${clientKey}`);
      const evaluated = evaluateRateWindows(
        globalWindow,
        clientWindow,
        globalLimit,
        clientLimit,
        windowMs,
        now,
      );
      if (evaluated.allowed) {
        writeRateWindow(sql, "global", evaluated.globalWindow);
        writeRateWindow(sql, `client:${clientKey}`, evaluated.clientWindow);
      }
      return evaluated;
    });

    return jsonResponse(
      200,
      { allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds },
      { "Cache-Control": "no-store" },
    );
  }
}

async function takeDurableRateLimit(
  env: Env,
  clientAddress: string,
  clientLimit: number,
  globalLimit: number,
  windowSeconds: number,
  quantity: number = 1,
): Promise<RateLimitDecision> {
  if (!env.RATE_LIMITER) throw new Error("RATE_LIMITER binding is unavailable");

  const clientKey = await sha256(clientAddress);
  const id = env.RATE_LIMITER.idFromName(RATE_LIMITER_INSTANCE);
  const response = await env.RATE_LIMITER.get(id).fetch(RATE_LIMITER_URL, {
    method: "POST",
    headers: {
      "X-Rate-Limit-Key": clientKey,
      "X-Client-Limit": String(clientLimit),
      "X-Global-Limit": String(globalLimit),
      "X-Window-Ms": String(windowSeconds * 1_000),
      "X-Quantity": String(quantity),
    },
  });
  if (!response.ok) throw new Error("Durable rate limiter rejected the request");

  const value: unknown = await response.json();
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).allowed !== "boolean" ||
    !Number.isInteger((value as Record<string, unknown>).retryAfterSeconds) ||
    ((value as Record<string, unknown>).retryAfterSeconds as number) < 0
  ) {
    throw new Error("Durable rate limiter returned an invalid response");
  }
  return value as RateLimitDecision;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readRateWindow(sql: DurableObjectState["storage"]["sql"], key: string): RateWindow | undefined {
  const row = sql
    .exec<{ count: number; reset_at: number }>(
      "SELECT count, reset_at FROM rate_windows WHERE key = ?",
      key,
    )
    .toArray()[0];
  return row ? { count: row.count, resetAt: row.reset_at } : undefined;
}

function writeRateWindow(
  sql: DurableObjectState["storage"]["sql"],
  key: string,
  window: RateWindow,
): void {
  sql.exec(
    `INSERT INTO rate_windows (key, count, reset_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at`,
    key,
    window.count,
    window.resetAt,
  );
}

function parseInternalPositiveInteger(value: string | null, maximum: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

// Absent (legacy caller) or "1" mean a single request. Out-of-range values
// fail closed so a malformed quantity can never charge an unlimited budget.
function parseRateQuantity(value: string | null): number | null {
  if (value === null || value === "" || value === "1") return 1;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_SPEECH_BATCH_LINES ? parsed : null;
}

async function processImport(
  request: Request,
  env: Env,
  contentType: string,
  requestId: string,
  cors: ReturnType<typeof resolveCors>,
  fetchImplementation: typeof fetch,
  providerErrorLogger: typeof logProviderError,
): Promise<Response> {
  let form: FormData;
  try {
    const body = await readBodyWithLimit(request, MAX_REQUEST_BYTES);
    form = await new Request("https://local.invalid", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    }).formData();
  } catch (error) {
    const tooLarge = error instanceof RequestTooLargeError;
    return withCors(
      errorResponse(
        tooLarge ? 413 : 400,
        tooLarge ? "request_too_large" : "invalid_multipart",
        tooLarge ? "Request body exceeds 10 MiB" : "Malformed multipart request",
        requestId,
      ),
      cors,
    );
  }

  let upload: ValidatedUpload;
  try {
    upload = await validateForm(form);
  } catch (error) {
    if (error instanceof ClientInputError) {
      return withCors(errorResponse(error.status, error.code, error.message, requestId), cors);
    }
    throw error;
  }

  try {
    const result = await extractScreenplay(
      upload,
      env,
      fetchImplementation,
      requestId,
      providerErrorLogger,
    );
    return withCors(
      jsonResponse(200, result, {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-OCR-Model": env.OPENAI_VISION_MODEL || "gpt-5.6-sol",
        "X-Request-Id": requestId,
      }),
      cors,
    );
  } catch (error) {
    if (error instanceof OpenAiTimeoutError) {
      return withCors(
        errorResponse(504, "upstream_timeout", "Vision processing timed out", requestId),
        cors,
      );
    }
    if (error instanceof ModelValidationError) {
      return withCors(
        errorResponse(
          502,
          "invalid_model_output",
          "Vision processing returned an invalid screenplay",
          requestId,
        ),
        cors,
      );
    }
    if (error instanceof OpenAiError) {
      providerErrorLogger(requestId, error);
      const publicError = classifyOpenAiError(error);
      return withCors(
        errorResponse(502, publicError.code, publicError.message, requestId),
        cors,
      );
    }
    return withCors(
      errorResponse(500, "internal_error", "Screenplay import failed", requestId),
      cors,
    );
  }
}

type SpeechVoice = (typeof OPENAI_SPEECH_VOICES)[number];

const GEMINI_SPEECH_VOICE_MAP: Record<SpeechVoice, string> = {
  alloy: "Charon",
  echo: "Puck",
  onyx: "Orus",
  ash: "Algenib",
  sage: "Sadaltager",
  ballad: "Zubenelgenubi",
  nova: "Kore",
  fable: "Vindemiatrix",
  coral: "Sulafat",
  shimmer: "Achernar",
  verse: "Despina",
  marin: "Umbriel",
  cedar: "Algieba",
};

const GEMINI_AUDIO_TAGS = [
  "laughs",
  "sigh",
  "whispers",
  "nervousness",
  "frustration",
  "amusement",
  "tension",
  "sarcasm",
  "sadness",
  "excitement",
  "anger",
  "confusion",
  "disgust",
  "surprise",
  "fear",
  "relief",
  "determination",
  "affection",
] as const;

function isGeminiSpeechEnabled(env: Env): boolean {
  return env.GEMINI_SPEECH_ENABLED?.trim().toLowerCase() === "true";
}

interface ValidatedSpeechRequest {
  text: string;
  voice: SpeechVoice;
  stageNote: string | null;
}

interface SynthesizedSpeech {
  audio: ArrayBuffer;
  contentType: string;
  model: string;
  voice: SpeechVoice;
}

async function processSpeech(
  request: Request,
  env: Env,
  requestId: string,
  cors: ReturnType<typeof resolveCors>,
  fetchImplementation: typeof fetch,
  providerErrorLogger: typeof logProviderError,
): Promise<Response> {
  let value: unknown;
  try {
    const body = await readBodyWithLimit(request, MAX_SPEECH_REQUEST_BYTES);
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    const tooLarge = error instanceof RequestTooLargeError;
    return withCors(
      errorResponse(
        tooLarge ? 413 : 400,
        tooLarge ? "request_too_large" : "invalid_json",
        tooLarge ? "Request body exceeds 16 KiB" : "Request body must be valid JSON",
        requestId,
      ),
      cors,
    );
  }

  let speechRequest: ValidatedSpeechRequest;
  try {
    speechRequest = validateSpeechRequest(value);
  } catch (error) {
    if (error instanceof ClientInputError) {
      return withCors(errorResponse(error.status, error.code, error.message, requestId), cors);
    }
    throw error;
  }

  const geminiEnabled = isGeminiSpeechEnabled(env);
  const model = geminiEnabled
    ? ""
    : env.OPENAI_SPEECH_MODEL?.trim() || DEFAULT_SPEECH_MODEL;
  if (!geminiEnabled && !OPENAI_SPEECH_MODELS.has(model)) {
    return withCors(
      errorResponse(
        503,
        "service_not_configured",
        "Configured OpenAI speech model is unsupported",
        requestId,
      ),
      cors,
    );
  }
  if (
    !geminiEnabled &&
    (model === "tts-1" || model === "tts-1-hd") &&
    !LEGACY_SPEECH_VOICES.has(speechRequest.voice)
  ) {
    return withCors(
      errorResponse(
        400,
        "invalid_voice",
        "voice is not supported by the configured speech model",
        requestId,
      ),
      cors,
    );
  }

  const outcome = await synthesizeSpeechLine(
    { text: speechRequest.text, stageNote: speechRequest.stageNote },
    speechRequest.voice,
    { geminiEnabled, model, env, fetchImplementation, providerErrorLogger, requestId },
  );
  if (!outcome.ok) {
    return withCors(
      errorResponse(outcome.status, outcome.code, outcome.message, requestId),
      cors,
    );
  }
  return withCors(
    new Response(outcome.audio, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, private",
        "Content-Length": String(outcome.audio.byteLength),
        "Content-Type": outcome.contentType,
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
        "X-Speech-Model": outcome.model,
        "X-Speech-Voice": outcome.voice,
      },
    }),
    cors,
  );
}

interface SpeechLineInput {
  text: string;
  stageNote: string | null;
}

type SpeechLineOutcome =
  | { ok: true; audio: ArrayBuffer; contentType: string; model: string; voice: SpeechVoice }
  | { ok: false; status: number; code: string; message: string };

// Shared per-line speech path used by both the single-line and batch
// endpoints: provider selection, synthesis (including Gemini stage-note
// resolution), byte caps, and error mapping are identical to the single
// endpoint, so the single endpoint's behavior is unchanged.
async function synthesizeSpeechLine(
  line: SpeechLineInput,
  voice: SpeechVoice,
  options: {
    geminiEnabled: boolean;
    model: string;
    env: Env;
    fetchImplementation: typeof fetch;
    providerErrorLogger: typeof logProviderError;
    requestId: string;
  },
): Promise<SpeechLineOutcome> {
  const request: ValidatedSpeechRequest = { text: line.text, voice, stageNote: line.stageNote };
  try {
    const result = options.geminiEnabled
      ? await synthesizeGeminiSpeech(
          request,
          options.env,
          options.fetchImplementation,
          options.providerErrorLogger,
          options.requestId,
        )
      : await synthesizeSpeech(request, options.model, options.env, options.fetchImplementation);
    return {
      ok: true,
      audio: result.audio,
      contentType: result.contentType,
      model: result.model,
      voice: result.voice,
    };
  } catch (error) {
    if (error instanceof OpenAiTimeoutError) {
      return {
        ok: false,
        status: 504,
        code: "upstream_timeout",
        message: "Speech generation timed out",
      };
    }
    if (error instanceof OpenAiError) {
      options.providerErrorLogger(options.requestId, error);
      const publicError = classifyOpenAiError(error, "speech");
      return {
        ok: false,
        status: 502,
        code: publicError.code,
        message: publicError.message,
      };
    }
    return {
      ok: false,
      status: 500,
      code: "internal_error",
      message: "Speech generation failed",
    };
  }
}

interface ValidatedSpeechBatch {
  voice: SpeechVoice;
  lines: SpeechLineInput[];
}

// Batch endpoint: runs every validated line through the shared per-line
// helper with a bounded concurrency pool. One failed line never fails the
// batch — results stay in input order with per-line codes.
async function processSpeechBatch(
  batch: ValidatedSpeechBatch,
  env: Env,
  requestId: string,
  cors: ReturnType<typeof resolveCors>,
  fetchImplementation: typeof fetch,
  providerErrorLogger: typeof logProviderError,
): Promise<Response> {
  const geminiEnabled = isGeminiSpeechEnabled(env);
  const model = geminiEnabled ? "" : env.OPENAI_SPEECH_MODEL?.trim() || DEFAULT_SPEECH_MODEL;
  if (!geminiEnabled && !OPENAI_SPEECH_MODELS.has(model)) {
    return withCors(
      errorResponse(
        503,
        "service_not_configured",
        "Configured OpenAI speech model is unsupported",
        requestId,
      ),
      cors,
    );
  }
  if (
    !geminiEnabled &&
    (model === "tts-1" || model === "tts-1-hd") &&
    !LEGACY_SPEECH_VOICES.has(batch.voice)
  ) {
    return withCors(
      errorResponse(
        400,
        "invalid_voice",
        "voice is not supported by the configured speech model",
        requestId,
      ),
      cors,
    );
  }

  const lines = batch.lines;
  const results = new Array<
    | { index: number; ok: true; contentType: string; audioB64: string }
    | { index: number; ok: false; code: string }
  >(lines.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= lines.length) return;
      const outcome = await synthesizeSpeechLine(lines[index], batch.voice, {
        geminiEnabled,
        model,
        env,
        fetchImplementation,
        providerErrorLogger,
        requestId,
      });
      results[index] = outcome.ok
        ? {
            index,
            ok: true,
            contentType: outcome.contentType,
            audioB64: toBase64(new Uint8Array(outcome.audio)),
          }
        : { index, ok: false, code: outcome.code };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SPEECH_BATCH_CONCURRENCY, lines.length) }, () => worker()),
  );

  return withCors(
    jsonResponse(
      200,
      { voice: batch.voice, results },
      {
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
        "X-Speech-Model": geminiEnabled
          ? env.GEMINI_SPEECH_MODEL?.trim() || DEFAULT_GEMINI_SPEECH_MODEL
          : model,
        "X-Speech-Voice": batch.voice,
      },
    ),
    cors,
  );
}

function validateSpeechRequest(value: unknown): ValidatedSpeechRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientInputError(400, "invalid_request", "Request body must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const unexpected = keys.find(
    (key) => key !== "text" && key !== "voice" && key !== "stageNote",
  );
  if (unexpected) {
    throw new ClientInputError(400, "unexpected_field", `Unexpected JSON field: ${unexpected}`);
  }
  if (typeof record.text !== "string") {
    throw new ClientInputError(400, "invalid_text", "text must be a string");
  }
  if (typeof record.voice !== "string") {
    throw new ClientInputError(400, "invalid_voice", "voice must be a string");
  }

  const text = validateSpeechTextContent(record.text);
  if (!(OPENAI_SPEECH_VOICES as readonly string[]).includes(record.voice)) {
    throw new ClientInputError(400, "invalid_voice", "voice is not supported");
  }
  const stageNote = validateSpeechStageNote(record.stageNote);
  return { text, voice: record.voice as SpeechVoice, stageNote };
}

// Shared speech-text checks (identical for the single and batch endpoints).
function validateSpeechTextContent(text: string): string {
  if (!text || text.trim() !== text) {
    throw new ClientInputError(
      400,
      "invalid_text",
      "text must be non-empty without outer whitespace",
    );
  }
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new ClientInputError(400, "invalid_text", "text contains unsupported control characters");
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new ClientInputError(400, "invalid_text", "text contains invalid Unicode");
    }
  }
  if ([...text].length > MAX_SPEECH_TEXT_CHARACTERS) {
    throw new ClientInputError(
      413,
      "text_too_long",
      `text exceeds ${MAX_SPEECH_TEXT_CHARACTERS} characters`,
    );
  }
  if (new TextEncoder().encode(text).byteLength > MAX_SPEECH_TEXT_BYTES) {
    throw new ClientInputError(
      413,
      "text_too_large",
      "UTF-8 text exceeds 8 KiB",
    );
  }
  return text;
}

// Shared stage-note checks: whitespace-only is treated as absent and the
// size check only runs for non-empty notes.
function validateSpeechStageNote(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new ClientInputError(400, "invalid_stage_note", "stageNote must be a string");
  }
  if (value.trim() === "") return null;
  if (new TextEncoder().encode(value).byteLength > MAX_STAGE_NOTE_BYTES) {
    throw new ClientInputError(
      413,
      "stage_note_too_large",
      `stageNote exceeds ${MAX_STAGE_NOTE_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function validateSpeechLine(index: number, value: unknown): SpeechLineInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientInputError(400, "invalid_line", `lines[${index}] must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => key !== "text" && key !== "stageNote");
  if (unexpected) {
    throw new ClientInputError(400, "unexpected_field", `Unexpected JSON field: ${unexpected}`);
  }
  if (typeof record.text !== "string") {
    throw new ClientInputError(400, "invalid_text", "text must be a string");
  }
  const text = validateSpeechTextContent(record.text);
  return { text, stageNote: validateSpeechStageNote(record.stageNote) };
}

function validateSpeechBatchRequest(value: unknown): ValidatedSpeechBatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientInputError(400, "invalid_request", "Request body must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).find((key) => key !== "voice" && key !== "lines");
  if (unexpected) {
    throw new ClientInputError(400, "unexpected_field", `Unexpected JSON field: ${unexpected}`);
  }
  if (typeof record.voice !== "string") {
    throw new ClientInputError(400, "invalid_voice", "voice must be a string");
  }
  if (!(OPENAI_SPEECH_VOICES as readonly string[]).includes(record.voice)) {
    throw new ClientInputError(400, "invalid_voice", "voice is not supported");
  }
  if (!Array.isArray(record.lines)) {
    throw new ClientInputError(400, "invalid_lines", "lines must contain 1 to 12 entries");
  }
  if (record.lines.length === 0) {
    throw new ClientInputError(400, "invalid_lines", "lines must contain 1 to 12 entries");
  }
  if (record.lines.length > MAX_SPEECH_BATCH_LINES) {
    throw new ClientInputError(
      400,
      "too_many_lines",
      `lines must contain at most ${MAX_SPEECH_BATCH_LINES} entries`,
    );
  }
  const lines = record.lines.map((entry, index) => validateSpeechLine(index, entry));
  return { voice: record.voice as SpeechVoice, lines };
}

async function synthesizeSpeech(
  request: ValidatedSpeechRequest,
  model: string,
  env: Env,
  fetchImplementation: typeof fetch,
): Promise<SynthesizedSpeech> {
  const apiKey = env.OPENAI_API_KEY!.trim();
  const keyCandidateError = getOpenAiKeyCandidateError(apiKey);
  if (keyCandidateError) {
    throw new OpenAiError({
      ...emptyProviderError(),
      operation: "configuration",
      type: "authentication_error",
      code: `invalid_api_key_${keyCandidateError}`,
      message: "Stored OpenAI key does not match the expected key format.",
    });
  }

  const timeoutMs = positiveInteger(env.OPENAI_SPEECH_TIMEOUT_MS, 30_000, 5_000, 60_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImplementation(OPENAI_SPEECH_URL, {
        method: "POST",
        headers: {
          Accept: "application/octet-stream",
          Authorization: ["Bearer", apiKey].join(" "),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: request.text,
          voice: request.voice,
          response_format: SPEECH_RESPONSE_FORMAT,
          stream_format: "audio",
          ...(model.startsWith("gpt-4o-mini-tts")
            ? { instructions: SPEECH_INSTRUCTIONS }
            : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new OpenAiTimeoutError();
      throw OpenAiError.fromTransport(error, "speech");
    }
    if (!response.ok) {
      const providerError = await OpenAiError.fromResponse(response, "speech");
      if (controller.signal.aborted) throw new OpenAiTimeoutError();
      throw providerError;
    }

    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > MAX_SPEECH_AUDIO_BYTES) {
      await response.body?.cancel();
      throw invalidProviderResponse(
        "speech",
        "ResponseTooLarge",
        response.headers.get("content-type"),
      );
    }

    const providerContentType = sanitizeContentType(response.headers.get("content-type"));
    if (
      providerContentType &&
      !providerContentType.startsWith("audio/") &&
      providerContentType !== "application/octet-stream"
    ) {
      await response.body?.cancel();
      throw invalidProviderResponse(
        "speech",
        "InvalidContentType",
        response.headers.get("content-type"),
      );
    }

    let audio: ArrayBuffer;
    try {
      audio = await readStreamWithLimit(response.body, MAX_SPEECH_AUDIO_BYTES);
    } catch (error) {
      if (controller.signal.aborted) throw new OpenAiTimeoutError();
      if (error instanceof RequestTooLargeError) {
        throw invalidProviderResponse(
          "speech",
          "ResponseTooLarge",
          response.headers.get("content-type"),
        );
      }
      throw OpenAiError.fromTransport(error, "speech");
    }
    if (audio.byteLength === 0) {
      throw invalidProviderResponse(
        "speech",
        "EmptyResponse",
        response.headers.get("content-type"),
      );
    }
    return {
      audio,
      contentType:
        providerContentType && providerContentType.startsWith("audio/")
          ? providerContentType
          : SPEECH_CONTENT_TYPE,
      model,
      voice: request.voice,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeGeminiSpeech(
  request: ValidatedSpeechRequest,
  env: Env,
  fetchImplementation: typeof fetch,
  providerErrorLogger: typeof logProviderError,
  requestId: string,
): Promise<SynthesizedSpeech> {
  const apiKey = env.GEMINI_API_KEY!.trim();
  const base = (env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
  const model = env.GEMINI_SPEECH_MODEL?.trim() || DEFAULT_GEMINI_SPEECH_MODEL;
  const llmModel = env.GEMINI_LLM_MODEL?.trim() || DEFAULT_GEMINI_LLM_MODEL;
  const timeoutMs = positiveInteger(env.GEMINI_SPEECH_TIMEOUT_MS, 30_000, 5_000, 60_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let input = request.text;
    if (request.stageNote) {
      const tags = await resolveGeminiStageTags(
        request,
        llmModel,
        base,
        apiKey,
        controller,
        fetchImplementation,
        providerErrorLogger,
        requestId,
      );
      if (tags.length > 0) {
        input = tags.map((tag) => `[${tag}]`).join(" ") + ` ${request.text}`;
      }
    }

    let response: Response;
    try {
      response = await fetchImplementation(`${base}/v1beta/interactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model,
          input,
          response_format: { type: "audio" },
          generation_config: {
            speech_config: [{ voice: GEMINI_SPEECH_VOICE_MAP[request.voice] }],
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new OpenAiTimeoutError();
      throw OpenAiError.fromTransport(error, "gemini_speech");
    }
    if (!response.ok) {
      const providerError = await OpenAiError.fromResponse(response, "gemini_speech");
      if (controller.signal.aborted) throw new OpenAiTimeoutError();
      throw providerError;
    }

    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > MAX_GEMINI_TTS_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw invalidProviderResponse(
        "gemini_speech",
        "ResponseTooLarge",
        response.headers.get("content-type"),
      );
    }

    let body: ArrayBuffer;
    try {
      body = await readStreamWithLimit(response.body, MAX_GEMINI_TTS_RESPONSE_BYTES);
    } catch (error) {
      if (controller.signal.aborted) throw new OpenAiTimeoutError();
      if (error instanceof RequestTooLargeError) {
        throw invalidProviderResponse(
          "gemini_speech",
          "ResponseTooLarge",
          response.headers.get("content-type"),
        );
      }
      throw OpenAiError.fromTransport(error, "gemini_speech");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw invalidProviderResponse(
        "gemini_speech",
        "InvalidJson",
        response.headers.get("content-type"),
      );
    }

    const pcm = extractGeminiPcm(parsed);
    if (controller.signal.aborted) throw new OpenAiTimeoutError();

    const audio = new ArrayBuffer(44 + pcm.byteLength);
    new Uint8Array(audio).set(buildWavHeader(pcm));
    new Uint8Array(audio, 44).set(pcm);
    return {
      audio,
      contentType: GEMINI_AUDIO_CONTENT_TYPE,
      model,
      voice: request.voice,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveGeminiStageTags(
  request: ValidatedSpeechRequest,
  llmModel: string,
  base: string,
  apiKey: string,
  controller: AbortController,
  fetchImplementation: typeof fetch,
  providerErrorLogger: typeof logProviderError,
  requestId: string,
): Promise<string[]> {
  const stageNote = request.stageNote!;
  let text: string | null = null;
  try {
    const response = await fetchImplementation(
      `${base}/v1beta/models/${llmModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildGeminiStageTagPrompt(request.text, stageNote) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: { tags: { type: "array", items: { type: "string" } } },
              required: ["tags"],
            },
            temperature: 0,
          },
        }),
        signal: controller.signal,
      },
    );
    if (controller.signal.aborted) throw new OpenAiTimeoutError();
    if (!response.ok) {
      const providerError = await OpenAiError.fromResponse(response, "gemini_stage_tags").catch(
        () => new OpenAiError(emptyProviderError()),
      );
      providerErrorLogger(
        requestId,
        new OpenAiError({ ...providerError.provider, code: "stage_note_tags_unavailable" }),
      );
      return [];
    }

    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && declaredLength > MAX_GEMINI_LLM_RESPONSE_BYTES) {
      await response.body?.cancel();
      providerErrorLogger(requestId, geminiStageTagDegradation());
      return [];
    }

    const body = await readStreamWithLimit(response.body, MAX_GEMINI_LLM_RESPONSE_BYTES);
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    if (controller.signal.aborted || error instanceof OpenAiTimeoutError) {
      throw new OpenAiTimeoutError();
    }
    // The tag call is best-effort: any transport/read failure degrades to the plain line.
    const providerError =
      error instanceof OpenAiError ? error : OpenAiError.fromTransport(error, "gemini_stage_tags");
    providerErrorLogger(
      requestId,
      new OpenAiError({
        ...providerError.provider,
        operation: "gemini_stage_tags",
        code: "stage_note_tags_unavailable",
      }),
    );
    return [];
  }

  const tags = parseGeminiStageTags(text!);
  if (tags === null) {
    providerErrorLogger(
      requestId,
      new OpenAiError({
        ...emptyProviderError(),
        operation: "gemini_stage_tags",
        code: "stage_note_tags_rejected",
        message: "Gemini stage-note tag output failed validation",
      }),
    );
    return [];
  }
  return tags;
}

function geminiStageTagDegradation(): OpenAiError {
  return new OpenAiError({
    ...emptyProviderError(),
    operation: "gemini_stage_tags",
    code: "stage_note_tags_unavailable",
    message: "Gemini stage-note tag call failed",
  });
}

function buildGeminiStageTagPrompt(line: string, stageNote: string): string {
  return [
    "Convert the stage direction below into audio-effect tags for a text-to-speech model.",
    "",
    "Dialogue line:",
    `"${line}"`,
    "",
    "Stage direction:",
    `"${stageNote}"`,
    "",
    "Rules:",
    "- Output exactly one JSON object that matches the schema, and nothing else.",
    "- Zero prose: no explanation, no markdown, no code fences, no extra fields.",
    '- Shape: {"tags": ["tag"]}.',
    `- "tags" contains zero to ${GEMINI_STAGE_TAG_LIMIT} entries.`,
    `- Every tag must be exactly one of these lowercase English tags: ${[...GEMINI_AUDIO_TAGS].join(", ")}.`,
    "- Do not rewrite, summarize, translate, or echo the dialogue line.",
  ].join("\n");
}

function parseGeminiStageTags(text: string): string[] | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return null;
  }
  const root = (typeof envelope === "object" && envelope !== null ? envelope : {}) as Record<
    string,
    unknown
  >;
  const candidates = root.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = (typeof candidates[0] === "object" && candidates[0] !== null ? candidates[0] : {}) as Record<
    string,
    unknown
  >;
  const content = (typeof first.content === "object" && first.content !== null ? first.content : {}) as Record<
    string,
    unknown
  >;
  const parts = content.parts;
  if (!Array.isArray(parts)) return null;
  const inner = parts
    .map((part) =>
      typeof part === "object" && part !== null
        ? (part as Record<string, unknown>).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const tags = (parsed as Record<string, unknown>).tags;
  if (!Array.isArray(tags) || tags.length > GEMINI_STAGE_TAG_LIMIT) return null;
  for (const tag of tags) {
    if (typeof tag !== "string" || !(GEMINI_AUDIO_TAGS as readonly string[]).includes(tag)) {
      return null;
    }
  }
  return tags as string[];
}

/**
 * The Interactions API returns the rendered audio as parts inside steps:
 * `steps[].content[]`, where the audio part carries base64 L16 PCM in `data`
 * (`type: "audio"`, e.g. `audio/l16; rate=24000; channels=1`). There is no
 * `interaction.output_audio` field — the audio part is the only carrier.
 */
function extractGeminiPcm(body: unknown): Uint8Array {
  const root = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const steps = Array.isArray(root.steps) ? (root.steps as unknown[]) : [];
  const pcmParts: Uint8Array[] = [];
  for (const step of steps) {
    const content =
      typeof step === "object" && step !== null ? (step as Record<string, unknown>).content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const partRecord = (
        typeof part === "object" && part !== null ? part : {}
      ) as Record<string, unknown>;
      if (partRecord.type !== "audio") continue;
      const data = partRecord.data;
      if (typeof data !== "string" || data.trim() === "") {
        throw invalidProviderResponse("gemini_speech", "MissingOutputAudio", null);
      }
      let decoded: Uint8Array;
      try {
        decoded = decodeBase64Chunked(data);
      } catch {
        throw invalidProviderResponse("gemini_speech", "InvalidPcmAudio", null);
      }
      pcmParts.push(decoded);
    }
  }
  if (pcmParts.length === 0) {
    throw invalidProviderResponse("gemini_speech", "MissingOutputAudio", null);
  }
  const pcm = new Uint8Array(pcmParts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of pcmParts) {
    pcm.set(part, offset);
    offset += part.byteLength;
  }
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_GEMINI_PCM_BYTES) {
    throw invalidProviderResponse("gemini_speech", "InvalidPcmAudio", null);
  }
  return pcm;
}

function decodeBase64Chunked(value: string): Uint8Array {
  const chunkSize = 32_768;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < value.length; index += chunkSize) {
    const decoded = Uint8Array.from(
      atob(value.slice(index, index + chunkSize)),
      (character) => character.charCodeAt(0),
    );
    total += decoded.byteLength;
    chunks.push(decoded);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function buildWavHeader(pcm: Uint8Array): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, GEMINI_PCM_SAMPLE_RATE, true);
  view.setUint32(28, GEMINI_PCM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  return header;
}

function invalidProviderResponse(
  operation: SanitizedProviderError["operation"],
  errorName: string,
  contentType: string | null,
): OpenAiError {
  return new OpenAiError({
    ...emptyProviderError(),
    operation,
    transportErrorName: errorName,
    responseContentType: sanitizeContentType(contentType),
  });
}

interface ValidatedUpload {
  bytes: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "application/pdf";
  kind: "image" | "pdf";
  title: string | null;
}

async function validateForm(form: FormData): Promise<ValidatedUpload> {
  let unexpectedField: string | null = null;
  form.forEach((_value, name) => {
    if (name !== "image" && name !== "file" && name !== "title") {
      unexpectedField = name;
    }
  });
  if (unexpectedField) {
    throw new ClientInputError(
      400,
      "unexpected_field",
      `Unexpected multipart field: ${unexpectedField}`,
    );
  }

  const imageValues = form.getAll("image");
  const fileValues = form.getAll("file");
  const uploadValues = [...imageValues, ...fileValues];
  if (uploadValues.length === 0) {
    throw new ClientInputError(400, "missing_image", "Multipart field image or file is required");
  }
  if (uploadValues.length !== 1 || typeof uploadValues[0] === "string") {
    throw new ClientInputError(
      400,
      fileValues.length === 0 ? "too_many_images" : "invalid_file_count",
      fileValues.length === 0
        ? "Exactly one image is allowed"
        : "Exactly one uploaded file is allowed",
    );
  }
  const upload = uploadValues[0];

  const titleValues = form.getAll("title");
  if (titleValues.length > 1) {
    throw new ClientInputError(400, "duplicate_title", "Only one title field is allowed");
  }
  if (titleValues.some((value) => typeof value !== "string")) {
    throw new ClientInputError(400, "invalid_title", "Title must be text");
  }
  const rawTitle = titleValues[0];
  const title = typeof rawTitle === "string" ? rawTitle.trim() || null : null;

  if (upload.size === 0) {
    throw new ClientInputError(
      400,
      imageValues.length === 1 ? "empty_image" : "empty_file",
      imageValues.length === 1 ? "Image must not be empty" : "Uploaded file must not be empty",
    );
  }
  if (upload.size > MAX_UPLOAD_BYTES) {
    throw new ClientInputError(
      413,
      imageValues.length === 1 ? "image_too_large" : "file_too_large",
      imageValues.length === 1 ? "Image exceeds 8 MiB" : "Uploaded file exceeds 8 MiB",
    );
  }
  if (title && title.length > MAX_TITLE_LENGTH) {
    throw new ClientInputError(400, "title_too_long", "Title exceeds 200 characters");
  }
  if (
    upload.type !== "image/jpeg" &&
    upload.type !== "image/png" &&
    upload.type !== "application/pdf"
  ) {
    throw new ClientInputError(
      415,
      imageValues.length === 1 ? "unsupported_image_type" : "unsupported_file_type",
      imageValues.length === 1
        ? "Only JPEG and PNG images are supported"
        : "Only JPEG, PNG, and PDF files are supported",
    );
  }

  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (upload.type === "application/pdf") {
    validatePdf(bytes);
    return { bytes, mediaType: "application/pdf", kind: "pdf", title };
  }

  const detectedType = detectImageType(bytes);
  if (!detectedType || detectedType !== upload.type) {
    throw new ClientInputError(
      415,
      "invalid_image",
      "Image bytes do not match the declared JPEG or PNG type",
    );
  }

  return { bytes, mediaType: detectedType, kind: "image", title };
}

function detectImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (isValidJpeg(bytes)) return "image/jpeg";
  if (isValidPng(bytes)) return "image/png";
  return null;
}

function validatePdf(bytes: Uint8Array): void {
  const decoder = new TextDecoder();
  const header = decoder.decode(bytes.subarray(0, 16));
  if (!/^%PDF-(?:1\.[0-9]|2\.[0-9])(?:\r|\n)/.test(header)) {
    throw new ClientInputError(
      415,
      "invalid_pdf",
      "PDF bytes do not contain a supported PDF header",
    );
  }
  const trailer = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 2_048)));
  if (!/%%EOF[\s\u0000]*$/.test(trailer)) {
    throw new ClientInputError(
      415,
      "invalid_pdf",
      "PDF bytes do not contain a valid end marker",
    );
  }
}

function isValidPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 45 || !signature.every((byte, index) => bytes[index] === byte)) {
    return false;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let chunkIndex = 0;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (!hasSaneDimensions(width, height)) return false;
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      return length === 0 && sawImageData && chunkEnd === bytes.length;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }
  return false;
}

function isValidJpeg(bytes: Uint8Array): boolean {
  if (
    bytes.length < 32 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return false;
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let hasDimensions = false;

  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xda) {
      if (!hasDimensions || offset + 2 > bytes.length) return false;
      const scanLength = (bytes[offset] << 8) | bytes[offset + 1];
      return scanLength >= 2 && offset + scanLength <= bytes.length - 2;
    }
    if (marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return false;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (!hasSaneDimensions(width, height)) return false;
      hasDimensions = true;
    }
    offset += segmentLength;
  }
  return false;
}

function hasSaneDimensions(width: number, height: number): boolean {
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

async function extractScreenplay(
  upload: ValidatedUpload,
  env: Env,
  fetchImplementation: typeof fetch,
  requestId: string,
  providerErrorLogger: typeof logProviderError,
): Promise<ScreenplayImport> {
  const timeoutMs = positiveInteger(env.OPENAI_TIMEOUT_MS, 90_000, 5_000, 90_000);
  const maxOutputTokens = positiveInteger(env.OPENAI_MAX_OUTPUT_TOKENS, 10_000, 1_000, 10_000);
  const apiKey = env.OPENAI_API_KEY!.trim();
  const keyCandidateError = getOpenAiKeyCandidateError(apiKey);
  if (keyCandidateError) {
    throw new OpenAiError({
      ...emptyProviderError(),
      operation: "configuration",
      type: "authentication_error",
      code: `invalid_api_key_${keyCandidateError}`,
      message: "Stored OpenAI key does not match the expected key format.",
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let envelope: unknown;
  let uploadedFileId: string | null = null;
  let failure: unknown;
  try {
    const model = env.OPENAI_VISION_MODEL || "gpt-5.6-sol";
    const fileContent =
      upload.kind === "pdf"
        ? {
            type: "input_file",
            file_id: (uploadedFileId = await uploadOpenAiFile(
              upload,
              "user_data",
              apiKey,
              fetchImplementation,
              controller.signal,
            )),
            detail: "high",
          }
        : upload.bytes.byteLength > MAX_INLINE_IMAGE_BYTES
          ? {
              type: "input_image",
              file_id: (uploadedFileId = await uploadOpenAiFile(
                upload,
                "vision",
                apiKey,
                fetchImplementation,
                controller.signal,
              )),
              detail: model.startsWith("gpt-5.6") ? "original" : "high",
            }
          : {
              type: "input_image",
              image_url: `data:${upload.mediaType};base64,${toBase64(upload.bytes)}`,
              detail: model.startsWith("gpt-5.6") ? "original" : "high",
            };
    const response = await fetchImplementation(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: maxOutputTokens,
        instructions: screenplayExtractionInstructions,
        ...(model.startsWith("gpt-5.6")
          ? { reasoning: { effort: "medium", context: "current_turn" } }
          : {}),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  upload.kind === "pdf"
                    ? "Transcribe the screenplay content in this PDF according to the production extraction instructions."
                    : "Transcribe the screenplay content in this image according to the production extraction instructions.",
              },
              fileContent,
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "screenplay_import",
            strict: true,
            schema: screenplayJsonSchema,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw await OpenAiError.fromResponse(response, "responses");
    envelope = await response.json();
  } catch (error) {
    failure = controller.signal.aborted
      ? new OpenAiTimeoutError()
      : error instanceof OpenAiError
        ? error
        : OpenAiError.fromTransport(error, "responses");
  } finally {
    clearTimeout(timeout);
    if (uploadedFileId) {
      try {
        await deleteOpenAiFile(uploadedFileId, apiKey, fetchImplementation);
      } catch (cleanupError) {
        if (failure) {
          if (cleanupError instanceof OpenAiError) {
            providerErrorLogger(requestId, cleanupError);
          }
        } else {
          failure = cleanupError;
        }
      }
    }
  }
  if (failure) throw failure;

  const outputText = extractOutputText(envelope);

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new ModelValidationError("model output is not JSON");
  }
  const validated = validateModelImport(parsed);
  return { title: upload.title, ...validated };
}

export function isSafeOpenAiKeyCandidate(value: string): boolean {
  return getOpenAiKeyCandidateError(value) === null;
}

export function getOpenAiKeyCandidateError(value: string): string | null {
  if (!value.startsWith("sk-")) return "prefix";
  if (value.length < 20 || value.length > 512) return "length";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x20 || codePoint === 0x7f) return "whitespace_or_control";
    if (character === '"' || character === "'") return "quote";
    if (codePoint > 0x7e) return "non_ascii";
  }
  return null;
}

async function uploadOpenAiFile(
  upload: ValidatedUpload,
  purpose: "vision" | "user_data",
  apiKey: string,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.set("purpose", purpose);
  form.set("expires_after[anchor]", "created_at");
  form.set("expires_after[seconds]", String(FILE_EXPIRATION_SECONDS));
  const extension =
    upload.mediaType === "image/png"
      ? "png"
      : upload.mediaType === "application/pdf"
        ? "pdf"
        : "jpg";
  form.set(
    "file",
    new File([upload.bytes.slice().buffer], `screenplay.${extension}`, {
      type: upload.mediaType,
    }),
  );

  let response: Response;
  try {
    response = await fetchImplementation(OPENAI_FILES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch (error) {
    throw OpenAiError.fromTransport(error, "files.create");
  }
  if (!response.ok) throw await OpenAiError.fromResponse(response, "files.create");

  const value: unknown = await response.json();
  const id =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).id
      : null;
  if (typeof id !== "string" || !/^file-[A-Za-z0-9_-]+$/.test(id)) {
    throw new OpenAiError({
      ...emptyProviderError(),
      operation: "files.create",
      transportErrorName: "InvalidResponse",
      transportMessage: "OpenAI file upload returned an invalid identifier.",
    });
  }
  return id;
}

async function deleteOpenAiFile(
  fileId: string,
  apiKey: string,
  fetchImplementation: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImplementation(`${OPENAI_FILES_URL}/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok && response.status !== 404) {
      throw await OpenAiError.fromResponse(response, "files.delete");
    }
  } catch (error) {
    if (error instanceof OpenAiError) throw error;
    throw OpenAiError.fromTransport(error, "files.delete");
  } finally {
    clearTimeout(timeout);
  }
}

function extractOutputText(value: unknown): string {
  if (typeof value !== "object" || value === null) throw new OpenAiError();
  const envelope = value as Record<string, unknown>;
  if (envelope.status !== "completed" || !Array.isArray(envelope.output)) {
    throw new OpenAiError();
  }

  const texts: string[] = [];
  for (const output of envelope.output) {
    if (typeof output !== "object" || output === null) continue;
    const content = (output as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const record = part as Record<string, unknown>;
      if (record.type === "refusal") throw new OpenAiError();
      if (record.type === "output_text" && typeof record.text === "string") {
        texts.push(record.text);
      }
    }
  }
  if (texts.length !== 1 || texts[0].trim().length === 0) {
    throw new ModelValidationError("model returned no single output");
  }
  return texts[0];
}

async function readBodyWithLimit(request: Request, limit: number): Promise<ArrayBuffer> {
  return readStreamWithLimit(request.body, limit);
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<ArrayBuffer> {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }

  const buffer = new ArrayBuffer(total);
  const body = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function resolveCors(
  request: Request,
  env: Env,
): { allowed: boolean; headers: Record<string, string> } {
  const origin = request.headers.get("origin");
  if (!origin) return { allowed: true, headers: {} };

  const allowedOrigins = new Set(
    (env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((candidate) => candidate.trim())
      .filter(Boolean),
  );
  if (!allowedOrigins.has(origin)) return { allowed: false, headers: {} };

  return {
    allowed: true,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers":
        "X-Request-Id, X-OCR-Model, X-Speech-Model, X-Speech-Voice",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  };
}

function withCors(
  response: Response,
  cors: { allowed: boolean; headers: Record<string, string> },
): Response {
  if (!cors.allowed || Object.keys(cors.headers).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors.headers)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    status,
    { error: { code, message, requestId } },
    {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
      ...headers,
    },
  );
}

function jsonResponse(status: number, value: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

class ClientInputError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class RequestTooLargeError extends Error {}

interface SanitizedProviderError {
  operation:
    | "configuration"
    | "responses"
    | "speech"
    | "gemini_speech"
    | "gemini_stage_tags"
    | "files.create"
    | "files.delete";
  status: number | null;
  requestId: string | null;
  type: string | null;
  code: string | null;
  message: string | null;
  transportErrorName: string | null;
  transportMessage: string | null;
  responseContentType: string | null;
  responseBodyBytes: number | null;
  responseBodyFormat:
    | "empty"
    | "json_error"
    | "json_other"
    | "invalid_json"
    | "read_error"
    | "too_large"
    | null;
}

export class OpenAiError extends Error {
  constructor(readonly provider: SanitizedProviderError = emptyProviderError()) {
    super("OpenAI request failed");
    this.name = "OpenAiError";
  }

  static async fromResponse(
    response: Response,
    operation: SanitizedProviderError["operation"],
  ): Promise<OpenAiError> {
    const provider: SanitizedProviderError = {
      operation,
      status: response.status,
      requestId: sanitizeIdentifier(response.headers.get("x-request-id"), 128),
      type: null,
      code: null,
      message: null,
      transportErrorName: null,
      transportMessage: null,
      responseContentType: sanitizeContentType(response.headers.get("content-type")),
      responseBodyBytes: null,
      responseBodyFormat: null,
    };

    try {
      const bodyResult = await readProviderErrorBody(response);
      provider.responseBodyBytes = bodyResult.bytes;
      provider.responseBodyFormat = bodyResult.format;
      if (bodyResult.value) {
        const error = asProviderErrorRecord(bodyResult.value);
        provider.type = sanitizeIdentifier(error?.type, 64);
        provider.code = sanitizeIdentifier(error?.code, 64);
        provider.message = sanitizeProviderMessage(error?.message);
      }
    } catch {
      provider.responseBodyFormat = "read_error";
    }
    return new OpenAiError(provider);
  }

  static fromTransport(
    error: unknown,
    operation: SanitizedProviderError["operation"],
  ): OpenAiError {
    const record =
      typeof error === "object" && error !== null
        ? (error as { name?: unknown; message?: unknown })
        : {};
    return new OpenAiError({
      ...emptyProviderError(),
      operation,
      transportErrorName: sanitizeIdentifier(record.name, 64),
      transportMessage: sanitizeProviderMessage(record.message),
    });
  }
}

function emptyProviderError(): SanitizedProviderError {
  return {
    operation: "responses",
    status: null,
    requestId: null,
    type: null,
    code: null,
    message: null,
    transportErrorName: null,
    transportMessage: null,
    responseContentType: null,
    responseBodyBytes: null,
    responseBodyFormat: null,
  };
}

interface ProviderErrorBodyResult {
  value: unknown;
  bytes: number;
  format: NonNullable<SanitizedProviderError["responseBodyFormat"]>;
}

async function readProviderErrorBody(response: Response): Promise<ProviderErrorBodyResult> {
  if (!response.body) return { value: null, bytes: 0, format: "empty" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_ERROR_BYTES) {
      await reader.cancel();
      return { value: null, bytes: total, format: "too_large" };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    const value: unknown = JSON.parse(text);
    return {
      value,
      bytes: total,
      format: asProviderErrorRecord(value) ? "json_error" : "json_other",
    };
  } catch {
    return {
      value: null,
      bytes: total,
      format: text.trim() ? "invalid_json" : "empty",
    };
  }
}

function sanitizeContentType(value: string | null): string | null {
  if (!value) return null;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType) ? mediaType : null;
}

function asProviderErrorRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "object" && error !== null && !Array.isArray(error)
    ? (error as Record<string, unknown>)
    : null;
}

function sanitizeIdentifier(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) return null;
  return value.slice(0, maximumLength);
}

function sanitizeProviderMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 300) : null;
}

function logProviderError(requestId: string, error: OpenAiError): void {
  console.error("OpenAI request failed", {
    requestId,
    providerOperation: error.provider.operation,
    providerStatus: error.provider.status,
    providerRequestId: error.provider.requestId,
    providerErrorType: error.provider.type,
    providerErrorCode: error.provider.code,
    transportErrorName: error.provider.transportErrorName,
    responseContentType: error.provider.responseContentType,
    responseBodyBytes: error.provider.responseBodyBytes,
    responseBodyFormat: error.provider.responseBodyFormat,
  });
}

function classifyOpenAiError(
  error: OpenAiError,
  service: "vision" | "speech" = "vision",
): { code: string; message: string } {
  const label = service === "speech" ? "Speech" : "Vision";
  const code = error.provider.code?.toLowerCase();
  const type = error.provider.type?.toLowerCase();
  if (error.provider.status === 401 || type === "authentication_error") {
    return {
      code: "provider_auth_error",
      message: `${label} provider authentication failed`,
    };
  }
  if (
    error.provider.status === 429 &&
    (code === "insufficient_quota" || type === "insufficient_quota")
  ) {
    return {
      code: "provider_quota_exceeded",
      message: `${label} provider quota is unavailable`,
    };
  }
  if (code === "model_not_found" || code === "model_not_available") {
    return {
      code: "provider_model_unavailable",
      message: `Configured ${service} model is unavailable`,
    };
  }
  return { code: "upstream_error", message: `${label} processing failed` };
}

class OpenAiTimeoutError extends Error {}
