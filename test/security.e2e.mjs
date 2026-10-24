// 本机服务的边界：这个服务能改写源码、启动进程，外站网页和畸形请求都不能碰它。
//
//   [1] 畸形 Host 不会把服务带崩；Host 不是本机地址（DNS 重绑定）一律拒绝
//   [2] 外站 Origin 的写请求被拒；本页面自己（同源）照常可写
//   [3] 源码回写 / 还原只许碰调用栈里出现过的文件、只许用我们自己的备份

import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 8787;
const AM = `http://127.0.0.1:${PORT}`;
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

/** 发一个可以随意设 Host / Origin 的请求 */
function req(method, p, headers = {}, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (body) r.end(body);
    else r.end();
  });
}

/** 原始字节：http 模块不让发畸形 Host，只能手写 */
function raw(text) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.end(text));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
  });
}

console.log('\n[1] Host');
await raw('GET /api/health HTTP/1.1\r\nHost: [bad\r\nConnection: close\r\n\r\n');
await raw('GET /api/health HTTP/1.1\r\nHost: a b%zz\r\nConnection: close\r\n\r\n');
ok((await req('GET', '/api/health')).status === 200, '★ 畸形 Host 之后服务还活着');
ok((await req('GET', '/api/health', { host: 'evil.example:8787' })).status === 403, 'Host 是外站域名（DNS 重绑定）→ 拒绝');
ok((await req('GET', '/api/health', { host: `localhost:${PORT}` })).status === 200, 'Host 是 localhost → 正常');

console.log('\n[2] Origin');
const tmp = mkdtempSync(path.join(tmpdir(), 'am-sec-'));
const victim = path.join(tmp, 'victim.mjs');
const ORIG = "export const s = '原样';\n";
writeFileSync(victim, ORIG);
const bk = path.join(tmp, 'evil-backup.mjs');
writeFileSync(bk, 'export const s = "被覆盖了";\n');
const evil = await req('POST', '/api/source/revert', { origin: 'http://evil.example', 'content-type': 'application/json' }, JSON.stringify({ file: victim, backup: bk }));
ok(evil.status === 403 && readFileSync(victim, 'utf8') === ORIG, `★ 外站 Origin 调还原接口 → 拒绝，文件没被覆盖（${evil.status}）`);
const evil2 = await req('POST', '/api/breakpoints', { origin: 'http://evil.example', 'content-type': 'application/json' }, '{"llmBefore":false}');
ok(evil2.status === 403, '外站 Origin 改断点 → 拒绝');
const same = await req('POST', '/api/breakpoints', { origin: AM, 'content-type': 'application/json' }, '{"llmBefore":false}');
ok(same.status === 200, '同源页面（本服务自己的界面）照常可写');

console.log('\n[3] 回写 / 还原的路径');
const noOrigin = await req('POST', '/api/source/revert', { 'content-type': 'application/json' }, JSON.stringify({ file: victim, backup: bk }));
ok(noOrigin.status === 403 && readFileSync(victim, 'utf8') === ORIG, '★ 没 Origin 也不行：不在调用栈里的文件、不是我们做的备份 → 拒绝');
const apply = await req('POST', '/api/source/apply', { 'content-type': 'application/json' }, JSON.stringify({ file: victim, start: 18, end: 20, newText: 'x' }));
ok(apply.status === 403 && readFileSync(victim, 'utf8') === ORIG, '回写调用栈里没出现过的文件 → 拒绝');
const rel = await req('POST', '/api/source/apply', { 'content-type': 'application/json' }, JSON.stringify({ file: '../../etc/x.js', start: 0, end: 0, newText: 'x' }));
ok(rel.status === 403, '相对路径 → 拒绝');

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
