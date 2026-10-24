// prompt 按来源拆开 —— 「追查」的核心。
//
// 看到一次调用答错了，下一个问题永远是「它当时到底看到了什么、这些东西从哪来」。
// 把 prompt 的每一段标上出处：
//   template  源码里写死的模板（定位到文件和行，可写回）
//   tool      哪一次工具调用的结果，第几条到第几条
//   llm       前面哪一步模型的回答
//   other     运行时拼出来、来源对不上的部分（变量、请求体、计算结果……）
// 再把「上游给了、却没进来」的那几条单独列出来，并在附近的代码里找可疑的截断写法（slice(-5) / [:5] / truncate）。
//
// 出处靠内容匹配（子串），不靠追踪变量 —— 跨语言、零侵入，代价是同样的文字出现在两个上游时会归给先找到的那个。

import { readFileSync } from 'node:fs';
import { listOf, longestText, outputOf, parseJson } from './dataflow.ts';
import { stepIdOf, wrapperSet, type CallRow } from './flow.ts';
import { analyze } from './writability.ts';
import type { Frame, MessageIR } from '../shared/types.ts';

export type SourceKind = 'template' | 'tool' | 'llm' | 'other';

export type Seg = {
  source: SourceKind;
  text: string;
  /** 原文长度（text 可能被截短展示） */
  length: number;
  /** 来自哪一步（工具 / 模型来源） */
  from: string | null;
  callId: string | null;
  /** 列表来源：命中的是第几条（从 1 数） */
  items: number[];
  /** 模板来源：源码位置 */
  file: string | null;
  line: number | null;
};

export type Part = { key: string; role: string; length: number; segments: Seg[] };

export type Dropped = {
  from: string;
  callId: string;
  total: number;
  used: number;
  items: { index: number; text: string }[];
};

export type Suspect = { file: string; line: number; code: string; reason: string };

export type Anatomy = {
  callId: string;
  parts: Part[];
  /** 各来源占 prompt 的字符数 */
  totals: Record<SourceKind, number>;
  dropped: Dropped[];
  suspects: Suspect[];
};

type Producer = { call: CallRow; label: string; kind: 'tool' | 'llm'; text: string; list: unknown[] | null; immediate: boolean };

const MAX_SEG_TEXT = 600;

const parse = <T>(s: unknown, d: T): T => {
  try {
    return (JSON.parse(String(s)) ?? d) as T;
  } catch {
    return d;
  }
};

/**
 * @param consumer  要拆的那次模型调用
 * @param runCalls  同一次运行里的全部调用（按 seq 排好）—— 上游只在这里面找
 */
