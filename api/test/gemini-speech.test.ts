import { describe, expect, it, vi } from "vitest";
import {
  evaluateRateWindows,
  handleRequest,
  type Env,
  type OpenAiError,
  type RateWindow,
} from "../src/index";

// A small deterministic 16-bit PCM payload (4 little-endian samples).
const PCM = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00]);

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const TAGS = ["whispers", "tension", "sadness", "surprise", "relief"];
const GEMINI_TTS_URL = `${GEMINI_BASE}/v1beta/interactions`;
const GEMINI_LLM_URL = `${GEMINI_BASE}/v1beta/models/gemini-3.1-flash:generateContent`;

const openAiEnv: Env = {
  OPENAI_API_KEY: " sk-proj-1234567890abcdefghijklmnop\r\n",
  RATE_LIMIT_REQUESTS: "10",
};

const geminiEnv: Env = {
  ...openAiEnv,
  GEMINI_API_KEY: "AIza-synthesis-test-key",
  GEMINI_SPEECH_ENABLED: "true",
  GEMINI_SPEECH_MODEL: "gemini-3.1-flash-tts-preview",
  GEMINI_LLM_MODEL: "gemini-3.1-flash",
  GEMINI_BASE_URL: GEMINI_BASE,
  GEMINI_SPEECH_TIMEOUT_MS: "30000",
};

interface LlmBehavior {
  /** Valid tags to return as parts[0].text when no explicit text is given. */
  tags?: string[];
  /** Raw parts[0].text override (use for non-JSON / invalid output). */
  text?: string;
  /** Non-OK HTTP status. */
  status?: number;
  /** Error envelope body for the non-OK case. */
  json?: unknown;
  /** Transport failure. */
  throw?: Error;
}

interface TtsBehavior {
  /** Non-OK HTTP status. */
  status?: number;
  /** JSON body (default is the valid audio payload). */
  json?: unknown;
  /** Raw string body (for malformed-JSON cases). */
  raw?: string;
  /** Transport failure. */
  throw?: Error;
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function validTtsBody(): unknown {
  return { interaction: { output_audio: { data: b64encode(PCM) } } };
}

/**
 * Routes to the Gemini LLM (stage-note -> tags) or TTS (interactions) endpoint
 * by URL. Records every call so tests can assert request order and bodies.
 */
function geminiFetch(options: { llm?: LlmBehavior; tts?: TtsBehavior }): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(":generateContent")) {
      const llm = options.llm ?? {};
      if (llm.throw) throw llm.throw;
      if (llm.status && llm.status !== 200) {
        return Response.json(llm.json ?? geminiError(llm.status), { status: llm.status });
      }
      const text =
        llm.text !== undefined ? llm.text : JSON.stringify({ tags: llm.tags ?? [] });
      return Response.json({
        candidates: [{ content: { parts: [{ text }] } }],
      });
    }
    const tts = options.tts ?? {};
    if (tts.throw) throw tts.throw;
    if (tts.raw !== undefined) {
      return new Response(tts.raw, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (tts.status && tts.status !== 200) {
      return Response.json(tts.json ?? geminiError(tts.status), { status: tts.status });
    }
    return Response.json(tts.json ?? validTtsBody());
  });
}

function geminiError(status: number): unknown {
  return { error: { code: status, message: "provider detail", status: "INTERNAL" } };
}

