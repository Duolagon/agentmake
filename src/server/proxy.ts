// LLM 代理层 —— 「任何语言写的 agent」都能接进来的那一层。
//
// Node harness（--import）能拿到调用栈、能插桩循环，但它只吃 Node。
// Python / Go / Rust / Java / 甚至一段 curl 脚本，都没法用它。
//
// 而所有 agent 都有一个共同点：**最终都要发一个 HTTP 请求给模型**。
// 只要把这一跳接过来，就能看到全部 prompt、能断点、能改、能伪造、能重放 ——
// 代价是没有调用栈（画不出函数层级），换来的是零接入、任何语言。
//
//   OPENAI_BASE_URL=http://127.0.0.1:8787/p/openai/v1        python my_agent.py
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8787/p/anthropic     go run ./agent
//   任意上游：/p/x/<base64url(https://host/base)>/...
//
// 断点是天然的：这是一个真实的 HTTP 跳转，我们不回复，对方就在那儿等着 ——
// 和 harness 里「服务端悬住响应」是同一个机制，不需要对方配合任何东西。

import type http from 'node:http';
import { classify } from '../shared/classify.ts';
import { normalizeRequest, normalizeResponse, normalizeStream } from '../shared/normalize.ts';
import { denormalize, denormalizeResponse, fakeResponseBody } from '../shared/denormalize.ts';
import { requestHash } from '../shared/hash.ts';
import type { Gate, GateDecision, GatePhase } from './gate.ts';
import type { AgentEvent } from '../shared/types.ts';

// 常见上游的短名。不是白名单 —— 只是省得每次都写全 URL；
// 任何其他上游都能用 /p/x/<base64url> 或 x-agentmake-upstream 头。
const UPSTREAMS: Record<string, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com',
  moonshot: 'https://api.moonshot.cn',
  zhipu: 'https://open.bigmodel.cn',
  dashscope: 'https://dashscope.aliyuncs.com',
  openrouter: 'https://openrouter.ai',
  groq: 'https://api.groq.com',
  xai: 'https://api.x.ai',
};

// 这些头是这一跳自己的，不能原样转给上游
const HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  'accept-encoding', // 让 undici 自己协商，避免拿到我们解不开的编码
]);

// 我们自己的控制头，不该泄漏给上游
const OWN_HEADERS = new Set(['x-agentmake-upstream', 'x-agentmake-run', 'x-agentmake-replay']);

export type ProxyCtx = {
  gate: Gate;
  /** 落库 + 广播 */
  record: (ev: AgentEvent) => void;
  broadcastRaw: (ev: Record<string, unknown>) => void;
  /** 重放缓存查询：命中返回原始响应体 */
  replay: (baseline: string, hash: string, runId?: string) => { body: string; status: number; ctype?: string } | null;
};

// ── 运行（run）身份 ─────────────────────────────────────────
//
// harness 里 runId 就是进程；代理这边没有进程可依附。规则：
//   1. 客户端给了 x-agentmake-run 就用它（最准，推荐脚本里设一下）
//   2. 否则按「空闲窗口」切分：连续调用算同一次运行，静默超过 IDLE_MS 就开新的一次
// 这条启发式的取舍：宁可把两次紧挨着的运行并成一次（还能靠 runId 之外的信息分辨），
// 也不要把一次长运行切成一堆碎片 —— 碎片会让流程图和对比功能彻底失效。

const IDLE_MS = Number(process.env.AGENTMAKE_PROXY_IDLE_MS ?? 90_000);

let autoRun: { id: string; last: number } | null = null;
let counter = 0;

function runIdFor(explicit: string | null, now: number): string {
  if (explicit) return explicit;
  if (!autoRun || now - autoRun.last > IDLE_MS) {
    autoRun = { id: `run_proxy_${now.toString(36)}_${(counter++).toString(36)}`, last: now };
    return autoRun.id;
  }
  autoRun.last = now;
  return autoRun.id;
}

const seqs = new Map<string, number>();
function nextSeq(runId: string): number {
  const n = (seqs.get(runId) ?? 0) + 1;
  seqs.set(runId, n);
  return n;
}

