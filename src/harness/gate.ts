// 断点闸门：LLM 调用发出前，向调试器请示。
//
// 这是从「只读观测」跨到「真调试器」的那一步。拦截函数在这里 **阻塞** 等待决策 ——
// 阻塞的是被调试进程，这正是调试器该有的行为（和 pdb 停在断点上是一回事）。
//
// 为什么把 llm.before 事件也塞进这个请求，而不是走异步上报队列：
// 队列有 120ms 批量延迟，闸门是立即的，服务端会先收到闸门请求、后收到事件，
// 无法把「暂停的是哪一次调用」对应起来。合并成一个请求，顺序问题自然消失。

import type { RequestPatch } from '../shared/denormalize.ts';
import { endpoint, isDisabled, rawFetch, sourceHeaders } from './transport.ts';

export type GatePhase = 'llm.before' | 'llm.after' | 'http.before' | 'http.after';

export type GateDecision =
  | { action: 'continue' }
  | { action: 'patch'; patch: RequestPatch }
  | { action: 'fake'; text?: string; status?: number; body?: string }
  | { action: 'replace'; text?: string; status?: number; body?: string }
  | { action: 'abort'; message?: string };

const CONTINUE: GateDecision = { action: 'continue' };

/** 没暂停时服务端立刻回，这个超时只在真的停在断点上时才起作用 */
const HOLD_MS = Number(process.env.AGENTMAKE_BREAK_TIMEOUT_MS ?? 600_000);

export async function gate(phase: GatePhase, event: unknown): Promise<GateDecision> {
  if (isDisabled()) return CONTINUE;
  try {
    const res = await rawFetch()(`${endpoint()}/api/gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sourceHeaders() },
      body: JSON.stringify({ event, phase }),
      signal: AbortSignal.timeout(HOLD_MS),
    });
    if (!res.ok) return CONTINUE;
    const d = (await res.json()) as GateDecision;
    return d && typeof d.action === 'string' ? d : CONTINUE;
  } catch {
    // 调试器没起来 / 超时 / 网络问题 —— 一律放行。
    // 观测工具绝不能因为自己的问题把用户的程序卡死。
    return CONTINUE;
  }
}
