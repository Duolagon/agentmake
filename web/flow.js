// Agent 数据流画布。
//
// 这块屏回答三个问题，按用户视线的先后：
//   1. 它现在在干什么 —— 正在跑的那一步发光，旁边跳着已经跑了几秒
//   2. 数据怎么流的 —— 连线上写的是**真实流过去的东西**：「12 条 → 5 条 ✂」「3.1KB · 进了 prompt 42%」。
//      agent 最常见的 bug 不报错：上游给了 12 条，下游 prompt 里只剩 5 条。只有把这个数字画在线上才看得见
//   3. 哪里不对 —— 规则判定直接挂在出事的节点上（✗ 被截断 ×3），数据丢失的线变成琥珀色，
//      循环每一轮是一格，红的那一格就是出事的那一轮
//
// 从左往右是执行顺序；同一列上下叠着的是同时进行的步骤（Promise.all）。
// 数字之外的细节（源码位置、tokens、逐次瀑布）默认收起，想深究再展开。

const $ = (id) => document.getElementById(id);

let onPickCall = () => {};
let onPickStep = () => {};
let selectedStep = null;
let flow = null;
let annotations = new Map();
/** 异常栏选中某条时，只亮出相关的步骤 */
let highlight = null;
// 展开了细节的步骤 —— 重画时要保住，否则一有事件就自己合上
const expanded = new Set();
// 循环的实时状态（SSE 推来的），比 /api/flow 的快照新
const live = new Map();

export function initFlow({ pickCall, pickStep }) {
  onPickCall = pickCall;
  onPickStep = pickStep;
  // 「正在跑 · 已 2.1s」要自己走秒，不能等下一个事件
  setInterval(tickElapsed, 250);
}

export function setSelectedStep(id) {
  selectedStep = id;
  if (flow) paint();
}

/** 传 null 取消高亮 */
export function setHighlight(stepIds) {
  highlight = stepIds && stepIds.length ? new Set(stepIds) : null;
  if (flow) paint();
}

export function renderFlow(f, notes) {
  flow = f;
  if (notes) annotations = notes;
  paint();
}

/** SSE：循环跑到第几轮 / 停在哪一轮 —— 不等下一次快照就更新 */
export function noteLoopEvent(ev) {
  if (!ev.loopId) return;
  const s = live.get(ev.loopId) ?? {};
  // loop.iteration 有两个来源：闸门实时广播，以及 harness 批量上报的事件流。
  // 后者会晚到，如果让它清 paused，刚亮起的「已暂停」会被一条迟到的旧事件抹掉。
  if (ev.type === 'loop.iteration') {
    s.iteration = Math.max(s.iteration ?? 0, ev.iteration ?? 0);
    s.running = true;
  }
  if (ev.type === 'loop.paused') { s.paused = true; s.iteration = ev.iteration; }
  if (ev.type === 'loop.resumed') s.paused = false;
  if (ev.type === 'loop.exited') { s.running = false; s.reason = ev.reason; }
  if (ev.type === 'loop.override') s.override = ev.override;
  live.set(ev.loopId, s);
  if (flow) paint();
}

/** 顶部那句「它刚才干了什么」 */
export function summarize(f) {
  if (!f?.steps?.length) return null;
  const tools = f.steps.filter((s) => s.kind === 'tool');
  const llms = f.steps.filter((s) => s.kind === 'llm');
  const toolCalls = tools.reduce((n, s) => n + s.calls, 0);
  const llmCalls = llms.reduce((n, s) => n + s.calls, 0);
  const concurrent = f.steps.some((s) => s.concurrency > 1);

  const parts = [];
  if (toolCalls) parts.push(`抓了 ${toolCalls} 次数据${concurrent ? '（同时进行）' : ''}`);
  if (llmCalls) {
    const models = [...new Set(llms.map((s) => s.model).filter(Boolean))];
    parts.push(`问了模型 ${llmCalls} 次${models.length === 1 ? ` · ${models[0]}` : ''}`);
  }

  const loops = f.loops.filter((l) => l.stepIds.length);
  return {
    what: parts.join('，然后 ') || '这次运行没有对外调用',
    loops: loops.map((l) => `${loopName(l)}转了 ${l.iterations} 轮`).join('、'),
    time: fmtMs(f.totals.ms),
    tokens:
      f.totals.inputTokens + f.totals.outputTokens
        ? `${fmtNum(f.totals.inputTokens)} 进 / ${fmtNum(f.totals.outputTokens)} 出`
        : '',
    errors: f.totals.errors,
    running: f.steps.some((s) => s.running),
  };
}

