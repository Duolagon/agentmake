// denormalize 的单测。这段代码会真的改掉发给模型的东西，两条铁律必须守住：
//   1. 保守合并 —— 未编辑的字段（含我们不认识的）原样透传
//   2. 不破坏非文本内容 —— 图片 / 工具块 / cache_control 不能因为改文本而丢失
import assert from 'node:assert/strict';
import test from 'node:test';
import { denormalize, fakeResponseBody } from '../src/shared/denormalize.ts';
import { normalizeRequest } from '../src/shared/normalize.ts';
import { classify } from '../src/shared/classify.ts';

const GEMINI_URL = 'https://x/v1beta/models/gemini-2.5-pro:generateContent';
const irOf = (url: string, body: unknown) =>
  normalizeRequest(classify(url, 'POST', { 'anthropic-version': '2023-06-01' }), body);

test('gemini: 只改 system，其余字段原样保留', () => {
  const raw = {
    systemInstruction: { parts: [{ text: '旧' }] },
    contents: [{ role: 'user', parts: [{ text: '你好' }] }],
    generationConfig: { temperature: 0.4 },
    safetySettings: [{ category: 'HARM', threshold: 'NONE' }], // 我们不认识的字段
    cachedContent: 'projects/x/cachedContents/1',
  };
  const { body } = denormalize('gemini', irOf(GEMINI_URL, raw), { system: '新' }, GEMINI_URL);
  const b = body as typeof raw;
  assert.equal(b.systemInstruction.parts[0].text, '新');
  assert.deepEqual(b.contents, raw.contents, 'contents 未编辑，应原样');
  assert.deepEqual(b.safetySettings, raw.safetySettings, '不认识的字段必须透传');
  assert.equal(b.cachedContent, raw.cachedContent);
});

test('gemini: 改消息文本时保住图片 part', () => {
  const raw = {
    contents: [
      { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { text: '这是什么' }] },
    ],
  };
  const ir = irOf(GEMINI_URL, raw);
  const { body } = denormalize(
    'gemini', ir, { messages: [{ ...ir.messages[0], content: '改成这句' }] }, GEMINI_URL,
  );
  const parts = (body as typeof raw).contents[0].parts as Record<string, unknown>[];
  assert.equal(parts.length, 2, 'part 数量不变');
  assert.ok(parts[0].inlineData, '图片 part 必须保住');
  assert.equal(parts[1].text, '改成这句');
});

test('gemini: 改模型要同时改 URL（模型名在路径里）', () => {
  const { url } = denormalize('gemini', irOf(GEMINI_URL, {}), { model: 'gemini-2.0-flash' }, GEMINI_URL);
  assert.equal(url, 'https://x/v1beta/models/gemini-2.0-flash:generateContent');
});

test('gemini: assistant 角色写回时还原成 model', () => {
  const raw = { contents: [{ role: 'model', parts: [{ text: '旧' }] }] };
  const ir = irOf(GEMINI_URL, raw);
  assert.equal(ir.messages[0].role, 'assistant');
  const { body } = denormalize('gemini', ir, { messages: [{ ...ir.messages[0], content: '新' }] }, GEMINI_URL);
  assert.equal((body as typeof raw).contents[0].role, 'model');
});

test('anthropic: system 是 block 数组时保住 cache_control', () => {
  const url = 'https://api.anthropic.com/v1/messages';
  const raw = {
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: '旧', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '嗨' }],
    max_tokens: 1024,
  };
  const { body } = denormalize('anthropic', irOf(url, raw), { system: '新' }, url);
  const s = (body as typeof raw).system as Record<string, unknown>[];
  assert.equal(s[0].text, '新');
  assert.deepEqual(s[0].cache_control, { type: 'ephemeral' }, 'cache_control 必须保住');
});

test('anthropic: 改文本时保住 tool_result 块', () => {
  const url = 'https://api.anthropic.com/v1/messages';
  const raw = {
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'text', text: '继续' },
    ] }],
  };
  const ir = irOf(url, raw);
  const { body } = denormalize('anthropic', ir, { messages: [{ ...ir.messages[0], content: '改了' }] }, url);
  const blocks = (body as typeof raw).messages[0].content as Record<string, unknown>[];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'tool_result');
  assert.equal(blocks[1].text, '改了');
});

test('openai: system 抽出后写回，位置与其余消息不乱', () => {
  const url = 'https://api.deepseek.com/v1/chat/completions';
  const raw = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '旧系统' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
    ],
    response_format: { type: 'json_object' }, // 未编辑，须透传
  };
  const ir = irOf(url, raw);
  assert.equal(ir.system, '旧系统');
  assert.equal(ir.messages.length, 2);

  const { body } = denormalize('openai', ir, { system: '新系统', model: 'gpt-4o' }, url);
  const b = body as typeof raw;
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.messages[0].content, '新系统');
  assert.equal(b.messages[1].content, '问题');
  assert.equal(b.messages[2].content, '回答');
  assert.equal(b.model, 'gpt-4o');
  assert.deepEqual(b.response_format, { type: 'json_object' });
});

test('空补丁 = 原样', () => {
  const url = 'https://api.deepseek.com/v1/chat/completions';
  const raw = { model: 'm', messages: [{ role: 'user', content: 'x' }], seed: 42 };
  const { body, url: u } = denormalize('openai', irOf(url, raw), {}, url);
  assert.deepEqual(body, raw);
  assert.equal(u, null);
});

test('改写响应：只换文本，usage / finish_reason 等全保留', async () => {
  const { denormalizeResponse } = await import('../src/shared/denormalize.ts');
  const { normalizeResponse } = await import('../src/shared/normalize.ts');

  const cases = [
    ['gemini', {
      candidates: [{ content: { role: 'model', parts: [{ text: '旧答案' }] }, finishReason: 'STOP', safetyRatings: [1] }],
      usageMetadata: { promptTokenCount: 111, candidatesTokenCount: 22 },
    }],
    ['anthropic', {
      content: [{ type: 'text', text: '旧答案' }], stop_reason: 'end_turn',
      usage: { input_tokens: 111, output_tokens: 22 }, id: 'msg_x',
    }],
    ['openai', {
      choices: [{ message: { role: 'assistant', content: '旧答案' }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 111, completion_tokens: 22 }, id: 'cmpl_x',
    }],
  ] as const;

  for (const [kind, raw] of cases) {
    const patched = denormalizeResponse(kind, raw, '新答案');
    const ir = normalizeResponse(kind, patched);
    assert.equal(ir.text, '新答案', `${kind} 文本未替换`);
    assert.equal(ir.usage.inputTokens, 111, `${kind} usage 丢了`);
    assert.equal(ir.usage.outputTokens, 22, `${kind} usage 丢了`);
    assert.ok(ir.finishReason, `${kind} finishReason 丢了`);
  }
  // 我们不认识的字段也得留着
  const g = denormalizeResponse('gemini', cases[0][1], 'x') as any;
  assert.deepEqual(g.candidates[0].safetyRatings, [1]);
  const o = denormalizeResponse('openai', cases[2][1], 'x') as any;
  assert.equal(o.id, 'cmpl_x');
  assert.equal(o.choices[0].logprobs, null);
});

test('伪造响应能被正向归一化读回', async () => {
  const { normalizeResponse } = await import('../src/shared/normalize.ts');
  for (const kind of ['gemini', 'anthropic', 'openai'] as const) {
    const r = normalizeResponse(kind, fakeResponseBody(kind, '伪造内容', 'm'));
    assert.equal(r.text, '伪造内容', `${kind} 往返失败`);
  }
});
