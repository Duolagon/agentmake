// 语言无关的 harness 钩子 API。
//
// 为什么存在：Node harness 把 classify / normalize / denormalize / requestHash 全部
// 在**进程内**做完，再把成品事件发给服务端。要给 Python 做同样的能力，就得把这四块
// 逻辑重写一遍 —— 而它们恰好是整个系统最琐碎、最容易写错的部分（三家协议的
// 字段映射、保守合并、指纹的规范化序列化）。重写一遍等于养两份必然漂移的实现，
// 而漂移在这里的后果很具体：**两边算出的 requestHash 不一样，跨语言重放永远打不中**。
//
// 所以换个切法：客户端只做它非做不可的两件事 —— 抓调用栈、拦 HTTP；
// 剩下的全部回到服务端。客户端把「我要发这个请求」原样递过来，服务端回答
// 「照发 / 改成这样发 / 别发了直接用这个响应 / 中止」。
//
//   POST /api/hook/before  { runId, callId, url, method, body, frames }
//     → { action: continue | patch | fake | abort, url?, body?, response?, message? }
//   POST /api/hook/after   { runId, callId, status, ok, durationMs, body }
//     → { action: continue | replace | abort, body?, status? }
//
// 代价是每次 LLM 调用多一次本地往返（~1ms）—— 但 Node harness 本来就要为闸门
// 走一次往返，所以这不是新增成本。
//
// 收益：新增一门语言的成本从「重写四个模块」降到「抓栈 + 拦 HTTP + 两个 POST」。

import { classify } from '../shared/classify.ts';
import { normalizeRequest, normalizeResponse, normalizeStream } from '../shared/normalize.ts';
import { denormalize, denormalizeResponse, fakeResponseBody } from '../shared/denormalize.ts';
import { requestHash } from '../shared/hash.ts';
import type { Gate, GateDecision, GatePhase } from './gate.ts';
import type { AgentEvent, Frame, LLMRequestIR, ProviderKind } from '../shared/types.ts';

export type HookCtx = {
  gate: Gate;
  record: (ev: AgentEvent) => void;
  broadcastRaw: (ev: Record<string, unknown>) => void;
  replay: (baseline: string, hash: string, runId?: string) => { body: string; status: number; ctype?: string } | null;
};

type CallCtx = {
  kind: ProviderKind;
  isLLM: boolean;
  url: string;
  method: string;
  hash: string;
  ir: LLMRequestIR | null;
  frames: Frame[];
  runId: string;
  seq: number;
  startedAt: number;
};

// before 与 after 之间要携带的上下文。用 Map 而不是让客户端回传：
// 客户端回传等于把 IR 在网络上来回搬两趟，而且给了它篡改的机会。
const contexts = new Map<string, CallCtx>();
const MAX_CTX = 5000;

function remember(callId: string, c: CallCtx): void {
  // 被调试进程崩在 before 和 after 之间时上下文会留下来 —— 定量淘汰，不做 TTL 定时器
  if (contexts.size >= MAX_CTX) {
    for (const k of contexts.keys()) {
      contexts.delete(k);
      if (contexts.size < MAX_CTX * 0.9) break;
    }
  }
  contexts.set(callId, c);
}

export type BeforeReq = {
  runId: string;
  callId: string;
  seq: number;
  url: string;
  method?: string;
  /** 请求体。字符串按 JSON 解析；解析不了就当非 LLM 调用 */
  body?: string | null;
  headers?: Record<string, string>;
  frames?: Frame[];
  /** 重放基线 runId。给了就先查缓存 */
  replayBaseline?: string | null;
};

