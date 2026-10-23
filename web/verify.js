// 验证视图：修完重放，和基线逐步对齐；拿历史请求批量回归。
//
// 三块，从上到下回答：
//   1. 结论 —— 变好了没有：修好了哪几处、有没有新冒出来的、花了多少（重放命中的不花钱）
//   2. 逐步对齐 —— ★ 是改动生效的第一步，它之后的变化是连锁反应；点一行，右边看这一步 prompt / 输出的差异
//   3. 批量回归 —— 只改对一个请求不算数：把基线处理过的请求原样重发给改好的服务，逐个对比

let deps = { showDiff: () => {}, showCall: () => {}, runs: () => new Map(), current: () => null };
let state = { a: null, b: null, v: null, error: null };
let batch = null;

export function initVerify(d) {
  deps = { ...deps, ...d };
}

/** 进入验证视图（或者切了运行）—— b 是当前运行，a 缺省用它的重放基线 */
export async function loadVerify(b, a = null) {
  const host = document.getElementById('verifyWrap');
  if (!host) return;
  state = { a, b, v: null, error: null };
  if (!b) {
    host.innerHTML = '<div class="vf-empty">先在顶上选一次运行 —— 改完代码重跑（或批量回归）出来的那次。</div>';
    return;
  }
  const q = new URLSearchParams({ b });
  if (a) q.set('a', a);
  const r = await fetch(`/api/verify?${q}`).then((x) => x.json()).catch(() => ({ error: '调试器没响应' }));
  if (state.b !== b) return;
  if (r.error) state.error = r.error;
  else { state.v = r; state.a = r.a; }
  paint();
}

/** SSE 推来的回归进度 */
export function noteRegress(ev) {
  if (!batch || ev.batchId !== batch.id) return;
  if (ev.item && ev.index != null) batch.items[ev.index] = ev.item;
  if (ev.summary) batch.summary = ev.summary;
  if (ev.done) batch.done = true;
  paintBatch();
}

// ── 渲染 ───────────────────────────────────────────────────

function paint() {
  const host = document.getElementById('verifyWrap');
  const runs = deps.runs();
  const options = [...runs.values()]
    .filter((r) => r.run_id !== state.b)
    .sort((x, y) => y.started_at - x.started_at)
    .slice(0, 60)
    .map((r) => `<option value="${esc(r.run_id)}"${r.run_id === state.a ? ' selected' : ''}>${esc(runLabel(r))}</option>`)
    .join('');
  const bRun = runs.get(state.b);

  const head = `<div class="vf-head">
    <label class="vf-pick">A · 改之前
      <select id="vfA"><option value="">${state.a ? '' : '（选一个基线）'}</option>${options}</select></label>
    <span class="vf-arrow">⇄</span>
    <span class="vf-b">B · 改之后 <b>${esc(bRun ? runLabel(bRun) : state.b)}</b></span>
  </div>`;

  let body = '';
  if (state.error) body = `<div class="vf-empty">${esc(state.error)}</div>`;
  else if (state.v) body = verdictHtml(state.v) + stepsHtml(state.v);

  host.innerHTML = `${head}${body}<div id="vfBatch"></div>`;
  host.querySelector('#vfA').onchange = (e) => loadVerify(state.b, e.target.value || null);
  for (const tr of host.querySelectorAll('tr[data-pair]')) {
    tr.onclick = () => {
      for (const x of host.querySelectorAll('tr.sel')) x.classList.remove('sel');
      tr.classList.add('sel');
      const p = state.v.pairs[Number(tr.dataset.pair)];
      if (p.a && p.b) deps.showDiff(p.a.callIds[0], p.b.callIds[0], p);
      else deps.showCall((p.a ?? p.b).callIds[0]);
    };
  }
  paintBatch();
}

const VERDICT = {
  better: ['good', '✓ 变好了'],
  worse: ['bad', '✗ 变差了'],
  mixed: ['warn', '有好有坏'],
  same: ['', '结论没变'],
};

