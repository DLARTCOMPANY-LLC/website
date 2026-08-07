import {
  ModelValidationError,
  screenplayJsonSchema,
  validateModelImport,
  type ScreenplayImport,
} from "./schema";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_RATE_LIMIT_KEYS = 10_000;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface Env {
  OPENAI_API_KEY?: string;
  OPENAI_VISION_MODEL?: string;
  CORS_ALLOWED_ORIGINS?: string;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  MAX_CONCURRENT_REQUESTS?: string;
  OPENAI_TIMEOUT_MS?: string;
  OPENAI_MAX_OUTPUT_TOKENS?: string;
}

interface HandlerDependencies {
  fetch: typeof fetch;
  limiter: FixedWindowRateLimiter;
  now: () => number;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateEntry>();

  constructor(private readonly maxKeys = MAX_RATE_LIMIT_KEYS) {}

  take(key: string, limit: number, windowMs: number, now: number): RateEntry | null {
    const current = this.entries.get(key);
    if (current && current.resetAt > now) {
      if (current.count >= limit) return null;
      current.count += 1;
      return current;
    }

    if (!current && this.entries.size >= this.maxKeys) {
      this.removeExpired(now);
      if (this.entries.size >= this.maxKeys) return null;
    }

    const next = { count: 1, resetAt: now + windowMs };
    this.entries.set(key, next);
    return next;
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

const limiter = new FixedWindowRateLimiter();
let activeOpenAiRequests = 0;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

export async function handleRequest(
  request: Request,
  env: Env,
  dependencies: HandlerDependencies = {
    fetch,
    limiter,
    now: Date.now,
  },
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const cors = resolveCors(request, env);
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");

  if (request.method === "OPTIONS") {
    return cors.allowed
      ? new Response(null, { status: 204, headers: cors.headers })
      : errorResponse(403, "origin_not_allowed", "Origin is not allowed", requestId);
  }
  if (pathname !== "/v1/screenplays/import") {
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
  if (!env.OPENAI_API_KEY) {
    return withCors(
      errorResponse(503, "service_not_configured", "Screenplay import is not configured", requestId),
      cors,
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return withCors(
      errorResponse(
        415,
        "unsupported_content_type",
        "Content-Type must be multipart/form-data",
        requestId,
      ),
      cors,
    );
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_REQUEST_BYTES) {
    return withCors(
      errorResponse(413, "request_too_large", "Request body exceeds 10 MiB", requestId),
      cors,
    );
  }

  const rateLimit = positiveInteger(env.RATE_LIMIT_REQUESTS, 10, 1, 60);
  const windowSeconds = positiveInteger(env.RATE_LIMIT_WINDOW_SECONDS, 60, 1, 3_600);
  const now = dependencies.now();
  const rateEntry = dependencies.limiter.take(
    request.headers.get("cf-connecting-ip") ?? "unknown",
    rateLimit,
    windowSeconds * 1_000,
    now,
  );
  if (!rateEntry) {
    return withCors(
      errorResponse(429, "rate_limited", "Too many screenplay imports", requestId, {
        "Retry-After": String(windowSeconds),
      }),
      cors,
    );
  }

  const concurrencyLimit = positiveInteger(env.MAX_CONCURRENT_REQUESTS, 4, 1, 32);
  if (activeOpenAiRequests >= concurrencyLimit) {
    return withCors(
      errorResponse(503, "capacity_exceeded", "Screenplay import is temporarily busy", requestId, {
        "Retry-After": "5",
      }),
      cors,
    );
  }

  activeOpenAiRequests += 1;
  try {
    return await processImport(
      request,
      env,
      contentType,
      requestId,
      cors,
      dependencies.fetch,
    );
  } finally {
    activeOpenAiRequests -= 1;
  }
}

async function processImport(
  request: Request,
  env: Env,
  contentType: string,
  requestId: string,
  cors: ReturnType<typeof resolveCors>,
  fetchImplementation: typeof fetch,
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
    const result = await extractScreenplay(upload, env, fetchImplementation);
    return withCors(
      jsonResponse(200, result, {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
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
      return withCors(
        errorResponse(502, "upstream_error", "Vision processing failed", requestId),
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
): Promise<ScreenplayImport> {
  const timeoutMs = positiveInteger(env.OPENAI_TIMEOUT_MS, 45_000, 5_000, 90_000);
  const maxOutputTokens = positiveInteger(env.OPENAI_MAX_OUTPUT_TOKENS, 6_000, 1_000, 10_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let envelope: unknown;
  try {
    const response = await fetchImplementation(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
        store: false,
        max_output_tokens: maxOutputTokens,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Transcribe this screenplay image without inventing, correcting, summarizing, or omitting visible content.",
                  "Return character names in order of first spoken appearance.",
                  "Return every visible screenplay unit in reading order. Combine each speaker's parenthetical and dialogue into one item, preserving all text verbatim and preserving line breaks.",
                  "For spoken dialogue, set speaker to the visible character cue and isStageDirection to false.",
                  "For headings, action, transitions, and labels such as Role, START, and END, set speaker to null and isStageDirection to true. Never list those labels as characters.",
                  "Use confidence and warnings to identify uncertain or illegible text. Do not guess missing words.",
                ].join("\n"),
              },
              {
                type: "input_image",
                image_url: `data:${upload.mediaType};base64,${toBase64(upload.bytes)}`,
                detail: "high",
              },
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
    if (!response.ok) throw new OpenAiError();
    envelope = await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new OpenAiTimeoutError();
    throw new OpenAiError();
  } finally {
    clearTimeout(timeout);
  }

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
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
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
class OpenAiError extends Error {}
class OpenAiTimeoutError extends Error {}
