// 完整记录：把一次运行还原成「对话」—— 任务 → 模型回答 → 它调了哪些工具、拿到什么 → 下一轮 ……
//
// 原料是一次次模型调用，但每次调用发出去的都是**整段对话**（第 30 轮的 prompt 里带着前 29 轮），
// 直接挨个摆出来就是 30 份越来越长的重复。这里按「接着谁往下说」还原成一条时间线：
//   · 这次调用的 messages 以之前某次调用的 messages 开头 → 它是那次的下一轮，只显示多出来的部分
//     （通常是工具结果、新的用户消息），上一轮模型自己的回答不再重复
//   · 接不上任何一次（换了 system prompt 的旁路调用、上下文被压缩重写）→ 单独一条
// 系统提示、全量 prompt、原始请求 / 响应都不在这里铺开 —— 点一条再看那次调用的完整详情。

import type { MessageIR, ToolCallIR, ToolResultIR } from '../shared/types.ts';
import { splitInjected } from './history.ts';

export type TranscriptCall = {
  call_id: string;
  run_id: string;
  kind: string;
  model: string | null;
  url: string | null;
  method: string | null;
  status: number | null;
  ok: number | null;
  error: string | null;
  system: string | null;
  messages: string | null;
  response_text: string | null;
  response_tool_calls: string | null;
  finish_reason: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  started_at: number | null;
  response_preview: string | null;
  response_bytes: number | null;
};

export type TMessage = {
  role: string;
  text: string;
  truncated?: boolean;
  /** 框架拼在用户消息后面的运行时上下文（dsh 的 Current runtime context…），默认折起来 */
  context?: string;
  toolCalls?: { name: string; args: string }[];
  toolResults?: { name: string; text: string; truncated?: boolean; isError?: boolean }[];
};

export type TItem =
  | { kind: 'run'; runId: string; trigger: string | null; t: number | null }
  | {
      kind: 'llm';
      callId: string;
      runId: string;
      t: number | null;
      /** 第几轮（同一条对话里），旁路调用没有 */
      round: number | null;
      /** 这条对话是谁：主线（调用最多的那条）不标；旁路用 system prompt 的开头当名字 */
      thread: string | null;
      side: boolean;
      /** 接不上之前的对话（换了上下文 / 被压缩），这次的输入整段都算新的 */
      restart: boolean;
      model: string | null;
      ms: number | null;
      tokensIn: number | null;
      tokensOut: number | null;
      cache: number | null;
      pending: boolean;
      error: string | null;
      finish: string | null;
      input: TMessage[];
      reply: TMessage | null;
    }
  | {
      kind: 'http';
      callId: string;
      runId: string;
      t: number | null;
      method: string;
      url: string;
      status: number | null;
      ok: boolean;
      ms: number | null;
      bytes: number | null;
      preview: string | null;
    };

export type Transcript = {
  /** 交给 agent 的任务（主线第一条用户消息） */
  task: TMessage | null;
  items: TItem[];
  llm: number;
  tool: number;
};

/** 单段文字的上限 —— 一轮工具结果可能几十 KB，完整的点进去看 */
const MAX_TEXT = 6000;

const clip = (s: string, max = MAX_TEXT): { text: string; truncated?: boolean } =>
  s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s };

const parse = <T>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try {
    return (JSON.parse(s) as T) ?? d;
  } catch {
    return d;
  }
};

const argText = (c: ToolCallIR) => (typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}));

/** 两条消息是不是同一条（比对话前缀用）—— 正文 + 工具调用 + 工具结果都要一样 */
function same(a: MessageIR, b: MessageIR): boolean {
  if (a.role !== b.role || a.content !== b.content) return false;
  const ca = (a.toolCalls ?? []).map((c) => `${c.name}:${argText(c)}`).join('|');
  const cb = (b.toolCalls ?? []).map((c) => `${c.name}:${argText(c)}`).join('|');
  if (ca !== cb) return false;
  const ra = (a.toolResults ?? []).map((r) => r.content).join('|');
  const rb = (b.toolResults ?? []).map((r) => r.content).join('|');
  return ra === rb;
}

/**
 * prefix 是不是 all 的开头。只抽查首、中、尾三条 —— 逐条比的话，100 轮的 agent 每轮几百条消息、
 * 每条几 KB，两两比下来是上亿次字符比较；而真正「接着往下说」的对话首尾都对得上，抽查足够区分
 */
function isPrefix(prefix: MessageIR[], all: MessageIR[]): boolean {
  const n = prefix.length;
  if (!n || n > all.length) return false;
  for (const i of new Set([0, n >> 1, n - 1])) if (!same(prefix[i], all[i])) return false;
  return true;
}

