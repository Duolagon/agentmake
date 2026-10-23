// 三家协议 → 归一化 IR。
//
// 这是整个系统最琐碎、最容易写错的一块，也正是 harness 与 server 必须共用同一份实现的原因。
// 反向（IR → 原生，用于运行中改 prompt）见 denormalize.ts —— 那一步做保守合并，
// 只回写用户实际编辑过的路径，其余字段从 raw 原样透传。

import type {
  Classification,
} from './classify.ts';
import type {
  LLMRequestIR,
  LLMResponseIR,
  MessageIR,
  ProviderKind,
  ToolCallIR,
  ToolDefIR,
  ToolResultIR,
  UsageIR,
} from './types.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Gemini 的 parts[] 拼成纯文本；忽略 inlineData 等非文本 part，但标注出来 */
function partsToText(parts: unknown): string {
  return arr(parts)
    .map((p) => {
      const o = obj(p);
      if (typeof o.text === 'string') return o.text;
      if (o.functionCall) return `«functionCall ${str(obj(o.functionCall).name)}»`;
      if (o.functionResponse) return `«functionResponse»`;
      if (o.inlineData) return `«inlineData ${str(obj(o.inlineData).mimeType)}»`;
      return '';
    })
    .join('');
}

/** Anthropic / OpenAI 的 content 可能是 string，也可能是 block 数组 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map((b) => {
      const o = obj(b);
      if (typeof o.text === 'string') return o.text;
      if (o.type === 'tool_use') return `«toolUse ${str(o.name)}»`;
      if (o.type === 'tool_result') return `«toolResult»`;
      if (o.type === 'image' || o.type === 'image_url' || o.type === 'input_image') return '«image»';
      if (o.type === 'input_file') return '«file»';
      return '';
    })
    .join('');
}

// ── 工具调用 / 工具结果 ────────────────────────────────────
//
// 文本视图里工具块只剩占位符，这里把结构化内容抽出来：调了哪个工具、参数、结果。

/** OpenAI 的 arguments 是 JSON 字符串；Anthropic / Gemini 直接给对象 */
function toolCall(id: unknown, name: unknown, rawArgs: unknown): ToolCallIR {
  const tc: ToolCallIR = { id: typeof id === 'string' && id ? id : null, name: str(name), args: rawArgs ?? {} };
  if (typeof rawArgs === 'string') {
    if (rawArgs.trim() === '') tc.args = {};
    else {
      try {
        tc.args = JSON.parse(rawArgs);
      } catch {
        tc.argsInvalid = true;
      }
    }
  }
  return tc;
}

/** 工具结果可能是字符串、block 数组或任意 JSON —— 统一成文本 */
function resultText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return contentToText(v);
  return v == null ? '' : JSON.stringify(v);
}

function geminiToolCalls(parts: unknown): ToolCallIR[] {
  return arr(parts)
    .map((p) => obj(obj(p).functionCall))
    .filter((fc) => fc.name)
    .map((fc) => toolCall(fc.id, fc.name, fc.args));
}

function geminiToolResults(parts: unknown): ToolResultIR[] {
  return arr(parts)
    .map((p) => obj(obj(p).functionResponse))
    .filter((fr) => fr.name || fr.response)
    .map((fr) => ({
      callId: typeof fr.id === 'string' && fr.id ? fr.id : null,
      name: str(fr.name) || null,
      content: resultText(fr.response),
    }));
}

/** Anthropic content block 数组里的 tool_use */
function blockToolCalls(content: unknown): ToolCallIR[] {
  return arr(content)
    .map(obj)
    .filter((b) => b.type === 'tool_use')
    .map((b) => toolCall(b.id, b.name, b.input));
}

function blockToolResults(content: unknown): ToolResultIR[] {
  return arr(content)
    .map(obj)
    .filter((b) => b.type === 'tool_result')
    .map((b) => {
      const r: ToolResultIR = { callId: str(b.tool_use_id) || null, name: null, content: resultText(b.content) };
      if (b.is_error === true) r.isError = true;
      return r;
    });
}

