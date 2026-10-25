// 会拉起子进程的 agent（像 dsh 用 bash 跑命令那样）—— 验证子进程挂在父运行下面、开关能关掉继承。
//
//   1. 自己调一次模型
//   2. execFile（异步，走 ChildProcess.prototype.spawn）拉起一个也调模型的 node 子进程
//   3. spawnSync（同步）拉起一个 python 子进程，用 urllib 调模型
//   4. 起一个 HTTP 服务，在处理请求的过程中拉起子进程 —— 它应该记到那次请求上
//   5. 一个没调过模型的请求里拉起子进程（dsh 打开页面时跑的小命令）—— 不该因此冒出一个空的请求级运行
import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;
const PY = process.env.AGENTMAKE_PY_DEPS || 'python3';
const ask = (q) => fetch(`${MOCK}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: q }] }),
}).then((r) => r.json());

const childJs = `fetch('${MOCK}/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',messages:[{role:'user',content:process.argv[1]}]})}).then(r=>r.json()).then(()=>console.log('child-ok'))`;
const childPy = [
  'import json, sys, urllib.request',
  `req = urllib.request.Request('${MOCK}/v1/chat/completions', data=json.dumps({'model': 'm', 'messages': [{'role': 'user', 'content': 'py-child'}]}).encode(), headers={'content-type': 'application/json'})`,
  'urllib.request.urlopen(req).read()',
  "print('py-child-ok')",
].join('\n');

await ask('parent');
await promisify(execFile)(process.execPath, ['-e', childJs, 'exec-child']);
spawnSync(PY, ['-c', childPy], { stdio: 'ignore' });

const server = http.createServer(async (req, res) => {
  if (req.url === '/noop') {
    await promisify(execFile)(process.execPath, ['-e', '0', 'noop-child']);
    return res.end('ok');
  }
  await ask('in-request');
  await promisify(execFile)(process.execPath, ['-e', childJs, 'request-child']);
  res.end('ok');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await fetch(`http://127.0.0.1:${server.address().port}/work`, { method: 'POST' }).then((r) => r.text());
await fetch(`http://127.0.0.1:${server.address().port}/noop`, { method: 'POST' }).then((r) => r.text());
server.close();
console.log('spawn-agent-done');
