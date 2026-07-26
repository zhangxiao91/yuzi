import { afterEach, describe, expect, it, vi } from "vitest";
import { GameSession } from "./session";
import type { Env } from "./env";
import type { GameState } from "../shared/types";

function stateHarness() {
  const values = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
    setAlarm: vi.fn(async () => {}),
    deleteAll: vi.fn(async () => { values.clear(); }),
  };
  return { values, state: { storage } as unknown as DurableObjectState };
}

const env = {
  AI_GATEWAY_URL: "https://gateway.test/api/ai/generate",
  ZXLAB_AI_GATEWAY_TOKEN: "gateway-token",
} as Env;

async function initialize(session: GameSession): Promise<void> {
  const response = await session.fetch(new Request("https://session.internal/internal/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "session", sessionToken: "secret", expiresAt: Date.now() + 60_000 }),
  }));
  expect(response.status).toBe(201);
}

afterEach(() => vi.unstubAllGlobals());

describe("Durable Object session", () => {
  it("requires the exact bearer token and preserves refreshable state", async () => {
    const harness = stateHarness();
    const session = new GameSession(harness.state, env);
    await initialize(session);
    const rejected = await session.fetch(new Request("https://session.internal/state", { headers: { authorization: "Bearer wrong" } }));
    expect(rejected.status).toBe(401);
    const restored = await session.fetch(new Request("https://session.internal/state", { headers: { authorization: "Bearer secret" } }));
    expect(restored.status).toBe(200);
    const payload = await restored.json() as { game: GameState };
    expect(payload.game.version).toBe(1);
    expect(payload.game.phase).toBe("compose");
  });

  it("does not consume a turn or version when model generation fails", async () => {
    const harness = stateHarness();
    const session = new GameSession(harness.state, env);
    await initialize(session);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const record = harness.values.get("session") as { game: GameState };
    const fragmentIds = record.game.hand.filter((item) => ["她", "回到", "邮局"].includes(item.text)).map((item) => item.id);
    const response = await session.fetch(new Request("https://session.internal/turn", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, fragmentIds, punctuation: "。" }),
    }));
    expect(response.status).toBe(502);
    const after = harness.values.get("session") as { game: GameState };
    expect(after.game.turn).toBe(0);
    expect(after.game.version).toBe(1);
    expect(after.game.phase).toBe("compose");
  });

  it("rejects stale replay before calling the model", async () => {
    const harness = stateHarness();
    const session = new GameSession(harness.state, env);
    await initialize(session);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await session.fetch(new Request("https://session.internal/turn", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ version: 99, fragmentIds: ["a", "b"], punctuation: "。" }),
    }));
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
