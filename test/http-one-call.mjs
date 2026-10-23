// 用 node:http 发一次模型调用（axios / 旧版 SDK 的形状）—— 验证断点在这条路上也能改写、能伪造。
import http from 'node:http';

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;
const body = JSON.stringify({ model: 'm', messages: [{ role: 'system', content: '原始的系统提示' }, { role: 'user', content: '你好' }] });
const text = await new Promise((resolve, reject) => {
  const req = http.request(`${MOCK}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
    let s = '';
    res.on('data', (c) => (s += c));
    res.on('end', () => resolve(s));
  });
  req.on('error', reject);
  req.end(body);
});
console.log('answer:', JSON.parse(text).choices[0].message.content);
console.log('http-one-call-done');