export function buildTranscript(calls: TranscriptCall[], triggers: Map<string, string | null> = new Map()): Transcript {
  const llm = calls.filter((c) => c.kind === 'llm');
  // 主线 = 调用最多的那个 system prompt（agent 循环）；其余的是旁路（起标题、压缩上下文、子任务）
  const bySystem = new Map<string, number>();
  for (const c of llm) bySystem.set(c.system ?? '', (bySystem.get(c.system ?? '') ?? 0) + 1);
  const mainSystem = [...bySystem].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  /** 已经出现过的对话：每次调用发出去的 messages + 它的回答，下一轮就接在它后面 */
  const seen: { msgs: MessageIR[]; withReply: MessageIR[]; system: string; round: number }[] = [];
  /** 工具调用 id → 工具名（Anthropic 的工具结果里只有 id） */
  const toolName = new Map<string, string>();

  const items: TItem[] = [];
  let task: TMessage | null = null;
  let lastRun: string | null = null;
  const multiRun = new Set(calls.map((c) => c.run_id)).size > 1;

  for (const c of [...calls].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))) {
    if (multiRun && c.run_id !== lastRun) {
      items.push({ kind: 'run', runId: c.run_id, trigger: triggers.get(c.run_id) ?? null, t: c.started_at });
    }
    lastRun = c.run_id;

    if (c.kind !== 'llm') {
      items.push({
        kind: 'http',
        callId: c.call_id,
        runId: c.run_id,
        t: c.started_at,
        method: c.method ?? 'GET',
        url: c.url ?? '',
        status: c.status,
        ok: c.ok !== 0 && !c.error,
        ms: c.duration_ms,
        bytes: c.response_bytes,
        preview: c.response_preview,
      });
      continue;
    }

    const msgs = parse<MessageIR[]>(c.messages, []);
    const replyCalls = parse<ToolCallIR[]>(c.response_tool_calls, []);
    for (const m of msgs) for (const tc of m.toolCalls ?? []) if (tc.id) toolName.set(tc.id, tc.name);
    for (const tc of replyCalls) if (tc.id) toolName.set(tc.id, tc.name);

    // 接在哪一次后面：messages 以它（连同它的回答）开头、而且最长的那一次
    const system = c.system ?? '';
    // 从最近的往回找：下一轮几乎总是接在同一条对话的上一次后面，找到最长的那个就停
    let base: (typeof seen)[number] | null = null;
    let tried = 0;
    for (let i = seen.length - 1; i >= 0 && tried < 8; i--) {
      const s = seen[i];
      if (s.system !== system) continue;
      tried++;
      const pre = isPrefix(s.withReply, msgs) ? s.withReply : isPrefix(s.msgs, msgs) ? s.msgs : null;
      if (pre && (!base || pre.length > base.withReply.length)) base = { ...s, withReply: pre, msgs: s.msgs };
      if (base && base.withReply.length === s.withReply.length) break;
    }
    let fresh = base ? msgs.slice(base.withReply.length) : msgs;
    // 接在上一次后面、但没对上它的回答（框架回传历史时改了格式：思考过程、工具块的写法）——
    // 紧跟着的那条助手消息就是上一轮的回答，上一轮已经显示过了
    if (base && base.withReply === base.msgs && fresh[0]?.role === 'assistant') fresh = fresh.slice(1);
    const round = base ? base.round + 1 : 1;

    const input = fresh.map((m) => toTMessage(m, toolName));
    const side = system !== mainSystem;
    if (!task && !side) {
      const first = msgs.find((m) => m.role === 'user' && m.content && !(m.toolResults ?? []).length);
      if (first) task = toTMessage(first, toolName);
    }

    const reply: TMessage | null = c.response_text || replyCalls.length
      ? {
          role: 'assistant',
          ...clip(c.response_text ?? ''),
          ...(replyCalls.length ? { toolCalls: replyCalls.map((x) => ({ name: x.name, args: clip(argText(x), 2000).text })) } : {}),
        }
      : null;

    items.push({
      kind: 'llm',
      callId: c.call_id,
      runId: c.run_id,
      t: c.started_at,
      round: side ? null : round,
      thread: side ? (system.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 60) || '另一个对话' : null,
      side,
      restart: !side && !base && seen.some((s) => s.system === system),
      model: c.model,
      ms: c.duration_ms,
      tokensIn: c.input_tokens,
      tokensOut: c.output_tokens,
      cache: c.cache_read_tokens,
      pending: c.duration_ms == null && c.ok == null && !c.error,
      error: c.error,
      finish: c.finish_reason,
      // 第一轮的那条用户消息已经作为「任务」摆在最上面了，不再重复
      input: !side && round === 1 && !seen.some((s) => s.system === system) && task
        ? input.filter((m) => !(m.role === 'user' && m.text === task!.text && !m.toolResults))
        : input,
      reply,
    });

    const replyMsg: MessageIR | null = reply
      ? { role: 'assistant', content: c.response_text ?? '', ...(replyCalls.length ? { toolCalls: replyCalls } : {}) }
      : null;
    seen.push({ msgs, withReply: replyMsg ? [...msgs, replyMsg] : msgs, system, round });
  }

  return { task, items, llm: llm.length, tool: calls.length - llm.length };
}

function toTMessage(m: MessageIR, toolName: Map<string, string>): TMessage {
  const results = m.toolResults ?? [];
  // OpenAI 的 tool 消息正文就是结果本身；Anthropic 的正文只剩「«toolResult»」占位
  const bodyIsResult = results.some((r) => r.content === m.content) || /^(\s*«[^»]*»\s*)+$/.test(m.content);
  const raw = bodyIsResult ? '' : m.content;
  const { main, context } = m.role === 'user' ? splitInjected(raw) : { main: raw, context: null };
  return {
    role: m.role,
    ...clip(main),
    ...(context ? { context: clip(context, 3000).text } : {}),
    ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((x) => ({ name: x.name, args: clip(argText(x), 2000).text })) } : {}),
    ...(results.length
      ? {
          toolResults: results.map((r: ToolResultIR) => {
            const t = clip(r.content, 4000);
            return { name: r.name ?? (r.callId ? toolName.get(r.callId) : undefined) ?? '工具', text: t.text, ...(t.truncated ? { truncated: true } : {}), ...(r.isError ? { isError: true } : {}) };
          }),
        }
      : {}),
  };
}
