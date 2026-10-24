// 批量回归：拿历史上的真实请求，重发给改好的服务，逐个和当时的结果对比。
//
// 只看一个请求修好了不够 —— 要回答的是「原来出错的那批是不是都好了」以及「原来好好的那批有没有被改坏」。
// 请求本身是 harness 在入站时旁听下来的（方法、路径、请求体），这里原样重发，
// 并带上 x-agentmake-baseline 指明「你对应的是哪个历史请求」：
//   - 新请求级运行精确挂到那个基线请求上，对比一对一，不靠猜
//   - 新进程即使没开 AGENTMAKE_REPLAY，没改动的模型调用也按这个基线命中缓存 —— 只为变化的部分付钱

import type { Anomaly } from './anomalies.ts';
import type { Flow } from './flow.ts';
import type { Verification } from './verify.ts';

export type Outcome = 'fixed' | 'still' | 'ok' | 'regressed' | 'error';

export type RegressItem = {
  baseline: string;
  trigger: string;
  status: 'pending' | 'running' | 'done' | 'error';
  run: string | null;
  before: { failed: boolean; issues: string[] };
  after: { failed: boolean; issues: string[] } | null;
  outcome: Outcome | null;
  /** 和基线比，哪些步骤变了（★ 注入点在第一个） */
  changed: string[];
  real: number;
  replayed: number;
  error: string | null;
};

export type RegressBatch = {
  id: string;
  baseline: string;
  target: string;
  url: string;
  startedAt: number;
  done: boolean;
  items: RegressItem[];
  summary: {
    total: number;
    fixed: number;
    still: number;
    ok: number;
    regressed: number;
    error: number;
    real: number;
    replayed: number;
  };
};

type RunRow = {
  run_id: string;
  kind: string | null;
  parent_run_id: string | null;
  trigger: string | null;
  started_at: number;
  ended_at: number | null;
  cwd: string | null;
  listen: string | null;
  request_method: string | null;
  request_url: string | null;
  request_ctype: string | null;
  request_body: string | null;
  request_truncated: number | null;
};

export type RegressDeps = {
  requestRuns: (scope: string) => RunRow[];
  getRun: (id: string) => RunRow | undefined;
  /** 基线进程之后起来的、还在跑、在监听端口的进程（缺省目标） */
  findTarget: (baseline: string) => RunRow | undefined;
  /** 等新请求级运行落库（harness 是批量异步上报的） */
  findReplayRun: (baselineRun: string, targetProcess: string, after: number) => RunRow | undefined;
  analyze: (runId: string) => { flow: Flow; anomalies: Anomaly[] };
  verify: (a: string, b: string) => Verification;
  broadcast: (ev: Record<string, unknown>) => void;
};

/** 判结论只看结果层面的问题；「慢」受机器负载影响，不算 */
const ISSUE_KINDS = new Set(['data_dropped', 'rule', 'error', 'empty', 'duplicate', 'loop']);

const batches = new Map<string, RegressBatch>();

export function getBatch(id: string): RegressBatch | undefined {
  return batches.get(id);
}

export function listBatches(baseline?: string): RegressBatch[] {
  return [...batches.values()].filter((b) => !baseline || b.baseline === baseline).sort((a, b) => b.startedAt - a.startedAt);
}

export function issuesOf(x: { flow: Flow; anomalies: Anomaly[] }): string[] {
  const label = (id: string) => x.flow.steps.find((s) => s.id === id)?.label ?? id;
  return x.anomalies.filter((a) => ISSUE_KINDS.has(a.kind)).map((a) => `${a.title}（${a.stepIds.map(label).join(' → ')}）`);
}

/**
 * 开一批回归。立即返回批次（各条 pending），后台逐个重发；每完成一个广播一次进度。
 *
 * 逐个而不是并发：常驻服务的并发度是业务自己的事，回归不该把它压垮；
 * 而且串行跑，每个请求的新运行和基线一一对应，不会认错。
 */
