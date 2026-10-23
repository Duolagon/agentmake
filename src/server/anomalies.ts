// 异常自动发现 —— 「需要你看的」。
//
// 监视屏的用户是余光扫的：正常的东西应该退到背景里，不正常的要自己跳出来。
// 每条异常都回答三件事：出了什么事（一句人话）、影响面（41 次里几次）、在哪（步骤 / 调用）。
// 最后一项让页面能一键把图上相关的路径点亮、把调用列表筛到那几次。
//
// 「比平时」的「平时」来自基线范围：看单个请求时，拿它所在进程处理过的所有请求当参照；
// 看进程或运行组时就用它自己。样本不够（< 5）不下「慢」的结论 —— 宁可漏报，不要狼来了。

import type { CallRow, Flow, FlowStep, LoopEvent } from './flow.ts';
import { stepIdOf, wrapperSet } from './flow.ts';
import type { Frame } from '../shared/types.ts';

export type Anomaly = {
  id: string;
  kind: 'data_dropped' | 'rule' | 'error' | 'slow' | 'loop' | 'duplicate' | 'empty';
  /** fail = 结果已经错了 · warn = 很可能有问题 · info = 值得一看 */
  severity: 'fail' | 'warn' | 'info';
  icon: string;
  title: string;
  detail: string;
  /** 影响面，如「41/41 次」「3 次」「3.1×」 */
  count: string;
  stepIds: string[];
  callIds: string[];
  runIds: string[];
  /** 排序用：同一级别里影响越大越靠前 */
  weight: number;
};

export const RULE_TITLES: Record<string, string> = {
  'rule.truncated': '回答被截断',
  'rule.empty_output': '模型什么都没说',
  'rule.tool_args_invalid': '工具参数不是合法 JSON',
  'rule.unknown_tool': '调了没声明的工具',
  'rule.blocked': '被安全策略拦截',
};

const RANK = { fail: 0, warn: 1, info: 2 } as const;

