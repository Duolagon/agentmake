// 数据流：上游这一步产出了多少、其中多少真的进了下游的 prompt。
//
// 这是「看得见数据流」的核心。agent 最常见的一类 bug 根本不报错：
//   load_history 返回 12 条 → analyze 的 prompt 里只出现了最后 5 条（代码里一个 slice(-5)）
//   抓了 7 个信源 → 拼进 prompt 的只有前 2 个（字符串截断）
// 日志里每一步都是 200。只有把上游的输出和下游的输入摆在一起对照，才看得出数据在哪丢了。
//
// 对照方法是「探针」：从上游输出里取若干段有辨识度的文本，看它们是否出现在下游 prompt 里。
//   - 输出是 JSON 列表（或带一个主列表的对象）→ 每一条取一个探针，数「几条进去了」
//   - 其他文本 → 切成句子取样，算「百分之多少进去了」
// 刻意只做子串匹配、不做语义相似度：要的是确定性和可解释 —— 「这一条没出现」用户能自己核对。

import { messageFullText, toolCallText } from '../shared/tooltext.ts';
import type { MessageIR, ToolCallIR } from '../shared/types.ts';

export type DataCall = {
  kind: string;
  system?: string | null;
  messages?: string | null;
  response_text?: string | null;
  response_tool_calls?: string | null;
  response_body?: string | null;
  response_bytes?: number | null;
  body_truncated?: number | null;
  output_tokens?: number | null;
};

export type Output = {
  text: string;
  bytes: number;
  /** 输出是列表时的条数；不是列表为 null */
  items: number | null;
  /** 体积被截断过（只读了前 256KB）—— 条数和覆盖率都可能偏低 */
  truncated: boolean;
  tokens: number | null;
};

export type Measure = {
  bytes: number;
  items: number | null;
  /** 列表里有几条出现在了下游 prompt 里 */
  used: number | null;
  /** 非列表：探针命中比例 0~1 */
  coverage: number | null;
  tokens: number | null;
  truncated: boolean;
  /** 列表里没进 prompt 的几条（最多 3 条，各截 60 字）—— 对比表上一眼看出丢的是什么 */
  missing?: string[];
};

const parse = (s: unknown, d: unknown) => {
  try {
    return JSON.parse(String(s)) ?? d;
  } catch {
    return d;
  }
};

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

/** 一次调用交给下游的东西：工具是响应体，模型是回答正文 + 它发起的工具调用 */
export function outputOf(c: DataCall): Output {
  if (c.kind === 'http') {
    const text = c.response_body ?? '';
    return {
      text,
      bytes: c.response_bytes ?? byteLen(text),
      items: c.body_truncated ? null : itemCount(parseJson(text)),
      truncated: !!c.body_truncated,
      tokens: null,
    };
  }
  const calls = (parse(c.response_tool_calls, []) as ToolCallIR[]).map(toolCallText);
  const text = [c.response_text ?? '', ...calls].filter(Boolean).join('\n');
  return { text, bytes: byteLen(text), items: null, truncated: false, tokens: c.output_tokens ?? null };
}

/** 下游这次调用实际看到的全部文本（system + 每条消息的完整内容） */
export function promptOf(c: DataCall): string {
  const msgs = parse(c.messages, []) as MessageIR[];
  return norm([c.system ?? '', ...msgs.map(messageFullText)].join('\n'));
}

/**
 * 一批上游调用（比如并发抓的 7 个信源）对下游这次调用的贡献。
 * 下游不是模型调用时只报体积 —— 普通 HTTP 请求体我们不存，没有可对照的东西。
 */