export function startRegression(
  deps: RegressDeps,
  opts: { baseline: string; target?: string; only?: 'failed' | 'all'; limit?: number; timeoutMs?: number },
): RegressBatch | { error: string } {
  // 基线可以是一次运行、一个进程，也可以是一个运行组 —— 组不是一行 runs，getRun 查不到，
  // 但 requestRuns 按 SCOPE（含 group_id）能把组里的请求都捞出来
  const base = deps.getRun(opts.baseline);
  const all = deps.requestRuns(opts.baseline);
  if (!base && !all.length) return { error: `没有这个运行或运行组：${opts.baseline}` };

  const runs = all.filter((r) => r.request_url && !r.request_truncated);
  if (!runs.length) {
    return { error: `${opts.baseline} 下面没有记下入站请求的运行 —— 批量回归只支持 Node 常驻服务（需要 harness 旁听到请求本身）` };
  }

  // 找目标进程要一个锚点：组没有自己的进程，用组里最后一个请求所在的进程
  const anchor = base ? opts.baseline : runs[runs.length - 1].run_id;
  const target = opts.target ? deps.getRun(opts.target) : deps.findTarget(anchor);
  if (!target) return { error: '找不到改好之后在跑的服务。先用改好的代码把服务重新起来（带上探针），或者指定 target' };
  const port = (JSON.parse(target.listen ?? '[]') as { port: number }[])[0]?.port;
  if (!port) return { error: `运行 ${target.run_id} 没有在监听端口，没法往它重发请求` };

  const scored = runs.map((r) => {
    const issues = issuesOf(deps.analyze(r.run_id));
    return { r, before: { failed: issues.length > 0, issues } };
  });
  const picked = (opts.only === 'failed' ? scored.filter((x) => x.before.failed) : scored).slice(0, opts.limit ?? 50);
  if (!picked.length) return { error: '按这个条件没挑出要回归的请求（only=failed 时说明基线里没有出过问题的请求）' };

  const batch: RegressBatch = {
    id: `rg_${Date.now().toString(36)}`,
    baseline: opts.baseline,
    target: target.run_id,
    url: `http://127.0.0.1:${port}`,
    startedAt: Date.now(),
    done: false,
    items: picked.map(({ r, before }) => ({
      baseline: r.run_id,
      trigger: r.trigger ?? `${r.request_method} ${r.request_url}`,
      status: 'pending',
      run: null,
      before,
      after: null,
      outcome: null,
      changed: [],
      real: 0,
      replayed: 0,
      error: null,
    })),
    summary: { total: picked.length, fixed: 0, still: 0, ok: 0, regressed: 0, error: 0, real: 0, replayed: 0 },
  };
  batches.set(batch.id, batch);
  if (batches.size > 20) batches.delete(batches.keys().next().value!);

  void (async () => {
    for (const [i, it] of batch.items.entries()) {
      const r = picked[i].r;
      it.status = 'running';
      deps.broadcast({ type: 'regress', batchId: batch.id, index: i, item: it });
      try {
        const t0 = Date.now();
        const res = await fetch(`${batch.url}${r.request_url}`, {
          method: r.request_method ?? 'GET',
          headers: {
            ...(r.request_ctype ? { 'content-type': r.request_ctype } : {}),
            'x-agentmake-baseline': r.run_id,
          },
          body: ['GET', 'HEAD'].includes(r.request_method ?? 'GET') ? undefined : (r.request_body ?? ''),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
        });
        await res.arrayBuffer().catch(() => null);
        const run = await waitFor(() => deps.findReplayRun(r.run_id, batch.target, t0 - 1000), (x) => !!x?.ended_at, 5000);
        if (!run) throw new Error(`服务回了 HTTP ${res.status}，但没有记录到新的运行（这个请求没调用模型或工具？）`);
        it.run = run.run_id;
        const issues = issuesOf(deps.analyze(run.run_id));
        it.after = { failed: issues.length > 0, issues };
        const v = deps.verify(r.run_id, run.run_id);
        it.changed = v.pairs.filter((p) => p.status !== 'same').map((p) => `${p.star ? '★ ' : ''}${p.label}`);
        it.real = v.cost.bReal;
        it.replayed = v.cost.bReplayed;
        it.outcome = it.before.failed
          ? (it.after.failed ? 'still' : 'fixed')
          : (it.after.failed ? 'regressed' : 'ok');
        it.status = 'done';
      } catch (e) {
        it.status = 'error';
        it.outcome = 'error';
        it.error = e instanceof Error ? e.message : String(e);
      }
      tally(batch);
      deps.broadcast({ type: 'regress', batchId: batch.id, index: i, item: it, summary: batch.summary });
    }
    batch.done = true;
    deps.broadcast({ type: 'regress', batchId: batch.id, done: true, summary: batch.summary });
  })();

  return batch;
}

function tally(b: RegressBatch): void {
  const s = { total: b.items.length, fixed: 0, still: 0, ok: 0, regressed: 0, error: 0, real: 0, replayed: 0 };
  for (const it of b.items) {
    if (it.outcome) s[it.outcome]++;
    s.real += it.real;
    s.replayed += it.replayed;
  }
  b.summary = s;
}

async function waitFor<T>(get: () => T, ready: (x: T) => boolean, ms: number): Promise<T | undefined> {
  const t0 = Date.now();
  let last: T | undefined;
  while (Date.now() - t0 < ms) {
    last = get();
    if (last && ready(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last ?? undefined;
}
