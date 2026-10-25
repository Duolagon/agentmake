// 左侧会话栏：过去的运行，按「一次干活」列，标题是那次交给 agent 的任务。
//
// 以前只有顶上一个下拉框：一行一个 run，标签是时间 + 目录名或「POST /api/session/prompt」，
// 常驻服务、子进程、测试脚本、空进程上百条混在一起 —— 上次那一次根本找不回来。
// 这里像聊天记录那样常驻左边：按天分组、标题是任务原文、能搜能筛，点一条右边就是那次的流程。
// 一条怎么算、哪些不列，见服务端 history.ts。

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let state = { batches: [], entries: [], hiddenEmpty: 0 };
let filter = 'all'; // all | bad | live
let query = '';
let ctx = { select: () => {}, current: () => null };
let timer = null;
let inflight = null;

export function initHistory(c) {
  ctx = c;
  const rail = $('historyRail');
  rail.innerHTML = `
    <div class="hr-top">
      <input id="hrSearch" class="hr-search" type="search" placeholder="搜任务、程序、模型" autocomplete="off" />
      <div class="hr-filters" role="tablist">
        <button class="hr-f on" data-f="all">全部</button>
        <button class="hr-f" data-f="bad">有问题</button>
        <button class="hr-f" data-f="live">在跑</button>
      </div>
    </div>
    <div id="hrList" class="hr-list"></div>
    <div id="hrFoot" class="hr-foot"></div>`;
  $('hrSearch').oninput = (e) => {
    query = e.target.value;
    scheduleHistory(250);
  };
  for (const b of rail.querySelectorAll('.hr-f')) {
    b.onclick = () => {
      filter = b.dataset.f;
      for (const x of rail.querySelectorAll('.hr-f')) x.classList.toggle('on', x === b);
      renderHistory();
    };
  }
  $('hrList').onclick = (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      const id = tg.dataset.toggle;
      opened ??= new Set();
      if (opened.has(id)) opened.delete(id);
      else opened.add(id);
      return renderHistory();
    }
    const sc = e.target.closest('[data-scope]');
    if (sc) return ctx.select(sc.dataset.scope);
    const kid = e.target.closest('[data-kid]');
    if (kid) return ctx.select(kid.dataset.kid);
    const row = e.target.closest('[data-run]');
    if (row) ctx.select(row.dataset.run);
  };
  $('hrFoot').onclick = (e) => {
    if (e.target.closest('[data-all]')) ctx.select('');
  };
}