function speechRequest(body: unknown, origin?: string): Request {
  const headers = new Headers({
    "CF-Connecting-IP": "203.0.113.10",
    "Content-Type": "application/json",
  });
  if (origin) headers.set("Origin", origin);
  return new Request("https://api.example.com/v1/audio/speech", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function deps(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: {
    takeRateLimit?: (
      env: Env,
      clientAddress: string,
      clientLimit: number,
      globalLimit: number,
      windowSeconds: number,
    ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
    logProviderError?: (requestId: string, error: OpenAiError) => void;
  } = {},
) {
  return {
    fetch: fetchMock as typeof fetch,
    takeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    logProviderError: vi.fn(),
    ...overrides,
  };
}

function parseWav(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const ascii = (offset: number, length: number) => {
    let out = "";
    for (let index = 0; index < length; index += 1) {
      out += String.fromCharCode(bytes[offset + index]);
    }
    return out;
  };
  return {
    riff: ascii(0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    pcm: bytes.subarray(44),
  };
}

async function expectValidWav(response: Response, expectedPcm: Uint8Array): Promise<void> {
  expect(response.headers.get("content-type")).toBe("audio/wav");
  const buffer = await response.arrayBuffer();
  const wav = parseWav(buffer);
  expect(wav.riff).toBe("RIFF");
  expect(wav.riffSize).toBe(36 + expectedPcm.byteLength);
  expect(wav.wave).toBe("WAVE");
  expect(wav.fmt).toBe("fmt ");
  expect(wav.fmtSize).toBe(16);
  expect(wav.audioFormat).toBe(1);
  expect(wav.channels).toBe(1);
  expect(wav.sampleRate).toBe(24_000);
  expect(wav.byteRate).toBe(48_000);
  expect(wav.blockAlign).toBe(2);
  expect(wav.bitsPerSample).toBe(16);
  expect(wav.data).toBe("data");
  expect(wav.dataSize).toBe(expectedPcm.byteLength);
  expect(Array.from(wav.pcm)).toEqual(Array.from(expectedPcm));
}

function ttsCall(mock: ReturnType<typeof vi.fn>): { url: string; init?: RequestInit } {
  const calls = mock.mock.calls.filter((call) => String(call[0]).endsWith("/v1beta/interactions"));
  if (calls.length === 0) throw new Error("expected a TTS call");
  const last = calls[calls.length - 1];
  return { url: String(last[0]), init: last[1] as RequestInit | undefined };
}

function llmCall(mock: ReturnType<typeof vi.fn>): { url: string; init?: RequestInit } {
  const calls = mock.mock.calls.filter((call) => String(call[0]).endsWith(":generateContent"));
  if (calls.length === 0) throw new Error("expected a stage-tag LLM call");
  return { url: String(calls[0][0]), init: calls[0][1] as RequestInit | undefined };
}

describe("Gemini TTS speech (GEMINI_SPEECH_ENABLED)", () => {
  it("synthesizes a plain line via the interactions endpoint with mapped voice and WAV output", async () => {
    const geminiFetchMock = geminiFetch({});
    const response = await handleRequest(
      speechRequest({ text: "Privacy-safe rehearsal line.", voice: "marin" }),
      geminiEnv,
      deps(geminiFetchMock),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-speech-model")).toBe("gemini-3.1-flash-tts-preview");
    expect(response.headers.get("x-speech-voice")).toBe("marin");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("content-length")).toBe(String(44 + PCM.byteLength));

    // Exactly one upstream call, to the TTS interactions endpoint.
    expect(geminiFetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = ttsCall(geminiFetchMock);
    expect(url).toBe(GEMINI_TTS_URL);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("AIza-synthesis-test-key");
    const providerRequest = JSON.parse(String(init?.body));
    expect(providerRequest).toEqual({
      model: "gemini-3.1-flash-tts-preview",
      input: "Privacy-safe rehearsal line.",
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice: "Umbriel" }] },
    });

    await expectValidWav(response, PCM);
  });

  it.each([
    ["alloy", "Charon"],
    ["echo", "Puck"],
    ["onyx", "Orus"],
    ["ash", "Algenib"],
    ["sage", "Sadaltager"],
    ["ballad", "Zubenelgenubi"],
    ["nova", "Kore"],
    ["fable", "Vindemiatrix"],
    ["coral", "Sulafat"],
    ["shimmer", "Achernar"],
    ["verse", "Despina"],
    ["marin", "Umbriel"],
    ["cedar", "Algieba"],
  ])("maps preset %s to Gemini voice %s and keeps the preset in X-Speech-Voice", async (preset, geminiVoice) => {
    const geminiFetchMock = geminiFetch({});
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: preset }),
      geminiEnv,
      deps(geminiFetchMock),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-speech-voice")).toBe(preset);
    const { init } = ttsCall(geminiFetchMock);
    const providerRequest = JSON.parse(String(init?.body));
    expect(providerRequest.generation_config.speech_config).toEqual([{ voice: geminiVoice }]);
    await expectValidWav(response, PCM);
  });

  it("falls back to the default Gemini base URL when GEMINI_BASE_URL is unset", async () => {
    const withoutBaseUrl = { ...geminiEnv };
    delete withoutBaseUrl.GEMINI_BASE_URL;
    const geminiFetchMock = geminiFetch({});
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin" }),
      withoutBaseUrl,
      deps(geminiFetchMock),
    );

    expect(response.status).toBe(200);
    const { url } = ttsCall(geminiFetchMock);
    expect(url).toBe(GEMINI_TTS_URL);
  });

  it("converts a stageNote to tags via the LLM first, then inlines the tags ahead of the verbatim line", async () => {
    const line = "I already know what I want.";
    const stageNote = "quietly, almost to herself";
    const geminiFetchMock = geminiFetch({
      llm: { tags: ["whispers", "tension"] },
      tts: {},
    });

    const response = await handleRequest(
      speechRequest({ text: line, voice: "marin", stageNote }),
      geminiEnv,
      deps(geminiFetchMock),
    );

    expect(response.status).toBe(200);
    // LLM first, TTS second.
    expect(geminiFetchMock).toHaveBeenCalledTimes(2);
    expect(String(geminiFetchMock.mock.calls[0][0])).toBe(GEMINI_LLM_URL);
    expect(String(geminiFetchMock.mock.calls[1][0])).toBe(GEMINI_TTS_URL);

    const { url: llmUrl, init: llmInit } = llmCall(geminiFetchMock);
    expect(llmUrl).toBe(GEMINI_LLM_URL);
    expect(new Headers(llmInit?.headers).get("x-goog-api-key")).toBe("AIza-synthesis-test-key");
    const llmBody = JSON.parse(String(llmInit?.body));
    expect(llmBody.contents[0].parts[0].text).toContain(line);
    expect(llmBody.contents[0].parts[0].text).toContain(stageNote);
    expect(llmBody.generationConfig.responseMimeType).toBe("application/json");
    expect(llmBody.generationConfig.temperature).toBe(0);
    expect(llmBody.generationConfig.responseSchema).toEqual({
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    });

    const { init: ttsInit } = ttsCall(geminiFetchMock);
    const ttsBody = JSON.parse(String(ttsInit?.body));
    expect(ttsBody.input).toBe(`[whispers] [tension] ${line}`);
    // The line remains verbatim; the stage note itself is never sent to TTS.
    expect(ttsBody.input).toContain(line);
    expect(ttsBody.input).not.toContain(stageNote);

    await expectValidWav(response, PCM);
  });

  it("skips the LLM call when stageNote is whitespace-only and synthesizes the plain line", async () => {
    const geminiFetchMock = geminiFetch({});
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin", stageNote: "   " }),
      geminiEnv,
      deps(geminiFetchMock),
    );

    expect(response.status).toBe(200);
    expect(geminiFetchMock).toHaveBeenCalledTimes(1);
    const { init } = ttsCall(geminiFetchMock);
    const ttsBody = JSON.parse(String(init?.body));
    expect(ttsBody.input).toBe("Line.");
  });
});

