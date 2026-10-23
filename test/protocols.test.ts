// 协议覆盖：OpenAI Responses API 与四种流式格式。
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../src/shared/classify.ts';
import { denormalize, denormalizeResponse, fakeResponseBody } from '../src/shared/denormalize.ts';
import { normalizeRequest, normalizeResponse, normalizeStream } from '../src/shared/normalize.ts';
import { checkCall } from '../src/server/rules.ts';

const sse = (events: [string | null, unknown][]) =>
  events.map(([ev, d]) => `${ev ? `event: ${ev}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join('');

// ── Responses API ──────────────────────────────────────────

test('识别：/v1/responses 和 Azure 的 /openai/v1/responses 是 Responses；太泛的 /responses 不算', () => {
  assert.equal(classify('https://api.openai.com/v1/responses', 'POST').kind, 'openai_responses');
  assert.equal(classify('https://x.openai.azure.com/openai/v1/responses', 'POST').kind, 'openai_responses');
  assert.equal(classify('https://forms.example.com/api/responses', 'POST').kind, 'unknown');
  assert.equal(classify('https://api.deepseek.com/v1/chat/completions', 'POST').kind, 'openai');
});

const R_URL = 'https://api.openai.com/v1/responses';
const irOf = (body: unknown) => normalizeRequest(classify(R_URL, 'POST'), body);

test('Responses 请求：instructions 是系统提示，字符串 input 是一条用户消息', () => {
  const ir = irOf({ model: 'gpt-5', instructions: '你是助手', input: '你好', max_output_tokens: 100 });
  assert.equal(ir.provider, 'openai_responses');
  assert.equal(ir.system, '你是助手');
  assert.deepEqual(ir.messages.map((m) => [m.role, m.content]), [['user', '你好']]);
  assert.equal(ir.params.maxTokens, 100);
});

test('Responses 请求：条目里的工具调用与工具结果结构化；input 里的 system 消息并进系统提示', () => {
  const ir = irOf({
    model: 'gpt-5',
    input: [
      { role: 'developer', content: '只说中文' },
      { role: 'user', content: [{ type: 'input_text', text: '北京天气' }, { type: 'input_image', image_url: 'x' }] },
      { type: 'reasoning', summary: [] },
      { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"weather":"晴"}' },
    ],
    tools: [{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object' } }],
  });
  assert.equal(ir.system, '只说中文');
  assert.equal(ir.messages.length, 3, 'reasoning 和 developer 不算消息');
  assert.equal(ir.messages[0].content, '北京天气«image»');
  assert.deepEqual(ir.messages[1].toolCalls, [{ id: 'c1', name: 'get_weather', args: { city: '北京' } }]);
  assert.deepEqual(ir.messages[2].toolResults, [{ callId: 'c1', name: null, content: '{"weather":"晴"}' }]);
  assert.deepEqual(ir.tools.map((t) => t.name), ['get_weather']);
});

test('Responses 响应：正文、工具调用、usage；被截断时 finish 是 max_output_tokens，规则判得出来', () => {
  const r = normalizeResponse('openai_responses', {
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'function_call', call_id: 'c9', name: 'search', arguments: '{"q":"x"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
    ],
    usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
  });
  assert.equal(r.text, '好的');
  assert.deepEqual(r.toolCalls, [{ id: 'c9', name: 'search', args: { q: 'x' } }]);
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 });

  const cut = normalizeResponse('openai_responses', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '半' }] }] });
  assert.equal(cut.finishReason, 'max_output_tokens');
  const hits = checkCall({ kind: 'llm', ok: 1, status: 200, finish_reason: cut.finishReason, response_text: '半', response_tool_calls: null, tools: null });
  assert.deepEqual(hits.map((h) => h.name), ['rule.truncated']);
});

