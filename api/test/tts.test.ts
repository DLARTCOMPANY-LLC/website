import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "../src/index";

const env: Env = {
  OPENAI_API_KEY: "sk-proj-1234567890abcdefghijklmnop",
};
const audioBytes = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);

describe("POST text-to-speech", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the server-side OpenAI defaults and returns bounded MP3 audio", async () => {
    const openAiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.openai.com/v1/audio/speech");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${env.OPENAI_API_KEY}`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "gpt-4o-mini-tts",
        input: "Read this line.",
        voice: "alloy",
        response_format: "mp3",
      });
      return audioResponse(audioBytes, "audio/mpeg");
    });

    const response = await handleRequest(
      speechRequest({ input: "Read this line." }),
      env,
      dependencies(openAiFetch),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-tts-provider")).toBe("openai");
    expect(response.headers.get("x-tts-model")).toBe("gpt-4o-mini-tts");
    expect(response.headers.get("x-tts-voice")).toBe("alloy");
    expect(response.headers.get("x-tts-format")).toBe("mp3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audioBytes);
  });

  it("accepts supported voice and format overrides without exposing model control", async () => {
    const openAiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-4o-mini-tts",
        voice: "cedar",
        response_format: "wav",
      });
      return audioResponse(audioBytes, "audio/x-wav");
    });

    const response = await handleRequest(
      speechRequest({ input: "Read this line.", voice: "cedar", format: "wav" }),
      env,
      dependencies(openAiFetch),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="speech.wav"',
    );
  });

  it.each([
    [{}, "invalid_input"],
    [{ input: "" }, "empty_input"],
    [{ input: "x".repeat(4_097) }, "input_too_long"],
    [{ input: "hello", voice: "unknown" }, "invalid_voice"],
    [{ input: "hello", format: "exe" }, "invalid_format"],
    [{ input: "hello", model: "client-controlled" }, "unexpected_field"],
  ])("rejects invalid request payloads", async (body, code) => {
    const openAiFetch = vi.fn();
    const response = await handleRequest(
      speechRequest(body),
      env,
      dependencies(openAiFetch),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(openAiFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and unsupported request content types", async () => {
    const deps = dependencies(vi.fn());
    const malformed = await handleRequest(
      new Request("https://api.example.com/v1/tts/speech", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          "Content-Type": "application/json",
        },
        body: "{",
      }),
      env,
      deps,
    );
    const wrongType = await handleRequest(
      new Request("https://api.example.com/v1/tts/speech", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          "Content-Type": "text/plain",
        },
        body: "hello",
      }),
      env,
      deps,
    );

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "invalid_json" },
    });
    expect(wrongType.status).toBe(415);
    await expect(wrongType.json()).resolves.toMatchObject({
      error: { code: "unsupported_content_type" },
    });
  });

  it("rejects a JSON body larger than 16 KiB", async () => {
    const openAiFetch = vi.fn();
    const response = await handleRequest(
      speechRequest({ input: "x".repeat(17 * 1024) }),
      env,
      dependencies(openAiFetch),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
    expect(openAiFetch).not.toHaveBeenCalled();
  });

  it("times out a slow request body before acquiring provider capacity", async () => {
    vi.useFakeTimers();
    const openAiFetch = vi.fn();
    const request = new Request(
      "https://api.example.com/v1/tts/speech",
      {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          "Content-Type": "application/json",
        },
        body: new ReadableStream(),
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    const responsePromise = handleRequest(request, env, dependencies(openAiFetch));

    await vi.advanceTimersByTimeAsync(5_000);
    const response = await responsePromise;
    expect(response.status).toBe(408);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request_timeout" },
    });
    expect(openAiFetch).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid configured default voice", async () => {
    const openAiFetch = vi.fn();
    const response = await handleRequest(
      speechRequest({ input: "Read this line." }),
      { ...env, OPENAI_TTS_VOICE: "not-a-voice" },
      dependencies(openAiFetch),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_not_configured" },
    });
    expect(openAiFetch).not.toHaveBeenCalled();
  });

  it("rejects oversized upstream audio before returning a success response", async () => {
    const oversized = new Uint8Array(1_025);
    const response = await handleRequest(
      speechRequest({ input: "Read this line." }),
      { ...env, OPENAI_TTS_MAX_OUTPUT_BYTES: "1024" },
      dependencies(vi.fn(async () => audioResponse(oversized, "audio/mpeg"))),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "upstream_response_too_large" },
    });
  });

  it("rejects a non-audio provider response and keeps its body private", async () => {
    const logger = vi.fn();
    const response = await handleRequest(
      speechRequest({ input: "Read this line." }),
      env,
      {
        ...dependencies(
          vi.fn(async () => new Response("private provider body", {
            headers: { "Content-Type": "text/plain" },
          })),
        ),
        logProviderError: logger,
      },
    );

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider body");
    expect(logger).toHaveBeenCalledOnce();
  });

  it("maps provider authentication errors to the stable error envelope", async () => {
    const response = await handleRequest(
      speechRequest({ input: "Read this line." }),
      env,
      dependencies(
        vi.fn(async () =>
          Response.json(
            {
              error: {
                type: "authentication_error",
                code: "invalid_api_key",
                message: "secret provider detail",
              },
            },
            { status: 401 },
          ),
        ),
      ),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "provider_auth_error",
        message: "Speech provider authentication failed",
      },
    });
  });

  it("aborts speech generation at the configured timeout", async () => {
    vi.useFakeTimers();
    const openAiFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const responsePromise = handleRequest(
      speechRequest({ input: "Read this line." }),
      { ...env, OPENAI_TTS_TIMEOUT_MS: "1000" },
      dependencies(openAiFetch),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const response = await responsePromise;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "upstream_timeout" },
    });
  });

  it("applies the shared durable rate limit before calling OpenAI", async () => {
    const openAiFetch = vi.fn();
    const response = await handleRequest(speechRequest({ input: "hello" }), env, {
      fetch: openAiFetch as typeof fetch,
      takeRateLimit: async () => ({ allowed: false, retryAfterSeconds: 12 }),
      logProviderError: vi.fn(),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(openAiFetch).not.toHaveBeenCalled();
  });

  it("caps buffered TTS work independently of the shared OpenAI limit", async () => {
    const pendingResponses: Array<(response: Response) => void> = [];
    const openAiFetch = vi.fn(
      async (): Promise<Response> =>
        await new Promise((resolve) => pendingResponses.push(resolve)),
    );
    const deps = dependencies(openAiFetch);

    const first = handleRequest(speechRequest({ input: "first" }), env, deps);
    const second = handleRequest(speechRequest({ input: "second" }), env, deps);
    await vi.waitFor(() => expect(openAiFetch).toHaveBeenCalledTimes(2));

    const blocked = await handleRequest(speechRequest({ input: "third" }), env, deps);
    expect(blocked.status).toBe(503);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "capacity_exceeded" },
    });

    for (const resolve of pendingResponses) {
      resolve(audioResponse(audioBytes, "audio/mpeg"));
    }
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
  });
});

function speechRequest(body: unknown): Request {
  return new Request("https://api.example.com/v1/tts/speech", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.10",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function dependencies(openAiFetch: ReturnType<typeof vi.fn>) {
  return {
    fetch: openAiFetch as typeof fetch,
    takeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    logProviderError: vi.fn(),
  };
}

function audioResponse(bytes: Uint8Array, contentType: string): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { headers: { "Content-Type": contentType } });
}
