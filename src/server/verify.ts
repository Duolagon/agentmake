// 验证：修完重放，和基线逐步对齐。
//
// 「改完到底有没有变好」要回答三件事：
//   1. 改动从哪一步开始生效（★ 注入点）—— 它之后的变化都是连锁反应，别当成新问题
//   2. 每一步前后有什么不同：输入、输出、走向、花没花钱（重放命中 = 没打模型）
//   3. 结论：修好了哪几处、有没有新冒出来的
//
// 对齐按**步骤**而不是按「第几次调用」：修好之后常常走了另一条分支（auto_reply → escalate），
// 按序号对齐会把 A 的 auto_reply 和 B 的 escalate 硬配成一对。步骤用名字对齐 ——
// 改代码会让行号漂移，函数名不会。

import type { Anomaly } from './anomalies.ts';
import type { Flow, FlowStep, Span } from './flow.ts';

export type Side = {
  calls: number;
  callIds: string[];
  input: Span['input'];
  out: string;
  next: string | null;
  failing: string[];
  ms: number;
  /** 真打了模型的次数 / 走了重放缓存的次数（只算模型调用） */
  real: number;
  replayed: number;
  inTok: number;
};

export type StepPair = {
  label: string;
  kind: string;
  a: Side | null;
  b: Side | null;
  /** same = 输入输出都没变 · changed = 有变化 · only_a = 改之后没再执行 · only_b = 改之后第一次走到 */
  status: 'same' | 'changed' | 'only_a' | 'only_b';
  requestChanged: boolean;
  outputChanged: boolean;
  nextChanged: boolean;
  /** 第一处变化 —— 改动的注入点 */
  star: boolean;
};

export type Verification = {
  a: string;
  b: string;
  pairs: StepPair[];
  verdict: 'better' | 'worse' | 'mixed' | 'same';
  fixed: string[];
  introduced: string[];
  /** 两边都有、没变的问题 —— 「修了但没修好」 */
  remaining: string[];
  cost: {
    aCalls: number; bCalls: number;
    bReal: number; bReplayed: number;
    aTokens: number; bTokens: number;
    aMs: number; bMs: number;
  };
};

/** 结论只看「结果层面」的问题；「比平时慢」受机器负载影响，拿它判断改得好不好不靠谱 */
const VERDICT_KINDS = new Set(['data_dropped', 'rule', 'error', 'empty', 'duplicate', 'loop']);

