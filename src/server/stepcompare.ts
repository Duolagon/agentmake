// 同一步，跨请求看规律。
//
// 单看一次调用，「它判成了 normal」可能是对的；把这一步在 41 个请求里的表现排成一张表，
// 规律才浮出来：凡是上游数据被丢掉的那几次，结果都一样、都走了同一个分支。
// 这张表就是把这种对照替用户做掉 —— 按「数据有没有被丢」分两组，各自的输出、下一步、失败率摆在一起。

import type { Flow, Span } from './flow.ts';

export type CompareRow = {
  callId: string;
  runId: string | null;
  /** 请求级运行的触发请求，如 POST /tickets；脚本运行为空 */
  trigger: string | null;
  t: number;
  ms: number;
  ok: boolean;
  iteration: number | null;
  input: Span['input'];
  out: string;
  next: string | null;
  failing: string[];
};

export type GroupStat = {
  n: number;
  /** 输出 → 次数，按次数排 */
  outputs: [string, number][];
  nexts: [string, number][];
  failed: number;
};

export type StepCompare = {
  step: { id: string; label: string; kind: string; calls: number };
  rows: CompareRow[];
  all: GroupStat;
  /** 有上游数据被丢掉的那几次 vs 没丢的 —— 两组都有时才给 */
  split: { dropped: GroupStat; kept: GroupStat } | null;
  /** 一句话的规律（看不出规律时为 null） */
  pattern: string | null;
};

export function stepCompare(flow: Flow, stepId: string, triggers: Map<string, string | null>, limit = 100): StepCompare | null {
  const s = flow.steps.find((x) => x.id === stepId || x.label === stepId);
  if (!s) return null;

  const done = s.spans.filter((x) => !x.pending);
  const rows: CompareRow[] = done
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((x) => ({
      callId: x.callId,
      runId: x.runId,
      trigger: x.runId ? (triggers.get(x.runId) ?? null) : null,
      t: x.t,
      ms: x.ms,
      ok: x.ok,
      iteration: x.iteration,
      input: x.input,
      out: x.out,
      next: x.next,
      failing: x.failing,
    }));

  const all = stat(done);
  const dropped = done.filter((x) => x.input?.dropped);
  const kept = done.filter((x) => x.input && !x.input.dropped);
  const split = dropped.length && kept.length ? { dropped: stat(dropped), kept: stat(kept) } : null;

  return {
    step: { id: s.id, label: s.label, kind: s.kind, calls: s.calls },
    rows,
    all,
    split,
    pattern: describe(s.label, all, dropped.length ? stat(dropped) : null, kept.length ? stat(kept) : null),
  };
}

function stat(spans: Span[]): GroupStat {
  const count = (vals: string[]) => {
    const m = new Map<string, number>();
    for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  };
  return {
    n: spans.length,
    outputs: count(spans.map((x) => key(x.out))),
    nexts: count(spans.map((x) => x.next ?? '（结束）')),
    failed: spans.filter((x) => !x.ok || x.failing.length).length,
  };
}

/** 输出归一成可比较的键：同一个意思的回答（带个时间戳、换行）不该被算成不同的输出 */
function key(out: string): string {
  return out.replace(/\s+/g, ' ').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<时间>').trim().slice(0, 40) || '（空）';
}

const top = (g: GroupStat, which: 'outputs' | 'nexts') =>
  g[which].map(([v, n]) => `「${v}」${n} 次`).join('、');

/**
 * 能说出一句话的规律才说，说不出就不说 —— 一条看着像结论的废话比没有更糟。
 *   - 两组的主要输出 / 下一步不同 → 「丢了数据的都 …，没丢的 …」
 *   - 只有一组且结果单一 → 「N 次里输出全是 X」（41 次全是 normal 本身就可疑）
 */
function describe(label: string, all: GroupStat, dropped: GroupStat | null, kept: GroupStat | null): string | null {
  if (dropped && kept) {
    const dOut = dropped.outputs[0]?.[0];
    const kOut = kept.outputs[0]?.[0];
    const dNext = dropped.nexts[0]?.[0];
    const kNext = kept.nexts[0]?.[0];
    if (dOut !== kOut || dNext !== kNext) {
      return `上游数据被丢掉的 ${dropped.n} 次：输出 ${top(dropped, 'outputs')}，下一步 ${top(dropped, 'nexts')}；` +
        `没丢的 ${kept.n} 次：输出 ${top(kept, 'outputs')}，下一步 ${top(kept, 'nexts')}。两组结果不一样 —— 丢掉的那部分数据影响了 ${label} 的判断`;
    }
    return `上游数据被丢掉的 ${dropped.n} 次和没丢的 ${kept.n} 次结果一样（输出 ${top(dropped, 'outputs')}）—— 被丢掉的部分可能不影响 ${label}，也可能两组都错了`;
  }
  if (dropped && !kept && dropped.n >= 2) {
    return `${dropped.n} 次里每次都有上游数据被丢掉，输出 ${top(dropped, 'outputs')}，下一步 ${top(dropped, 'nexts')} —— 没有「数据完整」的对照组，修好之后再比一次`;
  }
  if (all.n >= 5 && all.outputs.length === 1) {
    return `${all.n} 次里输出全是「${all.outputs[0][0]}」—— 如果这一步本该区分情况，它可能从来没有被正确触发过`;
  }
  return null;
}