/** OpenAI 的 tool_calls，外加已废弃但仍有人用的单个 function_call */
function openaiToolCalls(msg: Record<string, unknown>): ToolCallIR[] {
  const calls = arr(msg.tool_calls).map((t) => {
    const fn = obj(obj(t).function);
    return toolCall(obj(t).id, fn.name, fn.arguments);
  });
  const legacy = obj(msg.function_call);
  if (legacy.name) calls.push(toolCall(null, legacy.name, legacy.arguments));
  return calls;
}

/** OpenAI 的 tool 角色（新）/ function 角色（旧）消息本身就是一条工具结果 */
function openaiToolResults(msg: Record<string, unknown>): ToolResultIR[] {
  if (msg.role === 'tool') {
    return [{ callId: str(msg.tool_call_id) || null, name: null, content: contentToText(msg.content) }];
  }
  if (msg.role === 'function') {
    return [{ callId: null, name: str(msg.name) || null, content: contentToText(msg.content) }];
  }
  return [];
}

/** 只在确实有工具内容时才挂键 —— 纯文本消息的形状（和指纹）与以前完全一致 */
function withTools(m: MessageIR, calls: ToolCallIR[], results: ToolResultIR[]): MessageIR {
  if (calls.length) m.toolCalls = calls;
  if (results.length) m.toolResults = results;
  return m;
}

// ── 请求 ───────────────────────────────────────────────────

export function normalizeRequest(
  cls: Classification,
  body: unknown,
): LLMRequestIR {
  const b = obj(body);
  switch (cls.kind) {
    case 'gemini':
      return normalizeGeminiRequest(b, cls.modelFromUrl);
    case 'anthropic':
      return normalizeAnthropicRequest(b);
    case 'openai':
      return normalizeOpenAIRequest(b);
    case 'openai_responses':
      return normalizeResponsesRequest(b);
    default:
      return {
        provider: 'unknown',
        model: '',
        system: null,
        messages: [],
        tools: [],
        params: {},
        raw: body,
      };
  }
}

function normalizeGeminiRequest(b: Record<string, unknown>, modelFromUrl: string | null): LLMRequestIR {
  // 系统提示是独立字段 systemInstruction，不在 contents 里
  const sysParts = obj(obj(b.systemInstruction).parts ? b.systemInstruction : {}).parts;
  const system = b.systemInstruction ? partsToText(sysParts) : null;

  const messages: MessageIR[] = arr(b.contents).map((c) => {
    const o = obj(c);
    const rawRole = str(o.role) || 'user';
    const m: MessageIR = {
      // Gemini 用 `model` 表示助手，归一为 assistant
      role: rawRole === 'model' ? 'assistant' : rawRole,
      rawRole,
      content: partsToText(o.parts),
    };
    return withTools(m, geminiToolCalls(o.parts), geminiToolResults(o.parts));
  });

  // tools 多嵌一层 functionDeclarations
  const tools: ToolDefIR[] = arr(b.tools).flatMap((t) =>
    arr(obj(t).functionDeclarations).map((f) => {
      const o = obj(f);
      return { name: str(o.name), description: str(o.description), schema: o.parameters };
    }),
  );

  const gc = obj(b.generationConfig);
  return {
    provider: 'gemini',
    model: modelFromUrl ?? str(b.model),
    system,
    messages,
    tools,
    params: dropEmpty({
      temperature: gc.temperature,
      maxTokens: gc.maxOutputTokens,
      topP: gc.topP,
      topK: gc.topK,
      responseMimeType: gc.responseMimeType,
      thinking: gc.thinkingConfig,
    }),
    raw: b,
  };
}

function normalizeAnthropicRequest(b: Record<string, unknown>): LLMRequestIR {
  // system 可能是 string，也可能是 text block 数组（带 cache_control 时）
  const system =
    b.system == null ? null : typeof b.system === 'string' ? b.system : contentToText(b.system);

  const messages: MessageIR[] = arr(b.messages).map((m) => {
    const o = obj(m);
    return withTools(
      { role: str(o.role), rawRole: str(o.role), content: contentToText(o.content) },
      blockToolCalls(o.content),
      blockToolResults(o.content),
    );
  });

  const tools: ToolDefIR[] = arr(b.tools).map((t) => {
    const o = obj(t);
    return { name: str(o.name), description: str(o.description), schema: o.input_schema };
  });

  return {
    provider: 'anthropic',
    model: str(b.model),
    system,
    messages,
    tools,
    params: dropEmpty({
      maxTokens: b.max_tokens,
      temperature: b.temperature,
      topP: b.top_p,
      thinking: b.thinking,
      effort: obj(b.output_config).effort,
    }),
    raw: b,
  };
}

