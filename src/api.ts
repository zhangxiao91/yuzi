import type { CutInput, GameState, SessionEnvelope, TurnInput } from "../shared/types";

const API_BASE = (import.meta.env.VITE_YUZHI_API_BASE_URL || "https://yuzhi-api.zx-dx.xyz").replace(/\/$/, "");
const SESSION_KEY = "yuzhi:active-session:v1";

interface Credentials { sessionId: string; sessionToken: string }

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export async function createSession(turnstileToken: string): Promise<SessionEnvelope> {
  const result = await request<SessionEnvelope>("/api/v1/sessions", { method: "POST", body: JSON.stringify({ turnstileToken }) });
  if (!result.sessionToken) throw new ApiError("INVALID_SESSION", "新手稿没有返回凭据。", 502);
  saveCredentials({ sessionId: result.sessionId, sessionToken: result.sessionToken });
  return result;
}

export async function restoreSession(): Promise<GameState | null> {
  const credentials = loadCredentials();
  if (!credentials) return null;
  try {
    const result = await request<{ game: GameState }>(`/api/v1/sessions/${credentials.sessionId}`, {}, credentials);
    return result.game;
  } catch (error) {
    if (error instanceof ApiError && [401, 404, 410].includes(error.status)) clearCredentials();
    throw error;
  }
}

export async function submitTurn(input: TurnInput): Promise<GameState> {
  const credentials = requiredCredentials();
  const result = await request<{ game: GameState }>(`/api/v1/sessions/${credentials.sessionId}/turn`, {
    method: "POST",
    body: JSON.stringify(input),
  }, credentials);
  return result.game;
}

export async function submitCut(input: CutInput): Promise<GameState> {
  const credentials = requiredCredentials();
  const result = await request<{ game: GameState }>(`/api/v1/sessions/${credentials.sessionId}/cut`, {
    method: "POST",
    body: JSON.stringify(input),
  }, credentials);
  return result.game;
}

export function clearSession(): void {
  clearCredentials();
}

async function request<T>(path: string, init: RequestInit, credentials?: Credentials): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (credentials) headers.set("authorization", `Bearer ${credentials.sessionToken}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } } & T;
  if (!response.ok) throw new ApiError(payload.error?.code ?? "REQUEST_FAILED", payload.error?.message ?? "手稿暂时没有回应。", response.status);
  return payload;
}

function loadCredentials(): Credentials | null {
  try {
    const value = sessionStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) as Credentials : null;
  } catch {
    return null;
  }
}

function saveCredentials(credentials: Credentials): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
}

function clearCredentials(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

function requiredCredentials(): Credentials {
  const value = loadCredentials();
  if (!value) throw new ApiError("SESSION_NOT_FOUND", "这份手稿已经合上。", 401);
  return value;
}
