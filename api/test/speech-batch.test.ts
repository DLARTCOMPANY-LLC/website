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

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function audioPart(data: Uint8Array): Record<string, unknown> {
  return {
    type: "audio",
    data: b64encode(data),
    channels: 1,
    sample_rate: 24000,
    mime_type: "audio/l16; rate=24000; channels=1",
  };
}

function validTtsBody(): unknown {
  return {
    id: "v1_test",
    status: "completed",
    object: "interaction",
    model: "gemini-3.1-flash-tts-preview",
    steps: [{ type: "model_output", content: [audioPart(PCM)] }],
  };
}

function geminiError(status: number): unknown {
  return { error: { code: status, message: "provider detail", status: "INTERNAL" } };
}

function geminiFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(":generateContent")) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ tags: [] }) }] } }],
      });
    }
    return Response.json(validTtsBody());
  });
}

/**
 * TTS routing by the line's text (`input` in the request body) so parallel
 * lines get independent outcomes regardless of provider call order.
 */
function geminiFetchByLine(tts: Record<string, TtsBehavior | undefined>) {
  const calls: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(":generateContent")) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ tags: [] }) }] } }],
      });
    }
    const body = JSON.parse(String(init?.body)) as { input?: unknown };
    calls.push(body);
    const behavior = tts[String(body.input ?? "")] ?? {};
    if (behavior.throw) throw behavior.throw;
    if (behavior.raw !== undefined) {
      return new Response(behavior.raw, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (behavior.status && behavior.status !== 200) {
      return Response.json(behavior.json ?? geminiError(behavior.status), { status: behavior.status });
    }
    return Response.json(behavior.json ?? validTtsBody());
  });
  return { fetchMock, calls };
}

function batchRequest(body: unknown, ip = "203.0.113.10", rawBody?: string): Request {
  return new Request("https://api.example.com/v1/audio/speech/batch", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": ip,
      "Content-Type": "application/json",
    },
    body: rawBody ?? JSON.stringify(body),
  });
}