export async function hookBefore(ctx: HookCtx, r: BeforeReq): Promise<Record<string, unknown>> {
  const method = (r.method ?? 'POST').toUpperCase();
  const frames = r.frames ?? [];
  const cls = classify(r.url, method, r.headers);
  const isLLM = cls.kind !== 'unknown';
  const ts = Date.now();

  if (!isLLM) {
    // 非 LLM 调用：只有开了工具断点才走闸门，否则原样放行。
    // （HTTP 调用可能上千次，每次都问一遍会白白多出上千次往返 —— 和 Node harness 同策略）
    if (!ctx.gate.httpArmed) {
      remember(r.callId, {
        kind: 'unknown', isLLM: false, url: r.url, method, hash: '', ir: null,
        frames, runId: r.runId, seq: r.seq, startedAt: ts,
      });
      return { action: 'continue', isLLM: false };
    }
    const d = await hold(ctx, 'http.before', {
      callId: r.callId, runId: r.runId, url: r.url, payload: { method, url: r.url }, frames,
    });
    remember(r.callId, {
      kind: 'unknown', isLLM: false, url: r.url, method, hash: '', ir: null,
      frames, runId: r.runId, seq: r.seq, startedAt: ts,
    });
    if (d.action === 'abort') return { action: 'abort', isLLM: false, message: d.message ?? 'aborted by agentmake' };
    if (d.action === 'fake') {
      return {
        action: 'fake',
        isLLM: false,
        response: { status: d.status ?? 200, body: d.body ?? '' },
      };
    }
    return { action: 'continue', isLLM: false };
  }

  // ── LLM 调用 ──
  let raw: unknown;
  try {
    raw = JSON.parse(r.body ?? '{}');
  } catch {
    // 请求体不是 JSON —— 我们看不懂就别挡路
    return { action: 'continue', isLLM: false };
  }

  let ir = normalizeRequest(cls, raw);
  let sendUrl = r.url;
  let sendBody: unknown = raw;

  ctx.record({
    type: 'llm.before', callId: r.callId, runId: r.runId, seq: r.seq, ts,
    url: r.url, request: ir, frames,
  } as never);

  const d = await hold(ctx, 'llm.before', {
    callId: r.callId, runId: r.runId, url: r.url, payload: ir, frames,
  });

  if (d.action === 'abort') {
    const message = d.message || 'aborted by agentmake';
    finish(ctx, {
      callId: r.callId, runId: r.runId, status: 0, ok: false, durationMs: 0,
      response: null, error: message, aborted: true, requestHash: requestHash(ir),
    });
    return { action: 'abort', isLLM: true, message };
  }

  if (d.action === 'patch') {
    const out = denormalize(cls.kind, ir, d.patch, sendUrl);
    sendBody = out.body;
    if (out.url) sendUrl = out.url;
    ir = normalizeRequest(classify(sendUrl, method, r.headers), out.body);
    // 库里必须是**实际发出去**的那一份，否则页面显示的还是改之前的
    ctx.record({
      type: 'llm.patched', callId: r.callId, runId: r.runId, seq: r.seq, ts: Date.now(),
      url: sendUrl, request: ir,
    } as never);
  }

  // 指纹按**实际要发出去的**请求算：改过 prompt 就该穿透缓存去真调
  const hash = requestHash(ir);
  remember(r.callId, {
    kind: cls.kind, isLLM: true, url: sendUrl, method, hash, ir,
    frames, runId: r.runId, seq: r.seq, startedAt: Date.now(),
  });

  if (d.action === 'fake') {
    const body = fakeResponseBody(cls.kind, d.text ?? '', ir.model);
    finish(ctx, {
      callId: r.callId, runId: r.runId, status: 200, ok: true, durationMs: 0,
      response: normalizeResponse(cls.kind, body), error: null, faked: true, requestHash: hash,
    });
    return {
      action: 'fake', isLLM: true,
      response: { status: 200, body: JSON.stringify(body) },
    };
  }

  if (r.replayBaseline) {
    const hit = ctx.replay(r.replayBaseline, hash, r.runId);
    if (hit) {
      const sse = /event-stream/i.test(hit.ctype ?? '');
      finish(ctx, {
        callId: r.callId, runId: r.runId, status: hit.status, ok: true, durationMs: 0,
        response: sse ? normalizeStream(cls.kind, hit.body) : normalizeResponse(cls.kind, safeJson(hit.body)), error: null,
        replayed: true, streaming: sse, requestHash: hash,
      });
      // ctype 让客户端按原样回放成流（流式调用的缓存是 SSE 文本）
      return { action: 'fake', isLLM: true, replayed: true, response: { status: hit.status, body: hit.body, ctype: hit.ctype ?? 'application/json' } };
    }
  }

  return {
    action: sendBody === raw && sendUrl === r.url ? 'continue' : 'patch',
    isLLM: true,
    url: sendUrl,
    body: JSON.stringify(sendBody),
    hash,
  };
}

export type AfterReq = {
  runId: string;
  callId: string;
  seq: number;
  status: number;
  ok: boolean;
  durationMs: number;
  body?: string | null;
  error?: string | null;
  /**
   * 只旁听：响应已经交给用户代码了（流式、aiohttp 的读取流被代理着），这里只记录、不停在断点上 ——
   * 停了也没用，用户代码早就拿到响应往下走了，页面上却显示「停在这里」，只会误导
   */
  passive?: boolean;
};

