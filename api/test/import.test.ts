import { describe, expect, it, vi } from "vitest";
import {
  evaluateRateWindows,
  handleRequest,
  isSafeOpenAiKeyCandidate,
  OpenAiError,
  type Env,
  type RateWindow,
} from "../src/index";

const pngBytes = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlKz1sAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
);

const waiterImport = {
  characters: ["Spencer", "Waiter", "Mitch"],
  items: [
    {
      order: 1,
      speaker: null,
      text: "Role",
      isStageDirection: true,
      confidence: 1,
    },
    {
      order: 2,
      speaker: null,
      text: "START",
      isStageDirection: true,
      confidence: 1,
    },
    {
      order: 3,
      speaker: "Spencer",
      text: "Could we see a menu?",
      isStageDirection: false,
      confidence: 0.99,
    },
    {
      order: 4,
      speaker: "Waiter",
      text: "Of course.",
      isStageDirection: false,
      confidence: 0.99,
    },
    {
      order: 5,
      speaker: "Mitch",
      text: "(quietly)\nI already know what I want.",
      isStageDirection: false,
      confidence: 0.98,
    },
    {
      order: 6,
      speaker: "Spencer",
      text: "You always do.",
      isStageDirection: false,
      confidence: 0.99,
    },
    {
      order: 7,
      speaker: "Waiter",
      text: "May I bring you something to drink?",
      isStageDirection: false,
      confidence: 0.99,
    },
    {
      order: 8,
      speaker: "Mitch",
      text: "Water, please.",
      isStageDirection: false,
      confidence: 0.99,
    },
    {
      order: 9,
      speaker: null,
      text: "END",
      isStageDirection: true,
      confidence: 1,
    },
  ],
  diagnostics: { overallConfidence: 0.99, warnings: [] },
};

const env: Env = {
  OPENAI_API_KEY: " sk-proj-1234567890abcdefghijklmnop\r\n",
  OPENAI_VISION_MODEL: "gpt-4.1-mini",
  RATE_LIMIT_REQUESTS: "10",
};

