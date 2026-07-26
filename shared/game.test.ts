import { describe, expect, it } from "vitest";
import { applyModelTurn, composeTurn, createInitialGame, cutFragments, glyphLength, resolveResult, validateModelOutput } from "./game";
import type { GameState, ModelTurnOutput, Punctuation } from "./types";

function game(): GameState {
  return createInitialGame("session", Date.now() + 60_000);
}

function ids(state: GameState, ...texts: string[]): string[] {
  return texts.map((text) => {
    const item = state.hand.find((fragment) => fragment.text === text);
    if (!item) throw new Error(`missing ${text}`);
    return item.id;
  });
}

function output(narrative = "她推开生锈的旧门，雨水沿着站台流进邮局。值夜人从抽屉深处取出一只没有地址的信封，示意她在灯下辨认。", candidates: ModelTurnOutput["candidates"] = [
  { text: "推开", role: "action" },
  { text: "旧门", role: "object" },
  { text: "邮局", role: "place" },
]): ModelTurnOutput {
  return { narrative, candidates };
}

describe("Yuzhi game domain", () => {
  it("composes whole semantic fragments in player order with punctuation semantics", () => {
    const state = game();
    const question = composeTurn(state, { version: 1, fragmentIds: ids(state, "她", "回到", "邮局"), punctuation: "？" });
    expect(question.sentence).toBe("她回到邮局？");
    expect(question.world.locationKnown).toBe(false);
    const assertion = composeTurn(state, { version: 1, fragmentIds: ids(state, "她", "回到", "邮局"), punctuation: "。" });
    expect(assertion.world.locationKnown).toBe(true);
    expect(assertion.cutBudget).toBe(glyphLength("她回到邮局"));
  });

  it("rejects split, duplicate, stale, and overlong constructions", () => {
    const state = game();
    expect(() => composeTurn(state, { version: 1, fragmentIds: ["天"], punctuation: "。" })).toThrow("INVALID_SENTENCE");
    const she = ids(state, "她")[0];
    expect(() => composeTurn(state, { version: 1, fragmentIds: [she, she], punctuation: "。" })).toThrow("DUPLICATE_FRAGMENT");
    expect(() => composeTurn(state, { version: 2, fragmentIds: ids(state, "她", "回到"), punctuation: "。" })).toThrow("VERSION_CONFLICT");
  });

  it("validates model length, contiguous candidates, and forbidden phrases", () => {
    expect(validateModelOutput(output(), [])).toEqual(output());
    expect(() => validateModelOutput(output("太短", [{ text: "太短", role: "object" }]), [])).toThrow("INVALID_NARRATIVE_LENGTH");
    expect(() => validateModelOutput(output(undefined, [{ text: "不存在", role: "object" }]), [])).toThrow("INVALID_CANDIDATE");
    expect(() => validateModelOutput(output(), ["邮局"])).toThrow("FORBIDDEN_FRAGMENT_REAPPEARED");
  });

  it("globally erases every exact phrase but adds one reusable copy", () => {
    const state = game();
    state.phase = "cut";
    state.cutBudget = 4;
    state.manuscript = [{ id: "p", turn: 1, text: "雨里有旧门，旧门后仍有灯。" }];
    state.candidates = [{ id: "door", text: "旧门", role: "object", start: 3, end: 5 }];
    const next = cutFragments(state, { version: 1, candidateIds: ["door"] });
    expect(next.manuscript[0].text).toBe("雨里有□□，□□后仍有灯。");
    expect(next.hand.filter((item) => item.text === "旧门")).toHaveLength(1);
    expect(next.forbidden).toContain("旧门");
  });

  it("enforces cut count, budget, candidate identity, and hand conservation", () => {
    const state = game();
    state.phase = "cut";
    state.cutBudget = 2;
    state.candidates = [
      { id: "a", text: "门", role: "object", start: 0, end: 1 },
      { id: "b", text: "雨夜", role: "time", start: 2, end: 4 },
    ];
    expect(() => cutFragments(state, { version: 1, candidateIds: ["a", "b"] })).toThrow("CUT_BUDGET_EXCEEDED");
    expect(() => cutFragments(state, { version: 1, candidateIds: [] })).toThrow("INVALID_CUT");
    expect(() => cutFragments(state, { version: 1, candidateIds: ["bad"] })).toThrow("UNKNOWN_CANDIDATE");
  });

  it("keeps an erased phrase forbidden until the player writes it back", () => {
    const state = game();
    state.forbidden = ["邮局"];
    const composition = composeTurn(state, { version: 1, fragmentIds: ids(state, "她", "回到", "邮局"), punctuation: "。" });
    expect(composition.nextForbidden).not.toContain("邮局");
    expect(composition.nextHand.some((item) => item.text === "邮局")).toBe(false);
  });

  it("applies place, memory, and letter erasure to structured world state", () => {
    const state = game();
    state.phase = "cut";
    state.cutBudget = 12;
    state.hand = [];
    state.world = { letterExists: true, locationKnown: true, remembersSender: true, hasLetter: true, readLetter: true, understoodLetter: true, departed: false };
    state.candidates = [
      { id: "place", text: "站台", role: "place", start: 0, end: 2 },
      { id: "memory", text: "她记得", role: "memory", start: 3, end: 6 },
    ];
    const next = cutFragments(state, { version: 1, candidateIds: ["place", "memory"] });
    expect(next.world.locationKnown).toBe(false);
    expect(next.world.remembersSender).toBe(false);
  });

  it("stops after five generated turns and resolves deterministic endings", () => {
    const state = game();
    state.turn = 4;
    const composition = composeTurn(state, { version: 1, fragmentIds: ids(state, "她", "读完了", "那封信"), punctuation: "。" });
    composition.world.understoodLetter = true;
    const afterModel = applyModelTurn(state, composition, output());
    expect(afterModel.turn).toBe(5);
    expect(afterModel.phase).toBe("cut");
    const final = cutFragments(afterModel, { version: 2, candidateIds: [afterModel.candidates[0].id] });
    expect(final.phase).toBe("complete");
    expect(final.result?.outcome).toBe("success");

    expect(resolveResult({ ...final, world: { ...final.world, understoodLetter: false } }, "她读完了信？", "？").outcome).toBe("open-ending");
    expect(resolveResult({ ...final, world: { ...final.world, letterExists: false, understoodLetter: false } }, "她读完了信。", "。").outcome).toBe("history-hollow");
    expect(resolveResult({ ...final, world: { ...final.world, understoodLetter: false } }, undefined, "。").outcome).toBe("cannot-write");
    expect(resolveResult({ ...final, world: { ...final.world, understoodLetter: false } }, "她读完了信。", "。").outcome).toBe("world-rejected");
  });

  it("rejects turns after the fifth cut", () => {
    const state = game();
    state.phase = "complete";
    state.turn = 5;
    expect(() => composeTurn(state, { version: 1, fragmentIds: [], punctuation: "。" as Punctuation })).toThrow("TURN_NOT_ALLOWED");
  });
});
