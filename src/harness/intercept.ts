// 包装 globalThis.fetch，捕获 LLM 调用与普通 HTTP 调用。
//
// 为什么拦 fetch 而不是 patch SDK：目标项目直接裸调 fetch（news/src/providers.mjs、
// bole/src/llm.js 都是），没有 SDK 可 patch。而且拦 fetch 天然框架无关 ——
// 任何手写 agent、任何 SDK、任何自研 HTTP 封装，最终都要走这一个口子。
//
// 为什么普通 HTTP 也要记：只看 LLM 调用的话执行图会退化成单点。news 整条流水线
// 只有一处调模型，真正的结构（并发抓取 7 个信源）全在普通请求里。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from '../shared/classify.ts';
import { denormalize, denormalizeResponse, fakeResponseBody } from '../shared/denormalize.ts';
import { normalizeRequest, normalizeResponse, normalizeStream } from '../shared/normalize.ts';
import { requestHash } from '../shared/hash.ts';
import { captureFrames } from '../shared/stack.ts';
import type { AgentEvent, Frame, LLMRequestIR, LLMResponseIR } from '../shared/types.ts';
import { gate } from './gate.ts';
import { initLoops, installLoopHooks } from './loops.ts';
import { baselineRunId, lookup as replayLookup } from './replay.ts';
import { currentRunId, endOpenRequestRuns, initRequestRuns, installRequestScopes } from './requests.ts';
import { installNodeHttp } from './nodehttp.ts';
import { drain, emit, endpoint, httpArmedAsync, primeHttpArmed, setRawFetch } from './transport.ts';

// agentmake 自身的源码目录 —— 把调试器自己的帧从执行图里剔掉。
// 只排除 src/ 而不是整个仓库：否则放在仓库内的测试 fixture 会被误判成调试器代码，
// 整条调用路径直接被过滤成空。
const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 工具响应体最多留多少字节。数据流图要拿它和下游的 prompt 对照；太大的只留前一段。
 * AGENTMAKE_BODY_BYTES=0 完全不读。
 */
const BODY_CAP = Number(process.env.AGENTMAKE_BODY_BYTES ?? 256 * 1024);
/** 只读文本类响应：图片、压缩包读了也对不上 prompt，白占内存 */
const TEXTY = /json|text|xml|html|javascript|csv|x-www-form-urlencoded/i;

/** 普通 HTTP 调用可能极多，设上限防止拖垮被调试进程 */
const MAX_HTTP_CALLS = Number(process.env.AGENTMAKE_MAX_HTTP ?? 5000);

let installed = false;
let seq = 0;
let callNo = 0;
let httpCount = 0;

/** 进程级运行。常驻服务里每个入站请求另有自己的请求级运行（见 requests.ts），挂在它下面 */
export const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** AGENTMAKE_GROUP：把多个进程的运行归成一组看（比如一批回归）。缺省时组就是进程自己 */
const groupId = process.env.AGENTMAKE_GROUP || undefined;

/** 事件归到当前所在的运行 —— 在请求里就是那个请求 */
function send(ev: Record<string, unknown> & { type: string }): void {
  sendFor(currentRunId(), ev);
}

function sendFor(rid: string, ev: Record<string, unknown> & { type: string }, ts = Date.now()): void {
  emit({ ...ev, runId: rid, seq: seq++, ts } as unknown as AgentEvent);
}

function runStartedFields(): Record<string, unknown> {
  return {
    cwd: process.cwd(),
    argv: process.argv.slice(1),
    pid: process.pid,
    ...(groupId ? { groupId } : {}),
    ...(baselineRunId ? { replayOf: baselineRunId } : {}),
  };
}