function verdictHtml(v) {
  const [cls, title] = VERDICT[v.verdict] ?? VERDICT.same;
  const list = (xs, label, c) => (xs.length ? `<div class="vf-list ${c}"><b>${label}</b>${xs.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : '');
  const c = v.cost;
  const llm = c.bReal + c.bReplayed;
  return `<div class="vf-verdict ${cls}">
    <div class="vf-title">${title}</div>
    ${list(v.fixed, `修好 ${v.fixed.length} 项`, 'good')}
    ${list(v.introduced, `新冒出来 ${v.introduced.length} 项`, 'bad')}
    ${list(v.remaining, `还在 ${v.remaining.length} 项`, 'warn')}
    ${!v.fixed.length && !v.introduced.length && !v.remaining.length ? '<div class="vf-list"><span>两边都没有发现问题</span></div>' : ''}
    <div class="vf-cost">${llm ? `模型调用 ${llm} 次，真打 ${c.bReal} 次、走缓存 ${c.bReplayed} 次 · ` : ''}tokens ${fmtNum(c.aTokens)} → ${fmtNum(c.bTokens)} · 耗时 ${fmtMs(c.aMs)} → ${fmtMs(c.bMs)}</div>
  </div>`;
}

const STATUS = {
  same: ['', '没变'],
  changed: ['chg', '变了'],
  only_a: ['gone', '改之后没再执行'],
  only_b: ['new', '改之后第一次走到'],
};

function sideHtml(s, other) {
  if (!s) return '<span class="dimtext">没执行</span>';
  const inp = s.input;
  const feed = !inp ? ''
    : inp.items != null && inp.used != null ? `看到 ${inp.used}/${inp.items} 条${inp.used < inp.items ? ' ✂' : ''} · `
    : inp.coverage != null ? `进了 ${Math.round(inp.coverage * 100)}% · ` : '';
  const outChanged = other && other.out !== s.out;
  return `${esc(feed)}<span class="${outChanged ? 'vf-diffval' : ''}">${esc(s.out || '（空）')}</span>
    ${s.next ? `<span class="dimtext"> → ${esc(s.next)}</span>` : ''}
    ${s.failing.length ? s.failing.map((f) => `<span class="rb">✗ ${esc(ruleName(f))}</span>`).join('') : ''}`;
}

function stepsHtml(v) {
  const rows = v.pairs.map((p, i) => {
    const [cls, word] = STATUS[p.status];
    const cost = !p.b ? '—'
      : p.kind !== 'llm' ? `${p.b.calls} 次请求`
      : p.b.replayed && !p.b.real ? `<span class="vf-free">⟲ 缓存 · 不花钱</span>`
      : `真打模型 ${p.b.real} 次${p.b.replayed ? ` · 缓存 ${p.b.replayed}` : ''}`;
    return `<tr data-pair="${i}" class="${cls}">
      <td><b>${esc(p.label)}</b>${p.star ? ' <span class="vf-star" title="第一处变化 —— 改动的注入点；之后的变化是连锁反应">★</span>' : ''}<div class="dimtext">${word}</div></td>
      <td>${sideHtml(p.a, p.b)}</td>
      <td>${sideHtml(p.b, p.a)}</td>
      <td>${cost}</td>
    </tr>`;
  }).join('');
  return `<div class="vf-sec"><b>逐步对齐</b><span class="dimtext">★ = 第一处变化（改动的注入点），之后的变化是连锁反应 · 点一行看这一步的差异</span></div>
    <div class="cmp-scroll"><table class="cmp vf-steps">
      <thead><tr><th>步骤</th><th>A · 改之前</th><th>B · 改之后</th><th>花了什么</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

// ── 批量回归 ───────────────────────────────────────────────

const OUTCOME = {
  fixed: ['good', '改对了'],
  still: ['bad', '还有问题'],
  ok: ['', '本来就好 · 没变坏'],
  regressed: ['bad', '被改坏了'],
  error: ['bad', '出错'],
};

/** 回归的基线：B 是重放出来的就用它基线所在的进程；否则就是当前选中的进程 */
function defaultBaseline() {
  const runs = deps.runs();
  const pick = (id) => {
    const r = runs.get(id);
    return r?.kind === 'request' && r.parent_run_id ? r.parent_run_id : id;
  };
  const b = runs.get(state.b);
  if (state.a) return pick(state.a);
  if (b?.replay_of) return pick(b.replay_of);
  return pick(state.b);
}

function paintBatch() {
  const host = document.getElementById('vfBatch');
  if (!host) return;
  const base = defaultBaseline();
  const runs = deps.runs();
  const baseRun = base ? runs.get(base) : null;

  const controls = `<div class="vf-sec"><b>拿历史请求批量回归</b>
      <span class="dimtext">只改对一个请求不算数 —— 把基线处理过的请求原样重发给改好的服务，逐个对比</span></div>
    <div class="vf-ctl">
      <span>基线：<b>${esc(baseRun ? runLabel(baseRun) : base ?? '—')}</b></span>
      <label><input type="radio" name="vfOnly" value="all" checked /> 全部请求</label>
      <label><input type="radio" name="vfOnly" value="failed" /> 只回归出过问题的</label>
      <button type="button" class="btn primary" id="vfGo"${batch && !batch.done ? ' disabled' : ''}>${batch && !batch.done ? '回归中…' : '开始回归'}</button>
      <span class="dimtext">改好的服务要先带着探针跑起来，会自动找到它</span>
    </div>
    <div id="vfErr" class="vf-err" hidden></div>`;

  host.innerHTML = controls + (batch ? batchHtml(batch) : '');
  host.querySelector('#vfGo').onclick = async () => {
    const only = host.querySelector('input[name=vfOnly]:checked')?.value ?? 'all';
    const r = await fetch('/api/regress', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseline: base, only }),
    }).then((x) => x.json()).catch(() => ({ error: '调试器没响应' }));
    if (r.error) {
      const e = host.querySelector('#vfErr');
      e.hidden = false;
      e.textContent = r.error;
      return;
    }
    batch = r;
    paintBatch();
  };
  for (const tr of host.querySelectorAll('tr[data-run]')) {
    tr.onclick = () => loadVerify(tr.dataset.run, tr.dataset.base);
  }
}

