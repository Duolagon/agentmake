// 工具调用 / 工具结果的一行文本形式 —— 对比、MCP、流程图共用，免得三处各写一套格式。
//
// 形状刻意像函数调用：`search({"q":"订单延迟"})`。人和 AI 一眼就能读，也方便做文本 diff。

import type { MessageIR, ToolCallIR, ToolResultIR } from './types.ts';

export function toolCallText(c: ToolCallIR): string {
  const args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {});
  return `${c.name || '?'}(${args})${c.argsInvalid ? ' ⚠参数不是合法 JSON' : ''}`;
}

export function toolResultText(r: ToolResultIR): string {
  const who = r.name ?? r.callId ?? '?';
  return `${r.isError ? '✗ ' : ''}${who} → ${r.content}`;
}

/** 消息的完整文本：正文 + 工具调用 + 工具结果。content 里只有占位符，比对必须看这个 */
export function messageFullText(m: MessageIR): string {
  // OpenAI 的 tool 消息正文本身就是结果，再拼一遍是重复
  const dup = (m.toolResults ?? []).some((r) => r.content === m.content);
  const lines = dup ? [] : [m.content];
  for (const c of m.toolCalls ?? []) lines.push(`«调用» ${toolCallText(c)}`);
  for (const r of m.toolResults ?? []) lines.push(`«结果» ${toolResultText(r)}`);
  return lines.filter(Boolean).join('\n');
}
