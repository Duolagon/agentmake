// 请求指纹 —— 重放缓存的键。
//
// 用「内容寻址」而不是「第几步」：缓存键是归一化请求的哈希，于是
// 「改一版 prompt 重跑」的理想行为自然落出来 ——
//
//   改动之前的调用：请求逐字节相同 → 命中缓存 → 不花钱、不等待
//   被改动的那次：  请求变了       → 未命中   → 真实调用
//   它之后的调用：  上游输出变了   → 未命中   → 真实调用
//
// 不需要跟踪步号，也不怕 agent 的控制流本身发生变化。

import { createHash } from 'node:crypto';
import type { LLMRequestIR } from './types.ts';

/** 键顺序无关的序列化 —— 否则对象字面量的书写顺序会影响指纹 */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}

/**
 * 只哈希会影响模型输出的部分。
 * 刻意排除 `raw` —— 它含有我们不认识的字段（如 cachedContent 引用、请求 id），
 * 那些变化不代表语义变化，纳入会让缓存几乎永远打不中。
 *
 * 工具调用的参数和工具结果必须进指纹：content 里它们只剩「«toolResult»」占位，
 * 不纳入的话「同一个问题、工具返回了不同结果」会被当成同一个请求，重放给出过期的回答。
 * 但调用 id 刻意排除 —— call_… / toolu_… 是每次响应随机生成的，语义相同的请求 id 也不同。
 * 纯文本消息不挂这两个键（undefined 会被 JSON.stringify 丢掉），老指纹保持不变。
 *
 * 同理，IR 里看不全、但会改变模型输出的东西也要进来，否则「改了却没生效」：
 *   工具的参数 schema · 图片 / 文件（content 里只剩「«image»」占位）· tool_choice · 输出 schema。
 * 后三样从原始请求体里取，只在请求里真有时才挂键。
 */
export function requestHash(ir: LLMRequestIR): string {
  const raw = ir.raw && typeof ir.raw === 'object' ? (ir.raw as Record<string, unknown>) : {};
  const media = mediaDigests(raw);
  const gc = raw.generationConfig && typeof raw.generationConfig === 'object' ? (raw.generationConfig as Record<string, unknown>) : {};
  const material = canonical({
    provider: ir.provider,
    model: ir.model,
    system: ir.system,
    messages: ir.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls?.map((c) => ({ name: c.name, args: c.args })),
      toolResults: m.toolResults?.map((r) => ({ name: r.name, content: r.content, isError: r.isError })),
    })),
    tools: ir.tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })),
    params: ir.params,
    media: media.length ? media : undefined,
    toolChoice: raw.tool_choice ?? raw.toolConfig ?? raw.tool_config,
    outputSchema: gc.responseSchema ?? gc.responseJsonSchema,
  });
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}

// 各家放图片 / 文件的形状：OpenAI image_url / input_audio / file，Responses input_image / input_file，
// Anthropic image / document，Gemini 的 inlineData / fileData part。
const MEDIA_TYPES = new Set(['image', 'image_url', 'input_image', 'input_audio', 'input_file', 'file', 'document', 'audio']);
const MEDIA_KEYS = ['inlineData', 'inline_data', 'fileData', 'file_data'];

/**
 * 请求里每个图片 / 文件块一个摘要，按出现顺序。
 * 只摘要，不把 base64 原文塞进指纹材料 —— 一张图几 MB，sha256 一下就够区分。
 */
function mediaDigests(raw: unknown): string[] {
  const out: string[] = [];
  const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex').slice(0, 16);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.type === 'string' && MEDIA_TYPES.has(o.type)) return void out.push(digest(o));
    const k = MEDIA_KEYS.find((x) => o[x] && typeof o[x] === 'object');
    if (k) return void out.push(digest(o[k]));
    for (const x of Object.values(o)) walk(x);
  };
  // 只看消息部分：tools 里的 JSON schema 也可能有 type: "file" 之类，不能当成媒体
  walk(raw && typeof raw === 'object' ? [(raw as any).messages, (raw as any).contents, (raw as any).input, (raw as any).system] : []);
  return out;
}