export function install(): void {
  if (installed) return;
  installed = true;

  const original = globalThis.fetch;
  if (typeof original !== 'function') return;
  setRawFetch(original); // 上报走原始 fetch，避免自我拦截造成无限递归
  primeHttpArmed();      // 预取断点状态，见 transport.ts 的说明
  initLoops(currentRunId, () => seq++);
  installLoopHooks();    // 循环插桩注入的代码通过 globalThis 调这些钩子

  sendFor(runId, { type: 'run.started', kind: 'process', ...runStartedFields() });

  initRequestRuns(runId, {
    // 回归重发的请求带着它对应的基线请求 —— 比进程级的 AGENTMAKE_REPLAY 精确，对比时一对一
    start: (rid, trigger, ts, baseline) =>
      sendFor(rid, {
        type: 'run.started', kind: 'request', parentRunId: runId, trigger, ...runStartedFields(),
        ...(baseline ? { replayOf: baseline } : {}),
      }, ts),
    end: (rid, httpStatus, request) => sendFor(rid, { type: 'run.ended', exitCode: null, httpStatus, request }),
    listening: (port, host) => sendFor(runId, { type: 'run.listening', port, host }),
  });
  installRequestScopes();

  globalThis.fetch = async function agentmakeFetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> {
    // ⚠️ 观测逻辑的任何差错都不允许影响调用方，全部兜住
    let plan: Plan | null = null;
    try {
      plan = await prepare(input, init);
    } catch {
      plan = null;
    }

    if (!plan) return original(input as never, init as never);
    const { ctx } = plan;

    // 响应不来自模型：断点上伪造的，或重放缓存命中
    if (plan.fake) {
      fakeAfter(plan);
      return plan.fake;
    }

    // 断点上选了「中止」：把错误抛进用户代码，模拟调用失败
    if (plan.abortMessage != null) {
      abortAfter(plan);
      throw new Error(plan.abortMessage);
    }

    const started = Date.now();
    try {
      const res = await original(plan.input as never, plan.init as never);
      // finishCall 可能因「响应后断点」返回改写过的 Response，也可能因「中止」抛出。
      // 这两种是用户要的行为，必须透传；只有观测本身的差错才吞掉。
      return await finishCall(ctx, res, started);
    } catch (err) {
      try {
        failCall(ctx, err, Date.now() - started);
      } catch {
        /* ignore */
      }
      throw err; // 原样抛回，行为与未拦截时完全一致
    }
  } as typeof fetch;

  installExitHooks();

  // 不走全局 fetch 的那一半：axios、got、底层用 node-fetch 的旧版 SDK —— 接到同一条处理链上
  installNodeHttp({
    isOwn: (url) => url.startsWith(endpoint()),
    prepare: (url, init) => prepare(url, init as never),
    finish: (ctx, res, started) => finishCall(ctx as CallContext, res, started),
    fail: (ctx, err, ms) => failCall(ctx as CallContext, err, ms),
    fakeAfter: (plan) => fakeAfter(plan as Plan),
    abortAfter: (plan) => abortAfter(plan as Plan),
    toolStart: (url, method) => {
      if (httpCount >= MAX_HTTP_CALLS) return null;
      httpCount++;
      return { callId: `call_${runId.slice(4)}_${callNo++}`, url, method, frames: captureFrames(SELF_DIR) };
    },
    toolDone: (t, info) => {
      const c = t as { callId: string; url: string; method: string; frames: Frame[] };
      send({
        type: 'http.call', callId: c.callId, method: c.method, url: c.url, status: info.status, ok: info.ok,
        durationMs: info.durationMs, startedAt: info.startedAt, error: info.error, frames: c.frames,
      });
      if (info.body) send({ type: 'http.body', callId: c.callId, bytes: info.body.bytes, body: info.body.text, truncated: info.body.truncated });
    },
    bodyCap: BODY_CAP,
  });
}

/** 断点上伪造的回答 / 重放命中：模型没被调用，补一条 llm.after */
function fakeAfter(plan: Plan): void {
  send({
    type: 'llm.after',
    callId: plan.ctx.callId,
    ok: true,
    status: plan.fake!.status,
    durationMs: 0,
    response: plan.fakeIR,
    error: null,
    streaming: /event-stream/i.test(plan.fake!.headers.get('content-type') ?? ''),
    requestHash: plan.ctx.hash,
    ...(plan.replayed ? { replayed: true } : { faked: true }),
  });
}

function abortAfter(plan: Plan): void {
  send({
    type: 'llm.after',
    callId: plan.ctx.callId,
    ok: false,
    status: 0,
    durationMs: 0,
    response: null,
    error: plan.abortMessage ?? 'aborted by agentmake',
    streaming: false,
    aborted: true,
  });
}