// ── 渲染 ───────────────────────────────────────────────────

function paint() {
  const host = $('flow');
  if (!flow || !flow.steps.length) {
    host.innerHTML = '';
    return;
  }

  const blocks = layoutBlocks(flow.steps);

  // 画布每来一个事件就重画，正在输入的框会被冲掉 —— 先把焦点和当前值记下来
  const a = document.activeElement;
  const keep =
    a && host.contains(a) && a.classList.contains('lmax')
      ? { loop: a.closest('.loopbox')?.dataset.loop, value: a.value }
      : null;

  const parts = [];
  blocks.forEach((b, i) => {
    if (i) parts.push(edgeHtml(lastSteps(blocks[i - 1]), firstSteps(b)));
    parts.push(b.type === 'loop' ? loopBox(b) : colHtml(b.row));
  });
  host.innerHTML = `${legend()}<div class="fl-track">${parts.join('')}</div>`;

  if (keep) {
    const el = host.querySelector(`.loopbox[data-loop="${CSS.escape(keep.loop)}"] .lmax`);
    if (el) { el.value = keep.value; el.focus(); }
  }
  wire(host);
  tickElapsed();
}

/** 同一排（并发）的步骤成一列；连续落在同一个循环里的列收进一个循环框 */
function layoutBlocks(steps) {
  const rows = [];
  for (const s of [...steps].sort((a, b) => a.row - b.row || a.order - b.order)) {
    const last = rows.at(-1);
    if (last && last.row === s.row) last.steps.push(s);
    else rows.push({ row: s.row, loopId: s.loopId, steps: [s] });
  }
  const blocks = [];
  for (const r of rows) {
    const last = blocks.at(-1);
    if (r.loopId && last?.type === 'loop' && last.loopId === r.loopId) last.rows.push(r);
    else if (r.loopId) blocks.push({ type: 'loop', loopId: r.loopId, rows: [r] });
    else blocks.push({ type: 'row', row: r });
  }
  return blocks;
}

const firstSteps = (b) => (b.type === 'loop' ? b.rows[0].steps : b.row.steps);
const lastSteps = (b) => (b.type === 'loop' ? b.rows.at(-1).steps : b.row.steps);

function legend() {
  return `<div class="fl-legend">
    <span><i class="lg run"></i>正在跑</span>
    <span><i class="lg ok"></i>跑完</span>
    <span><i class="lg drop"></i>数据被丢掉</span>
    <span><i class="lg fail"></i>判定失败</span>
    <span class="dimtext">线上的数字 = 真实流过去的数据</span>
  </div>`;
}

function colHtml(r) {
  const head = r.steps.length > 1 ? `<div class="parallel">这 ${r.steps.length} 步同时进行</div>` : '';
  return `<div class="fl-col">${head}${r.steps.map(stepNode).join('')}</div>`;
}

// ── 连线：线上画真实流过的数据 ─────────────────────────────

