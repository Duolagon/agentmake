// 各种客户端写法的 agent —— 验证「不管怎么调模型，都看得见」。
//
//   node:http（ESM 具名导入）· gzip 压缩的响应（axios 默认要 gzip）· node:http 读流 · http.get 调工具
//   fetch 读流：OpenAI / Anthropic / Gemini / Responses 四种 SSE
//   Responses API：先调工具，再把工具结果送回去
//
// 最后一行打印用户代码实际拿到的东西 —— e2e 拿它和重放那一次比，必须一字不差。
import http, { request as namedRequest } from 'node:http';
import zlib from 'node:zlib';

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;
const out = {};

/** 用 node:http 发一个 JSON POST（像 axios / node-fetch 那样），返回状态、头、已解压的正文 */
function httpPost(path, body, headers = {}, req = http.request) {
  return new Promise((resolve, reject) => {
    const r = req(`${MOCK}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8') });
      });
      res.on('error', reject);
    });
    r.on('error', reject);
    // 分两次写，模拟流式写入的客户端
    const s = JSON.stringify(body);
    r.write(s.slice(0, 10));
    r.end(s.slice(10));
  });
}

/** 把一段 SSE 里的增量文本按协议拼起来 —— 用户代码自己读流时就是这么干的 */
function deltas(sseText) {
  let s = '';
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    const j = JSON.parse(d);
    s += j.choices?.[0]?.delta?.content ?? '';
    if (j.type === 'content_block_delta') s += j.delta?.text ?? '';
    if (j.type === 'response.output_text.delta') s += j.delta ?? '';
    for (const p of j.candidates?.[0]?.content?.parts ?? []) s += p.text ?? '';
  }
  return s;
}

const msgs = [{ role: 'system', content: '你是客户端测试助手' }, { role: 'user', content: '各种客户端都打个招呼' }];

// 1) node:http · ESM 具名导入（导入时拷走的绑定 —— 拦截要能同步到它）
out.httpNamed = JSON.parse((await httpPost('/v1/chat/completions', { model: 'm', messages: msgs }, {}, namedRequest)).text).choices[0].message.content;

// 2) node:http · gzip 压缩的响应
out.httpGzip = JSON.parse((await httpPost('/v1/chat/completions', { model: 'm', messages: [...msgs, { role: 'user', content: 'gzip' }] }, { 'x-mock-gzip': '1', 'accept-encoding': 'gzip' })).text).choices[0].message.content;

// 3) node:http · 读流
out.httpStream = deltas((await httpPost('/v1/chat/completions', { model: 'm', stream: true, messages: [...msgs, { role: 'user', content: 'stream' }] })).text);

// 4) node:http · Anthropic（要带 anthropic-version 才认得出）
out.httpAnthropic = JSON.parse((await httpPost('/v1/messages', { model: 'claude-x', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, { 'anthropic-version': '2023-06-01' })).text).content[0].text;

// 5) http.get 调一个工具（不是模型调用）
out.tool = await new Promise((resolve, reject) => {
  http.get(`${MOCK}/feed/clients`, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve(s)); }).on('error', reject);
});

// 6) fetch 读流：四种协议
const sse = async (path, body, headers = {}) =>
  deltas(await (await fetch(`${MOCK}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).text());
out.fetchOpenAI = await sse('/v1/chat/completions', { model: 'm', stream: true, messages: [...msgs, { role: 'user', content: 'fetch stream' }] });
out.fetchAnthropic = await sse('/v1/messages', { model: 'claude-x', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'stream' }] }, { 'anthropic-version': '2023-06-01' });
out.fetchGemini = await sse('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse', { contents: [{ role: 'user', parts: [{ text: 'stream' }] }] });
out.fetchResponses = await sse('/v1/responses', { model: 'gpt-x', stream: true, instructions: '简短回答', input: '你好' });

// 7) Responses API：先调工具，再把结果送回去
const tools = [{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
const r1 = await (await fetch(`${MOCK}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-x', instructions: '你会查天气', input: '北京天气怎么样', tools }) })).json();
const fc = r1.output.find((x) => x.type === 'function_call');
const r2 = await (await fetch(`${MOCK}/v1/responses`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-x', instructions: '你会查天气', tools, input: [{ role: 'user', content: '北京天气怎么样' }, fc, { type: 'function_call_output', call_id: fc.call_id, output: '{"weather":"晴"}' }] }),
})).json();
out.responsesTool = `${fc.name}(${fc.arguments}) → ${r2.output[0].content[0].text}`;

console.log(`RESULT ${JSON.stringify(out)}`);
console.log('client-agent-done');