export function measure(producers: DataCall[], consumer: DataCall): Measure {
  const outs = producers.map(outputOf);
  const bytes = outs.reduce((n, o) => n + o.bytes, 0);
  const truncated = outs.some((o) => o.truncated);
  const tokens = outs.every((o) => o.tokens == null) ? null : outs.reduce((n, o) => n + (o.tokens ?? 0), 0);
  const itemsKnown = outs.length > 0 && outs.every((o) => o.items != null);
  const items = itemsKnown ? outs.reduce((n, o) => n + (o.items ?? 0), 0) : null;

  if (consumer.kind !== 'llm') return { bytes, items, used: null, coverage: null, tokens, truncated };
  const hay = promptOf(consumer);
  if (!hay) return { bytes, items, used: null, coverage: null, tokens, truncated };

  if (itemsKnown && items) {
    let probed = 0;
    let used = 0;
    const missing: string[] = [];
    for (const o of outs) {
      for (const it of listOf(parseJson(o.text)) ?? []) {
        const p = probeOfItem(it);
        if (!p) continue;
        probed++;
        if (hay.includes(p)) used++;
        else if (missing.length < 3) missing.push(longestText(it).slice(0, 60));
      }
    }
    // 列表里全是数字、短码之类取不出探针的 —— 报条数，不下结论
    if (probed) return { bytes, items: probed, used, coverage: used / probed, tokens, truncated, missing };
    return { bytes, items, used: null, coverage: null, tokens, truncated };
  }

  const probes = outs.flatMap((o) => textProbes(o.text));
  if (probes.length < 2) return { bytes, items, used: null, coverage: null, tokens, truncated };
  const hit = probes.filter((p) => hay.includes(p)).length;
  return { bytes, items, used: null, coverage: hit / probes.length, tokens, truncated };
}

/** 判定「数据在进 prompt 前被丢掉了」—— 宁可少报：误报会让人很快不再相信这条提示 */
export function isDropped(m: Measure): boolean {
  if (m.items != null && m.used != null) return m.items >= 2 && m.used < m.items;
  return m.coverage != null && m.coverage < 0.5;
}

// ── 列表与探针 ─────────────────────────────────────────────

export function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t || (t[0] !== '[' && t[0] !== '{')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** 顶层是数组，或对象里有一个「主列表」（items / data / messages 之类，取最长的那个） */
export function listOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return null;
  let best: unknown[] | null = null;
  for (const x of Object.values(v as Record<string, unknown>)) {
    if (Array.isArray(x) && x.length >= 2 && (!best || x.length > best.length)) best = x;
  }
  return best;
}

function itemCount(v: unknown): number | null {
  const l = listOf(v);
  return l ? l.length : null;
}

/** 一条的探针：它最长的那段文字的开头。太短的（「ok」「投诉」）不用 —— 几乎必然误中 */
export function probeOfItem(it: unknown): string | null {
  const best = longestText(it);
  if (!best || best.length < 6) return null;
  return best.slice(0, 24);
}

/** 一条里最有内容的那段文字（对象取最长的字符串字段） */
export function longestText(it: unknown): string {
  const strs: string[] = [];
  collectStrings(it, strs, 0);
  return strs.map(norm).sort((a, b) => b.length - a.length)[0] ?? '';
}

function collectStrings(v: unknown, out: string[], depth: number): void {
  if (depth > 3 || out.length > 50) return;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
}

/**
 * 非列表文本的探针：按句切开，每句取中间一段。
 * 取中间而不是开头 —— 下游常给每段加前缀（「资料 1：」「- 」），开头最容易对不上。
 * JSON 先解开取字符串叶子，不然转义（\n、\"）会让本来在 prompt 里的内容也匹配不上。
 */
function textProbes(text: string): string[] {
  const json = parseJson(text);
  const pieces: string[] = [];
  if (json !== undefined) collectStrings(json, pieces, 0);
  else pieces.push(text);
  const sentences = pieces
    .flatMap((p) => p.split(/[\n。！？!?；;]+/))
    .map(norm)
    .filter((s) => s.length >= 10);
  const step = Math.max(1, Math.floor(sentences.length / 60));
  const out: string[] = [];
  for (let i = 0; i < sentences.length && out.length < 60; i += step) {
    const s = sentences[i];
    const mid = Math.max(0, Math.floor(s.length / 2) - 8);
    out.push(s.slice(mid, mid + 16));
  }
  return out;
}