export function computeAnomalies(input: {
  flow: Flow;
  calls: CallRow[];
  /** 「平时」的参照；缺省就用 calls 自己 */
  baselineCalls?: CallRow[];
  loopEvents?: LoopEvent[];
  baselineLoopEvents?: LoopEvent[];
}): Anomaly[] {
  const { flow, calls } = input;
  const out: Anomaly[] = [];
  const stepOfCall = new Map<string, FlowStep>();
  for (const s of flow.steps) for (const id of s.callIds) stepOfCall.set(id, s);
  const label = (id: string) => flow.steps.find((s) => s.id === id)?.label ?? id;

  // ── 数据在进下游前被丢掉 ──
  for (const e of flow.edges) {
    const d = e.data;
    if (!d?.dropped) continue;
    const m = d.last;
    const detail = m.items != null && m.used != null
      ? `${label(e.from)} 给了 ${m.items} 条，${label(e.to)} 的 prompt 里只出现了 ${m.used} 条`
      : `${label(e.from)} 的输出只有 ${Math.round((m.coverage ?? 0) * 100)}% 进了 ${label(e.to)} 的 prompt`;
    out.push({
      id: `drop:${e.from}→${e.to}`,
      kind: 'data_dropped',
      severity: 'warn',
      icon: '✂',
      title: '数据在进 prompt 前被丢掉',
      detail,
      count: `${d.dropped}/${d.samples} 次`,
      stepIds: [e.from, e.to],
      callIds: d.exampleCallId ? [d.exampleCallId] : [],
      runIds: d.droppedRuns,
      weight: d.dropped,
    });
  }

  // ── 规则 / AI / 人判的失败 ──
  const byRule = new Map<string, { steps: Set<string>; calls: string[]; runs: Set<string> }>();
  for (const s of flow.steps) {
    for (const sp of s.spans) {
      for (const name of sp.failing) {
        const g = byRule.get(name) ?? { steps: new Set(), calls: [], runs: new Set() };
        g.steps.add(s.id);
        g.calls.push(sp.callId);
        if (sp.runId) g.runs.add(sp.runId);
        byRule.set(name, g);
      }
    }
  }
  for (const [name, g] of byRule) {
    const where = [...g.steps].map(label).join('、');
    out.push({
      id: `rule:${name}`,
      kind: 'rule',
      severity: 'fail',
      icon: '✗',
      title: RULE_TITLES[name] ?? `判定失败 · ${name}`,
      detail: `${where}${g.runs.size > 1 ? ` · 涉及 ${g.runs.size} 个请求` : ''}`,
      count: `${g.calls.length} 次`,
      stepIds: [...g.steps],
      callIds: g.calls.slice(-20),
      runIds: [...g.runs],
      weight: g.calls.length,
    });
  }

  // ── 调用本身失败（HTTP 错误、网络错误、被中止） ──
  for (const s of flow.steps) {
    if (!s.errors) continue;
    const bad = s.spans.filter((x) => !x.ok && !x.pending);
    out.push({
      id: `err:${s.id}`,
      kind: 'error',
      severity: 'fail',
      icon: '⨯',
      title: '调用失败',
      detail: `${s.label} 失败了 ${s.errors} 次`,
      count: `${s.errors}/${s.calls} 次`,
      stepIds: [s.id],
      callIds: bad.map((x) => x.callId).slice(-20),
      runIds: [...new Set(bad.map((x) => x.runId).filter(Boolean) as string[])],
      weight: s.errors,
    });
  }

  // ── 比平时慢 ──
  const base = input.baselineCalls ?? calls;
  // 和流程图用同一套「哪些是封装」的判定，否则基线里的步骤 id 对不上图上的
  const wrappers = wrapperSet(calls);
  const durs = new Map<string, number[]>();
  for (const c of base) {
    if (c.duration_ms == null) continue;
    const id = stepIdOf(parseFrames(c.frames), c, wrappers).id;
    durs.set(id, [...(durs.get(id) ?? []), c.duration_ms]);
  }
  for (const s of flow.steps) {
    const sample = durs.get(s.id) ?? [];
    if (sample.length < 5) continue;
    const med = median(sample);
    const worst = s.spans.filter((x) => !x.pending).sort((a, b) => b.ms - a.ms)[0];
    if (!worst || worst.ms < Math.max(3 * med, med + 500)) continue;
    out.push({
      id: `slow:${s.id}`,
      kind: 'slow',
      severity: 'info',
      icon: '⏱',
      title: '比平时慢',
      detail: `${s.label} 这次 ${fmtMs(worst.ms)}，平时 ${fmtMs(med)}`,
      count: `${(worst.ms / Math.max(med, 1)).toFixed(1)}×`,
      stepIds: [s.id],
      callIds: [worst.callId],
      runIds: worst.runId ? [worst.runId] : [],
      weight: worst.ms / Math.max(med, 1),
    });
  }

  // ── 循环比平时多转 ──
  const cur = loopRounds(input.loopEvents ?? []);
  const ref = loopRounds(input.baselineLoopEvents ?? input.loopEvents ?? []);
  for (const [loopId, runs] of cur) {
    const history = [...(ref.get(loopId)?.values() ?? [])];
    if (history.length < 3) continue;
    const med = median(history);
    for (const [runId, n] of runs) {
      if (n < Math.max(2 * med, med + 2)) continue;
      const l = flow.loops.find((x) => x.id === loopId);
      out.push({
        id: `loop:${loopId}:${runId}`,
        kind: 'loop',
        severity: 'warn',
        icon: '⟳',
        title: '循环比平时多转',
        detail: `${l?.label ?? loopId} 这次转了 ${n} 轮，平时 ${med} 轮`,
        count: `${n} 轮`,
        stepIds: l?.stepIds ?? [],
        callIds: [],
        runIds: runId ? [runId] : [],
        weight: n / Math.max(med, 1),
      });
    }
  }

  // ── 同一个请求发了好几遍 ──
  const dup = new Map<string, CallRow[]>();
  for (const c of calls) {
    if (c.kind !== 'llm' || !c.request_hash || c.replayed) continue;
    const k = `${c.run_id ?? ''}|${c.request_hash}`;
    dup.set(k, [...(dup.get(k) ?? []), c]);
  }
  for (const group of dup.values()) {
    if (group.length < 2) continue;
    const s = stepOfCall.get(group[0].call_id);
    out.push({
      id: `dup:${group[0].call_id}`,
      kind: 'duplicate',
      severity: 'warn',
      icon: '⧉',
      title: '同一个请求发了好几遍',
      detail: `${s?.label ?? '模型调用'}：完全相同的 prompt 在一次运行里发了 ${group.length} 遍 —— 多半是没缓存的重试，白花钱`,
      count: `${group.length} 遍`,
      stepIds: s ? [s.id] : [],
      callIds: group.map((c) => c.call_id),
      runIds: group[0].run_id ? [group[0].run_id] : [],
      weight: group.length,
    });
  }

  // ── 工具返回了空数据（下游很可能在空数据上硬答） ──
  const empties = new Map<string, CallRow[]>();
  for (const c of calls) {
    if (c.kind !== 'http' || !c.ok || c.response_bytes == null) continue;
    const body = (c.response_body ?? '').trim();
    if (body && !['[]', '{}', 'null', '""'].includes(body)) continue;
    const s = stepOfCall.get(c.call_id);
    if (!s) continue;
    empties.set(s.id, [...(empties.get(s.id) ?? []), c]);
  }
  for (const [sid, group] of empties) {
    const s = flow.steps.find((x) => x.id === sid)!;
    out.push({
      id: `empty:${sid}`,
      kind: 'empty',
      severity: 'warn',
      icon: '∅',
      title: '工具返回了空数据',
      detail: `${s.label} 返回空，下游可能是在没有资料的情况下硬答的`,
      count: `${group.length}/${s.calls} 次`,
      stepIds: [sid],
      callIds: group.map((c) => c.call_id).slice(-20),
      runIds: [...new Set(group.map((c) => c.run_id).filter(Boolean) as string[])],
      weight: group.length,
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.weight - a.weight);
}

/** 每个循环在每次运行里转了几轮 */
function loopRounds(events: LoopEvent[]): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const e of events) {
    const n = e.iteration ?? e.iterations ?? 0;
    if (!e.loopId || !n) continue;
    const runs = m.get(e.loopId) ?? new Map<string, number>();
    const rid = e.runId ?? '';
    runs.set(rid, Math.max(runs.get(rid) ?? 0, n));
    m.set(e.loopId, runs);
  }
  return m;
}

function parseFrames(s: string | null): Frame[] {
  try {
    return (JSON.parse(String(s)) ?? []) as Frame[];
  } catch {
    return [];
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
