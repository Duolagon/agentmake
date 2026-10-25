// 规则型失败判定 —— HTTP 200、但回答其实已经坏了的那一类。
//
// find_failures 以前只认 `ok = 0 OR error`，于是「被截断」「什么都没说」「工具参数是坏 JSON」
// 这些在日志里全是成功。它们不需要模型来判断，看响应形状就够了：零成本、确定性、可以落库时就算。
//
// 只记失败，不记通过：每次调用 × 每条规则都写一行「通过」会让表膨胀几倍，而通过率可以由
// 「检查过的调用数 − 失败数」推出来（calls.rules_checked 标记检查过没有）。

import type { ToolCallIR, ToolDefIR } from '../shared/types.ts';

export type RuleInput = {
  kind: string;
  ok: number | null;
  status: number | null;
  faked?: number | null;
  finish_reason: string | null;
  response_text: string | null;
  response_tool_calls: string | null;
  tools: string | null;
  streaming?: number | null;
};

export type RuleHit = { name: string; comment: string };

/** 页面和 MCP 上给人看的名字。键就是落库的 score name —— 稳定，别随便改 */
export const RULE_LABELS: Record<string, string> = {
  'rule.truncated': '被截断',
  'rule.empty_output': '空输出',
  'rule.tool_args_invalid': '工具参数坏了',
  'rule.unknown_tool': '调了不存在的工具',
  'rule.blocked': '被安全策略拦截',
};

// finish reason 各家写法不同，统一小写比较
const TRUNCATED = new Set(['length', 'max_tokens', 'model_context_window_exceeded', 'max_output_tokens']);
const BLOCKED = new Set(['content_filter', 'safety', 'refusal', 'recitation', 'prohibited_content', 'blocklist', 'spii']);

const parse = <T>(s: string | null, d: T): T => {
  try {
    return (JSON.parse(String(s)) ?? d) as T;
  } catch {
    return d;
  }
};

export function checkCall(c: RuleInput): RuleHit[] {
  // HTTP 失败已经是失败了，不再叠判；伪造的回答是用户自己写的，不评它
  if (c.kind !== 'llm' || !c.ok || c.status == null || c.faked) return [];

  const hits: RuleHit[] = [];
  const finish = (c.finish_reason ?? '').toLowerCase();
  const calls = parse<ToolCallIR[]>(c.response_tool_calls, []);
  const text = (c.response_text ?? '').trim();

  if (TRUNCATED.has(finish)) {
    hits.push({
      name: 'rule.truncated',
      comment: `finish_reason=${c.finish_reason}：输出到了 token 上限被截断，下游拿到的是半截内容。调大 maxTokens 或缩短输入`,
    });
  }

  if (BLOCKED.has(finish)) {
    hits.push({ name: 'rule.blocked', comment: `finish_reason=${c.finish_reason}：模型拒绝或被安全策略拦截` });
  }

  // 流式响应目前只标记不解析，正文本来就是空的 —— 不能据此判「什么都没说」
  // reasoning_only：Codex 的模型只想了一下、什么都没发（在等后台的子 agent / 异步结果回来）—— 那是正常的让出，不是空输出
  if (!text && calls.length === 0 && !c.streaming && c.finish_reason !== 'reasoning_only') {
    hits.push({ name: 'rule.empty_output', comment: '模型既没有输出文本，也没有调用工具' });
  }

  const bad = calls.filter((x) => x.argsInvalid);
  if (bad.length) {
    hits.push({
      name: 'rule.tool_args_invalid',
      comment: `工具参数不是合法 JSON：${bad.map((x) => x.name).join(', ')}。下游 JSON.parse 会直接抛错`,
    });
  }

  // 请求里没声明工具时不判 —— 可能是 Gemini 内置检索之类不在 tools 数组里的能力
  const declared = new Set(parse<ToolDefIR[]>(c.tools, []).map((t) => t.name));
  if (declared.size) {
    const unknown = calls.filter((x) => !declared.has(x.name)).map((x) => x.name);
    if (unknown.length) {
      hits.push({
        name: 'rule.unknown_tool',
        comment: `调用了请求里没有声明的工具：${unknown.join(', ')}（声明的是 ${[...declared].join(', ')}）`,
      });
    }
  }

  return hits;
}
