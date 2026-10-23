// 常驻服务：按入站请求切分运行。
//
// 默认一个进程就是一次运行。可 news 这种 HTTP 服务一个进程跑一整天，所有请求混成一次运行，
// 流程图把十几次互不相干的请求画在一张图上、对比没法对齐、重放基线也没法选 —— 它们的单位
// 都应该是「一次请求」。
//
// 做法：包一层 http(s).Server 的 'request' 事件分发，把整个处理函数放进 AsyncLocalStorage。
// Node 的异步上下文会跟着 await / Promise.all / 定时器一路传下去，于是处理这个请求期间
// 发出的每一次 fetch 都知道自己属于哪个请求。框架无关 —— express / koa / fastify / 裸 http
// 最终都走 http.Server 的 emit('request')。
//
// 两条克制：
//   1. 惰性建运行：请求里第一次真有调用时才补发 run.started。健康检查、静态文件这种
//      不碰模型也不发请求的，不会在列表里冒出一堆空运行
//   2. 任何差错都退回「不切分」，绝不影响请求本身

import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import type { InboundRequest } from '../shared/types.ts';

type ReqRun = {
  runId: string;
  trigger: string;
  startedAt: number;
  started: boolean;
  ended: boolean;
  /** 回归重发的请求会带着它对应的基线请求（x-agentmake-baseline） */
  baseline: string | null;
  request: InboundRequest;
};

export type RequestRunHooks = {
  /** 请求里第一次有调用：补发这次请求级运行的 run.started（ts 用请求到达的时刻） */
  start: (runId: string, trigger: string, ts: number, baseline: string | null) => void;
  end: (runId: string, httpStatus: number | undefined, request: InboundRequest) => void;
  /** 服务开始监听了哪个端口 */
  listening?: (port: number, host: string | null) => void;
};

/** 入站请求体最多记多少 —— 再大的多半是文件上传，重发也没意义 */
const REQ_BODY_CAP = 64 * 1024;

const als = new AsyncLocalStorage<ReqRun>();
const open = new Set<ReqRun>();
const PATCHED = Symbol.for('agentmake.requestScoped');

let processRunId = '';
let hooks: RequestRunHooks | null = null;
let reqNo = 0;

export function initRequestRuns(pid: string, h: RequestRunHooks): void {
  processRunId = pid;
  hooks = h;
}

/** 当前事件该归到哪次运行：在某个入站请求里就是那个请求，否则是进程本身 */
export function currentRunId(): string {
  const r = als.getStore();
  if (!r) return processRunId;
  if (!r.started) {
    r.started = true;
    open.add(r);
    try {
      hooks?.start(r.runId, r.trigger, r.startedAt, r.baseline);
    } catch {
      /* 上报失败不影响归属 */
    }
  }
  return r.runId;
}

/** 当前请求带来的基线（回归重发时才有） */
export function currentBaseline(): string | null {
  return als.getStore()?.baseline ?? null;
}

/** 进程退出时还没结束的请求（长连接、SSE、被杀掉）也要收尾，不然列表上永远「仍在运行」 */
export function endOpenRequestRuns(): void {
  for (const r of open) finish(r, undefined);
}

export function installRequestScopes(): void {
  if (process.env.AGENTMAKE_REQUEST_RUNS === '0') return;
  // https.Server 继承的是 tls.Server，不是 http.Server —— 两个原型都要包
  for (const S of [http.Server, https.Server]) {
    try {
      patch(S.prototype as unknown as Emitter);
    } catch {
      /* 包不上就不切分 */
    }
  }
}

type Emitter = { emit: (event: string | symbol, ...args: unknown[]) => boolean; [PATCHED]?: boolean };

function patch(proto: Emitter): void {
  if (proto[PATCHED]) return;
  const orig = proto.emit;
  proto.emit = function (this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'listening') {
      try {
        const a = (this as http.Server).address();
        if (a && typeof a === 'object') hooks?.listening?.(a.port, a.address ?? null);
      } catch {
        /* 拿不到地址就算了 */
      }
      return orig.call(this, event, ...args);
    }
    if (event !== 'request') return orig.call(this, event, ...args);
    let r: ReqRun;
    try {
      const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
      const base = req.headers['x-agentmake-baseline'];
      r = {
        runId: `${processRunId}_r${++reqNo}`,
        trigger: triggerOf(req),
        startedAt: Date.now(),
        started: false,
        ended: false,
        baseline: typeof base === 'string' && base ? base : null,
        request: {
          method: req.method ?? 'GET',
          url: String(req.url ?? '/'),
          contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null,
          body: '',
          truncated: false,
        },
      };
      captureRequestBody(req, r.request);
      // close 在正常结束、客户端断开、超时时都会触发，比 finish 兜得全
      res.once('close', () => finish(r, res.statusCode));
    } catch {
      return orig.call(this, event, ...args);
    }
    return als.run(r, () => orig.call(this, event, ...args));
  };
  proto[PATCHED] = true;
}

function finish(r: ReqRun, status: number | undefined): void {
  if (!r.started || r.ended) return;
  r.ended = true;
  open.delete(r);
  try {
    hooks?.end(r.runId, status, r.request);
  } catch {
    /* ignore */
  }
}

/**
 * 旁听请求体：HTTP 解析器是通过 req.push() 把数据喂进流的，在这里顺手记一份。
 *
 * 不能自己去 on('data') —— 那会把流切到 flowing 模式，用户代码稍后挂的监听器会丢掉前面的数据。
 * 包 push 不改变流的任何行为：用户用 on('data')、for await 还是 pipe 读，拿到的都一模一样。
 */
function captureRequestBody(req: http.IncomingMessage, into: InboundRequest): void {
  const push = req.push;
  const chunks: Buffer[] = [];
  let size = 0;
  req.push = function (chunk: unknown, encoding?: BufferEncoding): boolean {
    try {
      if (chunk != null && !into.truncated) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
        if (size + b.length > REQ_BODY_CAP) {
          into.truncated = true;
        } else {
          chunks.push(b);
          size += b.length;
          into.body = Buffer.concat(chunks).toString('utf8');
        }
      }
    } catch {
      /* 记不下就不记 */
    }
    return push.call(this, chunk, encoding);
  } as typeof req.push;
}

/** `POST /api/dispatch` —— query 一律丢掉，参数里常带 token */
function triggerOf(req: http.IncomingMessage): string {
  const p = String(req.url ?? '/').split('?')[0].slice(0, 200);
  return `${req.method ?? 'GET'} ${p}`;
}
