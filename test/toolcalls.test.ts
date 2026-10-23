// 工具调用进 IR 的单测。三件事：
//   1. 三家协议的 tool call / tool result 都被结构化抽出来
//   2. 指纹：纯文本请求指纹不变；工具结果变了指纹必须变；调用 id 不影响指纹
//   3. 反向映射：改一条消息时，只含工具块的消息原样透传，不被塞进占位符
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../src/shared/classify.ts';
import { denormalize } from '../src/shared/denormalize.ts';
import { requestHash } from '../src/shared/hash.ts';
import { normalizeRequest, normalizeResponse } from '../src/shared/normalize.ts';
import { compareRuns } from '../src/server/compare.ts';

const OPENAI_URL = 'https://api.deepseek.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://x/v1beta/models/gemini-2.5-pro:generateContent';
const irOf = (url: string, body: unknown) =>
  normalizeRequest(classify(url, 'POST', { 'anthropic-version': '2023-06-01' }), body);

// ── 1. 抽取 ────────────────────────────────────────────────

test('openai: 助手的 tool_calls 与 tool 角色结果', () => {
  const ir = irOf(OPENAI_URL, {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: '查订单' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"42"}' } },
          { id: 'call_2', type: 'function', function: { name: 'broken', arguments: '{"q":' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '已发货' },
    ],
  });
  assert.deepEqual(ir.messages[1].toolCalls, [
    { id: 'call_1', name: 'search', args: { q: '42' } },
    { id: 'call_2', name: 'broken', args: '{"q":', argsInvalid: true },
  ]);
  assert.deepEqual(ir.messages[2].toolResults, [{ callId: 'call_1', name: null, content: '已发货' }]);
  assert.equal('toolCalls' in ir.messages[0], false, '纯文本消息不挂工具键');
});

test('openai: 只调工具的响应，正文为空但工具调用可见', () => {
  const r = normalizeResponse('openai', {
    choices: [{
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'search', arguments: '' } }] },
      finish_reason: 'tool_calls',
    }],
  });
  assert.equal(r.text, '');
  assert.deepEqual(r.toolCalls, [{ id: 'c', name: 'search', args: {} }]);
});

test('openai: 旧版 function_call / function 角色', () => {
  const ir = irOf(OPENAI_URL, {
    messages: [
      { role: 'assistant', content: null, function_call: { name: 'old', arguments: '{"a":1}' } },
      { role: 'function', name: 'old', content: 'r' },
    ],
  });
  assert.deepEqual(ir.messages[0].toolCalls, [{ id: null, name: 'old', args: { a: 1 } }]);
  assert.deepEqual(ir.messages[1].toolResults, [{ callId: null, name: 'old', content: 'r' }]);
});

test('anthropic: tool_use / tool_result（含 block 内容与 is_error）', () => {
  const ir = irOf(ANTHROPIC_URL, {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: '查' },
      { role: 'assistant', content: [{ type: 'text', text: '我查一下' }, { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: '42' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '超时' }], is_error: true },
        ],
      },
    ],
  });
  assert.deepEqual(ir.messages[1].toolCalls, [{ id: 'toolu_1', name: 'search', args: { q: '42' } }]);
  assert.deepEqual(ir.messages[2].toolResults, [{ callId: 'toolu_1', name: null, content: '超时', isError: true }]);

  const r = normalizeResponse('anthropic', {
    content: [{ type: 'tool_use', id: 'toolu_2', name: 'search', input: { q: '43' } }],
    stop_reason: 'tool_use',
  });
  assert.deepEqual(r.toolCalls, [{ id: 'toolu_2', name: 'search', args: { q: '43' } }]);
});

test('gemini: functionCall / functionResponse', () => {
  const ir = irOf(GEMINI_URL, {
    contents: [
      { role: 'user', parts: [{ text: '查' }] },
      { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: '42' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search', response: { status: '已发货' } } }] },
    ],
  });
  assert.deepEqual(ir.messages[1].toolCalls, [{ id: null, name: 'search', args: { q: '42' } }]);
  assert.deepEqual(ir.messages[2].toolResults, [{ callId: null, name: 'search', content: '{"status":"已发货"}' }]);

  const r = normalizeResponse('gemini', {
    candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] } }],
  });
  assert.deepEqual(r.toolCalls, [{ id: null, name: 'search', args: {} }]);
});

// ── 2. 指纹 ────────────────────────────────────────────────

test('指纹: 纯文本请求与改动前完全一致（老的重放基线不失效）', () => {
  const h = requestHash({
    provider: 'openai', model: 'm', system: 's',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
    tools: [{ name: 't', description: 'd' }], params: { temperature: 0 }, raw: {},
  });
  // 这个值是改动前的 requestHash 算出来的
  assert.equal(h, '54249fdab54bc216c058a281ad3d42b2');
});

