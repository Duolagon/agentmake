// node:http / node:https 的拦截 —— 不走全局 fetch 的那一半 Node 生态。
//
// axios、got、旧版 OpenAI / Anthropic SDK（底层 node-fetch）、各种自研封装都是直接调 http.request。
// 只拦 fetch 的话，这些 agent 的模型调用在调试器里完全看不见。
//
// 做法：包住 http.request / https.request，把它接到 fetch 那条处理链上（intercept.ts 的 prepare / finishCall），
// 于是归一化、断点改写、伪造回答、重放缓存、规则判定、数据流 —— 能力和 fetch 完全一样，不重写第二遍。
//   - 请求体：模型调用先攒着，等用户 end() 了再决定（断点可能要改写它、伪造回答可能根本不发）
//   - 响应：非流式的先整段读完，过完「响应后断点」再交给用户一个内容相同（或被改写过）的响应；
//           流式的原样交给用户、旁听一份，流结束后再解析上报 —— 不能让用户等整段流
//   - 普通 HTTP（工具调用）：只观测，不改变任何行为
// 压缩（axios 默认要 gzip）在旁听那一侧解开，交给用户的永远是原始字节。
//
// 铁律和 fetch 那边一样：观测出任何差错都退回原样调用，绝不改变用户程序的行为。

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { classify } from '../shared/classify.ts';

