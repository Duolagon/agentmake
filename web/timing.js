// 时序：一轮一行的瀑布图，所有行共用一条时间轴。
//
// 「流程」视图按步骤归并 —— dsh 的 103 轮都从同一处代码发出，被并成一张「×103」的卡片，先后顺序全丢了。
// 这里按发生顺序一轮一行：蓝条是模型在想，后面的灰条是到下一轮开始前的空档 —— 单线程的 agent 循环里，
// 那就是它在本地跑工具的时间。卡住的命令（120 秒的浏览器测试）只在这里看得见：
// 每次模型调用都正常，慢在两轮之间。超过 30 秒的空档标红。
// 旁路调用（起会话标题）和 HTTP 请求按实际发生的时间插在中间。点一行 → 右栏打开那次调用。

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 两轮之间的工具执行超过多久算「卡住」，标红 */
const SLOW_MS = 30_000;

let ctx = { openCall: () => {}, current: () => null, selected: () => null };
let shownFor = null;
let timer = null;
let loading = null;

export function initTiming(c) {
  ctx = c;
  $('timingWrap').onclick = (e) => {
    const row = e.target.closest('[data-call]');
    if (row) ctx.openCall(row.dataset.call);
  };
}

export async function loadTiming(runId) {
  const host = $('timingWrap');
  if (!runId) {
    shownFor = null;
    host.innerHTML = '<div class="tm-empty">选一次运行，这里按时间一轮一行排出来。</div>';
    return;
  }
  if (shownFor !== runId) host.innerHTML = '<div class="tm-empty">正在排时间轴…</div>';
  shownFor = runId;
  const my = fetch(`/api/timing?runId=${encodeURIComponent(runId)}`).then((r) => r.json()).catch(() => null);
  loading = my;
  const tm = await my;
  if (loading !== my || shownFor !== runId) return;
  if (!tm || tm.error) {
    host.innerHTML = `<div class="tm-empty">${esc(tm?.error ?? '取不到时序')}</div>`;
    return;
  }
  const list = host.querySelector('.tm-rows');
  const keepScroll = list ? list.scrollTop : 0;
  const atBottom = list ? list.scrollTop + list.clientHeight >= list.scrollHeight - 30 : false;
  host.innerHTML = render(tm);
  const nl = host.querySelector('.tm-rows');
  if (nl) nl.scrollTop = atBottom ? nl.scrollHeight : keepScroll;
  markTiming(ctx.selected());
  // 有调用没回来、或者工具正在执行：空档在往右长，过一会儿再排一次
  clearTimeout(timer);
  if (tm.rows.some((r) => r.pending || r.gapRunning)) timer = setTimeout(() => refreshTiming(0), 2000);
}

/** 正在看的那次运行有新调用：攒一下再排（一轮里的几个事件只排一次） */
export function refreshTiming(ms = 1500) {
  if (!shownFor || $('timingWrap').hidden) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (shownFor && ctx.current() === shownFor && !$('timingWrap').hidden) loadTiming(shownFor);
  }, ms);
}

/** 右栏打开了哪次调用，就把那一行标出来 */
export function markTiming(callId) {
  for (const el of document.querySelectorAll('#timingWrap .tm-row.sel')) el.classList.remove('sel');
  if (callId) document.querySelector(`#timingWrap .tm-row[data-call="${CSS.escape(callId)}"]`)?.classList.add('sel');
}

function render(tm) {
  const rounds = tm.rows.filter((r) => r.kind === 'round').length;
  const span = Math.max(tm.span, 1);
  const pct = (v) => `${Math.min(100, (v / span) * 100).toFixed(3)}%`;
  const width = (v) => `max(2px, ${Math.min(100, (v / span) * 100).toFixed(3)}%)`;
  const slow = tm.rows.filter((r) => (r.gap ?? 0) >= SLOW_MS).length;

  const head = `<div class="tm-head">
    <span class="tm-sum">${rounds} 轮 · 全程 ${dur(tm.span)} · 模型在想 ${dur(tm.modelMs)} · 工具在跑 ${dur(tm.toolMs)}${
      slow ? ` · <b class="tm-slowtxt">${slow} 处工具超过 ${SLOW_MS / 1000} 秒</b>` : ''}</span>
    <span class="tm-legend"><span><i class="tm-m"></i>模型</span><span><i class="tm-g"></i>工具执行</span><span><i class="tm-g slow"></i>超过 ${SLOW_MS / 1000} 秒</span></span>
  </div>`;

  const ticks = [0, 0.5, 1].map((f) =>
    `<span style="left:${(f * 100).toFixed(0)}%">${dur(span * f)}</span>`).join('');
  const axis = `<div class="tm-row tm-axisrow"><span></span><span></span><span class="tm-axis">${ticks}</span><span></span></div>`;

  const rows = tm.rows.map((r) => {
    const end = r.start + (r.ms ?? 0);
    const gapCls = `tm-g${(r.gap ?? 0) >= SLOW_MS ? ' slow' : ''}${r.gapRunning ? ' run' : ''}`;
    const bars = [
      `<i class="${r.kind === 'round' ? 'tm-m' : r.kind === 'side' ? 'tm-s' : 'tm-h'}${r.pending ? ' run' : ''}${r.error ? ' bad' : ''}" style="left:${pct(r.start)};width:${width(r.ms ?? 0)}"></i>`,
      r.gap ? `<i class="${gapCls}" style="left:${pct(end)};width:${width(r.gap)}"></i>` : '',
    ].join('');
    const num = r.kind === 'round' ? r.round : r.kind === 'side' ? '旁路' : 'HTTP';
    const tip = [
      r.kind === 'round' ? `第 ${r.round} 轮` : r.kind === 'side' ? `旁路 · ${r.label}` : r.label,
      `开始 +${dur(r.start)}`,
      r.pending ? '模型还在回答' : `模型 ${dur(r.ms ?? 0)}`,
      r.gap != null ? `${r.gapRunning ? '工具正在执行，已 ' : '之后工具执行 '}${dur(r.gap)}` : '',
      ...r.tools.map((t) => `→ ${t}`),
      r.text ? `\n${r.text}` : '',
      r.error ? `✗ ${r.error}` : '',
    ].filter(Boolean).join('\n');
    const gapTxt = r.gap != null && (r.gap >= 1000 || r.gapRunning)
      ? `<b class="${(r.gap ?? 0) >= SLOW_MS ? 'slow' : ''}">+${short(r.gap)}${r.gapRunning ? '…' : ''}</b>` : '';
    return `<div class="tm-row tm-${r.kind}${r.error ? ' bad' : ''}" data-call="${esc(r.callId)}" title="${esc(tip)}">
      <span class="tm-n">${num}</span>
      <span class="tm-label">${esc(r.label)}</span>
      <span class="tm-track">${bars}</span>
      <span class="tm-dur">${r.pending ? '…' : short(r.ms ?? 0)}${gapTxt}</span>
    </div>`;
  }).join('');

  return `${head}<div class="tm-rows">${axis}${rows || '<div class="tm-empty">这次运行还没有调用</div>'}</div>`;
}

function dur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${Math.round(s % 60)} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 每行右边那一列放不下「2 分 0 秒」—— 用短写法 */
function short(ms) {
  if (ms < 60_000) return dur(ms);
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
