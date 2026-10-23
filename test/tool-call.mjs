// 最小被调试对象：发一次**非 LLM** 的 HTTP 调用（模拟调工具/抓数据）。
// 用来验证工具断点与「伪造工具返回值」。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;

const res = await fetch(`${MOCK}/some/tool/api?q=x`);
const text = await res.text();
console.log('status:', res.status);
console.log('body:', text);
console.log('tool-done');
