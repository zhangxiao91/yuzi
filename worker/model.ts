import { validateModelOutput } from "../shared/game";
import type { GameState, ModelTurnOutput } from "../shared/types";
import type { Env } from "./env";

interface GatewayResponse {
  ok?: boolean;
  data?: { json?: unknown };
  error?: { code?: string };
}

export async function generateTurn(env: Env, state: GameState, sentence: string, forbidden: string[]): Promise<ModelTurnOutput> {
  const first = await callGateway(env, state, sentence, forbidden, undefined);
  try {
    return validateModelOutput(first, forbidden);
  } catch (error) {
    const repaired = await callGateway(env, state, sentence, forbidden, {
      reason: error instanceof Error ? error.message : "INVALID_MODEL_OUTPUT",
      previous: first,
    });
    return validateModelOutput(repaired, forbidden);
  }
}

async function callGateway(
  env: Env,
  state: GameState,
  sentence: string,
  forbidden: string[],
  repair: { reason: string; previous: unknown } | undefined,
): Promise<unknown> {
  const system = [
    "你是生成式文字游戏《余字》的世界叙述器，不是玩家的代笔作者。",
    "严格输出 JSON：{\"narrative\":string,\"candidates\":[{\"text\":string,\"role\":\"subject|time|action|object|place|memory|connector\"}] }。",
    "narrative 必须为 40 至 60 个中文字符，只推进一个事件，直接回应玩家句子，不得擅自宣布目标完成。",
    "候选意群必须有 3 至 7 个，均为 narrative 中真实存在的连续 1 至 6 字片段，不重复。",
    "根据进度自然提供下一步可用意群：先确认邮局，再找到信，再读信，最后理解内容。",
    "禁用意群不得以完全相同的字面形式出现；使用代称或其他表达。",
    "不要输出 Markdown、解释、状态或额外字段。",
  ].join("\n");
  const user = JSON.stringify({
    turn: state.turn + 1,
    maxTurns: state.maxTurns,
    goal: state.goal,
    playerSentence: sentence,
    world: state.world,
    forbidden,
    recentManuscript: state.manuscript.slice(-4).map((item) => item.text),
    ...(repair ? { repair } : {}),
  });
  const response = await fetch(env.AI_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.ZXLAB_AI_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      task: "yuzi-turn",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      responseFormat: { type: "json" },
      context: { source: "yuzi", operation: repair ? "repair-turn" : "generate-turn", metadata: { turn: state.turn + 1 } },
    }),
  });
  const payload = await response.json().catch(() => ({})) as GatewayResponse;
  if (!response.ok || !payload.ok || payload.data?.json === undefined) {
    throw new Error(`AI_GATEWAY_${payload.error?.code ?? response.status}`);
  }
  return payload.data.json;
}