describe("POST screenplay import", () => {
  it("returns the waiter screenplay contract without dropping dialogue", async () => {
    const openAiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const providerRequest = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sk-proj-1234567890abcdefghijklmnop",
      );
      expect(providerRequest.store).toBe(false);
      expect(providerRequest.model).toBe("gpt-4.1-mini");
      expect(providerRequest.text.format.strict).toBe(true);
      expect(providerRequest.input[0].content[1].image_url).toMatch(
        /^data:image\/png;base64,/,
      );
      return openAiResponse(waiterImport);
    });

    const response = await handleRequest(createRequest(), env, dependencies(openAiFetch));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      title: string;
      characters: string[];
      items: typeof waiterImport.items;
    };

    expect(result.title).toBe("Dinner scene");
    expect(result.characters).toEqual(["Spencer", "Waiter", "Mitch"]);
    expect(result.items.filter((item) => !item.isStageDirection)).toHaveLength(6);
    expect(
      result.items
        .filter((item) => item.isStageDirection)
        .map((item) => item.text),
    ).toEqual(["Role", "START", "END"]);
    expect(result.items[4].text).toBe("(quietly)\nI already know what I want.");
  });

  it("rejects MIME spoofing before calling OpenAI", async () => {
    const openAiFetch = vi.fn();
    const form = new FormData();
    form.set("image", new File([new Uint8Array([1, 2, 3])], "page.png", { type: "image/png" }));

    const response = await handleRequest(
      multipartRequest(form),
      env,
      dependencies(openAiFetch),
    );
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_image" },
    });
    expect(openAiFetch).not.toHaveBeenCalled();
  });

  it("rejects HEIC with an explicit unsupported media error", async () => {
    const form = new FormData();
    form.set("image", new File([pngBytes], "page.heic", { type: "image/heic" }));

    const response = await handleRequest(
      multipartRequest(form),
      env,
      dependencies(vi.fn()),
    );
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unsupported_image_type" },
    });
  });

  it("rejects malformed model output and reserved direction characters", async () => {
    const malformed = {
      ...waiterImport,
      characters: ["Spencer", "Role", "Waiter", "Mitch"],
    };
    const response = await handleRequest(
      createRequest(),
      env,
      dependencies(vi.fn(async () => openAiResponse(malformed))),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_model_output" },
    });
  });

  it("returns a safe quota code and logs only sanitized provider diagnostics", async () => {
    const logger = vi.fn();
    const response = await handleRequest(createRequest(), env, {
      ...dependencies(
        vi.fn(async () =>
          Response.json(
            {
              error: {
                type: "insufficient_quota",
                code: "insufficient_quota",
                message: "Quota exhausted for this account.",
              },
            },
            {
              status: 429,
              headers: { "x-request-id": "req_provider-123" },
            },
          ),
        ),
      ),
      logProviderError: logger,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "provider_quota_exceeded",
        message: "Vision provider quota is unavailable",
      },
    });
    expect(logger).toHaveBeenCalledOnce();
    const [, error] = logger.mock.calls[0] as [string, OpenAiError];
    expect(error.provider).toMatchObject({
      operation: "responses",
      status: 429,
      requestId: "req_provider-123",
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: "Quota exhausted for this account.",
      transportErrorName: null,
      transportMessage: null,
      responseContentType: "application/json",
      responseBodyFormat: "json_error",
    });
    expect(error.provider.responseBodyBytes).toBeGreaterThan(0);
  });

  it("distinguishes a malformed stored provider key without logging its value", async () => {
    const logger = vi.fn();
    const openAiFetch = vi.fn();
    const response = await handleRequest(
      createRequest(),
      { ...env, OPENAI_API_KEY: "not-an-openai-key" },
      {
        ...dependencies(openAiFetch),
        logProviderError: logger,
      },
    );

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "provider_auth_error" },
    });
    expect(openAiFetch).not.toHaveBeenCalled();
    const [, error] = logger.mock.calls[0] as [string, OpenAiError];
    expect(error.provider).toMatchObject({
      operation: "configuration",
      type: "authentication_error",
      code: "invalid_api_key_format",
    });
    expect(JSON.stringify(error.provider)).not.toContain("not-an-openai-key");
  });

  it("captures a bounded sanitized transport exception without exposing it publicly", async () => {
    const logger = vi.fn();
    const response = await handleRequest(createRequest(), env, {
      ...dependencies(
        vi.fn(async () => {
          throw new TypeError("Subrequest failed with sk-supersecret\nBearer private-token");
        }),
      ),
      logProviderError: logger,
    });

    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(502);
    expect(body).toContain('"code":"upstream_error"');
    expect(body).not.toContain("Subrequest failed");
    const [, error] = logger.mock.calls[0] as [string, OpenAiError];
    expect(error.provider.transportErrorName).toBe("TypeError");
    expect(error.provider.operation).toBe("responses");
    expect(error.provider.transportMessage).toBe(
      "Subrequest failed with [REDACTED] Bearer [REDACTED]",
    );
  });

  it("preserves safe HTTP metadata when the provider error body cannot be read", async () => {
    const logger = vi.fn();
    const response = await handleRequest(createRequest(), env, {
      ...dependencies(
        vi.fn(async () => {
          const body = new ReadableStream({
            start(controller) {
              controller.error(new Error("body failed"));
            },
          });
          return new Response(body, {
            status: 503,
            headers: {
              "content-type": "application/json",
              "x-request-id": "req-read-failure",
            },
          });
        }),
      ),
      logProviderError: logger,
    });

    expect(response.status).toBe(502);
    const [, error] = logger.mock.calls[0] as [string, OpenAiError];
    expect(error.provider).toMatchObject({
      status: 503,
      requestId: "req-read-failure",
      responseContentType: "application/json",
      responseBodyFormat: "read_error",
    });
  });

  it("uploads large images transiently and deletes them after the response", async () => {
    const calls: string[] = [];
    const openAiFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method}:${url}`);
      if (url.endsWith("/v1/files") && init?.method === "POST") {
        const form = init.body as FormData;
        expect(form.get("purpose")).toBe("vision");
        expect(form.get("expires_after[seconds]")).toBe("3600");
        return Response.json({ id: "file-screenplay123" });
      }
      if (url.endsWith("/v1/responses")) {
        const providerRequest = JSON.parse(String(init?.body));
        expect(providerRequest.input[0].content[1]).toEqual({
          type: "input_image",
          file_id: "file-screenplay123",
          detail: "high",
        });
        return openAiResponse(waiterImport);
      }
      if (url.endsWith("/v1/files/file-screenplay123") && init?.method === "DELETE") {
        return Response.json({ id: "file-screenplay123", deleted: true });
      }
      return new Response(null, { status: 500 });
    });

    const form = new FormData();
    form.set(
      "image",
      new File([createLargePng()], "large.png", { type: "image/png" }),
    );
    const response = await handleRequest(
      multipartRequest(form),
      env,
      dependencies(openAiFetch),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "POST:https://api.openai.com/v1/files",
      "POST:https://api.openai.com/v1/responses",
      "DELETE:https://api.openai.com/v1/files/file-screenplay123",
    ]);
  });

  it("redacts secrets and does not expose arbitrary provider messages publicly", async () => {
    const logger = vi.fn();
    const response = await handleRequest(createRequest(), env, {
      ...dependencies(
        vi.fn(async () =>
          Response.json(
            {
              error: {
                type: "invalid_request_error",
                code: "bad_request",
                message: "Bad input using sk-supersecret\nBearer private-token",
              },
            },
            {
              status: 400,
              headers: { "x-request-id": "invalid request id with spaces" },
            },
          ),
        ),
      ),
      logProviderError: logger,
    });

    const body = JSON.stringify(await response.json());
    expect(body).toContain('"code":"upstream_error"');
    expect(body).not.toContain("Bad input");
    expect(body).not.toContain("supersecret");
    const [, error] = logger.mock.calls[0] as [string, OpenAiError];
    expect(error.provider.requestId).toBeNull();
    expect(error.provider.message).toBe(
      "Bad input using [REDACTED] Bearer [REDACTED]",
    );
  });

  it("omits all provider and transport message text from console logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await handleRequest(createRequest(), env, {
        fetch: vi.fn(async () =>
          Response.json(
            {
              error: {
                type: "invalid_request_error",
                code: "bad_request",
                message: "Arbitrary provider response text",
              },
            },
            { status: 400 },
          ),
        ) as typeof fetch,
        takeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      });

      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).toContain("invalid_request_error");
      expect(logged).toContain("bad_request");
      expect(logged).not.toContain("Arbitrary provider response text");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("enforces the durable per-client rate limit", async () => {
    const testEnv = { ...env, RATE_LIMIT_REQUESTS: "1" };
    const openAiFetch = vi.fn(async () => openAiResponse(waiterImport));
    let globalWindow: RateWindow | undefined;
    let clientWindow: RateWindow | undefined;
    const deps = {
      fetch: openAiFetch as typeof fetch,
      takeRateLimit: async (
        _env: Env,
        _clientAddress: string,
        clientLimit: number,
        globalLimit: number,
        windowSeconds: number,
      ) => {
        const result = evaluateRateWindows(
          globalWindow,
          clientWindow,
          globalLimit,
          clientLimit,
          windowSeconds * 1_000,
          1_000,
        );
        globalWindow = result.globalWindow;
        clientWindow = result.clientWindow;
        return {
          allowed: result.allowed,
          retryAfterSeconds: result.retryAfterSeconds,
        };
      },
    };

    expect((await handleRequest(createRequest(), testEnv, deps)).status).toBe(200);
    const second = await handleRequest(createRequest(), testEnv, deps);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(openAiFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the durable rate limiter is unavailable", async () => {
    const openAiFetch = vi.fn();
    const response = await handleRequest(createRequest(), env, {
      fetch: openAiFetch as typeof fetch,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limit_unavailable" },
    });
    expect(openAiFetch).not.toHaveBeenCalled();
  });

  it("allows configured browser origins and rejects all others", async () => {
    const corsEnv = { ...env, CORS_ALLOWED_ORIGINS: "https://app.example.com" };
    const allowed = createRequest("https://app.example.com");
    const rejected = createRequest("https://evil.example");

    const allowedResponse = await handleRequest(
      allowed,
      corsEnv,
      dependencies(vi.fn(async () => openAiResponse(waiterImport))),
    );
    expect(allowedResponse.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );

    const rejectedResponse = await handleRequest(
      rejected,
      corsEnv,
      dependencies(vi.fn()),
    );
    expect(rejectedResponse.status).toBe(403);
  });

  describe("durable rate-window evaluation", () => {
    it("coordinates a global budget across clients and resets deterministically", () => {
      let globalWindow: RateWindow | undefined;
      let clientA: RateWindow | undefined;
      let clientB: RateWindow | undefined;

      const first = evaluateRateWindows(globalWindow, clientA, 2, 2, 60_000, 1_000);
      globalWindow = first.globalWindow;
      clientA = first.clientWindow;
      expect(first.allowed).toBe(true);

      const second = evaluateRateWindows(globalWindow, clientB, 2, 2, 60_000, 1_000);
      globalWindow = second.globalWindow;
      clientB = second.clientWindow;
      expect(second.allowed).toBe(true);

      const blocked = evaluateRateWindows(globalWindow, clientA, 2, 2, 60_000, 1_000);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSeconds).toBe(60);

      const reset = evaluateRateWindows(
        blocked.globalWindow,
        blocked.clientWindow,
        2,
        2,
        60_000,
        61_000,
      );
      expect(reset.allowed).toBe(true);
      expect(reset.globalWindow.count).toBe(1);
      expect(reset.clientWindow.count).toBe(1);
    });
  });

  it("does not expose the handler on unconfigured paths", async () => {
    const request = new Request("https://api.example.com/", { method: "POST" });
    const response = await handleRequest(request, env, dependencies(vi.fn()));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });
});

describe("OpenAI key candidate validation", () => {
  it("accepts evolving printable punctuation after the sk- prefix", () => {
    expect(
      isSafeOpenAiKeyCandidate("sk-project.v2/key+segment=alpha_beta-123"),
    ).toBe(true);
  });

  it.each([
    ["embedded space", "sk-validlooking key-that-is-long"],
    ["tab", "sk-validlooking\tkey-that-is-long"],
    ["control", "sk-validlooking\u0000key-that-is-long"],
    ["double quote", 'sk-validlooking"key-that-is-long'],
    ["single quote", "sk-validlooking'key-that-is-long"],
    ["Bearer value", "Bearer sk-validlooking-key-that-is-long"],
    ["project ID", "proj_1234567890abcdefghijklmnop"],
    ["too short", "sk-short"],
  ])("rejects %s", (_case, value) => {
    expect(isSafeOpenAiKeyCandidate(value)).toBe(false);
  });
});

function createRequest(origin?: string): Request {
  const form = new FormData();
  form.set("image", new File([pngBytes], "page.png", { type: "image/png" }));
  form.set("title", "Dinner scene");
  return multipartRequest(form, origin);
}

function multipartRequest(form: FormData, origin?: string): Request {
  const headers = new Headers({ "CF-Connecting-IP": "203.0.113.10" });
  if (origin) headers.set("Origin", origin);
  return new Request("https://api.example.com/v1/screenplays/import", {
    method: "POST",
    headers,
    body: form,
  });
}

function dependencies(openAiFetch: ReturnType<typeof vi.fn>) {
  return {
    fetch: openAiFetch as typeof fetch,
    takeRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    logProviderError: vi.fn(),
  };
}

function openAiResponse(payload: unknown): Response {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(payload) }],
      },
    ],
  });
}

function createLargePng(): Uint8Array<ArrayBuffer> {
  const iend = pngBytes.slice(pngBytes.length - 12);
  const prefix = pngBytes.slice(0, pngBytes.length - 12);
  const payloadLength = 5 * 1024 * 1024;
  const chunk = new Uint8Array(payloadLength + 12);
  new DataView(chunk.buffer).setUint32(0, payloadLength);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4);
  const result = new Uint8Array(prefix.length + chunk.length + iend.length);
  result.set(prefix);
  result.set(chunk, prefix.length);
  result.set(iend, prefix.length + chunk.length);
  return result;
}