function normalizeOpenAIRequest(b: Record<string, unknown>): LLMRequestIR {
  // 系统提示混在 messages 里，抽出来单独放
  const all = arr(b.messages).map((m) => {
    const o = obj(m);
    return withTools(
      { role: str(o.role), rawRole: str(o.role), content: contentToText(o.content) },
      openaiToolCalls(o),
      openaiToolResults(o),
    );
  });
  const systemMsgs = all.filter((m) => m.role === 'system' || m.role === 'developer');
  const rest = all.filter((m) => m.role !== 'system' && m.role !== 'developer');

  const tools: ToolDefIR[] = arr(b.tools).map((t) => {
    const fn = obj(obj(t).function);
    return { name: str(fn.name), description: str(fn.description), schema: fn.parameters };
  });

  return {
    provider: 'openai',
    model: str(b.model),
    system: systemMsgs.length ? systemMsgs.map((m) => m.content).join('\n\n') : null,
    messages: rest,
    tools,
    params: dropEmpty({
      temperature: b.temperature,
      maxTokens: b.max_tokens ?? b.max_completion_tokens,
      topP: b.top_p,
      responseFormat: b.response_format,
      reasoningEffort: b.reasoning_effort,
    }),
    raw: b,
  };
}

// ── 响应 ───────────────────────────────────────────────────

export function normalizeResponse(kind: ProviderKind, body: unknown): LLMResponseIR {
  const b = obj(body);
  switch (kind) {
    case 'gemini': {
      const cand = obj(arr(b.candidates)[0]);
      const um = obj(b.usageMetadata);
      return {
        text: partsToText(obj(cand.content).parts),
        toolCalls: geminiToolCalls(obj(cand.content).parts),
        finishReason: cand.finishReason ? str(cand.finishReason) : null,
        usage: {
          inputTokens: num(um.promptTokenCount),
          outputTokens: num(um.candidatesTokenCount),
          cacheReadTokens: num(um.cachedContentTokenCount),
        },
        raw: b,
      };
    }
    case 'anthropic': {
      const u = obj(b.usage);
      return {
        text: contentToText(b.content),
        toolCalls: blockToolCalls(b.content),
        finishReason: b.stop_reason ? str(b.stop_reason) : null,
        usage: {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cacheReadTokens: num(u.cache_read_input_tokens),
        },
        raw: b,
      };
    }
    case 'openai': {
      const choice = obj(arr(b.choices)[0]);
      const u = obj(b.usage);
      return {
        text: contentToText(obj(choice.message).content),
        toolCalls: openaiToolCalls(obj(choice.message)),
        finishReason: choice.finish_reason ? str(choice.finish_reason) : null,
        usage: {
          inputTokens: num(u.prompt_tokens),
          outputTokens: num(u.completion_tokens),
          cacheReadTokens: num(obj(u.prompt_tokens_details).cached_tokens),
        },
        raw: b,
      };
    }
    case 'openai_responses': {
      // output 是一串条目：message（正文）、function_call（工具调用）、reasoning（思考摘要，不算回答）
      let text = '';
      const toolCalls: ToolCallIR[] = [];
      for (const it of arr(b.output)) {
        const o = obj(it);
        if (o.type === 'message') text += contentToText(o.content);
        else if (o.type === 'function_call') toolCalls.push(toolCall(o.call_id ?? o.id, o.name, o.arguments));
      }
      if (!text && typeof b.output_text === 'string') text = b.output_text;
      const u = obj(b.usage);
      // 截断不在 finish_reason 里，而是 status=incomplete + incomplete_details.reason=max_output_tokens
      const reason = b.status === 'incomplete' ? str(obj(b.incomplete_details).reason) || 'incomplete' : b.status ? str(b.status) : null;
      return {
        text,
        toolCalls,
        finishReason: reason,
        usage: {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cacheReadTokens: num(obj(u.input_tokens_details).cached_tokens),
        },
        raw: b,
      };
    }
    default:
      return { text: '', toolCalls: [], finishReason: null, usage: emptyUsage(), raw: b };
  }
}

