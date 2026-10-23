// 循环运行时：被插桩的代码调用这里的钩子。
//
// 三件事，对应需求里的「实时调整 loop 方式」：
//   改上限     —— 不去改用户的 MAX 变量（读不到），而是自己数轮次，到了就强制条件为 false
//   立即跳出   —— 下一次条件求值直接返回 false
//   再来一轮   —— 即使原条件已为 false 也强制返回 true
//
// 这三个都是**运行中**生效，不需要改代码、不需要重跑。

import { endpoint, isDisabled, rawFetch } from './transport.ts';
import { emit } from './transport.ts';

export type LoopOverride = {
  maxIterations?: number | null;
  breakNow?: boolean;
  forceOneMore?: boolean;
  /** 每轮开始时暂停 */
  breakpoint?: boolean;
};

type LoopState = { iter: number; entered: number };

const states = new Map<string, LoopState>();
const overrides = new Map<string, LoopOverride>();
/** 取「当前所在的运行」—— 常驻服务里循环跑在哪个请求里，事件就归哪个请求 */
let runIdOf: () => string = () => '';
let seq = () => 0;

export function initLoops(currentRun: () => string, nextSeq: () => number): void {
  runIdOf = currentRun;
  seq = nextSeq;
}

function send(ev: Record<string, unknown>): void {
  emit({ ...ev, runId: runIdOf(), seq: seq(), ts: Date.now() } as never);
}

/**
 * 轮次按「所在的运行 + 循环」分开计。
 *
 * 只按循环计的话，常驻服务里每个请求都会重新进入同一个循环，第 2 个请求从第 4 轮开始数、
 * 并发的两个请求还会互相抢同一个计数器 —— 逐轮轨道上的「第几轮」就全错了。
 * 同一次运行里反复进入同一个循环仍然接着数（脚本里的行为不变）。
 */
function stateOf(id: string): LoopState {
  const key = `${runIdOf()}|${id}`;
  let s = states.get(key);
  if (!s) {
    s = { iter: 0, entered: 0 };
    states.set(key, s);
    // 常驻服务一天处理上万个请求，计数器不能无限攒；最早的那批早就跑完了
    if (states.size > 5000) states.delete(states.keys().next().value!);
  }
  return s;
}

/** 条件钩子：同步，返回最终的循环条件 */
export function loopTest(id: string, original: boolean): boolean {
  const s = stateOf(id);
  const o = overrides.get(id) ?? {};

  if (o.breakNow) {
    consume(id, 'breakNow');
    send({ type: 'loop.exited', loopId: id, iterations: s.iter, reason: 'break' });
    return false;
  }
  if (o.maxIterations != null && s.iter >= o.maxIterations) {
    send({ type: 'loop.exited', loopId: id, iterations: s.iter, reason: 'max_override' });
    return false;
  }
  // 「再来一轮」只在原条件已经为假时才生效 —— 否则会在本来就要继续的那一轮被白白消费掉，
  // 等真正需要救回来时标志已经没了。
  if (o.forceOneMore && !original) {
    consume(id, 'forceOneMore');
    send({ type: 'loop.forced', loopId: id, iteration: s.iter });
    return true;
  }
  if (!original && s.entered > 0) {
    send({ type: 'loop.exited', loopId: id, iterations: s.iter, reason: 'condition' });
  }
  return original;
}

// 轮询上限：agent 的循环通常几十轮，每轮内还有几百毫秒的模型调用，
// 一次本地往返（~1ms）无所谓。但要防住紧凑循环 —— 超过这个轮数就不再取覆写。
const POLL_LIMIT = Number(process.env.AGENTMAKE_LOOP_POLL_LIMIT ?? 200);

/**
 * 进入一轮循环体：上报轮次、**取回最新覆写**、命中断点则阻塞。
 *
 * 覆写在这里取、在下一次 loopTest 生效（差一轮的延迟）——
 * 这就是「改上限 / 跳出 / 再来一轮」能在循环跑着的时候生效的原因。
 */
export async function loopEnter(id: string, endLine = 0): Promise<'continue' | 'break'> {
  const s = stateOf(id);
  s.iter++;
  s.entered++;
  const o = overrides.get(id) ?? {};

  send({
    type: 'loop.iteration',
    loopId: id,
    iteration: s.iter,
    endLine,
    maxOverride: o.maxIterations ?? null,
  });

  if (isDisabled() || s.iter > POLL_LIMIT) return 'continue';

  try {
    // 命中循环断点时服务端会把响应悬住，被调试进程就停在轮次边界上；
    // 没断点时立即返回，只是顺带把最新覆写带回来。
    const res = await rawFetch()(`${endpoint()}/api/loop-gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: runIdOf(), loopId: id, iteration: s.iter, armed: !!o.breakpoint }),
      signal: AbortSignal.timeout(600_000),
    });
    const d = (await res.json()) as { action?: string; override?: LoopOverride };
    if (d.override) setOverride(id, d.override);
    if (d.action === 'break') {
      // 'break_boundary' 而不是 'break'：这一轮**刚进来还没干活**就被叫停了。
      // 流程图靠这个区分「这一步在分支里没跑」和「这一步压根没轮到」。
      send({ type: 'loop.exited', loopId: id, iterations: s.iter, reason: 'break_boundary' });
      return 'break';
    }
  } catch {
    /* 调试器不可用一律放行 */
  }
  return 'continue';
}

/** 非 async 上下文的降级版本：只上报，不阻塞 */
export function loopEnterSync(id: string, endLine = 0): 'continue' | 'break' {
  const s = stateOf(id);
  s.iter++;
  s.entered++;
  send({ type: 'loop.iteration', loopId: id, iteration: s.iter, endLine, maxOverride: null });
  return 'continue';
}

/**
 * 合并覆写。
 *
 * ⚠️ 一次性标志（breakNow / forceOneMore）是**脉冲**：服务端置位一次就清掉，
 * 之后每轮推回来的都是 false。如果直接覆盖，会把本地还没来得及生效的挂起标志抹掉
 * —— 「再来一轮」就永远不会发生。所以这两个字段只允许置位（true 覆盖 false），
 * 清除交给本地消费点。
 */
export function setOverride(id: string, o: LoopOverride): void {
  const prev = overrides.get(id) ?? {};
  const next: LoopOverride = { ...prev, ...o };
  next.breakNow = prev.breakNow || o.breakNow || false;
  next.forceOneMore = prev.forceOneMore || o.forceOneMore || false;
  overrides.set(id, next);
}

/** 本地显式清除（消费点用） */
function consume(id: string, flag: 'breakNow' | 'forceOneMore'): void {
  const o = overrides.get(id) ?? {};
  overrides.set(id, { ...o, [flag]: false });
}

export function snapshot(): { id: string; iter: number; override: LoopOverride }[] {
  return [...states.entries()].map(([id, s]) => ({
    id,
    iter: s.iter,
    override: overrides.get(id) ?? {},
  }));
}

/** 把钩子挂到全局 —— 插桩后的代码通过 globalThis 调用 */
export function installLoopHooks(): void {
  (globalThis as any).__am_test = loopTest;
  (globalThis as any).__am_enter = loopEnter;
  (globalThis as any).__am_enter_sync = loopEnterSync;
  (globalThis as any).__am_set_loop_override = setOverride;
}

/** 服务端推来的覆写（通过闸门响应或轮询） */
export function applyOverrides(list: { loopId: string; override: LoopOverride }[]): void {
  for (const x of list) setOverride(x.loopId, x.override);
}