export function anatomize(consumer: CallRow, runCalls: CallRow[], readFile: (f: string) => string | null = safeRead): Anatomy {
  const wrappers = wrapperSet(runCalls);
  const label = (c: CallRow) => stepIdOf(parse<Frame[]>(c.frames, []), c, wrappers).label;
  const stepOf = (c: CallRow) => stepIdOf(parse<Frame[]>(c.frames, []), c, wrappers).id;

  // 紧挨在它前面的那一批上游（和数据流图的连线同一个判定）
  const idx = runCalls.findIndex((c) => c.call_id === consumer.call_id);
  const before = runCalls.slice(0, idx < 0 ? runCalls.length : idx).filter((c) => c.duration_ms != null && c.ok);
  const immediate = new Set<string>();
  if (before.length) {
    const prevStep = stepOf(before[before.length - 1]);
    for (let i = before.length - 1; i >= 0 && stepOf(before[i]) === prevStep; i--) immediate.add(before[i].call_id);
  }

  const producers: Producer[] = before
    .map((c) => {
      const o = outputOf(c);
      return {
        call: c,
        label: label(c),
        kind: (c.kind === 'llm' ? 'llm' : 'tool') as 'tool' | 'llm',
        text: o.text,
        list: c.kind === 'http' && !c.body_truncated ? listOf(parseJson(o.text)) : null,
        immediate: immediate.has(c.call_id),
      };
    })
    .filter((p) => p.text.trim().length >= 6);

  const msgs = parse<MessageIR[]>(consumer.messages, []);
  const texts: { key: string; role: string; text: string }[] = [];
  if (consumer.system) texts.push({ key: 'system', role: 'system', text: consumer.system });
  msgs.forEach((m, i) => texts.push({ key: `message:${i}`, role: m.role, text: m.content ?? '' }));

  // 带上行号：同文件有两处一样的模板时，analyze 靠调用位置选对那一处
  const files = parse<Frame[]>(consumer.frames, []).map((f) => ({ file: f.file, line: f.line }));
  const totals: Record<SourceKind, number> = { template: 0, tool: 0, llm: 0, other: 0 };
  // 每个列表来源：哪几条在 prompt 里找到了
  const found = new Map<string, Set<number>>();

  const parts: Part[] = texts.map(({ key, role, text }) => {
    const n = text.length;
    // 每个字符的出处：0 = 来源不明，1 = 模板，≥ 2 = 第 (code - 2) 个上游
    const code = new Uint16Array(n);
    const itemAt = new Map<number, number>(); // 区间起点 → 第几条（从 1 数）

    // 模板：能在源码里对上的静态片段
    const w = analyze(text, files);
    if (w.writability === 'static_literal') code.fill(1);
    else if (w.writability === 'static_composed') {
      let from = 0;
      for (const sg of w.segments) {
        if (!sg.text) continue;
        const at = text.indexOf(sg.text, from);
        if (at < 0) continue;
        code.fill(1, at, at + sg.text.length);
        from = at + sg.text.length;
      }
    }

    // 上游：列表逐条找，其余逐句找。上游的内容盖过模板（插值处本来就不是模板）
    producers.forEach((p, pi) => {
      const mark = (at: number, len: number) => code.fill(pi + 2, at, Math.min(n, at + len));
      if (p.list) {
        p.list.forEach((it, ii) => {
          const full = longestText(it);
          if (full.length < 6) return;
          const hit = locate(text, full);
          if (!hit) return;
          mark(hit.at, hit.len);
          itemAt.set(hit.at, ii + 1);
          const set = found.get(p.call.call_id) ?? new Set<number>();
          set.add(ii + 1);
          found.set(p.call.call_id, set);
        });
      } else {
        for (const s of sentences(p.text)) {
          let from = 0;
          for (;;) {
            const at = text.indexOf(s, from);
            if (at < 0) break;
            mark(at, s.length);
            from = at + s.length;
          }
        }
      }
    });

    // 连续同出处的字符收成一段
    const segments: Seg[] = [];
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && code[i] === code[start]) continue;
      const c = code[start];
      const p = c >= 2 ? producers[c - 2] : null;
      const raw = text.slice(start, i);
      const source: SourceKind = c === 1 ? 'template' : p ? p.kind : 'other';
      // 只有空白的「来源不明」片段不值得单列（模板之间的换行）
      if (source === 'other' && !raw.trim()) {
        if (segments.length) segments[segments.length - 1].length += raw.length;
        start = i;
        continue;
      }
      const items = p?.list
        ? [...itemAt.entries()].filter(([at]) => at >= start && at < i).map(([, k]) => k).sort((a, b) => a - b)
        : [];
      totals[source] += raw.length;
      const prev = segments[segments.length - 1];
      if (prev && prev.source === source && prev.callId === (p?.call.call_id ?? null) && source !== 'other') {
        prev.text = (prev.text + raw).slice(0, MAX_SEG_TEXT);
        prev.length += raw.length;
        prev.items.push(...items);
      } else {
        segments.push({
          source,
          text: raw.slice(0, MAX_SEG_TEXT),
          length: raw.length,
          from: p?.label ?? null,
          callId: p?.call.call_id ?? null,
          items,
          file: source === 'template' ? w.file : null,
          line: source === 'template' ? w.line : null,
        });
      }
      start = i;
    }
    return { key, role, length: n, segments };
  });

  // 上游给了、却没进来的：用了一部分（典型的截断），或者紧挨着的上游一条都没用上
  const dropped: Dropped[] = [];
  for (const p of producers) {
    if (!p.list) continue;
    const used = found.get(p.call.call_id) ?? new Set<number>();
    const probed = p.list.map((it, i) => ({ i: i + 1, t: longestText(it) })).filter((x) => x.t.length >= 6);
    if (!probed.length || used.size >= probed.length) continue;
    if (used.size === 0 && !p.immediate) continue;
    dropped.push({
      from: p.label,
      callId: p.call.call_id,
      total: probed.length,
      used: used.size,
      items: probed.filter((x) => !used.has(x.i)).slice(0, 20).map((x) => ({ index: x.i, text: x.t.slice(0, 160) })),
    });
  }

  return {
    callId: consumer.call_id,
    parts,
    totals,
    dropped,
    suspects: dropped.length ? findSuspects(parse<Frame[]>(consumer.frames, []), readFile) : [],
  };
}

