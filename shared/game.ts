import type {
  CandidateFragment,
  CutInput,
  Fragment,
  FragmentRole,
  GameResult,
  GameState,
  ModelTurnOutput,
  Punctuation,
  TurnInput,
  WorldState,
} from "./types";

export const MAX_TURNS = 5;
export const MAX_HAND_GLYPHS = 24;
export const INITIAL_GOAL = "在天亮以前，让她亲手读到并理解那封信。";

const roles = new Set<FragmentRole>(["subject", "time", "action", "object", "place", "memory", "connector"]);
const progressActions = {
  locate: /回到|抵达|来到|找到.*地方|确认.*位置/,
  acquire: /找到|取回|拿到|收到|推开|打开/,
  read: /读|看完|拆开/,
  understand: /读懂|理解|明白|想起/,
};

export function glyphLength(text: string): number {
  return [...text].length;
}

export function createInitialGame(id: string, expiresAt: number): GameState {
  return {
    id,
    version: 1,
    phase: "compose",
    turn: 0,
    maxTurns: MAX_TURNS,
    goal: INITIAL_GOAL,
    hand: [
      fragment("她", "subject"),
      fragment("在天亮前", "time"),
      fragment("回到", "action"),
      fragment("邮局", "place"),
      fragment("寻找", "action"),
      fragment("那封信", "object"),
      fragment("读完了", "action"),
      fragment("仍然记得", "memory"),
    ],
    forbidden: [],
    manuscript: [
      { id: "opening-1", turn: 0, text: "雨水模糊了末班车站的灯。她在这里等一封多年没有寄出的信。" },
      { id: "opening-2", turn: 0, text: "天亮以后她会离开这座城，邮局的旧窗口也将永远关闭。" },
    ],
    candidates: [],
    cutBudget: 0,
    world: {
      letterExists: true,
      locationKnown: false,
      remembersSender: true,
      hasLetter: false,
      readLetter: false,
      understoodLetter: false,
      departed: false,
    },
    expiresAt,
  };
}

export function composeTurn(state: GameState, input: TurnInput): {
  sentence: string;
  nextHand: Fragment[];
  nextForbidden: string[];
  cutBudget: number;
  world: WorldState;
} {
  if (state.phase !== "compose") throw new Error("TURN_NOT_ALLOWED");
  if (input.version !== state.version) throw new Error("VERSION_CONFLICT");
  if (!Array.isArray(input.fragmentIds) || input.fragmentIds.length < 2 || input.fragmentIds.length > 5) throw new Error("INVALID_SENTENCE");
  if (!(["。", "？", "“”"] as Punctuation[]).includes(input.punctuation)) throw new Error("INVALID_PUNCTUATION");
  if (new Set(input.fragmentIds).size !== input.fragmentIds.length) throw new Error("DUPLICATE_FRAGMENT");

  const selected = input.fragmentIds.map((id) => state.hand.find((item) => item.id === id));
  if (selected.some((item) => !item)) throw new Error("UNKNOWN_FRAGMENT");
  const fragments = selected as Fragment[];
  const body = fragments.map((item) => item.text).join("");
  const sentence = input.punctuation === "“”" ? `“${body}”` : `${body}${input.punctuation}`;
  const selectedIds = new Set(input.fragmentIds);
  const nextHand = state.hand.filter((item) => !selectedIds.has(item.id));
  const usedText = new Set(fragments.map((item) => item.text));
  const nextForbidden = state.forbidden.filter((item) => !usedText.has(item));
  const asserted = input.punctuation === "。";
  const hasRole = (role: FragmentRole) => fragments.some((item) => item.role === role);
  const actionText = fragments.filter((item) => item.role === "action").map((item) => item.text).join("");
  const hasLetterObject = fragments.some((item) => item.role === "object" && item.text.includes("信"));
  const world = { ...state.world };

  if (asserted && hasRole("place") && progressActions.locate.test(`${actionText}${body}`)) world.locationKnown = true;
  if (asserted && state.world.locationKnown && hasLetterObject && progressActions.acquire.test(actionText)) world.hasLetter = true;
  if (asserted && state.world.hasLetter && hasLetterObject && progressActions.read.test(actionText)) world.readLetter = true;
  if (asserted && state.world.readLetter && hasLetterObject && progressActions.understand.test(actionText)) world.understoodLetter = true;

  return { sentence, nextHand, nextForbidden, cutBudget: glyphLength(body), world };
}

export function validateModelOutput(value: unknown, forbidden: string[]): ModelTurnOutput {
  if (!value || typeof value !== "object") throw new Error("INVALID_MODEL_OUTPUT");
  const record = value as Record<string, unknown>;
  if (typeof record.narrative !== "string") throw new Error("INVALID_MODEL_OUTPUT");
  const narrative = record.narrative.trim();
  const length = glyphLength(narrative);
  if (length < 40 || length > 60) throw new Error("INVALID_NARRATIVE_LENGTH");
  if (forbidden.some((text) => narrative.includes(text))) throw new Error("FORBIDDEN_FRAGMENT_REAPPEARED");
  if (!Array.isArray(record.candidates) || record.candidates.length < 3 || record.candidates.length > 7) throw new Error("INVALID_CANDIDATES");

  const seen = new Set<string>();
  const candidates = record.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") throw new Error("INVALID_CANDIDATE");
    const item = candidate as Record<string, unknown>;
    if (typeof item.text !== "string" || typeof item.role !== "string" || !roles.has(item.role as FragmentRole)) throw new Error("INVALID_CANDIDATE");
    const text = item.text.trim();
    if (glyphLength(text) < 1 || glyphLength(text) > 6 || seen.has(text) || !narrative.includes(text)) throw new Error("INVALID_CANDIDATE");
    seen.add(text);
    return { text, role: item.role as FragmentRole };
  });
  return { narrative, candidates };
}

