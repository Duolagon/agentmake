// IR 补丁 → 原生请求体。normalize.ts 的反向。
//
// 这一步比正向难，因为它会真的改掉发给模型的东西。两条铁律：
//
// 1. **保守合并**：只回写用户实际编辑过的字段，其余从 raw 原样透传。
//    用户的项目可能带了我们不认识的参数（safety_settings、cached_content、
//    自定义 generation_config…），全量重建会把它们丢掉，导致「一进调试器行为就变」
//    —— 调试器最不能犯的错。
//
// 2. **不破坏非文本内容**：消息里可能有图片、工具调用块。改文本时按下标定位到
//    原始消息对象，只替换其中的文本部分，其余结构原样保留。

import type { LLMRequestIR, MessageIR, ProviderKind } from './types.ts';
import { responsesInputItems } from './normalize.ts';

/** UI 传下来的补丁：只有出现的键才会被回写 */
export type RequestPatch = {
  system?: string | null;
  messages?: MessageIR[];
  model?: string;
  params?: Record<string, unknown>;
};

export type DenormResult = {
  body: unknown;
  /** Gemini 把模型名放在 URL 路径里，改模型要连 URL 一起换 */
  url: string | null;
};

const clone = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v)) as T));
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function denormalize(
  kind: ProviderKind,
  ir: LLMRequestIR,
  patch: RequestPatch,
  url: string,
): DenormResult {
  const body = clone(ir.raw) as Record<string, unknown>;
  if (!body || typeof body !== 'object') return { body: ir.raw, url: null };

  const before = ir.messages;
  switch (kind) {
    case 'gemini':
      return { body: patchGemini(body, patch, before), url: patchGeminiUrl(url, patch.model) };
    case 'anthropic':
      return { body: patchAnthropic(body, patch, before), url: null };
    case 'openai':
      return { body: patchOpenAI(body, patch, before), url: null };
    case 'openai_responses':
      return { body: patchResponses(body, patch, before), url: null };
    default:
      return { body, url: null };
  }
}

// ── OpenAI Responses API ───────────────────────────────────

function patchResponses(b: Record<string, unknown>, p: RequestPatch, before: MessageIR[]): Record<string, unknown> {
  // 系统提示写回 instructions（没有 instructions、却有 system 消息时改那条消息）
  if ('system' in p) {
    const sysIdx = arr(b.input).findIndex((x) => {
      const o = obj(x);
      return (!o.type || o.type === 'message') && (o.role === 'system' || o.role === 'developer');
    });
    if (p.system == null || p.system === '') delete b.instructions;
    else if (typeof b.instructions === 'string' || sysIdx < 0) b.instructions = p.system;
    else {
      const items = clone(arr(b.input)) as Record<string, unknown>[];
      items[sysIdx] = { ...items[sysIdx], content: p.system };
      b.input = items;
    }
  }

  if (p.messages) {
    if (typeof b.input === 'string') {
      const m = p.messages[0];
      if (m && !untouched(m, before[0])) b.input = m.content;
    } else {
      const items = clone(arr(b.input)) as Record<string, unknown>[];
      // 和 normalize 用同一套「哪些条目对应 IR 消息」，按下标对回去
      responsesInputItems(b).forEach(({ index }, i) => {
        const m = p.messages![i];
        if (!m || untouched(m, before[i])) return;
        const it = items[index];
        if (it.type === 'function_call_output') { it.output = m.content; return; }
        if (it.type === 'function_call') return; // 改不了模型之前发起的调用
        if (typeof it.content === 'string' || it.content == null) { it.content = m.content; return; }
        const parts = clone(arr(it.content)) as Record<string, unknown>[];
        const k = parts.findIndex((x) => typeof x.text === 'string');
        if (k >= 0) parts[k].text = m.content;
        else parts.unshift({ type: it.role === 'assistant' ? 'output_text' : 'input_text', text: m.content });
        it.content = parts;
      });
      b.input = items;
    }
  }

  if (p.model) b.model = p.model;
  if (p.params) {
    setIf(b, 'temperature', p.params.temperature);
    setIf(b, 'max_output_tokens', p.params.maxTokens);
    setIf(b, 'top_p', p.params.topP);
  }
  return b;
}

/**
 * 这条消息用户没动过 —— 原生对象原样保留。
 *
 * UI 改一条消息时会把整个数组传下来。只含工具块的消息，文本视图是「«toolResult»」这类占位，
 * 照常回写的话占位符会被当成正文塞进请求（Anthropic 还会因为 tool_result 前多了 text 块直接 400）。
 */