describe("Gemini stage-note degradation", () => {
  it.each([
    ["unknown tag", { tags: ["whispers", "yelling"] }],
    ["more than four tags", { tags: TAGS }],
    ["non-JSON output", { text: "definitely not json" }],
  ])("degrades to the plain line when the LLM returns %s and logs stage_note_tags_rejected", async (_case, llm) => {
    const logger = vi.fn();
    const geminiFetchMock = geminiFetch({ llm: llm as LlmBehavior, tts: {} });
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin", stageNote: "whispered" }),
      geminiEnv,
      deps(geminiFetchMock, { logProviderError: logger }),
    );

    expect(response.status).toBe(200);
    const { init } = ttsCall(geminiFetchMock);
    const ttsBody = JSON.parse(String(init?.body));
    expect(ttsBody.input).toBe("Line.");
    const rejected = logger.mock.calls.some((call) => {
      const error = call[1] as { provider: { code?: string | null; operation?: string } } | undefined;
      return (
        error?.provider?.code === "stage_note_tags_rejected" &&
        error?.provider?.operation === "gemini_stage_tags"
      );
    });
    expect(rejected).toBe(true);
  });

  it.each([
    ["HTTP 500", { status: 500 }],
    ["HTTP 401", { status: 401 }],
    ["transport failure", { throw: new Error("network down") }],
  ])("degrades to the plain line when the LLM call %s and logs stage_note_tags_unavailable", async (_case, llm) => {
    const logger = vi.fn();
    const geminiFetchMock = geminiFetch({ llm: llm as LlmBehavior, tts: {} });
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin", stageNote: "whispered" }),
      geminiEnv,
      deps(geminiFetchMock, { logProviderError: logger }),
    );

    expect(response.status).toBe(200);
    const { init } = ttsCall(geminiFetchMock);
    const ttsBody = JSON.parse(String(init?.body));
    expect(ttsBody.input).toBe("Line.");
    const unavailable = logger.mock.calls.some((call) => {
      const error = call[1] as { provider: { code?: string | null; operation?: string } } | undefined;
      return (
        error?.provider?.code === "stage_note_tags_unavailable" &&
        error?.provider?.operation === "gemini_stage_tags"
      );
    });
    expect(unavailable).toBe(true);
  });
});