export function materializeCandidates(output: ModelTurnOutput): CandidateFragment[] {
  return output.candidates.map((candidate, index) => {
    const start = output.narrative.indexOf(candidate.text);
    return {
      id: crypto.randomUUID(),
      text: candidate.text,
      role: candidate.role,
      start,
      end: start + candidate.text.length,
    };
  });
}

export function applyModelTurn(
  state: GameState,
  composition: ReturnType<typeof composeTurn>,
  output: ModelTurnOutput,
): GameState {
  const turn = state.turn + 1;
  const next: GameState = {
    ...state,
    version: state.version + 1,
    turn,
    phase: "cut",
    hand: composition.nextHand,
    forbidden: composition.nextForbidden,
    cutBudget: composition.cutBudget,
    candidates: materializeCandidates(output),
    world: composition.world,
    manuscript: [...state.manuscript, {
      id: crypto.randomUUID(),
      turn,
      playerSentence: composition.sentence,
      text: `${composition.sentence}${output.narrative}`,
    }],
  };
  return next;
}

export function cutFragments(state: GameState, input: CutInput): GameState {
  if (state.phase !== "cut") throw new Error("CUT_NOT_ALLOWED");
  if (input.version !== state.version) throw new Error("VERSION_CONFLICT");
  if (!Array.isArray(input.candidateIds) || input.candidateIds.length < 1 || input.candidateIds.length > 2) throw new Error("INVALID_CUT");
  if (new Set(input.candidateIds).size !== input.candidateIds.length) throw new Error("DUPLICATE_FRAGMENT");
  const selected = input.candidateIds.map((id) => state.candidates.find((item) => item.id === id));
  if (selected.some((item) => !item)) throw new Error("UNKNOWN_CANDIDATE");
  const candidates = selected as CandidateFragment[];
  if (candidates.reduce((sum, item) => sum + glyphLength(item.text), 0) > state.cutBudget) throw new Error("CUT_BUDGET_EXCEEDED");

  const texts = [...new Set(candidates.map((item) => item.text))];
  const manuscript = state.manuscript.map((paragraph) => ({
    ...paragraph,
    text: texts.reduce((text, removed) => text.replaceAll(removed, "□".repeat(glyphLength(removed))), paragraph.text),
  }));
  const handByText = new Map(state.hand.map((item) => [item.text, item]));
  for (const candidate of candidates) handByText.set(candidate.text, { id: crypto.randomUUID(), text: candidate.text, role: candidate.role });
  const hand = [...handByText.values()];
  if (hand.reduce((sum, item) => sum + glyphLength(item.text), 0) > MAX_HAND_GLYPHS) throw new Error("HAND_CAPACITY_EXCEEDED");

  const world = applyErasureEffects(state.world, candidates);
  const forbidden = [...new Set([...state.forbidden, ...texts])];
  const next: GameState = {
    ...state,
    version: state.version + 1,
    phase: state.turn >= state.maxTurns ? "failed" : "compose",
    hand,
    forbidden,
    manuscript,
    candidates: [],
    cutBudget: 0,
    world,
  };
  if (state.turn >= state.maxTurns) {
    const finalSentence = [...manuscript].reverse().find((item) => item.playerSentence)?.playerSentence;
    const punctuation: Punctuation | undefined = finalSentence?.startsWith("“") ? "“”"
      : finalSentence?.endsWith("？") ? "？"
        : finalSentence?.endsWith("。") ? "。" : undefined;
    next.result = resolveResult(next, finalSentence, punctuation);
    next.phase = next.result.outcome === "success" ? "complete" : "failed";
  }
  return next;
}

export function resolveResult(state: GameState, finalSentence?: string, punctuation?: Punctuation): GameResult {
  if (punctuation === "？") return { outcome: "open-ending", title: "故事没有落笔", summary: "最后一个问号让清晨保持未决。", finalSentence };
  if (state.world.understoodLetter && finalSentence) {
    return { outcome: "success", title: "信终于被读懂", summary: "你搬运过的文字在天亮前重新组成了一个可以成立的事实。", finalSentence };
  }
  if (!state.world.letterExists || !state.world.remembersSender) return { outcome: "history-hollow", title: "过去失去了名字", summary: "关键历史被剪得过于空洞，结局已无从指向。", finalSentence };
  if (!finalSentence) return { outcome: "cannot-write", title: "最后一句没有写成", summary: "可用的意义不足以完成命运句。" };
  return { outcome: "world-rejected", title: "世界拒绝了这句话", summary: "句子可以被写下，但现存事实不足以支撑它。", finalSentence };
}

function applyErasureEffects(world: WorldState, candidates: CandidateFragment[]): WorldState {
  const next = { ...world };
  for (const candidate of candidates) {
    if (candidate.role === "place") next.locationKnown = false;
    if (candidate.role === "memory") next.remembersSender = false;
    if (candidate.role === "object" && candidate.text.includes("信")) {
      next.hasLetter = false;
      next.readLetter = false;
      next.understoodLetter = false;
    }
  }
  return next;
}

function fragment(text: string, role: FragmentRole): Fragment {
  return { id: crypto.randomUUID(), text, role };
}