function untouched(m: MessageIR, prev: MessageIR | undefined): boolean {
  // MCP 传下来的消息常常不带 rawRole，缺省时不拿它比
  return !!prev && m.content === prev.content && m.role === prev.role &&
    (m.rawRole === undefined || m.rawRole === prev.rawRole);
}

// ── Gemini ─────────────────────────────────────────────────

function patchGemini(b: Record<string, unknown>, p: RequestPatch, before: MessageIR[]): Record<string, unknown> {
  if ('system' in p) {
    if (p.system == null || p.system === '') delete b.systemInstruction;
    else b.systemInstruction = { parts: [{ text: p.system }] };
  }

  if (p.messages) {
    const orig = arr(b.contents);
    b.contents = p.messages.map((m, i) => {
      if (orig[i] && untouched(m, before[i])) return orig[i];
      const src = obj(orig[i]);
      // IR 的 assistant 对应 Gemini 的 model；优先用原生角色，避免来回转换出偏差
      const role = m.rawRole ?? (m.role === 'assistant' ? 'model' : m.role);
      const parts = arr(src.parts);
      if (!parts.length) return { role, parts: [{ text: m.content }] };
      // 只改第一个文本 part，图片 / functionCall 等原样保留
      const idx = parts.findIndex((x) => typeof obj(x).text === 'string');
      const next = clone(parts);
      if (idx >= 0) (next[idx] as Record<string, unknown>).text = m.content;
      else next.unshift({ text: m.content });
      return { ...src, role, parts: next };
    });
  }

  if (p.params) {
    const gc = obj(b.generationConfig);
    setIf(gc, 'temperature', p.params.temperature);
    setIf(gc, 'maxOutputTokens', p.params.maxTokens);
    setIf(gc, 'topP', p.params.topP);
    setIf(gc, 'topK', p.params.topK);
    if (Object.keys(gc).length) b.generationConfig = gc;
  }
  return b;
}

/** /v1beta/models/{model}:generateContent —— 模型名在路径里 */
function patchGeminiUrl(url: string, model?: string): string | null {
  if (!model) return null;
  const next = url.replace(/\/models\/[^:/]+:/, `/models/${encodeURIComponent(model)}:`);
  return next === url ? null : next;
}

// ── Anthropic ──────────────────────────────────────────────

function patchAnthropic(b: Record<string, unknown>, p: RequestPatch, before: MessageIR[]): Record<string, unknown> {
  if ('system' in p) {
    if (p.system == null || p.system === '') delete b.system;
    else if (Array.isArray(b.system)) {
      // system 是 text block 数组时（带 cache_control），只改第一块的文本，
      // 保住 cache_control 等我们不认识的字段
      const blocks = clone(b.system) as Record<string, unknown>[];
      const i = blocks.findIndex((x) => typeof x.text === 'string');
      if (i >= 0) blocks[i].text = p.system;
      else blocks.unshift({ type: 'text', text: p.system });
      b.system = blocks;
    } else b.system = p.system;
  }

  if (p.messages) {
    const orig = arr(b.messages);
    b.messages = p.messages.map((m, i) => {
      if (orig[i] && untouched(m, before[i])) return orig[i];
      const src = obj(orig[i]);
      const content = src.content;
      if (typeof content === 'string' || content == null) {
        return { ...src, role: m.role, content: m.content };
      }
      const blocks = clone(arr(content)) as Record<string, unknown>[];
      const idx = blocks.findIndex((x) => x.type === 'text' || typeof x.text === 'string');
      if (idx >= 0) blocks[idx].text = m.content;
      else blocks.unshift({ type: 'text', text: m.content });
      return { ...src, role: m.role, content: blocks };
    });
  }

  if (p.model) b.model = p.model;
  if (p.params) {
    setIf(b, 'max_tokens', p.params.maxTokens);
    setIf(b, 'temperature', p.params.temperature);
    setIf(b, 'top_p', p.params.topP);
  }
  return b;
}

// ── OpenAI 兼容 ────────────────────────────────────────────