/** intercept.ts 提供的处理链 —— 和 fetch 共用同一套 */
export type Core = {
  /** 调试器自己的上报地址，不拦 */
  isOwn(url: string): boolean;
  prepare(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<Plan | null>;
  finish(ctx: unknown, res: Response, started: number): Promise<Response>;
  fail(ctx: unknown, err: unknown, ms: number): void;
  /** 伪造 / 重放命中时补发 llm.after */
  fakeAfter(plan: Plan): void;
  abortAfter(plan: Plan): void;
  toolStart(url: string, method: string): unknown | null;
  toolDone(t: unknown, info: { status: number; ok: boolean; durationMs: number; startedAt: number; error: string | null; body: { text: string; bytes: number; truncated: boolean } | null }): void;
  bodyCap: number;
};

type Plan = {
  ctx: unknown;
  input: unknown;
  init?: { body?: unknown };
  fake?: Response;
  abortMessage?: string;
};

type Info = { url: string; method: string; headers: Record<string, string> };

const PATCHED = Symbol.for('agentmake.nodeHttp');

export function installNodeHttp(core: Core): void {
  if (process.env.AGENTMAKE_NODE_HTTP === '0') return;
  patch(http, 'http:', core);
  patch(https, 'https:', core);
  // ESM 的 `import { request } from 'node:http'` 是导入时拷走的绑定 —— 同步一次才看得到包过的版本
  try {
    syncBuiltinESMExports();
  } catch {
    /* 老 Node 没有，只影响 ESM 具名导入 */
  }
}

type Mod = { request: (...a: unknown[]) => http.ClientRequest; get: (...a: unknown[]) => http.ClientRequest };

function patch(mod: Mod, protocol: string, core: Core): void {
  const orig = mod.request as Mod['request'] & { [PATCHED]?: boolean };
  if (orig[PATCHED]) return;
  const wrapped = function (this: unknown, ...args: unknown[]): http.ClientRequest {
    let info: Info | null = null;
    try {
      info = describe(args, protocol);
    } catch {
      info = null;
    }
    if (!info || core.isOwn(info.url)) return orig.apply(this, args);
    let isLLM = false;
    try {
      isLLM = classify(info.url, info.method, info.headers).kind !== 'unknown';
    } catch {
      isLLM = false;
    }
    const req = orig.apply(this, args);
    try {
      if (isLLM) interceptLLM(req, info, core);
      else observeTool(req, info, core);
    } catch {
      /* 包不上就当没拦 */
    }
    return req;
  } as Mod['request'] & { [PATCHED]?: boolean };
  wrapped[PATCHED] = true;
  mod.request = wrapped;
  // http.get 内部调的是模块私有的 request，不经过上面那个导出 —— 得一起换
  mod.get = function (...args: unknown[]) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

/** http.request 的三种调用形状：(url, opts?, cb?) / (opts, cb?) —— 拼出完整 URL、方法、请求头 */
function describe(args: unknown[], protocol: string): Info {
  let url: URL | null = null;
  let opts: Record<string, unknown> = {};
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    url = new URL(String(args[0]));
    if (args[1] && typeof args[1] === 'object') opts = args[1] as Record<string, unknown>;
  } else if (args[0] && typeof args[0] === 'object') {
    opts = args[0] as Record<string, unknown>;
  }
  if (!url || opts.path || opts.hostname || opts.host) {
    const proto = String(opts.protocol ?? url?.protocol ?? protocol);
    const host = String(opts.hostname ?? opts.host ?? url?.hostname ?? 'localhost').replace(/:\d+$/, '');
    const port = opts.port ?? url?.port ?? '';
    const path = String(opts.path ?? (url ? url.pathname + url.search : '/'));
    url = new URL(`${proto}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port ? `:${port}` : ''}${path}`);
  }
  return {
    url: url.href,
    method: String(opts.method ?? 'GET').toUpperCase(),
    headers: lowerHeaders(opts.headers),
  };
}

function lowerHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== 'object') return out;
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i]).toLowerCase()] = String(h[i + 1]);
    return out;
  }
  for (const [k, v] of Object.entries(h)) if (v != null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

// ── 模型调用 ───────────────────────────────────────────────

function interceptLLM(req: http.ClientRequest, info: Info, core: Core): void {
  const chunks: Buffer[] = [];
  const realWrite = req.write.bind(req);
  const realEnd = req.end.bind(req) as (...a: unknown[]) => http.ClientRequest;
  const realEmit = req.emit;
  let ended = false;
  /**
   * waiting = 还在等决定（查重放、过断点）—— 这期间连接上的报错先压着：
   *           重放命中的话根本不需要这条连接，「连不上」不该抛给用户
   * fake    = 交了伪造 / 重放的响应 —— 那条没用上的连接再报什么都吞掉
   * real    = 真发出去了 —— 照常
   */
  let phase: 'waiting' | 'fake' | 'real' = 'waiting';
  let pendingErr: unknown = null;
  /** 已经把（真的或伪造的）响应交给用户了 —— 之后底层连接的报错不再往上抛 */
  let delivered = false;
  void realWrite;
  let onReal: ((ev: string | symbol, a: unknown[]) => boolean) | null = null;

  req.emit = function (this: http.ClientRequest, ev: string | symbol, ...a: unknown[]): boolean {
    if (phase === 'waiting') {
      if (ev === 'error') { pendingErr ??= a[0]; return true; }
      return realEmit.call(this, ev, ...a);
    }
    if (phase === 'fake') return ev === 'error' ? true : realEmit.call(this, ev, ...a);
    return onReal ? onReal.call(this, ev, a) : realEmit.call(this, ev, ...a);
  } as typeof req.emit;

  req.write = function (chunk: unknown, enc?: unknown, cb?: unknown): boolean {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (chunk != null) chunks.push(toBuf(chunk, enc as BufferEncoding | undefined));
    if (typeof cb === 'function') process.nextTick(cb as () => void);
    return true;
  } as typeof req.write;

  req.end = function (chunk?: unknown, enc?: unknown, cb?: unknown): http.ClientRequest {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (ended) return req;
    ended = true;
    if (chunk != null) chunks.push(toBuf(chunk, enc as BufferEncoding | undefined));
    const body = Buffer.concat(chunks);

    void (async () => {
      let plan: Plan | null = null;
      try {
        plan = await core.prepare(info.url, { method: info.method, headers: { ...info.headers, ...lowerHeaders(req.getHeaders()) }, body: body.toString('utf8') });
      } catch {
        plan = null;
      }
      if (!plan) {
        phase = 'real';
        if (pendingErr) { realEmit.call(req, 'error', pendingErr); return; }
        try { realEnd(body.length ? body : undefined, cb); } catch { /* 连接已经坏了，错误会照常抛给用户 */ }
        return;
      }

      // 断点上伪造的回答 / 重放命中：根本不发请求，直接交一个响应
      if (plan.fake) {
        phase = 'fake';
        core.fakeAfter(plan);
        delivered = true;
        const msg = await toIncoming(plan.fake, req);
        (req as unknown as { res: unknown }).res = msg;
        realEmit.call(req, 'response', msg);
        // 用户读完之后再收掉那个没发出去的请求（提前销毁会把还没读的响应一起丢掉）
        msg.once('end', () => setImmediate(() => { try { req.destroy(); } catch { /* ignore */ } }));
        if (typeof cb === 'function') (cb as () => void)();
        return;
      }

      if (plan.abortMessage != null) {
        phase = 'fake';
        core.abortAfter(plan);
        delivered = true;
        realEmit.call(req, 'error', new Error(plan.abortMessage));
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }

      // 断点上改写过：换请求体（连同 content-length）；Gemini 换模型是换 URL 里的路径
      let out = body;
      const nextBody = plan.init?.body;
      if (typeof nextBody === 'string' && nextBody !== body.toString('utf8')) {
        out = Buffer.from(nextBody);
        try { if (!req.headersSent) req.setHeader('content-length', out.length); } catch { /* 头已经发出去了，只能按原样 */ }
      }
      if (typeof plan.input === 'string' && plan.input !== info.url) {
        try { if (!req.headersSent) req.path = new URL(plan.input).pathname + new URL(plan.input).search; } catch { /* ignore */ }
      }

      const t0 = Date.now();
      phase = 'real';
      onReal = function (this: http.ClientRequest, ev: string | symbol, a: unknown[]): boolean {
        if (ev === 'error') {
          if (delivered) return true;
          delivered = true;
          core.fail(plan!.ctx, a[0], Date.now() - t0);
          return realEmit.call(this, ev, ...a);
        }
        if (ev !== 'response') return realEmit.call(this, ev, ...a);
        delivered = true;
        const res = a[0] as http.IncomingMessage;
        const ct = String(res.headers['content-type'] ?? '');

        if (/event-stream/i.test(ct)) {
          // 流式：原样交给用户，旁听一份；流结束后交给处理链去解析上报
          tap(res, Infinity, (raw) => {
            void core.finish(plan!.ctx, responseOf(res, decode(raw, res.headers)), t0).catch(() => {});
          });
          return realEmit.call(this, ev, res);
        }

        // 非流式：读完整段 → 过处理链（可能停在「响应后断点」、可能被改写）→ 交给用户
        collect(res).then(async (raw) => {
          const plain = decode(raw, res.headers);
          const seen = responseOf(res, plain);
          let back: Response;
          try {
            back = await core.finish(plan!.ctx, seen, t0);
          } catch (err) {
            realEmit.call(this, 'error', err);
            return;
          }
          // 没被改写：原样交回原始字节（压缩的照旧压缩）；改写过：交解压后的新内容
          const msg = back === seen
            ? incoming(res.statusCode ?? 200, res.statusMessage ?? '', res.headers, raw, this)
            : await toIncoming(back, this);
          realEmit.call(this, 'response', msg);
        }, (err) => realEmit.call(this, 'error', err));
        return true;
      };

      // 等决定期间连接已经报错了（连不上之类）—— 现在要真发了，把它交出去
      if (pendingErr) {
        req.emit('error', pendingErr);
        return;
      }
      try { realEnd(out.length ? out : undefined, cb); } catch (err) { req.emit('error', err); }
    })();
    return req;
  } as typeof req.end;
}

// ── 普通 HTTP（工具调用）：只观测 ──────────────────────────

function observeTool(req: http.ClientRequest, info: Info, core: Core): void {
  const t = core.toolStart(info.url, info.method);
  if (!t) return;
  const t0 = Date.now();
  const realEmit = req.emit;
  let done = false;
  req.emit = function (this: http.ClientRequest, ev: string | symbol, ...a: unknown[]): boolean {
    try {
      if (ev === 'response' && !done) {
        const res = a[0] as http.IncomingMessage;
        tap(res, core.bodyCap, (raw, truncated, total) => {
          if (done) return;
          done = true;
          const ct = String(res.headers['content-type'] ?? '');
          const texty = !ct || /json|text|xml|html|javascript|csv|x-www-form-urlencoded/i.test(ct);
          core.toolDone(t, {
            status: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) < 400,
            durationMs: Date.now() - t0,
            startedAt: t0,
            error: null,
            body: texty && !/event-stream/i.test(ct)
              ? { text: truncated ? raw.toString('utf8') : decode(raw, res.headers), bytes: total, truncated }
              : null,
          });
        });
      } else if (ev === 'error' && !done) {
        done = true;
        const err = a[0];
        core.toolDone(t, { status: 0, ok: false, durationMs: Date.now() - t0, startedAt: t0, error: err instanceof Error ? err.message : String(err), body: null });
      }
    } catch {
      /* 观测出错不影响请求 */
    }
    return realEmit.call(this, ev, ...a);
  } as typeof req.emit;
}