function edgeHtml(fromSteps, toSteps) {
  const from = new Set(fromSteps.map((s) => s.id));
  const to = new Set(toSteps.map((s) => s.id));
  const es = (flow.edges ?? []).filter((e) => from.has(e.from) && to.has(e.to) && !e.back);
  const withData = es.filter((e) => e.data);
  const lit = !highlight || es.some((e) => highlight.has(e.from) && highlight.has(e.to));

  if (!withData.length) {
    return `<div class="fl-edge${lit ? '' : ' dim'}"><div class="el-top"></div><div class="el-line"></div><div class="el-bot"></div></div>`;
  }

  // 多条线汇进同一列时，挑最值得看的那条：有丢失的优先，其次数据量大的
  const e = [...withData].sort(
    (a, b) => (b.data.dropped > 0) - (a.data.dropped > 0) || b.data.last.bytes - a.data.last.bytes,
  )[0];
  const d = e.data;
  const m = d.last;
  const dropped = d.dropped > 0;

  let top = '';
  if (m.items != null && m.used != null) top = `${m.items} 条 → ${m.used} 条${m.used < m.items ? ' ✂' : ''}`;
  else if (m.items != null) top = `${m.items} 条 · ${fmtBytes(m.bytes)}`;
  else if (m.tokens) top = `${fmtNum(m.tokens)} tok`;
  else if (m.bytes) top = fmtBytes(m.bytes);

  const bits = [];
  if (m.items == null && m.coverage != null) bits.push(`进了 prompt ${Math.round(m.coverage * 100)}%`);
  else if (m.items != null && m.used != null && m.bytes) bits.push(fmtBytes(m.bytes));
  if (d.waiting) bits.push('等下游用');
  else if (dropped && d.samples > 1) bits.push(`${d.dropped}/${d.samples} 次丢失`);
  else if (d.samples > 1) bits.push(`${d.samples} 次`);
  if (m.truncated) bits.push('只读了前 256KB');

  const tip = dropped
    ? '上游的输出没有全部进到下游的 prompt 里 —— 点这条线，看出事那次下游的 prompt 缺了什么'
    : '这条线上最近一次真实流过的数据';
  return `<div class="fl-edge${dropped && !d.waiting ? ' drop' : ''}${d.waiting ? ' wait' : ''}${lit ? '' : ' dim'}" title="${esc(tip)}"
      ${d.exampleCallId ? `data-call="${esc(d.exampleCallId)}"` : ''}>
    <div class="el-top">${esc(top)}</div>
    <div class="el-line"></div>
    <div class="el-bot">${esc(bits.join(' · '))}</div>
  </div>`;
}

// ── 循环：每一轮一格 ───────────────────────────────────────

/** 「循环 @ providers.mjs:178」对用户没有意义，用文件名更贴近他脑子里的东西 */
function loopName(l) {
  const file = (l.file || '').split('/').pop() || '';
  const base = file.replace(/\.(mjs|cjs|jsx?|tsx?|py)$/, '');
  return base ? `${base} 里的循环` : '循环';
}

function loopBox(b) {
  const l = flow.loops.find((x) => x.id === b.loopId);
  const inner = () => {
    const parts = [];
    b.rows.forEach((r, i) => {
      if (i) parts.push(edgeHtml(b.rows[i - 1].steps, r.steps));
      parts.push(colHtml(r));
    });
    return `<div class="fl-track inner">${parts.join('')}</div>`;
  };
  if (!l) return inner();

  const lv = live.get(l.id) ?? {};
  const iter = Math.max(lv.iteration ?? 0, l.iterations);
  const running = lv.running ?? l.running;
  const paused = 'paused' in lv ? lv.paused : l.pausedAt != null;
  const pausedIter = lv.paused ? lv.iteration : l.pausedAt;
  const reason = lv.reason ?? l.exitReason;
  const ov = lv.override ?? l.override ?? {};
  const max = ov.maxIterations ?? l.maxOverride;

  const state = running
    ? `<b class="run">正在转 · 第 ${iter} 轮</b>`
    : `<b>转了 ${iter} 轮</b> <span class="dimtext">${exitText(reason, max)}</span>`;

  const maxBox = `<label class="lctl" title="不用改源码，直接给它设个上限">${running ? '最多转' : '下次最多转'}
      <input type="number" min="1" class="lmax" value="${max ?? ''}" placeholder="不限" /> 轮${
        max != null ? `<button class="xclr" data-lclear="${esc(l.id)}" title="取消上限">✕</button>` : ''
      }</label>`;

  // 控件只在还能起作用的时候出现。循环已经跑完了还挂着「现在就跳出」纯属误导。
  const controls = running
    ? `${maxBox}
       <button class="btn lbtn" data-lbreak="${esc(l.id)}">现在就跳出</button>
       <button class="btn lbtn" data-lmore="${esc(l.id)}" title="它本来要结束了，强行再转一轮">再转一轮</button>
       <label class="lctl"><input type="checkbox" class="lbp" ${ov.breakpoint ? 'checked' : ''}
         data-lbp="${esc(l.id)}" /> 每轮停一下</label>`
    : maxBox;

  const pausedBar = paused
    ? `<div class="lpaused">⏸ 停在第 ${pausedIter} 轮开头
         <button class="btn primary" data-lgo="${esc(l.id)}">继续</button>
         <button class="btn danger" data-lstop="${esc(l.id)}">跳出循环</button>
       </div>`
    : '';

  return `<div class="loopbox${running ? ' active' : ''}" data-loop="${esc(l.id)}">
    <div class="lhead">
      <span class="ltitle">↻ ${esc(loopName(l))}</span>
      <span class="lstate">${state}</span>
      <span class="spacer"></span>
      ${controls}
    </div>
    ${pausedBar}
    ${roundsHtml(l, iter, running, max)}
    <div class="lbody">${inner()}</div>
  </div>`;
}