export function verifyRuns(
  a: { id: string; flow: Flow; anomalies: Anomaly[] },
  b: { id: string; flow: Flow; anomalies: Anomaly[] },
): Verification {
  // 步骤身份 = 类型 + 名字 + 所在文件（不带行号：改代码行号会漂）。
  // 只用名字的话，两个文件里各有一个 analyze() 会撞成一个键，后一个盖掉前一个，
  // 真实的变化就被显示成「没变」。同一文件里同名的再按出现次序编号。
  const keyed = (steps: FlowStep[]) => {
    const seen = new Map<string, number>();
    return [...steps].sort((x, y) => x.order - y.order).map((s) => {
      const base = `${s.kind}:${s.label}@${s.file}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return [n ? `${base}#${n}` : base, s] as const;
    });
  };
  const aKeyed = keyed(a.flow.steps);
  const bKeyed = keyed(b.flow.steps);
  const aSteps = new Map(aKeyed);
  const bSteps = new Map(bKeyed);

  // 顺序：按 B 的执行顺序；只在 A 里有的步骤插在它在 A 里的前一步后面
  const order = bKeyed.map(([k]) => k);
  const aOrder = aKeyed.map(([k]) => k);
  aOrder.forEach((k, i) => {
    if (order.includes(k)) return;
    const prev = aOrder.slice(0, i).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : order.length, 0, k);
  });

  let starred = false;
  const pairs: StepPair[] = order.map((k) => {
    const sa = aSteps.get(k) ?? null;
    const sb = bSteps.get(k) ?? null;
    const A = sa ? side(sa) : null;
    const B = sb ? side(sb) : null;
    const hashes = (s: FlowStep | null) => (s?.spans.map((x) => x.hash ?? '').sort().join('|') ?? '');
    const requestChanged = !!sa && !!sb && sa.kind === 'llm' && hashes(sa) !== hashes(sb);
    const outputChanged = !!A && !!B && A.out !== B.out;
    const nextChanged = !!A && !!B && A.next !== B.next;
    const status: StepPair['status'] = !sa ? 'only_b' : !sb ? 'only_a'
      : requestChanged || outputChanged || nextChanged || inputChanged(A!, B!) ? 'changed' : 'same';
    const star = !starred && status !== 'same' && status !== 'only_a';
    if (star) starred = true;
    return { label: (sa ?? sb)!.label, kind: (sa ?? sb)!.kind, a: A, b: B, status, requestChanged, outputChanged, nextChanged, star };
  });

  // 结论：两边的异常求差。异常的身份用「标题 + 涉及的步骤名」—— 步骤 id 带行号，改代码会变
  const issues = (side: { flow: Flow; anomalies: Anomaly[] }) => {
    const label = (id: string) => side.flow.steps.find((s) => s.id === id)?.label ?? id;
    return new Set(
      side.anomalies.filter((x) => VERDICT_KINDS.has(x.kind)).map((x) => `${x.title}（${x.stepIds.map(label).join(' → ')}）`),
    );
  };
  const ia = issues(a);
  const ib = issues(b);
  const fixed = [...ia].filter((x) => !ib.has(x));
  const introduced = [...ib].filter((x) => !ia.has(x));
  const remaining = [...ia].filter((x) => ib.has(x));

  const sum = (f: Flow, pick: (s: FlowStep) => number) => f.steps.reduce((n, s) => n + pick(s), 0);
  const llm = (f: Flow) => f.steps.filter((s) => s.kind === 'llm').flatMap((s) => s.spans);

  return {
    a: a.id,
    b: b.id,
    pairs,
    verdict: fixed.length && introduced.length ? 'mixed' : fixed.length ? 'better' : introduced.length ? 'worse' : 'same',
    fixed,
    introduced,
    remaining,
    cost: {
      aCalls: sum(a.flow, (s) => s.calls),
      bCalls: sum(b.flow, (s) => s.calls),
      bReal: llm(b.flow).filter((x) => !x.replayed).length,
      bReplayed: llm(b.flow).filter((x) => x.replayed).length,
      aTokens: a.flow.totals.inputTokens + a.flow.totals.outputTokens,
      bTokens: b.flow.totals.inputTokens + b.flow.totals.outputTokens,
      aMs: a.flow.totals.ms,
      bMs: b.flow.totals.ms,
    },
  };
}

function side(s: FlowStep): Side {
  const done = s.spans.filter((x) => !x.pending);
  const last = done[done.length - 1];
  return {
    calls: s.calls,
    callIds: s.spans.map((x) => x.callId),
    input: done.find((x) => x.input)?.input ?? null,
    out: last?.out ?? '',
    next: last?.next ?? null,
    failing: [...new Set(done.flatMap((x) => x.failing))],
    ms: done.reduce((n, x) => n + x.ms, 0),
    real: s.kind === 'llm' ? done.filter((x) => !x.replayed).length : 0,
    replayed: s.kind === 'llm' ? done.filter((x) => x.replayed).length : 0,
    inTok: done.reduce((n, x) => n + (x.inTok ?? 0), 0),
  };
}

function inputChanged(a: Side, b: Side): boolean {
  const k = (x: Side) => (x.input ? `${x.input.items}/${x.input.used}/${x.input.coverage?.toFixed(2)}` : '');
  return k(a) !== k(b);
}

// ── 单步差异：prompt 与输出 ────────────────────────────────

export type DiffLine = { op: 'same' | 'add' | 'del'; text: string };

/**
 * 按行的最小差异（LCS）。prompt 的「行」是：system 的每一行、每条消息的每一行（前面标着角色）。
 * 行数通常几十到几百，O(n·m) 足够；超过上限就退化成「整段替换」，免得把服务端卡住。
 */
export function diffLines(a: string[], b: string[], cap = 2500): DiffLine[] {
  if (a.length * b.length > cap * cap) {
    return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: 'del', text: a[i++] });
    else out.push({ op: 'add', text: b[j++] });
  }
  while (i < n) out.push({ op: 'del', text: a[i++] });
  while (j < m) out.push({ op: 'add', text: b[j++] });
  return out;
}