function speechRequest(body: unknown, ip = "203.0.113.10"): Request {
  return new Request("https://api.example.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": ip,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function deps(
  fetchMock: ReturnType<typeof vi.fn>,
  overrides: {
    takeRateLimit?: (
      _env: Env,
      clientAddress: string,
      clientLimit: number,
      globalLimit: number,
      windowSeconds: number,
      quantity?: number,
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

function batchLines(count: number): Array<{ text: string }> {
  return Array.from({ length: count }, (_, i) => ({ text: `Line ${i}.` }));
}

describe("speech batch validation", () => {
  async function rejected(
    body: unknown,
    status: number,
    code: string,
    rawBody?: string,
  ) {
    const geminiFetchMock = geminiFetch();
    const takeRateLimit = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const response = await handleRequest(
      batchRequest(body, "203.0.113.10", rawBody),
      geminiEnv,
      deps(geminiFetchMock, { takeRateLimit }),
    );
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(geminiFetchMock).not.toHaveBeenCalled();
    expect(takeRateLimit).not.toHaveBeenCalled();
  }

  it("rejects an unknown voice", async () => {
    await rejected(
      { voice: "robot", lines: [{ text: "Line." }] },
      400,
      "invalid_voice",
    );
  });

  it("rejects a non-string voice", async () => {
    await rejected({ voice: 42, lines: [{ text: "Line." }] }, 400, "invalid_voice");
  });

  it("rejects a missing or non-array lines field", async () => {
    await rejected({ voice: "alloy" }, 400, "invalid_lines");
    await rejected({ voice: "alloy", lines: "nope" }, 400, "invalid_lines");
  });

  it("rejects an empty lines array", async () => {
    await rejected({ voice: "alloy", lines: [] }, 400, "invalid_lines");
  });

  it("rejects more than 12 lines", async () => {
    await rejected({ voice: "alloy", lines: batchLines(13) }, 400, "too_many_lines");
  });

  it("rejects a non-object line", async () => {
    await rejected(
      { voice: "alloy", lines: [{ text: "Line." }, "just a string"] },
      400,
      "invalid_line",
    );
  });

  it("rejects unknown fields at the top level and inside lines", async () => {
    await rejected(
      { voice: "alloy", lines: [{ text: "Line." }], extra: true },
      400,
      "unexpected_field",
    );
    await rejected(
      { voice: "alloy", lines: [{ text: "Line.", extra: true }] },
      400,
      "unexpected_field",
    );
  });

  it("applies the single-endpoint text rules per line", async () => {
    await rejected(
      { voice: "alloy", lines: [{ text: "  Line." }] },
      400,
      "invalid_text",
    );
    await rejected(
      { voice: "alloy", lines: [{ text: 42 }] },
      400,
      "invalid_text",
    );
    await rejected(
      { voice: "alloy", lines: [{ text: "a".repeat(2001) }] },
      413,
      "text_too_long",
    );
  });

  it("applies the single-endpoint stageNote rules per line", async () => {
    await rejected(
      { voice: "alloy", lines: [{ text: "Line.", stageNote: 42 }] },
      400,
      "invalid_stage_note",
    );
    await rejected(
      { voice: "alloy", lines: [{ text: "Line.", stageNote: "n".repeat(4001) }] },
      413,
      "stage_note_too_large",
    );
  });

  it("rejects malformed JSON bodies", async () => {
    await rejected({ voice: "alloy" }, 400, "invalid_json", "this is not json");
  });

  it("rejects bodies over the 96 KiB batch cap before touching the provider", async () => {
    const lines = Array.from({ length: 12 }, () => ({ text: "a".repeat(8200) }));
    await rejected({ voice: "alloy", lines }, 413, "request_too_large");
  });

  it("accepts bodies above the single-endpoint 16 KiB cap", async () => {
    const geminiFetchMock = geminiFetch();
    const lines = Array.from({ length: 8 }, () => ({
      text: "a".repeat(2000),
      stageNote: "n".repeat(500),
    }));
    const response = await handleRequest(
      batchRequest({ voice: "marin", lines }),
      geminiEnv,
      deps(geminiFetchMock),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results).toHaveLength(8);
    expect(body.results.every((line) => line.ok)).toBe(true);
    // Each line has a stage note: one stage-tag LLM call plus one TTS call per line.
    expect(geminiFetchMock).toHaveBeenCalledTimes(16);
  });
});

describe("speech batch happy path", () => {
  it("synthesizes every line in input order with the single-endpoint audio bytes", async () => {
    const { fetchMock, calls } = geminiFetchByLine({});
    const response = await handleRequest(
      batchRequest({
        voice: "marin",
        lines: [{ text: "Line one." }, { text: "Line two." }, { text: "Line three." }],
      }),
      geminiEnv,
      deps(fetchMock),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-speech-model")).toBe("gemini-3.1-flash-tts-preview");
    expect(response.headers.get("x-speech-voice")).toBe("marin");

    const body = (await response.json()) as {
      voice: string;
      results: Array<{
        index: number;
        ok: boolean;
        contentType?: string;
        audioB64?: string;
        code?: string;
      }>;
    };
    expect(body.voice).toBe("marin");
    expect(body.results).toHaveLength(3);
    body.results.forEach((line, position) => {
      expect(line.index).toBe(position);
      expect(line.ok).toBe(true);
      expect(line.contentType).toBe("audio/wav");
      const audio = b64decode(line.audioB64!);
      // 44-byte WAV header plus the 8-byte PCM payload.
      expect(audio).toHaveLength(52);
      expect(String.fromCharCode(...audio.slice(0, 4))).toBe("RIFF");
      expect(Array.from(audio.slice(-8))).toEqual(Array.from(PCM));
    });
    expect(calls).toHaveLength(3);
    const firstBody = calls[0] as { generation_config: { speech_config: Array<{ voice: string }> } };
    expect(firstBody.generation_config.speech_config[0].voice).toBe("Umbriel");
  });

  it("bounds provider concurrency at 4", async () => {
    let inFlight = 0;
    let peak = 0;
    const geminiFetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        if (init?.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
        return Response.json(validTtsBody());
      },
    );
    const response = await handleRequest(
      batchRequest({ voice: "marin", lines: batchLines(8) }),
      geminiEnv,
      deps(geminiFetchMock),
    );
    expect(response.status).toBe(200);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(geminiFetchMock).toHaveBeenCalledTimes(8);
    const body = (await response.json()) as {
      results: Array<{ ok: boolean; index: number }>;
    };
    expect(body.results.map((line) => line.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(body.results.every((line) => line.ok)).toBe(true);
  });

  it("keeps the OpenAI provider path available for batches", async () => {
    const openAiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const providerRequest = JSON.parse(String(init?.body)) as { model: string; input: string };
      expect(providerRequest.model).toBe("gpt-4o-mini-tts");
      return new Response(Uint8Array.from([0xff, 0xf1, 0x00, providerRequest.input.length]), {
        status: 200,
        headers: { "Content-Type": "audio/aac" },
      });
    });
    const lines = [{ text: "Line one." }, { text: "Line two." }];
    const response = await handleRequest(
      batchRequest({ voice: "alloy", lines }),
      { ...openAiEnv, GEMINI_SPEECH_ENABLED: "false", OPENAI_SPEECH_MODEL: "gpt-4o-mini-tts" },
      deps(openAiFetch),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ ok: boolean; contentType?: string; audioB64?: string }>;
    };
    expect(body.results).toHaveLength(2);
    body.results.forEach((line, position) => {
      expect(line.ok).toBe(true);
      expect(line.contentType).toBe("audio/aac");
      const audio = b64decode(line.audioB64!);
      expect(Array.from(audio)).toEqual([0xff, 0xf1, 0x00, lines[position].text.length]);
    });
  });
});

describe("speech batch failure isolation", () => {
  it("keeps the batch at 200 when one line's provider call fails", async () => {
    const { fetchMock } = geminiFetchByLine({
      "Line one.": {},
      "Line two.": { status: 502 },
      "Line three.": {},
    });
    const logProviderError = vi.fn();
    const response = await handleRequest(
      batchRequest({
        voice: "alloy",
        lines: [{ text: "Line one." }, { text: "Line two." }, { text: "Line three." }],
      }),
      geminiEnv,
      deps(fetchMock, { logProviderError }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{
        index: number;
        ok: boolean;
        contentType?: string;
        audioB64?: string;
        code?: string;
      }>;
    };
    expect(body.results.map((line) => [line.index, line.ok, line.code])).toEqual([
      [0, true, undefined],
      [1, false, "upstream_error"],
      [2, true, undefined],
    ]);
    expect(body.results[0].contentType).toBe("audio/wav");
    expect(logProviderError).toHaveBeenCalledTimes(1);
  });

  it("maps provider auth failures to the per-line auth code", async () => {
    const { fetchMock } = geminiFetchByLine({ "Bad line.": { status: 401 } });
    const response = await handleRequest(
      batchRequest({ voice: "alloy", lines: [{ text: "Bad line." }, { text: "Good line." }] }),
      geminiEnv,
      deps(fetchMock),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ ok: boolean; code?: string }>;
    };
    expect(body.results[0]).toMatchObject({ ok: false, code: "provider_auth_error" });
    expect(body.results[1]).toMatchObject({ ok: true });
  });

  it("reports a timed-out line as upstream_timeout without failing the batch", async () => {
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
        batchRequest({ voice: "marin", lines: [{ text: "Only line." }] }),
        { ...geminiEnv, GEMINI_SPEECH_TIMEOUT_MS: "5000" },
        deps(geminiFetchMock),
      );

      await vi.advanceTimersByTimeAsync(5_000);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        voice: "marin",
        results: [{ index: 0, ok: false, code: "upstream_timeout" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("speech batch rate limiting", () => {
  /**
   * Durable limiter backed by the real evaluateRateWindows, capturing the
   * quantity each request charges. All calls share one fixed "now".
   */
  function quantityDeps(fetchMock: ReturnType<typeof vi.fn>) {
    let globalWindow: RateWindow | undefined;
    const clientWindows = new Map<string, RateWindow>();
    const captured: number[] = [];
    const depsForRate = {
      fetch: fetchMock as typeof fetch,
      takeRateLimit: async (
        _env: Env,
        clientAddress: string,
        clientLimit: number,
        globalLimit: number,
        windowSeconds: number,
        quantity = 1,
      ) => {
        captured.push(quantity);
        const result = evaluateRateWindows(
          globalWindow,
          clientWindows.get(clientAddress),
          globalLimit,
          clientLimit,
          windowSeconds * 1_000,
          1_000,
          quantity,
        );
        globalWindow = result.globalWindow;
        clientWindows.set(clientAddress, result.clientWindow);
        return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
      },
      logProviderError: vi.fn(),
    };
    return { depsForRate, captured };
  }

  it("charges a batch as lines.length against both budgets", async () => {
    const geminiFetchMock = geminiFetch();
    const { depsForRate, captured } = quantityDeps(geminiFetchMock);
    const rateEnv: Env = {
      ...geminiEnv,
      RATE_LIMIT_REQUESTS: "12",
      GLOBAL_RATE_LIMIT_REQUESTS: "12",
      RATE_LIMIT_WINDOW_SECONDS: "60",
    };

    const batch = await handleRequest(
      batchRequest({ voice: "marin", lines: batchLines(12) }, "198.51.100.7"),
      rateEnv,
      depsForRate,
    );
    expect(batch.status).toBe(200);
    expect(captured).toEqual([12]);

    // The per-IP window is exactly exhausted by the batch.
    const sameClient = await handleRequest(
      speechRequest({ text: "one", voice: "marin" }, "198.51.100.7"),
      rateEnv,
      depsForRate,
    );
    expect(sameClient.status).toBe(429);
    expect(Number(sameClient.headers.get("retry-after"))).toBe(60);

    // The global window is exhausted too, so a fresh client is also rejected.
    const otherClient = await handleRequest(
      speechRequest({ text: "one", voice: "marin" }, "203.0.113.9"),
      rateEnv,
      depsForRate,
    );
    expect(otherClient.status).toBe(429);
    expect(geminiFetchMock).toHaveBeenCalledTimes(12);
  });

  it("rejects a batch that would exceed the per-IP budget with 429 and no provider calls", async () => {
    const geminiFetchMock = geminiFetch();
    const { depsForRate, captured } = quantityDeps(geminiFetchMock);
    const rateEnv: Env = {
      ...geminiEnv,
      RATE_LIMIT_REQUESTS: "5",
      GLOBAL_RATE_LIMIT_REQUESTS: "12",
      RATE_LIMIT_WINDOW_SECONDS: "60",
    };

    const rejected = await handleRequest(
      batchRequest({ voice: "marin", lines: batchLines(12) }),
      rateEnv,
      depsForRate,
    );
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("retry-after"))).toBe(60);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "rate_limited", message: "Too many AI requests" },
    });
    expect(captured).toEqual([12]);
    expect(geminiFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a batch that would exceed the global budget", async () => {
    const geminiFetchMock = geminiFetch();
    const { depsForRate } = quantityDeps(geminiFetchMock);
    const rateEnv: Env = {
      ...geminiEnv,
      RATE_LIMIT_REQUESTS: "12",
      GLOBAL_RATE_LIMIT_REQUESTS: "5",
      RATE_LIMIT_WINDOW_SECONDS: "60",
    };

    const rejected = await handleRequest(
      batchRequest({ voice: "marin", lines: batchLines(12) }),
      rateEnv,
      depsForRate,
    );
    expect(rejected.status).toBe(429);
    expect(geminiFetchMock).not.toHaveBeenCalled();
  });

  it("does not consume rate budget for rejected batches", async () => {
    const geminiFetchMock = geminiFetch();
    const { depsForRate, captured } = quantityDeps(geminiFetchMock);
    const rateEnv: Env = {
      ...geminiEnv,
      RATE_LIMIT_REQUESTS: "1",
      GLOBAL_RATE_LIMIT_REQUESTS: "1",
      RATE_LIMIT_WINDOW_SECONDS: "60",
    };

    const invalid = await handleRequest(
      batchRequest({ voice: "robot", lines: batchLines(1) }),
      rateEnv,
      depsForRate,
    );
    expect(invalid.status).toBe(400);
    expect(captured).toEqual([]);

    const valid = await handleRequest(
      speechRequest({ text: "one", voice: "marin" }),
      rateEnv,
      depsForRate,
    );
    expect(valid.status).toBe(200);
  });
});

describe("evaluateRateWindows quantity", () => {
  it("allows a batch that lands exactly on the budget and blocks the next one", () => {
    const atEdge = evaluateRateWindows(
      { count: 9, resetAt: 61_000 },
      undefined,
      12,
      12,
      60_000,
      1_000,
      3,
    );
    expect(atEdge.allowed).toBe(true);
    expect(atEdge.globalWindow.count).toBe(12);
    expect(atEdge.clientWindow.count).toBe(3);

    const over = evaluateRateWindows(
      { count: 10, resetAt: 61_000 },
      undefined,
      12,
      12,
      60_000,
      1_000,
      3,
    );
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSeconds).toBe(60);
  });
});