/** 找一条内容在 prompt 里的位置：先找全文，找不到退到开头 24 个字（下游常把长内容截短） */
function locate(text: string, full: string): { at: number; len: number } | null {
  const whole = text.indexOf(full);
  if (whole >= 0) return { at: whole, len: full.length };
  const head = full.slice(0, 24);
  const at = text.indexOf(head);
  return at >= 0 ? { at, len: head.length } : null;
}

function sentences(t: string): string[] {
  return t.split(/[\n。！？!?；;]+/).map((s) => s.trim()).filter((s) => s.length >= 10).slice(0, 200);
}

// ── 可疑代码 ───────────────────────────────────────────────

const PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\.slice\(\s*-\s*\d+\s*\)/, reason: '只取最后几个' },
  { re: /\.slice\(\s*0\s*,\s*\w+/, reason: '只取前几个' },
  { re: /\.(substring|substr)\(/, reason: '截断字符串' },
  { re: /\.splice\(/, reason: '删掉一段' },
  { re: /\[\s*-\s*\d+\s*:\s*\]/, reason: '只取最后几个' },
  { re: /\[\s*:\s*-?\w+\s*\]/, reason: '只取前几个' },
  { re: /truncat/i, reason: '截断' },
  // 只认限制**输入**的上限；max_tokens 限的是输出长度，和数据没进 prompt 无关
  { re: /\b(limit|top_?k|max_?(items|history|messages|docs|results|len|length|chars|n))\b/i, reason: '数量上限' },
  { re: /\.(take|head)\(\s*\d+/, reason: '只取前几个' },
];

/**
 * 在发起这次调用的几层函数附近找截断写法。
 * 只看调用点往上 30 行 —— prompt 一般就在发调用之前拼好；离得越近越可疑，排在前面。
 */
function findSuspects(frames: Frame[], readFile: (f: string) => string | null): Suspect[] {
  const out: (Suspect & { dist: number })[] = [];
  const seen = new Set<string>();
  for (const f of [...frames].reverse()) {
    const src = readFile(f.file);
    if (!src) continue;
    const lines = src.split('\n');
    for (let ln = Math.max(1, f.line - 30); ln <= Math.min(lines.length, f.line + 2); ln++) {
      const code = lines[ln - 1];
      // 注释里提到 slice / limit 不算
      if (/^\s*(\/\/|#|\*|\/\*)/.test(code)) continue;
      const hit = PATTERNS.find((p) => p.re.test(code));
      const key = `${f.file}:${ln}`;
      if (!hit || seen.has(key)) continue;
      seen.add(key);
      out.push({ file: f.file, line: ln, code: code.trim().slice(0, 160), reason: hit.reason, dist: Math.abs(f.line - ln) });
    }
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, 5).map(({ dist: _d, ...s }) => s);
}

function safeRead(f: string): string | null {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}