export async function hookAfter(ctx: HookCtx, r: AfterReq): Promise<Record<string, unknown>> {
  const c = contexts.get(r.callId);
  contexts.delete(r.callId);

  if (!c || !c.isLLM) {
    // 工具/普通 HTTP 调用
    if (c && ctx.gate.httpArmed && !r.error && !r.passive) {
      const d = await hold(ctx, 'http.after', {
        callId: r.callId, runId: r.runId, url: c.url,
        payload: { status: r.status, body: r.body }, frames: c.frames,
      });
      emitHttp(ctx, r, c);
      if (d.action === 'replace') {
        return { action: 'replace', response: { status: d.status ?? r.status, body: d.body ?? '' } };
      }
      if (d.action === 'abort') return { action: 'abort', message: d.message ?? 'aborted by agentmake' };
      return { action: 'continue' };
    }
    if (c) emitHttp(ctx, r, c);
    return { action: 'continue' };
  }

  const rawResp = r.body ? safeJson(r.body) : null;
  const streaming = rawResp == null && !!r.body && /^\s*(data:|event:)/m.test(r.body);

  // 流式：把增量拼回完整的回答再上报（「响应后断点」对流不生效 —— 它已经交给用户代码了）
  if (streaming && r.ok && !r.error) {
    finish(ctx, {
      callId: r.callId, runId: r.runId, status: r.status, ok: true, durationMs: r.durationMs,
      response: normalizeStream(c.kind, r.body!), error: null, streaming: true, requestHash: c.hash,
    });
    return { action: 'continue' };
  }

  if (r.passive && !r.error && r.ok && rawResp != null) {
    finish(ctx, {
      callId: r.callId, runId: r.runId, status: r.status, ok: true, durationMs: r.durationMs,
      response: normalizeResponse(c.kind, rawResp), error: null, streaming: false, requestHash: c.hash,
    });
    return { action: 'continue' };
  }

  if (r.error || !r.ok || rawResp == null) {
    finish(ctx, {
      callId: r.callId, runId: r.runId, status: r.status, ok: false, durationMs: r.durationMs,
      response: null, error: r.error ?? `HTTP ${r.status}: ${(r.body ?? '').slice(0, 400)}`,
      streaming, requestHash: c.hash,
    });
    return { action: 'continue' };
  }

  let respIR = normalizeResponse(c.kind, rawResp);
  const d = await hold(ctx, 'llm.after', {
    callId: r.callId, runId: r.runId, url: c.url, payload: respIR, frames: c.frames,
  });

  if (d.action === 'replace' && typeof d.text === 'string') {
    const patched = denormalizeResponse(c.kind, rawResp, d.text);
    respIR = normalizeResponse(c.kind, patched);
    finish(ctx, {
      callId: r.callId, runId: r.runId, status: r.status, ok: true, durationMs: r.durationMs,
      response: respIR, error: null, replaced: true, streaming, requestHash: c.hash,
    });
    return { action: 'replace', response: { status: r.status, body: JSON.stringify(patched) } };
  }

  if (d.action === 'abort') {
    const message = d.message || 'aborted by agentmake';
    finish(ctx, {
      callId: r.callId, runId: r.runId, status: r.status, ok: false, durationMs: r.durationMs,
      response: respIR, error: message, aborted: true, streaming, requestHash: c.hash,
    });
    return { action: 'abort', message };
  }

  finish(ctx, {
    callId: r.callId, runId: r.runId, status: r.status, ok: true, durationMs: r.durationMs,
    response: respIR, error: null, streaming, requestHash: c.hash,
  });
  return { action: 'continue' };
}

// ── 内部 ───────────────────────────────────────────────────

async function hold(
  ctx: HookCtx,
  phase: GatePhase,
  call: { callId: string; runId: string; url: string; payload: unknown; frames: Frame[] },
): Promise<GateDecision & Record<string, never>> {
  const { held, decision, bpChanged } = ctx.gate.request({ ...call, phase, since: Date.now() });
  if (bpChanged) ctx.broadcastRaw({ type: 'breakpoints', ...ctx.gate.breakpoints });
  if (held) {
    ctx.broadcastRaw({ type: 'paused', callId: call.callId, phase, runId: call.runId, ts: Date.now() });
  }
  const d = await decision;
  if (held) {
    ctx.broadcastRaw({ type: 'resumed', callId: call.callId, phase, action: d.action, ts: Date.now() });
    ctx.broadcastRaw({ type: 'httpArmed', value: ctx.gate.httpArmed });
  }
  return d as never;
}

let tail = 0;
function finish(ctx: HookCtx, e: Record<string, unknown>): void {
  ctx.record({ type: 'llm.after', ts: Date.now(), seq: 1_000_000 + tail++, streaming: false, ...e } as never);
}

function emitHttp(ctx: HookCtx, r: AfterReq, c: CallCtx): void {
  ctx.record({
    type: 'http.call', callId: r.callId, runId: r.runId, seq: r.seq, ts: Date.now(),
    method: c.method, url: c.url, status: r.status, ok: r.ok,
    durationMs: r.durationMs, startedAt: c.startedAt, error: r.error ?? null, frames: c.frames,
    // Python 侧响应体是同步拿到的，直接带上（数据流图要拿它和下游 prompt 对照）
    ...(typeof r.body === 'string'
      ? { responseBody: r.body.slice(0, 256 * 1024), responseBytes: Buffer.byteLength(r.body) }
      : {}),
  } as never);
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
