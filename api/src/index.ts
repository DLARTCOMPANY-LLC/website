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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_TTS_REQUEST_BYTES = 16 * 1024;
const MAX_TTS_INPUT_LENGTH = 4_096;
const TTS_REQUEST_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_TTS_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const RATE_LIMITER_INSTANCE = "screenplay-import-global-v1";
const RATE_LIMITER_URL = "https://rate-limiter.internal/check";
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const OPENAI_FILES_URL = "https://api.openai.com/v1/files";
const FILE_EXPIRATION_SECONDS = 3_600;

export interface Env {
  OPENAI_API_KEY?: string;
  RATE_LIMITER?: DurableObjectNamespace;
  OPENAI_VISION_MODEL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  RATE_LIMIT_REQUESTS?: string;
  GLOBAL_RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  MAX_CONCURRENT_REQUESTS?: string;
  OPENAI_TIMEOUT_MS?: string;
  OPENAI_MAX_OUTPUT_TOKENS?: string;
  OPENAI_TTS_MODEL?: string;
  OPENAI_TTS_VOICE?: string;
  OPENAI_TTS_FORMAT?: string;
  OPENAI_TTS_TIMEOUT_MS?: string;
  OPENAI_TTS_MAX_OUTPUT_BYTES?: string;
  MAX_CONCURRENT_TTS_REQUESTS?: string;
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
let activeTtsRequests = 0;

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
  const endpoint =
    pathname === "/v1/screenplays/import"
      ? "screenplay-import"
      : pathname === "/v1/tts/speech"
        ? "tts"
        : null;