type CallContext = {
  callId: string;
  kind: ReturnType<typeof classify>['kind'];
  isLLM: boolean;
  method: string;
  url: string;
  frames: Frame[];
  /** 最终发出的请求的指纹（断点改写之后），重放缓存的键 */
  hash?: string;
};

type Plan = {
  ctx: CallContext;
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
  fake?: Response;
  fakeIR?: LLMResponseIR;
  abortMessage?: string;
  /** 响应来自重放缓存，模型没有被真的调用 */
  replayed?: boolean;
};

/** 读出请求体文本，不消耗调用方的那一份。读不了（流式 body）就返回 null */
async function bodyText(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<string | null> {
  const b = init?.body;
  if (typeof b === 'string') return b;
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) {
    const v = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return new TextDecoder().decode(v);
  }
  if (b instanceof Blob) return b.text();
  if (b != null) return null;
  if (input instanceof Request && input.body && !input.bodyUsed) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

async function prepare(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Plan | null> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  const method = String(init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();
  const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);

  const cls = classify(url, method, headers as never);
  const isLLM = cls.kind !== 'unknown';

  if (!isLLM) {
    if (httpCount >= MAX_HTTP_CALLS) return null;
    httpCount++;
    const frames = captureFrames(SELF_DIR);
    const callId = `call_${runId.slice(4)}_${callNo++}`;
    const ctx: CallContext = { callId, kind: cls.kind, isLLM, method, url, frames };

    // HTTP 调用可能上千次，只在服务端确实开了 HTTP 断点时才走闸门
    if (!(await httpArmedAsync())) return { ctx, input, init };

    const d = await gate('http.before', {
      type: 'http.call', callId, method, url, status: 0, ok: false,
      durationMs: 0, error: null, frames, runId: currentRunId(), seq: seq++, ts: Date.now(),
    });
    if (d.action === 'abort') {
      return { ctx, input, init, abortMessage: d.message || 'aborted by agentmake' };
    }
    if (d.action === 'fake') {
      // 伪造工具返回值 —— 测异常分支不用真去制造故障
      return {
        ctx,
        input,
        init,
        fake: new Response(d.body ?? '', {
          status: d.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      };
    }
    return { ctx, input, init };
  }

  const frames = captureFrames(SELF_DIR);
  const callId = `call_${runId.slice(4)}_${callNo++}`;

  // 请求体可能在 init.body 里，也可能在 Request 对象自己身上（fetch(new Request(url, {body}))）。
  // 后者读 clone，不消耗用户的那一份；只有流式 body（ReadableStream）读不了，跳过解析。
  let parsed: unknown = null;
  const text = await bodyText(input, init);
  if (text != null) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const request = normalizeRequest(cls, parsed);
  const ctx: CallContext = { callId, kind: cls.kind, isLLM, method, url, frames };

  // 请示调试器。没有断点命中时服务端立即返回，开销是一次本地 HTTP 往返（~1ms），
  // 相对 LLM 调用本身的几百毫秒可以忽略。事件也在这个请求里一并上报（见 gate.ts）。
  const decision = await gate('llm.before', {
    type: 'llm.before',
    callId,
    url,
    request,
    frames,
    runId: currentRunId(),
    seq: seq++,
    ts: Date.now(),
  });

  if (decision.action === 'abort') {
    return { ctx, input, init, abortMessage: decision.message || 'aborted by agentmake' };
  }

  if (decision.action === 'fake') {
    const bodyObj = fakeResponseBody(cls.kind, decision.text ?? '', request.model);
    return {
      ctx,
      input,
      init,
      fake: new Response(JSON.stringify(bodyObj), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      fakeIR: normalizeResponse(cls.kind, bodyObj),
    };
  }

  let finalRequest = request;
  let nextInput = input;
  let nextInit = init;

  if (decision.action === 'patch') {
    const { body: newBody, url: newUrl } = denormalize(cls.kind, request, decision.patch, url);
    const target = newUrl ?? url;
    const merged = { ...(init ?? {}), body: JSON.stringify(newBody) };
    if (input instanceof Request) {
      // input 是 Request 对象时不能只换 init，得重建，否则原对象里的 body 会盖回来。
      // 方法、头、signal 从原 Request 继承（init 里给了的优先），长度头让 fetch 自己重算
      const h = new Headers((init?.headers as HeadersInit | undefined) ?? input.headers);
      h.delete('content-length');
      nextInput = new Request(target, {
        method: init?.method ?? input.method,
        headers: h,
        signal: init?.signal ?? input.signal,
        body: merged.body,
      });
      nextInit = undefined;
    } else {
      nextInput = target;
      nextInit = merged;
    }
    // 指纹要按**实际发出去的**请求算：改过 prompt 就该穿透缓存去真调
    finalRequest = normalizeRequest(classify(target, method, headers as never), newBody);
    // 同时把改写后的请求补报一次，否则库里留的是改之前的版本
    send({ type: 'llm.patched', callId, url: target, request: finalRequest } as never);
  }

  ctx.hash = requestHash(finalRequest);

  // 重放：命中就直接把上次的响应交回去，模型不被调用、不花钱、不等待
  // 进程级开了重放，或这个请求自己带着基线（回归重发）—— lookup 自己判断，没基线直接返回 null
  {
    const hit = await replayLookup(ctx.hash);
    if (hit) {
      const sse = /event-stream/i.test(hit.ctype);
      let ir: LLMResponseIR | undefined;
      try {
        ir = sse ? normalizeStream(cls.kind, hit.body) : normalizeResponse(cls.kind, JSON.parse(hit.body));
      } catch {
        ir = undefined;
      }
      return {
        ctx,
        input: nextInput,
        init: nextInit,
        // 流式的按原样回放成一段流 —— 用户代码照样一段一段地读
        fake: new Response(hit.body, {
          status: hit.status,
          headers: { 'content-type': hit.ctype },
        }),
        fakeIR: ir,
        replayed: true,
      };
    }
  }

  return { ctx, input: nextInput, init: nextInit };
}

/**
 * 异步读响应体的副本，读完补发 http.body。
 *
 * 三条克制：只读文本类、读到上限就停（并取消副本，不影响原始流）、10 秒读不完就放弃。
 * SSE 这种永远读不完的流直接跳过。任何差错吞掉 —— 用户拿到的 Response 完全不受影响。
 */
function captureBody(callId: string, res: Response): void {
  if (BODY_CAP <= 0 || !res.body) return;
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (/event-stream/i.test(ct) || (ct && !TEXTY.test(ct))) return;
    const declared = Number(res.headers.get('content-length') ?? NaN);
    const clone = res.clone();
    void readCapped(clone, BODY_CAP)
      .then(({ text, bytes, truncated }) =>
        send({
          type: 'http.body',
          callId,
          bytes: truncated && Number.isFinite(declared) ? declared : bytes,
          body: text,
          truncated,
        }),
      )
      .catch(() => {});
  } catch {
    /* 读不了就不读 */
  }
}

async function readCapped(res: Response, cap: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), 10_000);
  timer.unref?.();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - bytes;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      bytes += Math.min(value.byteLength, room);
      if (value.byteLength > room || bytes >= cap) {
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

/** 返回交还给调用方的 Response —— 命中「响应后断点」时它可能已被改写 */
async function finishCall(ctx: CallContext, res: Response, started: number): Promise<Response> {
  const durationMs = Date.now() - started;

  if (!ctx.isLLM) {
    const ev = {
      type: 'http.call' as const,
      callId: ctx.callId,
      method: ctx.method,
      url: ctx.url,
      status: res.status,
      ok: res.ok,
      durationMs,
      startedAt: started,
      error: null,
      frames: ctx.frames,
    };
    if (!(await httpArmedAsync())) {
      send(ev);
      captureBody(ctx.callId, res);
      return res;
    }
    const d = await gate('http.after', { ...ev, runId: currentRunId(), seq: seq++, ts: Date.now() });
    if (d.action === 'replace') {
      const replaced = new Response(d.body ?? (await res.clone().text()), {
        status: d.status ?? res.status,
        headers: res.headers,
      });
      captureBody(ctx.callId, replaced); // 记下游真正拿到的那一份
      return replaced;
    }
    if (d.action === 'abort') throw new Error(d.message || 'aborted by agentmake');
    captureBody(ctx.callId, res);
    return res;
  }

  const ct = res.headers.get('content-type') ?? '';
  const streaming = ct.includes('text/event-stream');

  // 流式：原样交回去，副本在后台读完再解析上报 —— 不能让用户等整段流结束。
  // 「响应后断点」对流式不生效（流已经在往下游走了）
  if (streaming) {
    void finishStreaming(ctx, res.clone(), started, res.status, res.ok).catch(() => {});
    return res;
  }

  let response: LLMResponseIR | null = null;
  let error: string | null = null;
  let rawBody: unknown = null;

  if (!streaming) {
    // clone() 后读副本，绝不消耗调用方要用的那个 body
    try {
      const text = await res.clone().text();
      if (res.ok) {
        rawBody = JSON.parse(text);
        response = normalizeResponse(ctx.kind, rawBody);
      } else {
        error = text.slice(0, 2000);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const ev = {
    type: 'llm.after' as const,
    callId: ctx.callId,
    ok: res.ok,
    status: res.status,
    durationMs,
    response,
    error,
    streaming, // TODO: tee 流式响应，逐 delta 上报（目标项目暂不使用流式）
    // 重放缓存的键。原始响应体服务端已经通过 response.raw 存了，不必重复上报
    requestHash: ctx.hash,
  };

  const d = await gate('llm.after', { ...ev, url: ctx.url, frames: ctx.frames, runId: currentRunId(), seq: seq++, ts: Date.now() });

  if (d.action === 'abort') throw new Error(d.message || 'aborted by agentmake');

  // 改写模型的回答 —— 用来测下游代码遇到异常输出会怎样
  if (d.action === 'replace' && rawBody != null && typeof d.text === 'string') {
    const patched = denormalizeResponse(ctx.kind, rawBody, d.text);
    send({ ...ev, response: normalizeResponse(ctx.kind, patched), replaced: true });
    return new Response(JSON.stringify(patched), { status: res.status, headers: res.headers });
  }

  send(ev);
  return res;
}

/**
 * 读完流式响应的副本，按协议拼回完整的回答（文本、工具调用、finish reason、usage）再上报。
 * 用户中途断开、流读到一半出错：拿已经收到的那部分照样解析 —— 半截的回答也比没有强。
 * 原始的 SSE 文本作为 raw 存下来，重放时原样回放成流。
 */
async function finishStreaming(ctx: CallContext, copy: Response, started: number, status: number, ok: boolean): Promise<void> {
  let text = '';
  let error: string | null = null;
  try {
    const reader = copy.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  } catch (e) {
    error = `流在中途断了：${e instanceof Error ? e.message : String(e)}`;
  }
  let response: LLMResponseIR | null = null;
  try {
    response = ok ? normalizeStream(ctx.kind, text) : null;
  } catch {
    response = null;
  }
  send({
    type: 'llm.after',
    callId: ctx.callId,
    ok,
    status,
    durationMs: Date.now() - started,
    response,
    error: ok ? error : text.slice(0, 2000),
    streaming: true,
    requestHash: ctx.hash,
  });
}

function failCall(ctx: CallContext, err: unknown, durationMs: number): void {
  const message = err instanceof Error ? err.message : String(err);
  if (ctx.isLLM) {
    send({
      type: 'llm.after',
      callId: ctx.callId,
      ok: false,
      status: 0,
      durationMs,
      response: null,
      error: message,
      streaming: false,
    });
  } else {
    send({
      type: 'http.call',
      callId: ctx.callId,
      method: ctx.method,
      url: ctx.url,
      status: 0,
      ok: false,
      durationMs,
      startedAt: Date.now() - durationMs,
      error: message,
      frames: ctx.frames,
    });
  }
}

function installExitHooks(): void {
  let done = false;
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    try {
      endOpenRequestRuns();
      sendFor(runId, { type: 'run.ended', exitCode: code });
    } catch {
      /* ignore */
    }
  };

  process.on('beforeExit', async () => {
    finish(0);
    await drain().catch(() => {});
  });
  process.on('exit', () => finish(process.exitCode ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      finish(null);
      await drain().catch(() => {});
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}
