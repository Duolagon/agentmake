// 重放缓存（harness 侧）。
//
// 开启方式是环境变量而不是服务端开关，刻意的：重放是「本次运行」的属性，
// 不是调试器的全局状态。用环境变量就不存在「进程已经跑起来了，开关才生效」
// 这类时序问题，也不会误伤同时在跑的其他 agent。
//
//   AGENTMAKE_REPLAY=<baseline runId>  node your-app.mjs
//
// 基线可以是一次运行，也可以是一个进程运行（连同它下面的请求级运行）或一个运行组：
// 常驻服务重启后重放，要找的是「上一个进程处理过的任何一个请求」里的同一个调用。

import { currentBaseline, currentRunId } from './requests.ts';
import { endpoint, isDisabled, rawFetch } from './transport.ts';

export const baselineRunId: string | null = process.env.AGENTMAKE_REPLAY || null;
export const replayEnabled = !!baselineRunId;

/** 命中则返回缓存的原生响应体（字符串），未命中返回 null */
export async function lookup(hash: string): Promise<{ body: string; status: number; ctype: string } | null> {
  // 回归重发的请求带着它自己的基线请求，比进程级的 AGENTMAKE_REPLAY 精确 —— 进程没开重放也照样能省钱
  const baseline = currentBaseline() ?? baselineRunId;
  if (!baseline || isDisabled()) return null;
  try {
    // 带上自己是谁：服务端据此记下「这次运行以谁为基线」，对比时不用再手动指定
    const q = new URLSearchParams({ baseline, hash, run: currentRunId() });
    const res = await rawFetch()(`${endpoint()}/api/replay?${q}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { hit: boolean; body?: string; status?: number; ctype?: string };
    return d.hit && typeof d.body === 'string'
      ? { body: d.body, status: d.status ?? 200, ctype: d.ctype ?? 'application/json' }
      : null;
  } catch {
    // 查缓存失败就当没命中，走真实调用 —— 绝不能因此让 agent 跑不下去
    return null;
  }
}
