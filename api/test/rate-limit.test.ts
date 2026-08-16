import { describe, expect, it, vi } from "vitest";
import {
  evaluateRateWindows,
  handleRequest,
  type Env,
  type RateWindow,
} from "../src/index";

// Production caps the per-client budget at 60 requests/minute (wrangler.jsonc).
// These tests deliberately lower the limit so the rate-limit contract can be
// exercised without firing 60 requests.
const env: Env = {
  OPENAI_API_KEY: " sk-proj-1234567890abcdefghijklmnop\r\n",
  OPENAI_VISION_MODEL: "gpt-4.1-mini",
  RATE_LIMIT_REQUESTS: "2",
  RATE_LIMIT_WINDOW_SECONDS: "60",
};

const AUDIO = new Uint8Array([0x00, 0x00, 0x00, 0x14]);

function speechRequest(text: string, ip: string): Request {
  const headers = new Headers({
    "CF-Connecting-IP": ip,
    "Content-Type": "application/json",
  });
  return new Request("https://api.example.com/v1/audio/speech", {
    method: "POST",
    headers,
    body: JSON.stringify({ text, voice: "alloy" }),
  });
}

function audioFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(
    async () =>
      new Response(AUDIO, {
        status: 200,
        headers: { "Content-Type": "audio/aac" },
      }),
  );
}

/**
 * Durable limiter backed by the real evaluateRateWindows. All calls share one
 * fixed "now", so windows never reset and counts are deterministic.
 */
function durableDeps(openAiFetch: ReturnType<typeof vi.fn>) {
  let globalWindow: RateWindow | undefined;
  const clientWindows = new Map<string, RateWindow>();
  return {
    fetch: openAiFetch as typeof fetch,
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

describe("rate-limit contract", () => {
  it("rejects the request over the per-client budget with a 429, Retry-After, and a message the client can show", async () => {
    const openAiFetch = audioFetch();
    const deps = durableDeps(openAiFetch);

    const first = await handleRequest(speechRequest("line one", "198.51.100.7"), env, deps);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/aac");

    const second = await handleRequest(speechRequest("line two", "198.51.100.7"), env, deps);
    expect(second.status).toBe(200);

    const rejected = await handleRequest(speechRequest("line three", "198.51.100.7"), env, deps);
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("retry-after"))).toBe(60);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "rate_limited", message: "Too many AI requests" },
    });
    expect(openAiFetch).toHaveBeenCalledTimes(2);
  });

  it("exhausts the shared global budget across clients and tells each one how long to wait", async () => {
    const globalEnv: Env = { ...env, GLOBAL_RATE_LIMIT_REQUESTS: "2" };
    const openAiFetch = audioFetch();
    const deps = durableDeps(openAiFetch);

    const clientA = await handleRequest(speechRequest("line one", "198.51.100.7"), globalEnv, deps);
    expect(clientA.status).toBe(200);
    const clientASecond = await handleRequest(speechRequest("line two", "198.51.100.7"), globalEnv, deps);
    expect(clientASecond.status).toBe(200);

    const clientB = await handleRequest(speechRequest("line one", "203.0.113.9"), globalEnv, deps);
    expect(clientB.status).toBe(429);
    expect(Number(clientB.headers.get("retry-after"))).toBe(60);
    await expect(clientB.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
    expect(openAiFetch).toHaveBeenCalledTimes(2);
  });
});