describe("Gemini speech error mapping", () => {
  it("returns 503 service_not_configured when enabled but GEMINI_API_KEY is missing", async () => {
    const withoutKey = { ...geminiEnv };
    delete withoutKey.GEMINI_API_KEY;
    const geminiFetchMock = geminiFetch({});
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin" }),
      withoutKey,
      deps(geminiFetchMock),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_not_configured" },
    });
    expect(geminiFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      { text: "Line.", voice: "marin", stageNote: 42 },
      400,
      "invalid_stage_note",
    ],
    [
      { text: "Line.", voice: "marin", stageNote: null },
      400,
      "invalid_stage_note",
    ],
    [
      { text: "Line.", voice: "marin", stageNote: "a".repeat(4001) },
      413,
      "stage_note_too_large",
    ],
    [
      { text: "Line.", voice: "marin", stageNote: "ok", extra: 1 },
      400,
      "unexpected_field",
    ],
  ])("rejects %# without provider access", async (body, status, code) => {
    const geminiFetchMock = geminiFetch({});
    const response = await handleRequest(
      speechRequest(body),
      geminiEnv,
      deps(geminiFetchMock),
    );
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(geminiFetchMock).not.toHaveBeenCalled();
  });

  it("accepts a stageNote at exactly 4,000 bytes", async () => {
    const geminiFetchMock = geminiFetch({});
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin", stageNote: "a".repeat(4000) }),
      geminiEnv,
      deps(geminiFetchMock),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    // 4,000 bytes is allowed: the LLM tag call and the TTS call both fire.
    expect(geminiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps a TTS 401 to provider_auth_error without exposing response text", async () => {
    const logger = vi.fn();
    const geminiFetchMock = geminiFetch({
      tts: {
        status: 401,
        json: { error: { code: 401, message: "Secret provider detail", status: "INVALID_ARGUMENT" } },
      },
    });
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin" }),
      geminiEnv,
      deps(geminiFetchMock, { logProviderError: logger }),
    );

    expect(response.status).toBe(502);
    const publicBody = JSON.stringify(await response.json());
    expect(publicBody).toContain("provider_auth_error");
    expect(publicBody).not.toContain("Secret provider detail");
    const [, error] = logger.mock.calls[0] as [
      string,
      { provider: { operation: string; status: number } },
    ];
    expect(error.provider).toMatchObject({ operation: "gemini_speech", status: 401 });
  });

  it.each([
    ["missing output_audio", { json: { interaction: {} } }],
    [
      "odd-length PCM",
      { json: { interaction: { output_audio: { data: b64encode(new Uint8Array([1, 2, 3])) } } } },
    ],
    ["non-JSON body", { raw: "this is not json" }],
  ])("maps malformed TTS response %s to upstream_error", async (_case, tts) => {
    const geminiFetchMock = geminiFetch({ tts: tts as TtsBehavior });
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin" }),
      geminiEnv,
      deps(geminiFetchMock),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "upstream_error" },
    });
  });

  it("times out the shared Gemini budget deterministically", async () => {
    vi.useFakeTimers();
    try {
      const geminiFetchMock = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Request aborted", "AbortError"));
            });
          }),
      );
      const responsePromise = handleRequest(
        speechRequest({ text: "Line.", voice: "marin" }),
        { ...geminiEnv, GEMINI_SPEECH_TIMEOUT_MS: "5000" },
        deps(geminiFetchMock),
      );

      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;
      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "upstream_timeout" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Gemini disabled keeps the OpenAI path", () => {
  it("ignores stageNote and speaks via OpenAI when GEMINI_SPEECH_ENABLED is false", async () => {
    const openAiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/audio/speech");
      const providerRequest = JSON.parse(String(init?.body));
      expect(providerRequest.model).toBe("gpt-4o-mini-tts");
      expect(providerRequest.input).toBe("Line.");
      expect(providerRequest.voice).toBe("marin");
      expect(providerRequest).not.toHaveProperty("stageNote");
      return new Response(Uint8Array.from([0xff, 0xf1]), {
        status: 200,
        headers: { "Content-Type": "audio/aac" },
      });
    });
    const response = await handleRequest(
      speechRequest({ text: "Line.", voice: "marin", stageNote: "ignored here" }),
      { ...openAiEnv, GEMINI_SPEECH_ENABLED: "false", OPENAI_SPEECH_MODEL: "gpt-4o-mini-tts" },
      deps(openAiFetch),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/aac");
    expect(response.headers.get("x-speech-model")).toBe("gpt-4o-mini-tts");
  });
});

