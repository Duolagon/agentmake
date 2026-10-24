// fetch(new Request(url, { body })) —— 请求体在 Request 对象自己身上，init 里没有。
// 一些 SDK（以及自己封装重试的代码）就是这么发的：探针要看得见 prompt，断点改写也要真的生效。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;
const req = new Request(`${MOCK}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-trace': 'keep-me' },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'Request 对象里的系统提示' }, { role: 'user', content: '你好' }] }),
});
const r = await fetch(req);
console.log('answer:', (await r.json()).choices[0].message.content);
console.log('request-obj-done');
