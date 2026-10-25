// 按请求分泳道的实时时间线。
//
// 流程图回答「它做了什么」，时间线回答「什么时候、和谁同时」：
//   - 常驻服务一次处理好几个请求，每个请求一条泳道，并发一眼可见
//   - 正在跑的调用一直往右长到「现在」那条线，卡住的调用会越拉越长 —— 不用看数字就知道哪个卡了
//   - 失败是红的，判定失败（规则 / AI）是琥珀色并在上方打 ▲，重放命中画成空心
//
// 数据直接用页面已有的 calls / runs，不额外请求；有调用在跑时每 250ms 重画一次。

let onPickCall = () => {};
let onPickRun = () => {};
let source = () => ({ lanes: [], selectedRun: null });
let selected = () => null;

const MAX_LANES = 8;
/** 有调用在跑时只看最近这么久 —— 不然一个 90 秒前的旧请求会把正在跑的这一条压成一根细线 */
const LIVE_WINDOW_MS = 30_000;

export function initTimeline({ pickCall, pickRun, data, selected: sel }) {
  onPickCall = pickCall;
  if (sel) selected = sel;
  onPickRun = pickRun;
  source = data;
  setInterval(() => {
    if (anyPending) paint();
  }, 250);
}

let anyPending = false;

export function renderTimeline() {
  paint();
}

function paint() {
  const host = document.getElementById('timeline');
  if (!host) return;
  const { lanes, selectedRun } = source();
  const now = Date.now();
  const endOf = (c) => (isPending(c) ? now : c.started_at + (c.duration_ms ?? 0));
  anyPending = lanes.some((l) => l.calls.some(isPending));
  // 实时：只留最近 30 秒里有动静的泳道（选中的那条总留着）
  const recent = anyPending
    ? lanes.filter((l) => l.runId === selectedRun || l.calls.some((c) => endOf(c) >= now - LIVE_WINDOW_MS))
    : lanes;
  const shown = recent.slice(-MAX_LANES);
  if (!shown.length || !shown.some((l) => l.calls.length)) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const starts = shown.flatMap((l) => l.calls.map((c) => c.started_at)).filter(Boolean);
  const ends = shown.flatMap((l) => l.calls.map(endOf));
  const t0 = anyPending ? Math.max(Math.min(...starts), now - LIVE_WINDOW_MS) : Math.min(...starts);
  const t1 = Math.max(anyPending ? now : 0, ...ends, t0 + 1000);
  const span = t1 - t0;
  const pos = (t) => `${(((t - t0) / span) * 100).toFixed(2)}%`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const t = t0 + f * span;
    const label = anyPending
      ? (f === 1 ? '现在' : `-${fmtS(t1 - t)}`)
      : fmtS(t - t0);
    return `<span style="left:${(f * 100).toFixed(1)}%"${f === 1 && anyPending ? ' class="now"' : ''}>${label}</span>`;
  }).join('');

  const rows = shown.map((l) => {
    const segs = l.calls.filter((c) => endOf(c) >= t0).map((c) => {
      const end = Math.max(endOf(c), c.started_at + 1);
      const from = Math.max(c.started_at, t0);
      const w = Math.max(0.4, ((end - from) / span) * 100);
      const cls = [
        'tlseg', c.kind === 'llm' ? 'llm' : 'tool',
        isPending(c) ? 'run' : '',
        c.ok === 0 || c.error ? 'bad' : '',
        c.failing ? 'flag' : '',
        c.replayed ? 'repl' : '',
        c.call_id === selected() ? 'sel' : '',
      ].filter(Boolean).join(' ');
      const tip = [
        c.kind === 'llm' ? `${c.model || '模型'}` : `${c.method || 'GET'} ${shortUrl(c.url)}`,
        isPending(c) ? `正在跑 · 已 ${fmtS(now - c.started_at)}` : `${c.duration_ms ?? 0}ms`,
        c.failing ? `判定失败：${c.failing}` : '',
        c.replayed ? '重放缓存，没真打模型' : '',
        c.error ? `错误：${c.error}` : '',
      ].filter(Boolean).join('\n');
      const mark = c.failing ? `<i class="mk" style="left:${pos(from)}">▲</i>` : '';
      return `<button type="button" class="${cls}" style="left:${pos(from)};width:${w.toFixed(2)}%"
        data-call="${esc(c.call_id)}" title="${esc(tip)}"></button>${mark}`;
    }).join('');
    const live = l.calls.some(isPending);
    return `<div class="tl-row${l.runId === selectedRun ? ' sel' : ''}">
      <button type="button" class="tl-lab" data-run="${esc(l.runId)}" title="${esc(l.title)}">
        <span>${esc(l.label)}</span>${live ? '<i class="tl-live">●</i>' : l.flag ? `<i class="tl-flag">${esc(l.flag)}</i>` : ''}
      </button>
      <div class="tl-track">${segs}${anyPending ? '<i class="tl-now"></i>' : ''}</div>
    </div>`;
  }).join('');

  const more = lanes.length > MAX_LANES ? `<span class="dimtext">只显示最近 ${MAX_LANES} 个，共 ${lanes.length} 个</span>` : '';
  host.innerHTML = `<div class="tl-head"><b>时间线</b><span class="dimtext">${
    shown.length > 1 ? '每个请求一条泳道' : '这次运行'} · ▲ 判定失败 · 空心 = 用了缓存</span>${more}</div>
    <div class="tl-ticks">${ticks}</div>${rows}`;

  for (const el of host.querySelectorAll('[data-call]')) el.onclick = () => onPickCall(el.dataset.call);
  for (const el of host.querySelectorAll('[data-run]')) el.onclick = () => onPickRun(el.dataset.run);
}

const isPending = (c) => c.pending || (c.ok == null && !c.error && c.duration_ms == null);
const fmtS = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const shortUrl = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u ?? ''); } };
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
