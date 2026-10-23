// 断点闸门（服务端侧）：决定一次调用是放行还是挂起，并保管挂起中的 HTTP 响应。
//
// 挂起的实现就是「不回复那个 HTTP 请求」—— 被调试进程正阻塞在 await 上。
// 用户在页面上做了决定，我们才 resolve 它。
//
// 四个阶段对应架构文档 §7.1 的断点位置：
//   llm.before   发请求前   —— 改 prompt / 伪造响应 / 中止
//   llm.after    收响应后   —— 改模型答案，测下游怎么处理异常输出
//   http.before  调工具前   —— 改入参 / 伪造工具返回，不用真去制造故障
//   http.after   工具返回后 —— 改返回值

import type { RequestPatch } from '../shared/denormalize.ts';

export type GatePhase = 'llm.before' | 'llm.after' | 'http.before' | 'http.after';

export type GateDecision =
  | { action: 'continue' }
  /** 请求侧改写 */
  | { action: 'patch'; patch: RequestPatch }
  /** 不真的发出去，直接造一个响应回去 */
  | { action: 'fake'; text?: string; status?: number; body?: string }
  /** 响应侧改写（after 阶段） */
  | { action: 'replace'; text?: string; status?: number; body?: string }
  | { action: 'abort'; message?: string };

export type Breakpoints = {
  llmBefore: boolean;
  llmAfter: boolean;
  httpBefore: boolean;
  httpAfter: boolean;
  /** 只在这个执行图节点（file#fn）下的调用暂停；null = 不限 */
  node: string | null;
  /** 只对 URL 含此子串的调用生效；null = 不限。HTTP 断点几乎必须配它，否则会被信源抓取淹没 */
  urlContains: string | null;
  /** 命中一次后自动解除 —— 「跑到下一次调用」的语义 */
  once: boolean;
};

export type PendingCall = {
  callId: string;
  runId: string;
  phase: GatePhase;
  url: string;
  /** before 阶段是请求 IR，after 阶段是响应 IR */
  payload: unknown;
  frames: { file: string; fn: string }[];
  since: number;
};

const DEFAULTS: Breakpoints = {
  llmBefore: false,
  llmAfter: false,
  httpBefore: false,
  httpAfter: false,
  node: null,
  urlContains: null,
  once: false,
};

export class Gate {
  breakpoints: Breakpoints = { ...DEFAULTS };

  private waiters = new Map<string, (d: GateDecision) => void>();
  private pending = new Map<string, PendingCall>();

  setBreakpoints(p: Partial<Breakpoints>): Breakpoints {
    this.breakpoints = { ...this.breakpoints, ...p };
    return this.breakpoints;
  }

  /** 有任何一个开关开着 —— harness 用它决定普通 HTTP 调用要不要走闸门 */
  get anyArmed(): boolean {
    const b = this.breakpoints;
    return b.llmBefore || b.llmAfter || b.httpBefore || b.httpAfter;
  }

  get httpArmed(): boolean {
    return this.breakpoints.httpBefore || this.breakpoints.httpAfter;
  }

  listPending(): PendingCall[] {
    return [...this.pending.values()].sort((a, b) => a.since - b.since);
  }

  private phaseArmed(phase: GatePhase): boolean {
    const b = this.breakpoints;
    switch (phase) {
      case 'llm.before': return b.llmBefore;
      case 'llm.after': return b.llmAfter;
      case 'http.before': return b.httpBefore;
      case 'http.after': return b.httpAfter;
    }
  }

  private shouldBreak(call: PendingCall): boolean {
    const bp = this.breakpoints;
    if (!this.phaseArmed(call.phase)) return false;
    if (bp.node && !call.frames.some((f) => `${f.file}#${f.fn}` === bp.node)) return false;
    if (bp.urlContains && !call.url.includes(bp.urlContains)) return false;
    return true;
  }

  /**
   * 返回一个 Promise：命中断点时它会一直悬着，直到 resolve() 被调用。
   * 没命中就立即 resolve('continue')。
   */
  request(call: PendingCall): { held: boolean; decision: Promise<GateDecision>; bpChanged: boolean } {
    if (!this.shouldBreak(call)) {
      return { held: false, decision: Promise.resolve({ action: 'continue' }), bpChanged: false };
    }
    // once 命中后自动解除当前阶段。必须让调用方广播出去，否则页面上的开关会停在旧状态。
    let bpChanged = false;
    if (this.breakpoints.once) {
      const key = ({
        'llm.before': 'llmBefore', 'llm.after': 'llmAfter',
        'http.before': 'httpBefore', 'http.after': 'httpAfter',
      } as const)[call.phase];
      this.breakpoints = { ...this.breakpoints, [key]: false };
      bpChanged = true;
    }

    // 同一次调用的 before / after 是两条不同的等待，key 要带上阶段
    const key = `${call.callId}:${call.phase}`;
    this.pending.set(key, call);
    const decision = new Promise<GateDecision>((resolve) => {
      this.waiters.set(key, resolve);
    });
    return { held: true, decision, bpChanged };
  }

  /** 用户在页面上做了决定 */
  resolve(callId: string, phase: GatePhase, decision: GateDecision): boolean {
    const key = `${callId}:${phase}`;
    const w = this.waiters.get(key);
    if (!w) return false;
    this.waiters.delete(key);
    this.pending.delete(key);
    w(decision);
    return true;
  }

  /** 全部放行 —— 关闭断点或页面退出时用，避免把被调试进程永久卡住 */
  releaseAll(): number {
    const n = this.waiters.size;
    for (const [k, w] of this.waiters) {
      this.pending.delete(k);
      w({ action: 'continue' });
    }
    this.waiters.clear();
    return n;
  }
}
