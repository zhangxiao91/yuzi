import type { SessionEnvelope } from "../shared/types";
import type { Env } from "./env";
import { GameSession } from "./session";
import { verifyTurnstile } from "./turnstile";

export { GameSession };

const SESSION_PATH = /^\/api\/v1\/sessions\/([a-f0-9-]+)$/;
const TURN_PATH = /^\/api\/v1\/sessions\/([a-f0-9-]+)\/turn$/;
const CUT_PATH = /^\/api\/v1\/sessions\/([a-f0-9-]+)\/cut$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: preflight(cors) });
    if (request.method === "GET" && url.pathname === "/health") return respond({ ok: true, service: "yuzi-api" }, 200, cors);
    if (!cors.get("access-control-allow-origin")) return respond({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed." } }, 403, cors);

    try {
      if (request.method === "POST" && url.pathname === "/api/v1/sessions") return createSession(request, env, cors);
      const route = url.pathname.match(SESSION_PATH) ?? url.pathname.match(TURN_PATH) ?? url.pathname.match(CUT_PATH);
      if (!route) return respond({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404, cors);
      const [, sessionId] = route;
      const stub = env.SESSIONS.getByName(sessionId);
      if (url.pathname.endsWith("/turn")) {
        const allowed = await env.TURN_RATE_LIMITER.limit({ key: `turn:${sessionId}` });
        if (!allowed.success) return respond({ error: { code: "RATE_LIMITED", message: "书写得太快了，请稍后再试。" } }, 429, cors);
      }
      const internalPath = url.pathname.endsWith("/turn") ? "/turn" : url.pathname.endsWith("/cut") ? "/cut" : "/state";
      const response = await stub.fetch(`https://session.internal${internalPath}`, {
        method: request.method,
        headers: { authorization: request.headers.get("authorization") ?? "", "content-type": "application/json" },
        body: request.method === "GET" ? undefined : request.body,
      });
      return withCors(response, cors);
    } catch (error) {
      console.error(JSON.stringify({ event: "yuzi.request.failed", path: url.pathname, message: error instanceof Error ? error.message : "unknown" }));
      return respond({ error: { code: "SERVICE_UNAVAILABLE", message: "手稿暂时无法打开。" } }, 503, cors);
    }
  },
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env, cors: Headers): Promise<Response> {
  const source = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.SESSION_RATE_LIMITER.limit({ key: `session:${source}` })).success) {
    return respond({ error: { code: "RATE_LIMITED", message: "新手稿创建得太频繁，请稍后再试。" } }, 429, cors);
  }
  const body = await request.json().catch(() => ({})) as { turnstileToken?: unknown };
  if (!(await verifyTurnstile(request, env, body.turnstileToken))) {
    return respond({ error: { code: "CHALLENGE_FAILED", message: "安全验证未通过，请刷新后重试。" } }, 403, cors);
  }
  const sessionId = crypto.randomUUID();
  const sessionToken = randomToken();
  const expiresAt = Date.now() + Math.max(300, Number(env.SESSION_TTL_SECONDS) || 1800) * 1000;
  const response = await env.SESSIONS.getByName(sessionId).fetch("https://session.internal/internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, sessionToken, expiresAt }),
  });
  const payload = await response.json<{ game: SessionEnvelope["game"] }>();
  return respond({ sessionId, sessionToken, game: payload.game } satisfies SessionEnvelope, 201, cors);
}

export function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ vary: "Origin" });
  const origin = request.headers.get("origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
  const matches = allowed.includes(origin) || allowed.some((item) => {
    const wildcard = item.indexOf("*");
    if (wildcard < 0) return false;
    const prefix = item.slice(0, wildcard);
    const suffix = item.slice(wildcard + 1);
    const middle = origin.slice(prefix.length, origin.length - suffix.length);
    return origin.startsWith(prefix) && origin.endsWith(suffix) && middle.length > 0 && !middle.includes(".");
  });
  if (matches) headers.set("access-control-allow-origin", origin);
  return headers;
}

function preflight(cors: Headers): Headers {
  const headers = new Headers(cors);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type");
  headers.set("access-control-max-age", "86400");
  return headers;
}

function respond(value: unknown, status: number, cors: Headers): Response {
  const headers = new Headers(cors);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(value), { status, headers });
}

function withCors(response: Response, cors: Headers): Response {
  const headers = new Headers(response.headers);
  cors.forEach((value, key) => headers.set(key, value));
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