/** 拉一次最新的历史。返回最近一条（打开页面时默认选它） */
export async function loadHistory() {
  const q = query.trim();
  const my = fetch(`/api/history${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.json()).catch(() => null);
  inflight = my;
  const h = await my;
  if (inflight !== my || !h || !Array.isArray(h.entries)) return state.entries[0]?.runId ?? null;
  state = h;
  renderHistory();
  return state.entries[0]?.runId ?? null;
}

/** 实时事件来了：攒一下再刷，一轮 agent 循环里几十个事件只刷一次 */
export function scheduleHistory(ms = 1200) {
  clearTimeout(timer);
  timer = setTimeout(loadHistory, ms);
}

export function renderHistory() {
  const list = $('hrList');
  if (!list) return;
  const cur = ctx.current();
  const keep = (e) =>
    filter === 'bad' ? e.status === 'failed' || e.errors || e.failing
    : filter === 'live' ? e.status === 'running'
    : true;
  const batches = (state.batches ?? [])
    .map((b) => ({ ...b, shown: b.entries.filter(keep) }))
    .filter((b) => b.shown.length);

  if (!batches.length) {
    list.innerHTML = `<div class="hr-empty">${
      query ? '没有匹配的记录' : filter === 'live' ? '现在没有在跑的' : filter === 'bad' ? '没有出过问题的记录' : '还没有记录。挂上探针跑一次 agent，这里就会出现。'
    }</div>`;
  } else {
    // 缺省展开：最新的一批 + 正在看的那一批。搜索 / 筛选时命中的都展开，不然搜到了也看不见
    const holding = cur ? batches.find((b) => b.entries.some((e) => e.runId === cur) || b.scope === cur) : undefined;
    if (!opened) opened = new Set([batches[0].id, holding?.id].filter(Boolean));
    else if (holding && autoOpenFor !== cur) opened.add(holding.id);
    autoOpenFor = cur;
    const forceOpen = !!query.trim() || filter !== 'all';
    list.innerHTML = batches.map((b) => batchHtml(b, forceOpen || opened.has(b.id), cur)).join('');
    list.querySelector('.hr-item.on, .hb.cur > .hb-head')?.scrollIntoView({ block: 'nearest' });
  }
  const hidden = state.hiddenEmpty;
  $('hrFoot').innerHTML =
    `${hidden ? `<span>另有 ${hidden} 个没调过模型的运行没列出</span>` : ''}` +
    `<button class="hr-all${cur ? '' : ' on'}" data-all>全部运行混在一起看</button>`;
}

/** 哪几批是展开的。null = 还没决定过（第一次渲染时按缺省规则定） */
let opened = null;
let autoOpenFor;

const STATUS_TIP = { running: '正在跑', done: '完成', failed: '有失败', interrupted: '没跑完进程就停了' };
const CARET = '<svg class="hb-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function batchHtml(b, open, cur) {
  const unit = b.kind === 'service' ? '轮对话' : '次运行';
  const span = b.endedAt && b.endedAt - b.startedAt > 60_000 ? ` – ${time(b.endedAt)}` : '';
  const meta = [
    `${dayLabel(b.startedAt)} ${time(b.startedAt)}${span}`,
    b.entries.length > 1 ? `${b.entries.length} ${unit}` : '',
    `${b.llm} 次模型`,
    b.tokens ? tokens(b.tokens) : '',
  ].filter(Boolean).join(' · ');
  const isCur = !!cur && b.scope === cur;
  return `<div class="hb${open ? ' open' : ''}${isCur ? ' cur' : ''}">
    <button class="hb-head" data-toggle="${esc(b.id)}" aria-expanded="${open}">
      ${CARET}
      <span class="hr-dot ${b.status}" title="${STATUS_TIP[b.status]}"></span>
      <span class="hb-main">
        <span class="hb-title">${esc(b.title)}</span>
        <span class="hb-meta">${esc(meta)}${b.bad ? ` · <b class="hr-bad">${b.bad} 次失败</b>` : ''}</span>
      </span>
      ${b.shown.length > 1 ? `<span class="hb-count">${b.shown.length}</span>` : ''}
    </button>
    ${open ? `<div class="hb-body">
      ${b.shown.map((e) => entryHtml(e, e.runId === cur)).join('')}
      ${b.scope && b.entries.length > 1 ? `<button class="hb-scope${isCur ? ' on' : ''}" data-scope="${esc(b.scope)}">整批放在一起看</button>` : ''}
    </div>` : ''}
  </div>`;
}

function entryHtml(e, on) {
  const title = e.task || e.trigger || e.program;
  const bad = e.errors + e.failing;
  const meta = [
    time(e.startedAt),
    `${e.llm} 次模型${e.tool ? ` · ${e.tool} 次工具` : ''}`,
    e.tokens ? tokens(e.tokens) : '',
    dur(e),
  ].filter(Boolean).join(' · ');
  const kids = on && e.children.length
    ? `<div class="hr-kids">${e.children.slice(0, 30).map((k) =>
        `<button class="hr-kid" data-kid="${esc(k.runId)}">⤷ ${esc(k.program.split(' · ')[0])}<span>${k.calls ? `${k.calls} 次调用` : '没有调用'}</span></button>`).join('')}${
        e.children.length > 30 ? `<div class="hr-more">还有 ${e.children.length - 30} 个</div>` : ''}</div>`
    : '';
  return `<div class="hr-item${on ? ' on' : ''}" data-run="${esc(e.runId)}" title="${esc(e.task || '')}">
    <div class="hr-title"><span class="hr-dot ${e.status}" title="${STATUS_TIP[e.status]}"></span>${esc(title)}</div>
    <div class="hr-meta">${esc(meta)}${
      bad ? ` · <b class="hr-bad">${bad} 次失败</b>` : ''}${e.replayOf ? ' · 重放' : ''}${
      e.children.length && !on ? ` · 拉起 ${e.children.length} 个子进程` : ''}</div>
    ${kids}
  </div>`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '今天';
  if (same(d, y)) return '昨天';
  return d.getFullYear() === today.getFullYear()
    ? `${d.getMonth() + 1} 月 ${d.getDate()} 日`
    : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

const time = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

function tokens(n) {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万 tok`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function dur(e) {
  if (!e.endedAt) return '';
  const s = Math.round((e.endedAt - e.startedAt) / 1000);
  if (s < 2) return '';
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}