function patchOpenAI(b: Record<string, unknown>, p: RequestPatch, before: MessageIR[]): Record<string, unknown> {
  const orig = clone(arr(b.messages)) as Record<string, unknown>[];

  if (p.messages) {
    // IR 把 system 抽出去了，这里要还原成 messages 里的一条
    const systemMsgs = orig.filter((m) => m.role === 'system' || m.role === 'developer');
    const rebuilt = p.messages.map((m, i) => {
      // 原数组里非 system 的第 i 条
      const src = orig.filter((x) => x.role !== 'system' && x.role !== 'developer')[i] ?? {};
      if (Object.keys(src).length && untouched(m, before[i])) return src;
      const content = src.content;
      if (typeof content === 'string' || content == null) {
        return { ...src, role: m.role, content: m.content };
      }
      const blocks = clone(arr(content)) as Record<string, unknown>[];
      const idx = blocks.findIndex((x) => x.type === 'text' || typeof x.text === 'string');
      if (idx >= 0) blocks[idx].text = m.content;
      else blocks.unshift({ type: 'text', text: m.content });
      return { ...src, role: m.role, content: blocks };
    });
    b.messages = [...systemMsgs, ...rebuilt];
  }

  if ('system' in p) {
    const list = clone(arr(b.messages)) as Record<string, unknown>[];
    const i = list.findIndex((m) => m.role === 'system' || m.role === 'developer');
    if (p.system == null || p.system === '') {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) {
      list[i] = { ...list[i], content: p.system };
    } else {
      list.unshift({ role: 'system', content: p.system });
    }
    b.messages = list;
  }

  if (p.model) b.model = p.model;
  if (p.params) {
    setIf(b, 'temperature', p.params.temperature);
    setIf(b, 'max_tokens', p.params.maxTokens);
    setIf(b, 'top_p', p.params.topP);
  }
  return b;
}

function setIf(target: Record<string, unknown>, key: string, v: unknown): void {
  if (v !== undefined && v !== null && v !== '') target[key] = v;
}

// ── 改写响应：把新文本写回原生响应体 ───────────────────────
//
// 用于「LLM 调用后断点」：模型已经答了，但你想看看下游代码拿到别的内容会怎样。
// 同样是保守合并 —— 只换文本，usage / finish_reason / 我们不认识的字段全部保留。

export function denormalizeResponse(kind: ProviderKind, raw: unknown, text: string): unknown {
  const b = clone(obj(raw));
  switch (kind) {
    case 'gemini': {
      const cands = arr(b.candidates);
      if (!cands.length) return fakeResponseBody(kind, text, '');
      const c = obj(cands[0]);
      const parts = arr(obj(c.content).parts);
      const idx = parts.findIndex((p) => typeof obj(p).text === 'string');
      const next = clone(parts) as Record<string, unknown>[];
      if (idx >= 0) next[idx].text = text;
      else next.unshift({ text });
      b.candidates = [{ ...c, content: { ...obj(c.content), parts: next } }, ...cands.slice(1)];
      return b;
    }
    case 'anthropic': {
      const blocks = clone(arr(b.content)) as Record<string, unknown>[];
      const idx = blocks.findIndex((x) => x.type === 'text' || typeof x.text === 'string');
      if (idx >= 0) blocks[idx].text = text;
      else blocks.unshift({ type: 'text', text });
      b.content = blocks;
      return b;
    }
    case 'openai': {
      const choices = arr(b.choices);
      if (!choices.length) return fakeResponseBody(kind, text, String(b.model ?? ''));
      const c0 = obj(choices[0]);
      b.choices = [{ ...c0, message: { ...obj(c0.message), content: text } }, ...choices.slice(1)];
      return b;
    }
    case 'openai_responses': {
      const out = clone(arr(b.output)) as Record<string, unknown>[];
      const mi = out.findIndex((x) => x.type === 'message');
      if (mi < 0) out.unshift({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      else {
        const parts = clone(arr(out[mi].content)) as Record<string, unknown>[];
        const k = parts.findIndex((x) => x.type === 'output_text' || typeof x.text === 'string');
        if (k >= 0) parts[k].text = text;
        else parts.unshift({ type: 'output_text', text });
        out[mi] = { ...out[mi], content: parts };
      }
      b.output = out;
      if ('output_text' in b) b.output_text = text;
      return b;
    }
    default:
      return b;
  }
}

// ── 伪造响应：IR 文本 → 各家原生响应形状 ──────────────────

export function fakeResponseBody(kind: ProviderKind, text: string, model: string): unknown {
  switch (kind) {
    case 'openai_responses':
      return {
        id: 'resp_faked',
        object: 'response',
        status: 'completed',
        model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        output_text: text,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        _agentmakeFaked: true,
      };
    case 'gemini':
      return {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 },
        _agentmakeFaked: true,
      };
    case 'anthropic':
      return {
        id: 'msg_faked',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
        _agentmakeFaked: true,
      };
    default:
      return {
        id: 'chatcmpl-faked',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        _agentmakeFaked: true,
      };
  }
}