describe("Gemini rate-limit contract", () => {
  function durableDeps(fetchMock: ReturnType<typeof vi.fn>) {
    let globalWindow: RateWindow | undefined;
    const clientWindows = new Map<string, RateWindow>();
    return {
      fetch: fetchMock as typeof fetch,
      takeRateLimit: async (
        _env: Env,
        clientAddress: string,
        clientLimit: number,
        globalLimit: number,
        windowSeconds: number,
      ) => {
        const result = evaluateRateWindows(
          globalWindow,
          clientWindows.get(clientAddress),
          globalLimit,
          clientLimit,
          windowSeconds * 1_000,
          1_000,
        );
        globalWindow = result.globalWindow;
        clientWindows.set(clientAddress, result.clientWindow);
        return {
          allowed: result.allowed,
          retryAfterSeconds: result.retryAfterSeconds,
        };
      },
      logProviderError: vi.fn(),
    };
  }

  it("enforces the per-IP budget for Gemini requests", async () => {
    const geminiFetchMock = geminiFetch({});
    const depsForRate = durableDeps(geminiFetchMock);
    const rateEnv: Env = {
      ...geminiEnv,
      RATE_LIMIT_REQUESTS: "2",
      RATE_LIMIT_WINDOW_SECONDS: "60",
    };

    const first = await handleRequest(
      speechRequest({ text: "one", voice: "marin" }),
      rateEnv,
      depsForRate,
    );
    expect(first.status).toBe(200);
    const second = await handleRequest(
      speechRequest({ text: "two", voice: "marin" }),
      rateEnv,
      depsForRate,
    );
    expect(second.status).toBe(200);
    const rejected = await handleRequest(
      speechRequest({ text: "three", voice: "marin" }),
      rateEnv,
      depsForRate,
    );
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("retry-after"))).toBe(60);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "rate_limited", message: "Too many AI requests" },
    });
    expect(geminiFetchMock).toHaveBeenCalledTimes(2);
  });
});