// ── 路由解析 ───────────────────────────────────────────────

export function resolveUpstream(
  pathAfterPrefix: string,
  headerUpstream: string | null,
): { base: string; rest: string } | null {
  // /p/x/<base64url>/rest —— 任意上游
  const m = /^x\/([^/]+)(\/.*)?$/.exec(pathAfterPrefix);
  if (m) {
    try {
      const base = Buffer.from(m[1], 'base64url').toString('utf8');
      new URL(base);
      return { base: base.replace(/\/$/, ''), rest: m[2] ?? '' };
    } catch {
      return null;
    }
  }

  const slash = pathAfterPrefix.indexOf('/');
  const name = (slash === -1 ? pathAfterPrefix : pathAfterPrefix.slice(0, slash)).toLowerCase();
  const rest = slash === -1 ? '' : pathAfterPrefix.slice(slash);

  const envBase = process.env[`AGENTMAKE_UPSTREAM_${name.toUpperCase()}`];
  const base = headerUpstream || envBase || UPSTREAMS[name];
  if (!base) return null;
  return { base: base.replace(/\/$/, ''), rest };
}

// ── 主处理 ─────────────────────────────────────────────────

export async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: ProxyCtx,
): Promise<void> {
  const after = url.pathname.slice('/p/'.length);
  const headerUpstream = str(req.headers['x-agentmake-upstream']);
  const target = resolveUpstream(after, headerUpstream);

  if (!target) {
    return fail(res, 400,
      `认不出上游。用 /p/<${Object.keys(UPSTREAMS).join('|')}>/…，` +
      '或 /p/x/<base64url(https://host)>/…，或带上 x-agentmake-upstream 头。');
  }

  const upstreamUrl = target.base + target.rest + url.search;
  const method = (req.method ?? 'GET').toUpperCase();
  const bodyBuf = await readBody(req);
  const now = Date.now();
  const runId = runIdFor(str(req.headers['x-agentmake-run']), now);
  const seq = nextSeq(runId);
  const callId = `call_${runId.slice(4)}_${seq}`;

  const headers = forwardHeaders(req.headers, target.base);
  const cls = classify(upstreamUrl, method, req.headers as Record<string, unknown>);

  if (cls.kind === 'unknown') {
    return passThroughTool(res, { upstreamUrl, method, headers, bodyBuf, runId, seq, callId, ctx, now });
  }

  // ── LLM 调用：normalize → 断点 → 转发 → 断点 → 回给客户端 ──
  let raw: unknown;
  try {
    raw = JSON.parse(bodyBuf.toString('utf8') || '{}');
  } catch {
    // 解析不了就当普通请求透传，绝不因为我们看不懂而挡住 agent
    return passThroughTool(res, { upstreamUrl, method, headers, bodyBuf, runId, seq, callId, ctx, now });
  }

  let ir = normalizeRequest(cls, raw);
  let sendUrl = upstreamUrl;
  let sendBody: unknown = raw;

  ctx.record({
    type: 'llm.before', callId, runId, seq, ts: now,
    url: upstreamUrl, request: ir,
    // 代理这一层没有调用栈 —— 这是它相对 harness 的代价，如实留空
    frames: [],
  } as never);

  const before = await hold(ctx, 'llm.before', { callId, runId, url: upstreamUrl, payload: ir, ts: now });

  if (before.action === 'patch') {
    const d = denormalize(cls.kind, ir, before.patch, sendUrl);
    sendBody = d.body;
    if (d.url) sendUrl = d.url;
    ir = normalizeRequest(classify(sendUrl, method, req.headers as Record<string, unknown>), d.body);
    // 把改写后的请求写回库里 —— 页面上要看到的是**实际发出去**的那一份
    ctx.record({
      type: 'llm.patched', callId, runId, seq: nextSeq(runId), ts: Date.now(),
      url: sendUrl, request: ir,
    } as never);
  }

  if (before.action === 'abort') {
    const msg = before.message || 'aborted by agentmake';
    finish(ctx, { callId, runId, ts: Date.now(), status: 0, ok: false, durationMs: 0,
      response: null, error: msg, aborted: true, requestHash: requestHash(ir) });
    return fail(res, 599, msg);
  }

  if (before.action === 'fake') {
    const body = fakeResponseBody(cls.kind, before.text ?? '', ir.model ?? '');
    const respIR = normalizeResponse(cls.kind, body);
    finish(ctx, { callId, runId, ts: Date.now(), status: 200, ok: true, durationMs: 0,
      response: respIR, error: null, faked: true, requestHash: requestHash(ir) });
    return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(body));
  }

  // 重放：命中就完全不打上游
  const hash = requestHash(ir);
  const baseline = str(req.headers['x-agentmake-replay']);
  if (baseline) {
    const hit = ctx.replay(baseline, hash, runId);
    if (hit) {
      const sse = /event-stream/i.test(hit.ctype ?? '');
      const respIR = sse ? normalizeStream(cls.kind, hit.body) : normalizeResponse(cls.kind, safeJson(hit.body));
      finish(ctx, { callId, runId, ts: Date.now(), status: hit.status, ok: true, durationMs: 0,
        response: respIR, error: null, replayed: true, streaming: sse, requestHash: hash });
      return send(res, hit.status, { 'content-type': hit.ctype ?? 'application/json' }, hit.body);
    }
  }

  const started = Date.now();
  let upstreamRes: Response;
  let text: string;
  try {
    upstreamRes = await fetch(sendUrl, {
      method,
      headers,
      body: JSON.stringify(sendBody),
      signal: AbortSignal.timeout(Number(process.env.AGENTMAKE_PROXY_TIMEOUT_MS ?? 600_000)),
    });
    text = await upstreamRes.text();
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    finish(ctx, { callId, runId, ts: Date.now(), status: 0, ok: false,
      durationMs: Date.now() - started, response: null, error: message, requestHash: hash });
    return fail(res, 502, `上游请求失败：${message}`);
  }

  const durationMs = Date.now() - started;
  const rawResp = safeJson(text);
  // 流式：把增量拼回完整的回答（代理这边是读完整段再转发的 —— 内容完整，只是客户端看不到逐字出现）
  const streaming = rawResp == null && /^\s*(data:|event:)/m.test(text);
  let respIR = !upstreamRes.ok ? null
    : streaming ? normalizeStream(cls.kind, text)
    : rawResp != null ? normalizeResponse(cls.kind, rawResp) : null;
  let outText = text;

  // 「响应后断点」只对非流式：流式的改写要重新拼 SSE，目前不支持
  if (respIR && !streaming) {
    const afterD = await hold(ctx, 'llm.after', {
      callId, runId, url: sendUrl, payload: respIR, ts: Date.now(),
    });
    if (afterD.action === 'replace' && typeof afterD.text === 'string') {
      const patched = denormalizeResponse(cls.kind, rawResp, afterD.text);
      outText = JSON.stringify(patched);
      respIR = normalizeResponse(cls.kind, patched);
      finish(ctx, { callId, runId, ts: Date.now(), status: upstreamRes.status, ok: true,
        durationMs, response: respIR, error: null, replaced: true, requestHash: hash });
      return relay(res, upstreamRes, outText);
    }
    if (afterD.action === 'abort') {
      const msg = afterD.message || 'aborted by agentmake';
      finish(ctx, { callId, runId, ts: Date.now(), status: upstreamRes.status, ok: false,
        durationMs, response: respIR, error: msg, aborted: true, requestHash: hash });
      return fail(res, 599, msg);
    }
  }

  finish(ctx, {
    callId, runId, ts: Date.now(),
    status: upstreamRes.status,
    ok: upstreamRes.ok,
    durationMs,
    response: respIR,
    error: upstreamRes.ok ? null : `HTTP ${upstreamRes.status}: ${text.slice(0, 400)}`,
    streaming,
    requestHash: hash,
  });
  return relay(res, upstreamRes, outText);
}

