// 规格与对账的端到端验证 —— HTTP 路由 + MCP 工具 + 真实运行。
//
// 单测已经把 reconcile 的推导规则钉死了，这里守的是另一件事：
// 整条链路（跑一次 → 反推规格 → 改规格 → 对账 → AI 通过 MCP 拿到差异）真的通。

const AM = 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (u, o) => fetch(u, o).then((r) => r.json());
const post = (p, body) =>
  j(`${AM}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

async function runAgent(script, env = {}) {
  const { spawn } = await import('node:child_process');
  const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;
  const p = spawn(process.execPath, [new URL(`./${script}`, import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise((r) => p.on('exit', r));
  await sleep(500);
}

const NAME = 'e2e_spec';

// ── 1. 跑一次，按实际反推规格草稿 ──────────────────────────

console.log('\n[1] 按实际运行反推规格草稿');
await runAgent('loop-agent.mjs', { LOOP_MAX: '4' });
{
  const spec = await post('/api/spec/from-run', { name: NAME });
  ok(!spec.error, `生成成功（${spec.steps?.length} 步）`);
  ok(spec.steps.some((s) => s.kind === 'loop'), '循环被识别成一个步骤');
  ok(spec.steps.every((s) => s.bind), '每一步都自动绑定到了实际步骤');

  const loop = spec.steps.find((s) => s.kind === 'loop');
  ok(loop.maxIterations === 4, `循环上限按实际填成 ${loop.maxIterations} 轮`);
}

console.log('\n[2] ★ 反推出来的规格，回头对账必须零差异');
{
  const d = await j(`${AM}/api/spec/diff?name=${NAME}`);
  ok(d.findings.length === 0, `零差异（实得 ${d.findings.length} 条：${d.findings.map((f) => f.kind).join(',')}）`);
  ok(d.coverage.unexpected === 0, '没有「跑了但没画」的步骤');
}

// ── 3. 改规格 → 差异出现 ───────────────────────────────────

console.log('\n[3] 把规格改成「和现实不符」，差异必须被抓出来');
{
  const spec = await j(`${AM}/api/spec?name=${NAME}`);
  const loop = spec.steps.find((s) => s.kind === 'loop');
  loop.maxIterations = 2;                       // 实际跑了 4 轮
  spec.steps.push({                              // 画了一个根本没实现的步骤
    id: 'never_ran', kind: 'tool', label: '发布到线上', intent: '推到生产',
  });
  spec.goal = '起草 → 精修 → 发布';
  await post('/api/spec', spec);

  const d = await j(`${AM}/api/spec/diff?name=${NAME}`);
  const kinds = d.findings.map((f) => f.kind);
  ok(kinds.includes('loop_overrun'), '★ 循环超轮被抓出来');
  ok(kinds.includes('missing'), '★ 没实现的步骤被抓出来');
  ok(
    d.findings.find((f) => f.kind === 'loop_overrun')?.level === 'blocker',
    '超轮是 blocker（你的心智模型和现实不符）',
  );
  ok(d.spec.goal === '起草 → 精修 → 发布', '目标被保存下来');
}

// ── 4. 另一次运行：同一份规格能反复用 ──────────────────────

console.log('\n[4] 换一次运行，同一份规格照样对账');
await runAgent('loop-agent.mjs', { LOOP_MAX: '2' });
{
  const d = await j(`${AM}/api/spec/diff?name=${NAME}`);
  const overrun = d.findings.find((f) => f.kind === 'loop_overrun');
  ok(!overrun, '★ 这次只跑 2 轮，符合规格里的上限 2 —— 超轮告警消失');
  ok(
    d.findings.some((f) => f.kind === 'missing'),
    '「发布到线上」仍然没实现，继续报',
  );
}

// ── 5. MCP：AI 拿得到规格和差异 ────────────────────────────

console.log('\n[5] MCP —— AI 侧的入口');
{
  const { TOOLS } = await import('../src/mcp/tools.ts');
  const tool = (n) => TOOLS.find((t) => t.name === n);

  ok(!!tool('get_spec') && !!tool('set_spec') && !!tool('diff_spec') && !!tool('draft_spec_from_run'),
    '四个规格工具都注册了');

  const spec = await tool('get_spec').run({ name: NAME });
  ok(spec.includes('发布到线上'), '★ AI 读得到用户画的意图');
  ok(spec.includes('意图：推到生产'), '意图正文也在（这是给 AI 的规格）');

  const diff = await tool('diff_spec').run({ name: NAME });
  ok(diff.includes('missing'), '★ AI 读得到差异');
  ok(diff.includes('优先处理'), '差异带了怎么读的提示');

  // AI 把规格改回去 —— set_spec 整份覆盖
  const cur = await j(`${AM}/api/spec?name=${NAME}`);
  const trimmed = cur.steps.filter((s) => s.id !== 'never_ran');
  await tool('set_spec').run({ name: NAME, goal: cur.goal, steps: trimmed });

  const after = await j(`${AM}/api/spec/diff?name=${NAME}`);
  ok(
    !after.findings.some((f) => f.kind === 'missing'),
    '★ AI 改完规格后，missing 消失 —— 闭环通了',
  );
}

// ── 6. 空规格不炸 ──────────────────────────────────────────

console.log('\n[6] 边界');
{
  const empty = await j(`${AM}/api/spec?name=不存在的规格`);
  ok(Array.isArray(empty.steps) && empty.steps.length === 0, '没有的规格返回空壳而不是 404');

  const d = await j(`${AM}/api/spec/diff?name=不存在的规格`);
  ok(d.coverage.total === 0, '空规格也能对账');
  ok(d.findings.length === 0, '★ 还没写规格时不报差异 —— 否则新用户一进来满屏「规格外」');

  await fetch(`${AM}/api/spec?name=${NAME}`, { method: 'DELETE' });
  const gone = await j(`${AM}/api/spec?name=${NAME}`);
  ok(gone.steps.length === 0, '删除生效');
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