  if (request.method === "OPTIONS") {
    return cors.allowed
      ? new Response(null, { status: 204, headers: cors.headers })
      : errorResponse(403, "origin_not_allowed", "Origin is not allowed", requestId);
  }
  if (!endpoint) {
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
  if (!env.OPENAI_API_KEY?.trim()) {
    return withCors(
      errorResponse(
        503,
        "service_not_configured",
        endpoint === "tts"
          ? "Text-to-speech is not configured"
          : "Screenplay import is not configured",
        requestId,
      ),
      cors,
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  const expectedContentType =
    endpoint === "tts" ? "application/json" : "multipart/form-data";
  const hasExpectedContentType =
    endpoint === "tts"
      ? contentType.split(";", 1)[0].trim().toLowerCase() === expectedContentType
      : contentType.toLowerCase().startsWith(`${expectedContentType};`);
  if (!hasExpectedContentType) {
    return withCors(
      errorResponse(
        415,
        "unsupported_content_type",
        `Content-Type must be ${expectedContentType}`,
        requestId,
      ),
      cors,
    );
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  const maxRequestBytes =
    endpoint === "tts" ? MAX_TTS_REQUEST_BYTES : MAX_REQUEST_BYTES;
  if (contentLength !== null && contentLength > maxRequestBytes) {
    return withCors(
      errorResponse(
        413,
        "request_too_large",
        endpoint === "tts"
          ? "Request body exceeds 16 KiB"
          : "Request body exceeds 10 MiB",
        requestId,
      ),
      cors,
    );
  }

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
    );
  } catch {
    return withCors(
      errorResponse(
        503,
        "rate_limit_unavailable",
        endpoint === "tts"
          ? "Text-to-speech rate limiting is unavailable"
          : "Screenplay import rate limiting is unavailable",
        requestId,
        { "Retry-After": "30" },
      ),
      cors,
    );
  }
  if (!rateDecision.allowed) {
    return withCors(
      errorResponse(
        429,
        "rate_limited",
        endpoint === "tts" ? "Too many text-to-speech requests" : "Too many screenplay imports",
        requestId,
        {
          "Retry-After": String(rateDecision.retryAfterSeconds),
        },
      ),
      cors,
    );
  }

  let speechInput: SpeechInput | null = null;
  if (endpoint === "tts") {
    try {
      speechInput = await parseSpeechInput(request, env);
    } catch (error) {
      return speechInputErrorResponse(error, requestId, cors);
    }
  }

  const concurrencyLimit = positiveInteger(env.MAX_CONCURRENT_REQUESTS, 4, 1, 32);
  const ttsConcurrencyLimit = positiveInteger(env.MAX_CONCURRENT_TTS_REQUESTS, 2, 1, 4);
  if (
    activeOpenAiRequests >= concurrencyLimit ||
    (endpoint === "tts" && activeTtsRequests >= ttsConcurrencyLimit)
  ) {
    return withCors(
      errorResponse(
        503,
        "capacity_exceeded",
        endpoint === "tts"
          ? "Text-to-speech is temporarily busy"
          : "Screenplay import is temporarily busy",
        requestId,
        {
          "Retry-After": "5",
        },
      ),
      cors,
    );
  }

  activeOpenAiRequests += 1;
  if (endpoint === "tts") activeTtsRequests += 1;
  try {
    return endpoint === "tts"
      ? await processSpeech(
          speechInput!,
          env,
          requestId,
          cors,
          fetchImplementation,
          providerErrorLogger,
        )
      : await processImport(
          request,
          env,
          contentType,
          requestId,
          cors,
          fetchImplementation,
          providerErrorLogger,
        );
  } finally {
    activeOpenAiRequests -= 1;
    if (endpoint === "tts") activeTtsRequests -= 1;
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
    nextGlobal.count >= globalLimit ? nextGlobal.resetAt : now,
    nextClient.count >= clientLimit ? nextClient.resetAt : now,
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
    globalWindow: { ...nextGlobal, count: nextGlobal.count + 1 },
    clientWindow: { ...nextClient, count: nextClient.count + 1 },
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
    if (!clientKey || !/^[a-f0-9]{64}$/.test(clientKey) || !clientLimit || !globalLimit || !windowMs) {
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

const TTS_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "cedar",
]);
const TTS_FORMAT_CONTENT_TYPES = {
  mp3: { response: "audio/mpeg", accepted: ["audio/mpeg", "audio/mp3"] },
  opus: { response: "audio/ogg", accepted: ["audio/ogg", "audio/opus"] },
  aac: { response: "audio/aac", accepted: ["audio/aac", "audio/mp4"] },
  flac: { response: "audio/flac", accepted: ["audio/flac", "audio/x-flac"] },
  wav: { response: "audio/wav", accepted: ["audio/wav", "audio/x-wav"] },
  pcm: {
    response: "application/octet-stream",
    accepted: ["application/octet-stream", "audio/pcm", "audio/l16"],
  },
} as const;

type TtsFormat = keyof typeof TTS_FORMAT_CONTENT_TYPES;

interface SpeechInput {
  input: string;
  model: string;
  voice: string;
  format: TtsFormat;
}

async function processSpeech(
  speechInput: SpeechInput,
  env: Env,
  requestId: string,
  cors: ReturnType<typeof resolveCors>,
  fetchImplementation: typeof fetch,
  providerErrorLogger: typeof logProviderError,
): Promise<Response> {
  try {
    const result = await synthesizeSpeech(speechInput, env, fetchImplementation);
    return withCors(
      new Response(result.audio, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="speech.${speechInput.format}"`,
          "Content-Length": String(result.audio.byteLength),
          "Content-Type": TTS_FORMAT_CONTENT_TYPES[speechInput.format].response,
          "X-Content-Type-Options": "nosniff",
          "X-Request-Id": requestId,
          "X-TTS-Format": speechInput.format,
          "X-TTS-Model": result.model,
          "X-TTS-Provider": "openai",
          "X-TTS-Voice": speechInput.voice,
        },
      }),
      cors,
    );
  } catch (error) {
    if (error instanceof OpenAiTimeoutError) {
      return withCors(
        errorResponse(504, "upstream_timeout", "Speech generation timed out", requestId),
        cors,
      );
    }
    if (error instanceof ProviderResponseTooLargeError) {
      return withCors(
        errorResponse(
          502,
          "upstream_response_too_large",
          "Speech provider returned too much audio",
          requestId,
        ),
        cors,
      );
    }
    if (error instanceof OpenAiError) {
      providerErrorLogger(requestId, error);
      const publicError = classifyOpenAiError(error, "speech");
      return withCors(
        errorResponse(502, publicError.code, publicError.message, requestId),
        cors,
      );
    }
    return withCors(
      errorResponse(500, "internal_error", "Speech generation failed", requestId),
      cors,
    );
  }
}

function speechInputErrorResponse(
  error: unknown,
  requestId: string,
  cors: ReturnType<typeof resolveCors>,
): Response {
  if (error instanceof RequestTooLargeError) {
    return withCors(
      errorResponse(413, "request_too_large", "Request body exceeds 16 KiB", requestId),
      cors,
    );
  }
  if (error instanceof RequestBodyTimeoutError) {
    return withCors(
      errorResponse(408, "request_timeout", "Request body was not received in time", requestId),
      cors,
    );
  }
  if (error instanceof ClientInputError) {
    return withCors(errorResponse(error.status, error.code, error.message, requestId), cors);
  }
  if (error instanceof ServiceConfigurationError) {
    return withCors(
      errorResponse(503, "service_not_configured", error.message, requestId),
      cors,
    );
  }
  return withCors(
    errorResponse(500, "internal_error", "Text-to-speech request failed", requestId),
    cors,
  );
}

async function parseSpeechInput(request: Request, env: Env): Promise<SpeechInput> {
  const body = await readBodyWithLimit(
    request,
    MAX_TTS_REQUEST_BYTES,
    TTS_REQUEST_BODY_TIMEOUT_MS,
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ClientInputError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClientInputError(400, "invalid_request", "Request body must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  const unexpectedField = Object.keys(record).find(
    (field) => field !== "input" && field !== "voice" && field !== "format",
  );
  if (unexpectedField) {
    throw new ClientInputError(400, "unexpected_field", `Unexpected JSON field: ${unexpectedField}`);
  }
  if (typeof record.input !== "string") {
    throw new ClientInputError(400, "invalid_input", "input must be a string");
  }
  if (record.input.trim().length === 0) {
    throw new ClientInputError(400, "empty_input", "input must not be empty");
  }
  if (record.input.length > MAX_TTS_INPUT_LENGTH) {
    throw new ClientInputError(
      400,
      "input_too_long",
      "input exceeds 4096 characters",
    );
  }

  const model = (env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts").trim();
  if (!model || model.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new ServiceConfigurationError("Configured text-to-speech model is invalid");
  }
  const configuredVoice = (env.OPENAI_TTS_VOICE || "alloy").trim();
  if (!TTS_VOICES.has(configuredVoice)) {
    throw new ServiceConfigurationError("Configured text-to-speech voice is invalid");
  }
  const voice = record.voice === undefined ? configuredVoice : record.voice;
  if (typeof voice !== "string" || !TTS_VOICES.has(voice)) {
    throw new ClientInputError(400, "invalid_voice", "voice is not supported");
  }

  const configuredFormat = (env.OPENAI_TTS_FORMAT || "mp3").trim();
  if (!isTtsFormat(configuredFormat)) {
    throw new ServiceConfigurationError("Configured text-to-speech format is invalid");
  }
  const format = record.format === undefined ? configuredFormat : record.format;
  if (typeof format !== "string" || !isTtsFormat(format)) {
    throw new ClientInputError(400, "invalid_format", "format is not supported");
  }

  return { input: record.input, model, voice, format };
}

function isTtsFormat(value: string): value is TtsFormat {
  return Object.hasOwn(TTS_FORMAT_CONTENT_TYPES, value);
}

async function synthesizeSpeech(
  input: SpeechInput,
  env: Env,
  fetchImplementation: typeof fetch,
): Promise<{ audio: ArrayBuffer; model: string }> {
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

  const timeoutMs = positiveInteger(env.OPENAI_TTS_TIMEOUT_MS, 30_000, 1_000, 90_000);
  const maxOutputBytes = positiveInteger(
    env.OPENAI_TTS_MAX_OUTPUT_BYTES,
    DEFAULT_TTS_MAX_OUTPUT_BYTES,
    1_024,
    DEFAULT_TTS_MAX_OUTPUT_BYTES,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImplementation(OPENAI_SPEECH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          input: input.input,
          voice: input.voice,
          response_format: input.format,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw controller.signal.aborted
        ? new OpenAiTimeoutError()
        : OpenAiError.fromTransport(error, "audio.speech");
    }
    if (!response.ok) throw await OpenAiError.fromResponse(response, "audio.speech");

    const providerContentType = sanitizeContentType(response.headers.get("content-type"));
    const acceptedContentTypes = TTS_FORMAT_CONTENT_TYPES[input.format].accepted as readonly string[];
    if (!providerContentType || !acceptedContentTypes.includes(providerContentType)) {
      throw new OpenAiError({
        ...emptyProviderError(),
        operation: "audio.speech",
        transportErrorName: "InvalidResponse",
        transportMessage: "OpenAI speech response used an unexpected content type.",
        responseContentType: providerContentType,
      });
    }

    const contentLength = parseContentLength(response.headers.get("content-length"));
    if (contentLength !== null && contentLength > maxOutputBytes) {
      await response.body?.cancel();
      throw new ProviderResponseTooLargeError();
    }
    return {
      audio: await readResponseBodyWithLimit(response, maxOutputBytes),
      model: input.model,
    };
  } catch (error) {
    throw controller.signal.aborted ? new OpenAiTimeoutError() : error;
  } finally {
    clearTimeout(timeout);
  }
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

interface ValidatedUpload {
  bytes: Uint8Array;
  mediaType: "image/jpeg" | "image/png";
  title: string | null;
}

async function validateForm(form: FormData): Promise<ValidatedUpload> {
  let unexpectedField: string | null = null;
  form.forEach((_value, name) => {
    if (name !== "image" && name !== "title") unexpectedField = name;
  });
  if (unexpectedField) {
    throw new ClientInputError(
      400,
      "unexpected_field",
      `Unexpected multipart field: ${unexpectedField}`,
    );
  }

  const imageValues = form.getAll("image");
  if (imageValues.length === 0) {
    throw new ClientInputError(400, "missing_image", "Multipart field image is required");
  }
  if (imageValues.length !== 1 || typeof imageValues[0] === "string") {
    throw new ClientInputError(400, "too_many_images", "Exactly one image is allowed");
  }
  const image = imageValues[0];

  const titleValues = form.getAll("title");
  if (titleValues.length > 1) {
    throw new ClientInputError(400, "duplicate_title", "Only one title field is allowed");
  }
  if (titleValues.some((value) => typeof value !== "string")) {
    throw new ClientInputError(400, "invalid_title", "Title must be text");
  }
  const rawTitle = titleValues[0];
  const title = typeof rawTitle === "string" ? rawTitle.trim() || null : null;

  if (image.size === 0) throw new ClientInputError(400, "empty_image", "Image must not be empty");
  if (image.size > MAX_IMAGE_BYTES) {
    throw new ClientInputError(413, "image_too_large", "Image exceeds 8 MiB");
  }
  if (title && title.length > MAX_TITLE_LENGTH) {
    throw new ClientInputError(400, "title_too_long", "Title exceeds 200 characters");
  }
  if (image.type !== "image/jpeg" && image.type !== "image/png") {
    throw new ClientInputError(
      415,
      "unsupported_image_type",
      "Only JPEG and PNG images are supported",
    );
  }

  const bytes = new Uint8Array(await image.arrayBuffer());
  const detectedType = detectImageType(bytes);
  if (!detectedType || detectedType !== image.type) {
    throw new ClientInputError(
      415,
      "invalid_image",
      "Image bytes do not match the declared JPEG or PNG type",
    );
  }

  return { bytes, mediaType: detectedType, title };
}

function detectImageType(bytes: Uint8Array): ValidatedUpload["mediaType"] | null {
  if (isValidJpeg(bytes)) return "image/jpeg";
  if (isValidPng(bytes)) return "image/png";
  return null;
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
    const imageContent =
      upload.bytes.byteLength > MAX_INLINE_IMAGE_BYTES
        ? {
            type: "input_image",
            file_id: (uploadedFileId = await uploadVisionFile(
              upload,
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
                text: "Transcribe the screenplay content in this image according to the production extraction instructions.",
              },
              imageContent,
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
        await deleteVisionFile(uploadedFileId, apiKey, fetchImplementation);
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

async function uploadVisionFile(
  upload: ValidatedUpload,
  apiKey: string,
  fetchImplementation: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.set("purpose", "vision");
  form.set("expires_after[anchor]", "created_at");
  form.set("expires_after[seconds]", String(FILE_EXPIRATION_SECONDS));
  const extension = upload.mediaType === "image/png" ? "png" : "jpg";
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

async function deleteVisionFile(
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

async function readBodyWithLimit(
  request: Request,
  limit: number,
  timeoutMs?: number,
): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void reader.cancel().catch(() => undefined);
        }, timeoutMs);

  try {
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
  } catch (error) {
    if (timedOut) throw new RequestBodyTimeoutError();
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (timedOut) throw new RequestBodyTimeoutError();

  const buffer = new ArrayBuffer(total);
  const body = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

async function readResponseBodyWithLimit(
  response: Response,
  limit: number,
): Promise<ArrayBuffer> {
  if (!response.body) {
    throw new OpenAiError({
      ...emptyProviderError(),
      operation: "audio.speech",
      transportErrorName: "InvalidResponse",
      transportMessage: "OpenAI speech response did not contain audio.",
    });
  }
  const reader = response.body.getReader();
  const storage = new Uint8Array(limit);
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const nextTotal = total + value.byteLength;
    if (nextTotal > limit) {
      await reader.cancel();
      throw new ProviderResponseTooLargeError();
    }
    storage.set(value, total);
    total = nextTotal;
  }
  if (total === 0) {
    throw new OpenAiError({
      ...emptyProviderError(),
      operation: "audio.speech",
      transportErrorName: "InvalidResponse",
      transportMessage: "OpenAI speech response contained no audio bytes.",
    });
  }

  return storage.buffer.slice(0, total);
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
class RequestBodyTimeoutError extends Error {}
class ProviderResponseTooLargeError extends Error {}
class ServiceConfigurationError extends Error {}

interface SanitizedProviderError {
  operation:
    | "configuration"
    | "responses"
    | "audio.speech"
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
  capability: "vision" | "speech" = "vision",
): { code: string; message: string } {
  const providerLabel = capability === "speech" ? "Speech" : "Vision";
  const code = error.provider.code?.toLowerCase();
  const type = error.provider.type?.toLowerCase();
  if (error.provider.status === 401 || type === "authentication_error") {
    return {
      code: "provider_auth_error",
      message: `${providerLabel} provider authentication failed`,
    };
  }
  if (
    error.provider.status === 429 &&
    (code === "insufficient_quota" || type === "insufficient_quota")
  ) {
    return {
      code: "provider_quota_exceeded",
      message: `${providerLabel} provider quota is unavailable`,
    };
  }
  if (code === "model_not_found" || code === "model_not_available") {
    return {
      code: "provider_model_unavailable",
      message: `Configured ${capability} model is unavailable`,
    };
  }
  return {
    code: "upstream_error",
    message: capability === "speech" ? "Speech generation failed" : "Vision processing failed",
  };
}

class OpenAiTimeoutError extends Error {}
