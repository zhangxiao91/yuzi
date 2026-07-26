import { applyModelTurn, composeTurn, createInitialGame, cutFragments } from "../shared/game";
import type { CutInput, GameState, TurnInput } from "../shared/types";
import type { Env } from "./env";
import { generateTurn } from "./model";

interface SessionRecord {
  tokenHash: string;
  game: GameState;
}

export class GameSession implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/init") return this.initialize(request);
    const record = await this.record();
    if (!record) return problem("SESSION_NOT_FOUND", 404);
    if (record.game.expiresAt <= Date.now()) {
      await this.state.storage.deleteAll();
      return problem("SESSION_EXPIRED", 410);
    }
    if (!(await this.authorized(request, record.tokenHash))) return problem("UNAUTHORIZED", 401);

    if (request.method === "GET" && url.pathname === "/state") return json({ game: record.game });
    if (request.method === "POST" && url.pathname === "/turn") return this.turn(request, record);
    if (request.method === "POST" && url.pathname === "/cut") return this.cut(request, record);
    return problem("NOT_FOUND", 404);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  private async initialize(request: Request): Promise<Response> {
    if (await this.record()) return problem("ALREADY_INITIALIZED", 409);
    const input = await request.json<{ sessionId: string; sessionToken: string; expiresAt: number }>();
    if (!input.sessionId || !input.sessionToken || !Number.isFinite(input.expiresAt)) return problem("INVALID_INPUT", 400);
    const record: SessionRecord = {
      tokenHash: await hash(input.sessionToken),
      game: createInitialGame(input.sessionId, input.expiresAt),
    };
    await this.state.storage.put("session", record);
    await this.state.storage.setAlarm(input.expiresAt);
    return json({ game: record.game }, 201);
  }

  private async turn(request: Request, record: SessionRecord): Promise<Response> {
    try {
      const input = await request.json<TurnInput>();
      const composition = composeTurn(record.game, input);
      const output = await generateTurn(this.env, record.game, composition.sentence, composition.nextForbidden);
      const game = applyModelTurn(record.game, composition, output);
      await this.state.storage.put("session", { ...record, game });
      return json({ game });
    } catch (error) {
      return gameError(error);
    }
  }

  private async cut(request: Request, record: SessionRecord): Promise<Response> {
    try {
      const input = await request.json<CutInput>();
      const game = cutFragments(record.game, input);
      await this.state.storage.put("session", { ...record, game });
      return json({ game });
    } catch (error) {
      return gameError(error);
    }
  }

  private record(): Promise<SessionRecord | undefined> {
    return this.state.storage.get<SessionRecord>("session");
  }

  private async authorized(request: Request, expectedHash: string): Promise<boolean> {
    const authorization = request.headers.get("authorization") ?? "";
    return authorization.startsWith("Bearer ") && await hash(authorization.slice(7)) === expectedHash;
  }
}

function gameError(error: unknown): Response {
  const code = error instanceof Error ? error.message : "GAME_ERROR";
  const status = code === "VERSION_CONFLICT" ? 409
    : code.startsWith("AI_GATEWAY_") || code.includes("MODEL") || code.includes("NARRATIVE") || code.includes("CANDIDATE") || code === "FORBIDDEN_FRAGMENT_REAPPEARED" ? 502
      : 400;
  console.error(JSON.stringify({ event: "yuzi.session.rejected", code }));
  return problem(code, status);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function problem(code: string, status: number): Response {
  return json({ error: { code, message: safeMessage(code) } }, status);
}

function safeMessage(code: string): string {
  if (code.startsWith("AI_GATEWAY_") || code.includes("MODEL")) return "这一轮没有写成，请重试。";
  if (code === "VERSION_CONFLICT") return "手稿已在其他位置更新，请刷新后继续。";
  if (code === "SESSION_EXPIRED") return "这份手稿已经合上，请开始新的一局。";
  if (code === "TURN_NOT_ALLOWED") return "当前不是构句阶段，请先完成剪取。";
  if (code === "INVALID_SENTENCE") return "请选择二至五个完整意群。";
  if (code === "DUPLICATE_FRAGMENT") return "同一个意群不能重复使用。";
  if (code === "UNKNOWN_FRAGMENT") return "字池已经变化，请刷新手稿后重试。";
  if (code === "INVALID_PUNCTUATION") return "请选择句号、问号或引号。";
  return "这次操作不符合当前手稿状态。";
}

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