const anthropicWithResult = (result: string, id = 'toolu_1') => ({
  model: 'claude-opus-5-5',
  messages: [
    { role: 'user', content: '查' },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'search', input: { q: '42' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
  ],
});

test('指纹: 工具结果变了 → 指纹变（否则重放会给出过期的回答）', () => {
  const a = requestHash(irOf(ANTHROPIC_URL, anthropicWithResult('已发货')));
  const b = requestHash(irOf(ANTHROPIC_URL, anthropicWithResult('已取消')));
  assert.notEqual(a, b);
});

test('指纹: 只有调用 id 不同 → 指纹相同（id 是每次随机生成的）', () => {
  const a = requestHash(irOf(ANTHROPIC_URL, anthropicWithResult('已发货', 'toolu_aaa')));
  const b = requestHash(irOf(ANTHROPIC_URL, anthropicWithResult('已发货', 'toolu_bbb')));
  assert.equal(a, b);
});

test('指纹: 工具参数变了 → 指纹变', () => {
  const body = (q: string) => ({
    messages: [
      { role: 'user', content: '查' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 's', arguments: JSON.stringify({ q }) } }] },
      { role: 'tool', tool_call_id: 'c', content: 'r' },
    ],
  });
  assert.notEqual(requestHash(irOf(OPENAI_URL, body('42'))), requestHash(irOf(OPENAI_URL, body('43'))));
});

// ── 3. 反向映射 ────────────────────────────────────────────

test('anthropic: 改用户问题时，tool_result 消息原样透传，不被塞进占位文本', () => {
  const raw = anthropicWithResult('已发货');
  const ir = irOf(ANTHROPIC_URL, raw);
  // UI 的做法：整个数组传下来，只有第 0 条改了
  const messages = ir.messages.map((m, i) => (i === 0 ? { ...m, content: '查一下订单' } : m));
  const { body } = denormalize('anthropic', ir, { messages }, ANTHROPIC_URL);
  const b = body as typeof raw;
  assert.equal(b.messages[0].content, '查一下订单');
  assert.deepEqual(b.messages[1], raw.messages[1], 'tool_use 消息原样');
  assert.deepEqual(b.messages[2], raw.messages[2], 'tool_result 消息原样 —— 前面多一个 text 块会直接 400');
});

test('gemini: 改别的消息时，只有 functionCall 的 model 消息原样透传', () => {
  const raw = {
    contents: [
      { role: 'user', parts: [{ text: '查' }] },
      { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: '42' } } }] },
    ],
  };
  const ir = irOf(GEMINI_URL, raw);
  const messages = ir.messages.map((m, i) => (i === 0 ? { ...m, content: '改' } : m));
  const { body } = denormalize('gemini', ir, { messages }, GEMINI_URL);
  assert.deepEqual((body as typeof raw).contents[1], raw.contents[1]);
});

test('openai: 改用户消息时，content=null 的 tool_calls 消息保持 null', () => {
  const raw = {
    messages: [
      { role: 'user', content: '查' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 's', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'r' },
    ],
  };
  const ir = irOf(OPENAI_URL, raw);
  const messages = ir.messages.map((m, i) => (i === 0 ? { ...m, content: '改' } : m));
  const { body } = denormalize('openai', ir, { messages }, OPENAI_URL);
  assert.deepEqual((body as typeof raw).messages[1], raw.messages[1]);
});

test('反向映射: MCP 传来的消息不带 rawRole 也能认出没改动', () => {
  const raw = anthropicWithResult('已发货');
  const ir = irOf(ANTHROPIC_URL, raw);
  const messages = ir.messages.map(({ role, content }, i) => ({ role, content: i === 0 ? '改' : content }));
  const { body } = denormalize('anthropic', ir, { messages }, ANTHROPIC_URL);
  assert.deepEqual((body as typeof raw).messages[2], raw.messages[2]);
});

// ── 4. 对比 ────────────────────────────────────────────────

const row = (id: string, toolCalls: unknown[] | null, text = '') => ({
  call_id: id, seq: 0, model: 'm', request_hash: 'h', frames: '[]', system: 's', messages: '[]',
  response_text: text, response_tool_calls: toolCalls ? JSON.stringify(toolCalls) : null,
  input_tokens: 1, output_tokens: 1, duration_ms: 1, replayed: 0, ok: 1,
});

test('对比: 只调工具的回答，选了不同工具 → 响应不同（以前会误判成相同）', () => {
  const r = compareRuns('A', 'B',
    [row('a', [{ id: 'x', name: 'search', args: { q: 1 } }])],
    [row('b', [{ id: 'y', name: 'refund', args: { q: 1 } }])]);
  assert.equal(r.pairs[0].responseSame, false);
  assert.match(r.pairs[0].toolCalls!.a, /^search\(/);
  assert.match(r.pairs[0].toolCalls!.b, /^refund\(/);
});

test('对比: 工具调用只差 id → 响应相同', () => {
  const r = compareRuns('A', 'B',
    [row('a', [{ id: 'x', name: 'search', args: { q: 1 } }])],
    [row('b', [{ id: 'y', name: 'search', args: { q: 1 } }])]);
  assert.equal(r.pairs[0].responseSame, true);
  assert.equal(r.pairs[0].toolCalls, undefined);
});

test('对比: 老库里没有工具列（NULL）不报错', () => {
  const r = compareRuns('A', 'B', [row('a', null, 'hi')], [row('b', null, 'hi')]);
  assert.equal(r.counts.identical, 1);
});
