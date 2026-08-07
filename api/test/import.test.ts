import { describe, expect, it, vi } from "vitest";
import {
  evaluateRateWindows,
  handleRequest,
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
  OPENAI_API_KEY: "test-only",
  OPENAI_VISION_MODEL: "gpt-4.1-mini",
  RATE_LIMIT_REQUESTS: "10",
};

describe("POST screenplay import", () => {
  it("returns the waiter screenplay contract without dropping dialogue", async () => {
    const openAiFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const providerRequest = JSON.parse(String(init?.body));
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
