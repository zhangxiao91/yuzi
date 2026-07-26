import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { corsHeaders } from "./index";
import { verifyTurnstile } from "./turnstile";
import type { Env } from "./env";

function env(overrides: Partial<Env> = {}): Env {
  const stub = { fetch: vi.fn(async () => Response.json({ game: { id: "id" } })) };
  return {
    SESSIONS: { getByName: vi.fn(() => stub) } as unknown as DurableObjectNamespace,
    SESSION_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    TURN_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ENVIRONMENT: "development",
    ALLOWED_ORIGINS: "https://zx-dx.xyz,https://*.zxlab.pages.dev",
    TURNSTILE_SECRET_KEY: "secret",
    TURNSTILE_EXPECTED_HOSTNAMES: "zx-dx.xyz,zxlab.pages.dev",
    AI_GATEWAY_URL: "https://example.test/api/ai/generate",
    ZXLAB_AI_GATEWAY_TOKEN: "token",
    SESSION_TTL_SECONDS: "1800",
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("worker boundary", () => {
  it("accepts exact and one-label wildcard origins only", () => {
    const config = env();
    expect(corsHeaders(new Request("https://api.test", { headers: { origin: "https://zx-dx.xyz" } }), config).get("access-control-allow-origin")).toBe("https://zx-dx.xyz");
    expect(corsHeaders(new Request("https://api.test", { headers: { origin: "https://beta.zxlab.pages.dev" } }), config).get("access-control-allow-origin")).toBe("https://beta.zxlab.pages.dev");
    expect(corsHeaders(new Request("https://api.test", { headers: { origin: "https://evil.beta.zxlab.pages.dev" } }), config).get("access-control-allow-origin")).toBeNull();
  });

  it("rejects disallowed origins before touching session state", async () => {
    const response = await worker.fetch(new Request("https://api.test/api/v1/sessions/id", { headers: { origin: "https://evil.test" } }), env());
    expect(response.status).toBe(403);
  });

  it("answers preflight with the narrow method and header list", async () => {
    const response = await worker.fetch(new Request("https://api.test/api/v1/sessions", { method: "OPTIONS", headers: { origin: "https://zx-dx.xyz" } }), env());
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  });

  it("applies IP rate limiting before Turnstile verification", async () => {
    const config = env({ SESSION_RATE_LIMITER: { limit: vi.fn(async () => ({ success: false })) } });
    const response = await worker.fetch(new Request("https://api.test/api/v1/sessions", { method: "POST", headers: { origin: "https://zx-dx.xyz", "cf-connecting-ip": "203.0.113.2", "content-type": "application/json" }, body: "{}" }), config);
    expect(response.status).toBe(429);
  });

  it("supports Cloudflare's documented development test token", async () => {
    await expect(verifyTurnstile(new Request("https://api.test"), env(), "test")).resolves.toBe(true);
    await expect(verifyTurnstile(new Request("https://api.test"), env(), "")).resolves.toBe(false);
  });

  it("validates production Turnstile action and hostname", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, action: "start-yuzhi", hostname: "zx-dx.xyz" })));
    await expect(verifyTurnstile(new Request("https://api.test"), env({ ENVIRONMENT: "production" }), "valid")).resolves.toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, action: "wrong", hostname: "zx-dx.xyz" })));
    await expect(verifyTurnstile(new Request("https://api.test"), env({ ENVIRONMENT: "production" }), "valid")).resolves.toBe(false);
  });

  it("rate-limits turn generation by session but not state reads or cuts", async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const config = env({ TURN_RATE_LIMITER: limiter });
    const turn = await worker.fetch(new Request("https://api.test/api/v1/sessions/deadbeef/turn", { method: "POST", headers: { origin: "https://zx-dx.xyz", authorization: "Bearer value", "content-type": "application/json" }, body: "{}" }), config);
    expect(turn.status).toBe(429);
    const read = await worker.fetch(new Request("https://api.test/api/v1/sessions/deadbeef", { headers: { origin: "https://zx-dx.xyz", authorization: "Bearer value" } }), config);
    expect(read.status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledTimes(1);
  });
});
