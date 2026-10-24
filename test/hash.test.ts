// 重放指纹：会改变模型输出的改动必须让指纹变，否则重放返回旧答案，看起来像「改了没生效」。
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../src/shared/classify.ts';
import { requestHash } from '../src/shared/hash.ts';
import { normalizeRequest } from '../src/shared/normalize.ts';

const h = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  requestHash(normalizeRequest(classify(url, 'POST', headers as never), body));
const OPENAI = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const RESPONSES = 'https://api.openai.com/v1/responses';

const tool = (props: unknown) => ({ type: 'function', function: { name: 'search', description: '搜', parameters: { type: 'object', properties: props } } });

test('改了工具参数 schema → 指纹变', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: '查' }] };
  assert.notEqual(
    h(OPENAI, { ...base, tools: [tool({ q: { type: 'string' } })] }),
    h(OPENAI, { ...base, tools: [tool({ q: { type: 'string' }, limit: { type: 'integer' } })] }),
  );
});

test('换了图片 → 指纹变（四种协议）', () => {
  const oa = (url: string) => ({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url } }] }] });
  assert.notEqual(h(OPENAI, oa('data:image/png;base64,AAAA')), h(OPENAI, oa('data:image/png;base64,BBBB')));

  const an = (data: string) => ({ model: 'c', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: '这是什么' }] }] });
  const ah = { 'anthropic-version': '2023-06-01' };
  assert.notEqual(h(ANTHROPIC, an('AAAA'), ah), h(ANTHROPIC, an('BBBB'), ah));

  const ge = (data: string) => ({ contents: [{ role: 'user', parts: [{ text: '这是什么' }, { inlineData: { mimeType: 'image/png', data } }] }] });
  assert.notEqual(h(GEMINI, ge('AAAA')), h(GEMINI, ge('BBBB')));

  const re = (url: string) => ({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: '这是什么' }, { type: 'input_image', image_url: url }] }] });
  assert.notEqual(h(RESPONSES, re('https://x/a.png')), h(RESPONSES, re('https://x/b.png')));
});

test('同一张图 → 指纹不变（缓存照样能命中）', () => {
  const oa = () => ({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
  assert.equal(h(OPENAI, oa()), h(OPENAI, oa()));
});

test('tool_choice / Gemini responseSchema 变了 → 指纹变', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: '查' }], tools: [tool({})] };
  assert.notEqual(h(OPENAI, { ...base, tool_choice: 'auto' }), h(OPENAI, { ...base, tool_choice: 'required' }));
  const ge = (t: string) => ({ contents: [{ role: 'user', parts: [{ text: 'x' }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: { type: t } } });
  assert.notEqual(h(GEMINI, ge('object')), h(GEMINI, ge('array')));
});

test('工具 schema 里的 type: "file" 不会被当成图片 / 文件', () => {
  const body = (d: string) => ({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [tool({ f: { type: 'file', description: d } })] });
  // 描述变了指纹当然变（schema 进了指纹），这里只确认不崩、可重复
  assert.equal(h(OPENAI, body('a')), h(OPENAI, body('a')));
});
