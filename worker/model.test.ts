import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialGame } from "../shared/game";
import { generateTurn } from "./model";
import type { Env } from "./env";

const valid = {
  narrative: "她推开生锈的旧门，雨水沿着站台流进邮局。值夜人从抽屉深处取出一只没有地址的信封，示意她在灯下辨认。",
  candidates: [
    { text: "推开", role: "action" },
    { text: "邮局", role: "place" },
    { text: "信封", role: "object" },
  ],
};

const env = {
  AI_GATEWAY_URL: "https://gateway.test/api/ai/generate",
  ZXLAB_AI_GATEWAY_TOKEN: "server-only-token",
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe("model generation contract", () => {
  it("repairs one invalid response and sends only server credentials", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, data: { json: { narrative: "bad" } } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { json: valid } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateTurn(env, createInitialGame("id", Date.now() + 1_000), "她回到邮局。", [])).resolves.toEqual(valid);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(first.headers).get("authorization")).toBe("Bearer server-only-token");
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondBody.context.operation).toBe("repair-turn");
  });

  it("fails after exactly one repair attempt", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { json: { narrative: "still bad" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateTurn(env, createInitialGame("id", Date.now() + 1_000), "她回到邮局。", [])).rejects.toThrow("INVALID_NARRATIVE_LENGTH");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects forbidden text even when the gateway marks the request successful", async () => {
    const forbidden = { ...valid, narrative: valid.narrative.replace("旧门", "旧邮局") };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, data: { json: forbidden } })));
    await expect(generateTurn(env, createInitialGame("id", Date.now() + 1_000), "她回到邮局。", ["邮局"])).rejects.toThrow("FORBIDDEN_FRAGMENT_REAPPEARED");
  });
});
