import type { Env } from "./env";

interface TurnstileResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
}

export async function verifyTurnstile(request: Request, env: Env, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  if (env.ENVIRONMENT !== "production" && token === "test") return true;
  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET_KEY);
  body.set("response", token);
  const source = request.headers.get("cf-connecting-ip");
  if (source) body.set("remoteip", source);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!response.ok) return false;
  const result = await response.json<TurnstileResponse>();
  const hostnames = env.TURNSTILE_EXPECTED_HOSTNAMES.split(",").map((item) => item.trim()).filter(Boolean);
  return result.success === true && result.action === "start-yuzi" && Boolean(result.hostname && hostnames.includes(result.hostname));
}