// ── 非 LLM 请求：照样转发，照样能断点（当工具调用看） ──────

async function passThroughTool(
  res: http.ServerResponse,
  a: {
    upstreamUrl: string; method: string; headers: Record<string, string>; bodyBuf: Buffer;
    runId: string; seq: number; callId: string; ctx: ProxyCtx; now: number;
  },
): Promise<void> {
  const started = Date.now();
  try {
    const r = await fetch(a.upstreamUrl, {
      method: a.method,
      headers: a.headers,
      body: a.method === 'GET' || a.method === 'HEAD' ? undefined : a.bodyBuf,
      signal: AbortSignal.timeout(Number(process.env.AGENTMAKE_PROXY_TIMEOUT_MS ?? 600_000)),
    });
    const text = await r.text();
    a.ctx.record({
      type: 'http.call', callId: a.callId, runId: a.runId, seq: a.seq, ts: Date.now(),
      method: a.method, url: a.upstreamUrl, status: r.status, ok: r.ok,
      durationMs: Date.now() - started, startedAt: started, error: null, frames: [],
    } as never);
    return relay(res, r, text);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    a.ctx.record({
      type: 'http.call', callId: a.callId, runId: a.runId, seq: a.seq, ts: Date.now(),
      method: a.method, url: a.upstreamUrl, status: 0, ok: false,
      durationMs: Date.now() - started, startedAt: started, error: message, frames: [],
    } as never);
    return fail(res, 502, `上游请求失败：${message}`);
  }
}