// ── Responses API 的请求 ───────────────────────────────────

/**
 * Responses API：instructions 是系统提示；input 是字符串或一串条目 ——
 * message（role + 文本 / parts）、function_call（模型之前发起的工具调用）、function_call_output（工具结果）、reasoning。
 * 一个条目对应一条 IR 消息（reasoning 和 system / developer 消息除外），denormalize 靠同样的规则按下标对回去。
 */
export function responsesInputItems(b: Record<string, unknown>): { index: number; item: Record<string, unknown> }[] {
  if (typeof b.input === 'string') return [{ index: 0, item: { type: 'message', role: 'user', content: b.input } }];
  return arr(b.input)
    .map((it, index) => ({ index, item: obj(it) }))
    .filter(({ item }) => item.type !== 'reasoning' && !(isMessage(item) && (item.role === 'system' || item.role === 'developer')));
}

const isMessage = (o: Record<string, unknown>) => !o.type || o.type === 'message';

function normalizeResponsesRequest(b: Record<string, unknown>): LLMRequestIR {
  const sys: string[] = [];
  if (typeof b.instructions === 'string' && b.instructions) sys.push(b.instructions);
  for (const it of arr(b.input)) {
    const o = obj(it);
    if (isMessage(o) && (o.role === 'system' || o.role === 'developer')) sys.push(contentToText(o.content));
  }

  const messages: MessageIR[] = responsesInputItems(b).map(({ item: o }) => {
    if (o.type === 'function_call') {
      return withTools({ role: 'assistant', rawRole: 'function_call', content: '' }, [toolCall(o.call_id ?? o.id, o.name, o.arguments)], []);
    }
    if (o.type === 'function_call_output') {
      const content = resultText(o.output);
      return withTools({ role: 'tool', rawRole: 'function_call_output', content }, [], [{ callId: str(o.call_id) || null, name: null, content }]);
    }
    return { role: str(o.role) || 'user', rawRole: str(o.role) || 'user', content: contentToText(o.content) };
  });

  const tools: ToolDefIR[] = arr(b.tools)
    .map(obj)
    .filter((t) => t.type === 'function' || t.name)
    .map((t) => ({ name: str(t.name), description: str(t.description), schema: t.parameters }));

  return {
    provider: 'openai_responses',
    model: str(b.model),
    system: sys.length ? sys.join('\n\n') : null,
    messages,
    tools,
    params: dropEmpty({
      temperature: b.temperature,
      maxTokens: b.max_output_tokens,
      topP: b.top_p,
      reasoning: b.reasoning,
      format: obj(b.text).format,
    }),
    raw: b,
  };
}

// ── 流式 ───────────────────────────────────────────────────