/**
 * 逐轮轨道：每一轮一格，格子的颜色是这一轮的结果，柱子高度是这一轮的 prompt 大小。
 *
 * 循环的 bug 几乎都是「某一轮开始不对」或「越转越大」—— 前者看颜色，后者看柱子。
 * 上限之内还没转到的轮画成虚格：一眼看出离上限还有多远。
 */
function roundsHtml(l, iter, running, max) {
  const steps = flow.steps.filter((s) => s.loopId === l.id);
  const spans = steps.flatMap((s) => s.spans);
  const total = Math.max(iter, 1);
  const rounds = [];
  for (let i = 1; i <= total; i++) {
    const sp = spans.filter((x) => x.iteration === i);
    const size = sp.reduce((n, x) => n + (x.inTok ?? 0), 0) || sp.reduce((n, x) => n + (x.outBytes ?? 0), 0);
    const fails = [...new Set(sp.flatMap((x) => x.failing ?? []))];
    const state = sp.some((x) => x.pending) || (running && i === iter) ? 'run'
      : sp.some((x) => !x.ok) ? 'bad'
      : fails.length ? 'flag'
      : sp.length ? 'ok' : 'none';
    rounds.push({ i, sp, size, fails, state });
  }
  const top = Math.max(1, ...rounds.map((r) => r.size));
  const usesTok = spans.some((x) => x.inTok);
  const cells = rounds.map((r) => {
    const tip = [
      `第 ${r.i} 轮 · ${r.sp.length} 次调用`,
      r.size ? (usesTok ? `prompt ${fmtNum(r.size)} tok` : fmtBytes(r.size)) : '',
      r.fails.length ? `判定失败：${r.fails.map(ruleName).join('、')}` : '',
      r.sp.some((x) => !x.ok) ? '有调用失败' : '',
    ].filter(Boolean).join('\n');
    const first = r.sp[0]?.callId;
    return `<button class="rd ${r.state}" title="${esc(tip)}" ${first ? `data-call="${esc(first)}"` : ''}>
      <i style="height:${Math.round((r.size / top) * 100)}%"></i><span>${r.i}</span></button>`;
  });
  const ghosts = max && max > total
    ? Array.from({ length: Math.min(max - total, 30) }, (_, k) => `<span class="rd ghost"><i></i><span>${total + k + 1}</span></span>`)
    : [];
  const note = usesTok ? '柱高 = 这一轮的 prompt 大小' : '柱高 = 这一轮产出的数据量';
  return `<div class="lrounds"><div class="rdrow">${cells.join('')}${ghosts.join('')}</div>
    <span class="dimtext">${note}${max ? ` · 上限 ${max} 轮` : ''} · 点某一轮看那一轮</span></div>`;
}

