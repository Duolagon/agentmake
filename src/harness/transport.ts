// 事件上报通道。
//
// 三条铁律（这段代码跑在用户进程里，任何差错都是我们的锅）：
//   1. 绝不阻塞用户代码 —— 入队即返回，后台批量发送
//   2. 绝不抛异常 —— 所有错误吞掉
//   3. 服务端不在就静默放弃 —— 不重试风暴、不打日志刷屏

import type { AgentEvent } from '../shared/types.ts';

const ENDPOINT = (process.env.AGENTMAKE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const FLUSH_MS = 120;
const MAX_QUEUE = 2000;

let queue: AgentEvent[] = [];
let timer: NodeJS.Timeout | null = null;
let disabled = false;
let inFlight: Promise<void> = Promise.resolve();
let httpArmed = false;
let priming: Promise<void> | null = null;

/**
 * 普通 HTTP 调用是否需要走闸门。
 *
 * 值平时由 /ingest 的响应捎回来，但**短命进程的第一个动作可能就是 HTTP 调用**，
 * 那时还没发生过任何上报往返，缓存值必然是错的 false。所以安装时先发一次预取，
 * 第一个 HTTP 调用 await 它 —— 代价是一次往返，且与进程启动重叠。
 */
export function primeHttpArmed(): void {
  if (priming) return;
  priming = fetchRaw(`${ENDPOINT}/api/breakpoints`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json())
    .then((d: { httpBefore?: boolean; httpAfter?: boolean }) => {
      httpArmed = !!(d?.httpBefore || d?.httpAfter);
    })
    .catch(() => {
      // 调试器没起来：静默，后续一律不走闸门
      httpArmed = false;
    });
}

export async function httpArmedAsync(): Promise<boolean> {
  if (disabled) return false;
  if (priming) await priming.catch(() => {});
  return httpArmed;
}

export function emit(ev: AgentEvent): void {
  if (disabled) return;
  if (queue.length >= MAX_QUEUE) {
    // 宁可丢事件也不能把用户进程的内存吃光
    queue.shift();
  }
  queue.push(ev);
  if (!timer) {
    timer = setTimeout(flush, FLUSH_MS);
    // 不要因为待发送的事件而阻止用户进程退出
    timer.unref?.();
  }
}

function flush(): Promise<void> {
  timer = null;
  if (disabled || queue.length === 0) return inFlight;
  const batch = queue;
  queue = [];

  inFlight = inFlight
    .then(() =>
      fetchRaw(`${ENDPOINT}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sourceHeaders() },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(2000),
      }),
    )
    .then(async (r) => {
      // 服务端捎回断点状态。普通 HTTP 调用可能上千次，不能每次都走闸门问一遍；
      // 用这个缓存的开关决定要不要问。上报每 120ms 一次，新鲜度足够。
      try {
        const d = (await r.json()) as { httpArmed?: boolean };
        if (typeof d?.httpArmed === 'boolean') httpArmed = d.httpArmed;
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      // 服务端没起来 / 连不上：静默关闭，不再尝试，不影响用户程序
      disabled = true;
      queue = [];
    });

  return inFlight;
}

/** 进程退出前把队列排空，否则最后几条事件会丢 */
export async function drain(): Promise<void> {
  if (disabled) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
  await inFlight;
}

/** 保存未被包装的原始 fetch —— 上报自身绝不能被自己的拦截器捕获，否则无限递归 */
let fetchRaw: typeof fetch = globalThis.fetch;
export function setRawFetch(f: typeof fetch): void {
  fetchRaw = f;
}
export function rawFetch(): typeof fetch {
  return fetchRaw;
}
/**
 * 每次上报都带上「我是谁」：服务端只记用户选了要监控的进程（见 server/agents.ts 的 Acceptor）。
 * 监控标记每次现读 —— 不重启挂上探针时，标记是装探针那一刻才设进来的
 */
export function sourceHeaders(): Record<string, string> {
  const w = process.env.AGENTMAKE_WATCH;
  return { 'x-agentmake-pid': String(process.pid), ...(w ? { 'x-agentmake-watch': w } : {}) };
}

export function endpoint(): string {
  return ENDPOINT;
}
export function isDisabled(): boolean {
  return disabled;
}