/** SSE 文本 → 一串 { event, data }。data 能解成 JSON 的解成 JSON；[DONE] 之类跳过 */
function sseEvents(text: string): { event: string | null; data: Record<string, unknown> }[] {
  const out: { event: string | null; data: Record<string, unknown> }[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    const payload = data.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      out.push({ event, data: obj(JSON.parse(payload)) });
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/**
 * 流式响应 → 和非流式一样的 IR：把增量拼回完整的正文、工具调用（参数是分片来的）、finish reason、usage。
 * raw 存原始 SSE 文本 —— 重放时原样回放成流。
 */
export function normalizeStream(kind: ProviderKind, text: string): LLMResponseIR {
  const evs = sseEvents(text);
  let out = '';
  let finishReason: string | null = null;
  const usage: UsageIR = { inputTokens: null, outputTokens: null, cacheReadTokens: null };
  const calls = new Map<number | string, { id: string | null; name: string; args: string }>();
  const call = (k: number | string) => {
    let c = calls.get(k);
    if (!c) { c = { id: null, name: '', args: '' }; calls.set(k, c); }
    return c;
  };

  switch (kind) {
    case 'openai':
      for (const { data: d } of evs) {
        const ch = obj(arr(d.choices)[0]);
        const delta = obj(ch.delta);
        if (typeof delta.content === 'string') out += delta.content;
        for (const t of arr(delta.tool_calls)) {
          const o = obj(t);
          const c = call(typeof o.index === 'number' ? o.index : calls.size);
          if (typeof o.id === 'string') c.id = o.id;
          const fn = obj(o.function);
          if (typeof fn.name === 'string') c.name += fn.name;
          if (typeof fn.arguments === 'string') c.args += fn.arguments;
        }
        if (typeof ch.finish_reason === 'string') finishReason = ch.finish_reason;
        const u = obj(d.usage);
        if (num(u.prompt_tokens) != null) usage.inputTokens = num(u.prompt_tokens);
        if (num(u.completion_tokens) != null) usage.outputTokens = num(u.completion_tokens);
        if (num(obj(u.prompt_tokens_details).cached_tokens) != null) usage.cacheReadTokens = num(obj(u.prompt_tokens_details).cached_tokens);
      }
      break;

    case 'anthropic':
      for (const { data: d } of evs) {
        const type = d.type;
        if (type === 'message_start') {
          const u = obj(obj(d.message).usage);
          usage.inputTokens = num(u.input_tokens);
          usage.cacheReadTokens = num(u.cache_read_input_tokens);
        } else if (type === 'content_block_start') {
          const b = obj(d.content_block);
          if (b.type === 'tool_use') { const c = call(num(d.index) ?? calls.size); c.id = str(b.id) || null; c.name = str(b.name); }
          if (b.type === 'text' && typeof b.text === 'string') out += b.text;
        } else if (type === 'content_block_delta') {
          const dl = obj(d.delta);
          if (dl.type === 'text_delta' && typeof dl.text === 'string') out += dl.text;
          if (dl.type === 'input_json_delta' && typeof dl.partial_json === 'string') call(num(d.index) ?? 0).args += dl.partial_json;
        } else if (type === 'message_delta') {
          if (typeof obj(d.delta).stop_reason === 'string') finishReason = str(obj(d.delta).stop_reason);
          if (num(obj(d.usage).output_tokens) != null) usage.outputTokens = num(obj(d.usage).output_tokens);
        }
      }
      break;

    case 'gemini':
      // 每个 data 都是一个完整形状的 GenerateContentResponse，只是 parts 是增量
      for (const { data: d } of evs) {
        const cand = obj(arr(d.candidates)[0]);
        for (const p of arr(obj(cand.content).parts)) {
          const o = obj(p);
          if (typeof o.text === 'string' && !o.thought) out += o.text;
          if (o.functionCall) { const fc = obj(o.functionCall); const c = call(calls.size); c.id = str(fc.id) || null; c.name = str(fc.name); c.args = JSON.stringify(fc.args ?? {}); }
        }
        if (cand.finishReason) finishReason = str(cand.finishReason);
        const um = obj(d.usageMetadata);
        if (num(um.promptTokenCount) != null) usage.inputTokens = num(um.promptTokenCount);
        if (num(um.candidatesTokenCount) != null) usage.outputTokens = num(um.candidatesTokenCount);
        if (num(um.cachedContentTokenCount) != null) usage.cacheReadTokens = num(um.cachedContentTokenCount);
      }
      break;

    case 'openai_responses': {
      // 收尾事件里带着完整的 response 对象 —— 有它就直接用，最准
      const last = [...evs].reverse().find((e) => /^response\.(completed|incomplete|failed)$/.test(str(e.data.type ?? e.event)));
      if (last) return { ...normalizeResponse('openai_responses', obj(last.data.response)), raw: text };
      for (const { data: d } of evs) {
        const type = str(d.type);
        if (type === 'response.output_text.delta' && typeof d.delta === 'string') out += d.delta;
        if (type === 'response.output_item.added' && obj(d.item).type === 'function_call') {
          const it = obj(d.item); const c = call(str(it.id) || calls.size); c.id = str(it.call_id) || null; c.name = str(it.name);
        }
        if (type === 'response.function_call_arguments.delta' && typeof d.delta === 'string') call(str(d.item_id)).args += d.delta;
      }
      break;
    }
  }

  return {
    text: out,
    toolCalls: [...calls.values()].map((c) => toolCall(c.id, c.name, c.args)),
    finishReason,
    usage,
    raw: text,
  };
}

function emptyUsage(): UsageIR {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null };
}

function dropEmpty(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}