test('Responses 改写：系统提示写回 instructions，改了的消息写回对应条目，没改的（含工具结果）原样', () => {
  const raw = {
    model: 'gpt-5',
    instructions: '旧',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '问题' }] },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
    store: false,
  };
  const ir = irOf(raw);
  const { body } = denormalize('openai_responses', ir, {
    system: '新',
    messages: ir.messages.map((m, i) => (i === 0 ? { ...m, content: '改过的问题' } : m)),
  }, R_URL);
  const b = body as any;
  assert.equal(b.instructions, '新');
  assert.equal(b.input[0].content[0].text, '改过的问题');
  assert.deepEqual(b.input[1], raw.input[1]);
  assert.deepEqual(b.input[2], raw.input[2]);
  assert.equal(b.store, false, '不认识的字段透传');

  const s = denormalize('openai_responses', irOf({ input: '你好' }), { messages: [{ role: 'user', content: '改' }] }, R_URL);
  assert.equal((s.body as any).input, '改');
});

test('Responses 伪造 / 改写回答：形状对，归一化回来就是那句话', () => {
  assert.equal(normalizeResponse('openai_responses', fakeResponseBody('openai_responses', '编的', 'gpt-5')).text, '编的');
  const real = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '原话' }] }], output_text: '原话' };
  const patched = denormalizeResponse('openai_responses', real, '改的') as any;
  assert.equal(normalizeResponse('openai_responses', patched).text, '改的');
  assert.equal(patched.output_text, '改的');
});

// ── 流式 ───────────────────────────────────────────────────

test('流式 OpenAI：正文拼起来；工具调用的参数分好几片来，也拼回完整 JSON', () => {
  const text = sse([
    [null, { choices: [{ delta: { role: 'assistant', content: '' } }] }],
    [null, { choices: [{ delta: { content: '你' } }] }],
    [null, { choices: [{ delta: { content: '好' } }] }],
    [null, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":' } }] } }] }],
    [null, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] }],
    [null, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
    [null, { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }],
    [null, '[DONE]'],
  ]);
  const r = normalizeStream('openai', text);
  assert.equal(r.text, '你好');
  assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'search', args: { q: '北京' } }]);
  assert.equal(r.finishReason, 'tool_calls');
  assert.equal(r.usage.inputTokens, 9);
  assert.equal(r.usage.outputTokens, 4);
  assert.equal(r.raw, text, 'raw 是原始 SSE —— 重放要原样回放');
});

test('流式 Anthropic：文本增量、tool_use 的 input_json_delta、stop_reason、usage', () => {
  const r = normalizeStream('anthropic', sse([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '查一下' } }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"}' } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }],
  ]));
  assert.equal(r.text, '查一下');
  assert.deepEqual(r.toolCalls, [{ id: 'toolu_1', name: 'search', args: { q: 'x' } }]);
  assert.equal(r.finishReason, 'tool_use');
  assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 7, cacheReadTokens: 5 });
});

test('流式 Gemini：每块是完整形状的响应，parts 增量拼起来；思考内容不算正文', () => {
  const r = normalizeStream('gemini', sse([
    [null, { candidates: [{ content: { parts: [{ text: '想一想', thought: true }, { text: '第一' }] } }] }],
    [null, { candidates: [{ content: { parts: [{ text: '第二' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }],
  ]));
  assert.equal(r.text, '第一第二');
  assert.equal(r.finishReason, 'MAX_TOKENS');
  assert.equal(r.usage.outputTokens, 2);
});

test('流式 Responses：有收尾事件就用里面的完整 response；没有就拼增量', () => {
  const full = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完整的' }] }], usage: { input_tokens: 3, output_tokens: 2 } };
  const r = normalizeStream('openai_responses', sse([
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: '完' }],
    ['response.completed', { type: 'response.completed', response: full }],
  ]));
  assert.equal(r.text, '完整的');
  assert.equal(r.usage.outputTokens, 2);

  const partial = normalizeStream('openai_responses', sse([
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: '半' }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: '截' }],
  ]));
  assert.equal(partial.text, '半截', '流中途断了也要拿到已经收到的部分');
});

test('流式：坏行、空行、[DONE] 不影响其余部分', () => {
  const r = normalizeStream('openai', `data: {坏的\n\n\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: '还在' } }] })}\n\ndata: [DONE]\n\n`);
  assert.equal(r.text, '还在');
});