function batchHtml(b) {
  const s = b.summary;
  const wasBad = b.items.filter((x) => x.before.failed).length;
  const wasOk = b.items.length - wasBad;
  const done = b.items.filter((x) => x.status === 'done' || x.status === 'error').length;
  const cards = `<div class="vf-cards">
    <div class="vf-card ${wasBad && s.fixed === wasBad ? 'good' : wasBad ? 'warn' : ''}"><span>原来出过问题的 ${wasBad} 个</span><b>${s.fixed} 个改对了</b>${s.still ? `<em>${s.still} 个还有问题</em>` : ''}</div>
    <div class="vf-card ${s.regressed ? 'bad' : wasOk ? 'good' : ''}"><span>原来就好的 ${wasOk} 个</span><b>${s.regressed ? `${s.regressed} 个被改坏了` : `${s.ok} 个没变坏`}</b></div>
    <div class="vf-card"><span>模型调用</span><b>真打 ${s.real} 次</b><em>走缓存 ${s.replayed} 次</em></div>
    <div class="vf-card"><span>进度</span><b>${done} / ${b.items.length}</b><em>${b.done ? '完成' : '进行中…'}${s.error ? ` · ${s.error} 个出错` : ''}</em></div>
  </div>`;

  const rows = b.items.map((it) => {
    const [cls, word] = it.outcome ? OUTCOME[it.outcome] : ['', it.status === 'running' ? '正在跑…' : '排队中'];
    return `<tr class="${cls}"${it.run ? ` data-run="${esc(it.run)}" data-base="${esc(it.baseline)}"` : ''}>
      <td class="mono">${esc(String(it.baseline).split('_').pop())} ${esc(it.trigger)}</td>
      <td>${it.before.failed ? it.before.issues.map((x) => `<div class="vf-issue">${esc(x)}</div>`).join('') : '<span class="dimtext">没问题</span>'}</td>
      <td><b class="vf-out ${cls}">${word}</b>${it.error ? `<div class="vf-issue">${esc(it.error)}</div>` : ''}
        ${it.after?.issues?.length ? it.after.issues.map((x) => `<div class="vf-issue">${esc(x)}</div>`).join('') : ''}</td>
      <td class="mono">${esc(it.changed.join(' · ') || (it.status === 'done' ? '没变' : ''))}</td>
      <td class="mono">${it.status === 'done' ? `真打 ${it.real} · 缓存 ${it.replayed}` : ''}</td>
    </tr>`;
  }).join('');

  return `${cards}<div class="cmp-scroll"><table class="cmp vf-batch">
    <thead><tr><th>请求（基线）</th><th>改之前</th><th>改之后</th><th>变了的步骤</th><th>花了什么</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="dimtext vf-tip">点一行，上面换成这个请求的逐步对齐</div>`;
}

// ── 小工具 ─────────────────────────────────────────────────

function runLabel(r) {
  const t = new Date(r.started_at).toLocaleTimeString('zh-CN', { hour12: false });
  const tail = String(r.run_id).split('_').pop();
  return r.kind === 'request'
    ? `${t} ${tail} ${r.trigger ?? ''}${r.replay_of ? ' · 重放' : ''}`
    : `${t} ${(r.cwd || '').split('/').pop() || tail}${r.replay_of ? ' · 重放' : ''}`;
}

const RULES = {
  'rule.truncated': '被截断',
  'rule.empty_output': '空输出',
  'rule.tool_args_invalid': '工具参数坏了',
  'rule.unknown_tool': '调了不存在的工具',
  'rule.blocked': '被拦截',
};
const ruleName = (n) => RULES[n] ?? n;
const fmtNum = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : (ms || 0) + 'ms');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