function exitText(reason, max) {
  if (reason === 'condition') return '自己转完了';
  if (reason === 'break' || reason === 'break_boundary') return '被你叫停';
  if (reason === 'max_override') return `到了你设的 ${max ?? ''} 轮上限`;
  return '';
}

// ── 节点 ───────────────────────────────────────────────────

const RULE_NAMES = {
  'rule.truncated': '被截断',
  'rule.empty_output': '空输出',
  'rule.tool_args_invalid': '工具参数坏了',
  'rule.unknown_tool': '调了不存在的工具',
  'rule.blocked': '被拦截',
};
const ruleName = (n) => RULE_NAMES[n] ?? n;

function stepNode(s) {
  const isLLM = s.kind === 'llm';
  const open = expanded.has(s.id);
  const fails = Object.entries(s.failing ?? {});
  const running = s.running > 0;
  const cls = [
    'node', s.kind,
    running ? 'run' : '',
    s.errors ? 'err' : '',
    fails.length ? 'flag' : '',
    s.id === selectedStep ? 'sel' : '',
    highlight && !highlight.has(s.id) ? 'dim' : '',
    highlight?.has(s.id) ? 'hi' : '',
    open ? 'open' : '',
  ].filter(Boolean).join(' ');

  const kind = isLLM ? `模型${s.model ? ` · ${s.model}` : ''}` : `工具 · HTTP${s.concurrency > 1 ? ' · 并发' : ''}`;
  const done = s.spans.filter((x) => !x.pending);
  const avg = done.length ? Math.round(done.reduce((n, x) => n + x.ms, 0) / done.length) : 0;
  const state = running
    ? `<span class="nrun">● 正在跑 · 已 <b data-since="${s.runningSince ?? ''}"></b></span>`
    : s.errors
      ? `<span class="bad">✗ ${s.errors}/${s.calls} 次失败</span>`
      : `<span class="nok">✓ ${s.calls > 1 ? `${s.calls} 次 · 平均 ` : ''}${fmtMs(avg)}</span>`;

  const badges = fails.map(
    ([n, k]) => `<span class="rb" title="判定失败：${esc(n)}">✗ ${esc(ruleName(n))}${k > 1 ? ` ×${k}` : ''}</span>`,
  );
  const note = annotations.get(s.id);
  if (note?.kind === 'unexpected') {
    badges.push('<span class="rb warn" title="你写的规格里没有这一步 —— 藏着的重试？fallback？">规格里没有</span>');
  }
  if (s.conditional) badges.push(`<span class="rb dim" title="它在 if 里，不是每轮都跑">只在 ${s.iterations.length} 轮里跑</span>`);

  return `<div class="${cls}" data-step="${esc(s.id)}">
    <div class="nkind">${esc(kind)}</div>
    <div class="nname">${esc(s.label)}${s.calls > 1 ? `<span class="ncount">×${s.calls}</span>` : ''}</div>
    <div class="nstate">${state}</div>
    ${badges.length ? `<div class="nbadges">${badges.join('')}</div>` : ''}
    <div class="nio"><b>${isLLM ? '答' : '果'}</b><span>${esc(s.preview?.out || (running ? '…' : ''))}</span></div>
    <button class="smore" data-more="${esc(s.id)}">${open ? '收起 ▴' : '细节 ▾'}</button>
    ${open ? details(s) : ''}
  </div>`;
}

/** 折叠区：输入、数字、源码位置、逐次瀑布 —— 想深究的人才需要 */
function details(s) {
  const bits = [
    `<span>耗时合计 ${fmtMs(s.ms)}</span>`,
    s.kind === 'llm' && (s.inputTokens || s.outputTokens)
      ? `<span>tokens ${fmtNum(s.inputTokens)} 进 / ${fmtNum(s.outputTokens)} 出</span>`
      : '',
    s.file ? `<span class="mono">${esc(s.file.split('/').pop())}:${s.line}</span>` : '',
    s.source === 'proxy' ? '<span title="经代理接入，拿不到调用栈">代理接入，没有源码位置</span>' : '',
  ].filter(Boolean).join('');

  return `<div class="sdetail">
    <div class="nio"><b>${s.kind === 'llm' ? '问' : '求'}</b><span>${esc(s.preview?.in ?? '')}</span></div>
    <div class="dbits">${bits}</div>
    ${waterfall(s)}
  </div>`;
}

