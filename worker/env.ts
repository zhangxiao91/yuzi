export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  SESSIONS: DurableObjectNamespace;
  SESSION_RATE_LIMITER: RateLimiter;
  TURN_RATE_LIMITER: RateLimiter;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_EXPECTED_HOSTNAMES: string;
  AI_GATEWAY_URL: string;
  ZXLAB_AI_GATEWAY_TOKEN: string;
  SESSION_TTL_SECONDS: string;
}