// ── 小工具 ─────────────────────────────────────────────────

function toBuf(chunk: unknown, enc?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), enc ?? 'utf8');
}

/** 我们自己读这个响应（用户还没拿到它） */
function collect(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/**
 * 旁听响应体：包 push，不挂 'data'（挂了会把流切到 flowing 模式，用户稍后挂的监听器就丢数据）。
 * 读完（或连接关了）回调一次。
 */
function tap(res: http.IncomingMessage, cap: number, done: (raw: Buffer, truncated: boolean, total: number) => void): void {
  const push = res.push;
  const chunks: Buffer[] = [];
  let size = 0;
  let total = 0;
  let truncated = false;
  let fired = false;
  res.push = function (chunk: unknown, enc?: BufferEncoding): boolean {
    try {
      if (chunk != null) {
        const b = toBuf(chunk, enc);
        total += b.length;
        if (size + b.length <= cap) { chunks.push(b); size += b.length; }
        else truncated = true;
      }
    } catch { /* ignore */ }
    return push.call(this, chunk, enc);
  } as typeof res.push;
  const fire = () => {
    if (fired) return;
    fired = true;
    try { done(Buffer.concat(chunks), truncated, total); } catch { /* ignore */ }
  };
  res.once('end', fire);
  res.once('close', fire);
}

/** 按 content-encoding 解压（只给我们自己看） */
function decode(raw: Buffer, headers: http.IncomingHttpHeaders): string {
  const enc = String(headers['content-encoding'] ?? '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(raw).toString('utf8');
    if (enc.includes('br')) return zlib.brotliDecompressSync(raw).toString('utf8');
    if (enc.includes('deflate')) {
      try { return zlib.inflateSync(raw).toString('utf8'); } catch { return zlib.inflateRawSync(raw).toString('utf8'); }
    }
  } catch { /* 解不开就按原样 */ }
  return raw.toString('utf8');
}

/** 给处理链看的 Response：已解压，去掉 content-encoding / content-length */
function responseOf(res: http.IncomingMessage, text: string): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v == null || k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  const status = res.statusCode ?? 200;
  const nobody = status === 204 || status === 304 || (status >= 100 && status < 200);
  return new Response(nobody ? null : text, { status: status < 200 ? 200 : status, statusText: res.statusMessage ?? '', headers });
}

/** 造一个 IncomingMessage 交给用户 —— axios / node-fetch 读它和读真的一样 */
function incoming(status: number, statusMessage: string, headers: http.IncomingHttpHeaders, body: Buffer, req: http.ClientRequest): http.IncomingMessage {
  const msg = new http.IncomingMessage(new net.Socket());
  msg.statusCode = status;
  msg.statusMessage = statusMessage;
  msg.httpVersion = '1.1';
  msg.httpVersionMajor = 1;
  msg.httpVersionMinor = 1;
  msg.headers = { ...headers };
  msg.rawHeaders = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.flatMap((x) => [k, x]) : v == null ? [] : [k, String(v)]));
  (msg as unknown as { req: unknown }).req = req;
  msg.push(body);
  msg.push(null);
  msg.complete = true;
  return msg;
}

async function toIncoming(r: Response, req: http.ClientRequest): Promise<http.IncomingMessage> {
  const body = Buffer.from(await r.arrayBuffer());
  const headers: http.IncomingHttpHeaders = {};
  r.headers.forEach((v, k) => {
    if (k !== 'content-encoding' && k !== 'transfer-encoding') headers[k] = v;
  });
  headers['content-length'] = String(body.length);
  return incoming(r.status, r.statusText, headers, body, req);
}