// ── 闸门 ───────────────────────────────────────────────────

async function hold(
  ctx: ProxyCtx,
  phase: GatePhase,
  call: { callId: string; runId: string; url: string; payload: unknown; ts: number },
): Promise<GateDecision & Record<string, never>> {
  const { held, decision, bpChanged } = ctx.gate.request({
    ...call, phase, frames: [], since: Date.now(),
  });
  if (bpChanged) ctx.broadcastRaw({ type: 'breakpoints', ...ctx.gate.breakpoints });
  if (held) {
    ctx.broadcastRaw({ type: 'paused', callId: call.callId, phase, runId: call.runId, ts: Date.now() });
  }
  const d = await decision;
  if (held) {
    ctx.broadcastRaw({ type: 'resumed', callId: call.callId, phase, action: d.action, ts: Date.now() });
  }
  return d as never;
}

function finish(ctx: ProxyCtx, e: Record<string, unknown>): void {
  ctx.record({ type: 'llm.after', seq: nextSeq(String(e.runId)), streaming: false, ...e } as never);
}

// ── HTTP 小工具 ────────────────────────────────────────────

function forwardHeaders(h: http.IncomingHttpHeaders, base: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (HOP_HEADERS.has(lk) || OWN_HEADERS.has(lk) || v == null) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  // Host 必须换成上游的，否则一部分网关会 400
  try {
    out.host = new URL(base).host;
  } catch {
    /* base 已经校验过，走不到这里 */
  }
  return out;
}

/** 把上游响应原样转回客户端（body 可能已被断点改写） */
function relay(res: http.ServerResponse, upstream: Response, body: string): void {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    // content-length 必须重算：body 可能被改过；编码相关的头也不能照抄
    if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding') return;
    headers[k] = v;
  });
  send(res, upstream.status, headers, body);
}

function send(res: http.ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function fail(res: http.ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: { message, type: 'agentmake_proxy_error' } });
  send(res, status, { 'content-type': 'application/json; charset=utf-8' }, body);
}

async function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : Array.isArray(v) ? str(v[0]) : null;

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** 给页面/CLI 用的接入说明 */
export function proxyHelp(port: number): string {
  const b = `http://127.0.0.1:${port}/p`;
  return [
    '任何语言的 agent 都可以只改环境变量接进来（代码一行不用动）：',
    `  OPENAI_BASE_URL=${b}/openai/v1`,
    `  ANTHROPIC_BASE_URL=${b}/anthropic`,
    `  GEMINI/GOOGLE base url=${b}/gemini`,
    `  其它上游：${b}/x/$(printf %s 'https://your.host' | base64 | tr '+/' '-_' | tr -d '=')/v1`,
    '可选：设 x-agentmake-run 头把一次运行标出来（否则按 90s 空闲窗口自动切分）。',
  ].join('\n');
}