function waterfall(s) {
  const { t0, t1 } = flow.window;
  const span = Math.max(1, t1 - t0);
  if (s.spans.length < 2) return '';
  const bars = s.spans
    .map((sp) => {
      const left = ((sp.t - t0) / span) * 100;
      const w = Math.max(0.6, (Math.max(sp.ms, 1) / span) * 100);
      return `<i class="bar${sp.ok ? '' : ' bad'}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%"
                data-call="${esc(sp.callId)}" title="耗时 ${sp.ms} 毫秒"></i>`;
    })
    .join('');
  return `<div class="swfWrap"><span class="lbl">每一次</span><div class="swf">${bars}</div></div>`;
}

/** 正在跑的节点自己走秒 */
function tickElapsed() {
  const now = Date.now();
  for (const el of document.querySelectorAll('#flow [data-since]')) {
    const t = Number(el.dataset.since);
    el.textContent = t ? fmtMs(Math.max(0, now - t)) : '…';
  }
}

// ── 交互 ───────────────────────────────────────────────────

function wire(host) {
  for (const el of host.querySelectorAll('[data-more]')) {
    el.onclick = (e) => {
      e.stopPropagation();
      const id = el.dataset.more;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      paint();
    };
  }
  for (const el of host.querySelectorAll('.node')) {
    el.onclick = (e) => {
      if (e.target.closest('[data-call],[data-more]')) return;
      const id = el.dataset.step;
      selectedStep = selectedStep === id ? null : id;
      paint();
      onPickStep(selectedStep, flow.steps.find((s) => s.id === selectedStep) ?? null);
    };
  }
  for (const el of host.querySelectorAll('[data-call]')) {
    el.onclick = (e) => {
      e.stopPropagation();
      onPickCall(el.dataset.call);
    };
  }

  for (const el of host.querySelectorAll('.lmax')) {
    el.onchange = () => {
      const id = el.closest('.loopbox').dataset.loop;
      const v = el.value.trim();
      loopPost(id, { maxIterations: v === '' ? null : Number(v) });
    };
  }
  for (const el of host.querySelectorAll('[data-lclear]')) {
    el.onclick = (e) => {
      e.preventDefault();
      loopPost(el.dataset.lclear, { maxIterations: null });
    };
  }
  for (const el of host.querySelectorAll('[data-lbreak]')) {
    el.onclick = () => loopPost(el.dataset.lbreak, { breakNow: true });
  }
  for (const el of host.querySelectorAll('[data-lmore]')) {
    el.onclick = () => loopPost(el.dataset.lmore, { forceOneMore: true });
  }
  for (const el of host.querySelectorAll('[data-lbp]')) {
    el.onchange = () => loopPost(el.dataset.lbp, { breakpoint: el.checked });
  }
  for (const el of host.querySelectorAll('[data-lgo]')) {
    el.onclick = () => loopResume(el.dataset.lgo, 'continue');
  }
  for (const el of host.querySelectorAll('[data-lstop]')) {
    el.onclick = () => loopResume(el.dataset.lstop, 'break');
  }
}

async function loopPost(loopId, override) {
  const r = await fetch('/api/loops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loopId, ...override }),
  })
    .then((x) => x.json())
    .catch(() => null);
  if (r?.override) noteLoopEvent({ type: 'loop.override', loopId, override: r.override });
}

async function loopResume(loopId, action) {
  await fetch('/api/loop-resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loopId, action }),
  }).catch(() => {});
  noteLoopEvent({ type: 'loop.resumed', loopId });
}

// ── 小工具 ─────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtNum = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : (ms || 0) + 'ms');
const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : b >= 1024 ? (b / 1024).toFixed(1) + 'KB' : `${b}B`);
