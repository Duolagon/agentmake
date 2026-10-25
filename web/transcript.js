// 右栏默认显示的「完整记录」：这次运行从头到尾说了什么、做了什么。
//
// 以前右栏在点某一步之前一直是空的（「点左边任意一步」），全部调用又折在中间栏最底下 ——
// 打开页面只看得到「需要你看的」，像是没有完整数据。这里按对话铺开：
//   任务 → 第 1 轮模型回答（它发起的工具调用）→ 工具结果 → 第 2 轮回答 → ……
// 旁路调用（起会话标题之类）和普通 HTTP 请求按时间插在中间，一行带过。
// 点任意一轮 → 那次调用的完整 prompt、原始请求 / 响应（原来的详情页），可以返回。
// 还原规则（只显示每轮新增的部分）见服务端 transcript.ts。

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let ctx = { openCall: () => {}, current: () => null };
let shownFor = null; // 现在显示的是哪次运行的记录
let timer = null;
let loading = null;

export function initTranscript(c) {
  ctx = c;
}

/** 右栏现在是不是在显示完整记录（不是某次调用的详情、不是验证对比） */
export const transcriptShown = () => !!$('detailPane')?.querySelector('.tr');

/** 显示一次运行的完整记录。runId 为空（「全部运行」）时给一句提示 */
export async function showTranscript(runId) {
  const pane = $('detailPane');
  if (shownFor !== runId) focused = null;
  if (!runId) {
    shownFor = null;
    pane.innerHTML = `<div class="placeholder"><p class="bigline">选一次运行看它的完整记录</p>
      <p>左边历史里点一条，这里会按对话顺序铺开：任务、每一轮模型的回答、它调了哪些工具、拿到了什么。</p></div>`;
    return;
  }
  const first = shownFor !== runId || !transcriptShown();
  shownFor = runId;
  if (first) pane.innerHTML = '<div class="tr"><div class="tr-loading">正在整理这次运行的完整记录…</div></div>';
  const my = fetch(`/api/transcript?runId=${encodeURIComponent(runId)}`).then((r) => r.json()).catch(() => null);
  loading = my;
  const t = await my;
  if (loading !== my || shownFor !== runId || !transcriptShown()) return; // 期间换了运行或点开了详情
  const box = pane.querySelector('.tr');
  // 已经在底部就跟着新内容走；用户往上翻着看的时候不打扰他
  const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 60;
  const open = new Set([...box.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k));
  box.innerHTML = t && !t.error ? render(t) : `<div class="tr-loading">${esc(t?.error ?? '取不到记录')}</div>`;
  for (const d of box.querySelectorAll('details[data-k]')) if (open.has(d.dataset.k)) d.open = true;
  if (focused) box.querySelector(`[data-call="${CSS.escape(focused)}"]`)?.closest('.tr-round')?.classList.add('cur');
  box.onclick = (e) => {
    const go = e.target.closest('[data-call]');
    if (go && !e.target.closest('summary, details > :not(summary)')) ctx.openCall(go.dataset.call);
  };
  if (first) pane.scrollTop = 0;
  else if (atBottom) pane.scrollTop = pane.scrollHeight;
}

/**
 * 跳到某一次调用：右栏留在完整记录里，滚到那一轮并高亮 —— 能看到它的输入、回答、工具和前后几轮。
 * 以前是整栏换成那次调用的原始详情：每次调用的详情开头都长一样，看不出跳到了哪，前后文也没了。
 * 记录里找不到这次调用（比如在看「全部运行」）就返回 false，由调用方退回原始详情。
 */
export async function focusCall(runId, callId) {
  if (!runId) return false;
  if (shownFor !== runId || !transcriptShown()) await showTranscript(runId);
  const pane = $('detailPane');
  const hit = pane.querySelector(`.tr [data-call="${CSS.escape(callId)}"]`);
  if (!hit) return false;
  const box = hit.closest('.tr-round') ?? hit;
  for (const el of pane.querySelectorAll('.tr .cur')) el.classList.remove('cur');
  box.classList.add('cur');
  // 工具结果默认只露前 4 行 —— 跳过来就是要看它，全部展开
  for (const d of box.querySelectorAll('.tr-result details')) d.open = true;
  box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  box.classList.remove('flash');
  void box.offsetWidth; // 重新触发动画
  box.classList.add('flash');
  focused = callId;
  return true;
}

/** 现在高亮着的那次调用（重新整理记录后要保持高亮） */
let focused = null;

/** 实时事件来了：正在看的那次运行有新调用就重新整理（攒一下，一轮里的几个事件只刷一次） */
export function refreshTranscript(ms = 1500) {
  if (!shownFor || !transcriptShown()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (shownFor && transcriptShown() && ctx.current() === shownFor) showTranscript(shownFor);
  }, ms);
}

function render(t) {
  const head = `<div class="tr-head">
    <span class="tr-h">完整记录</span>
    <span class="tr-sub">${t.llm} 次模型调用${t.tool ? ` · ${t.tool} 次工具 / HTTP` : ''} · 点任意一轮看完整 prompt 和原始请求</span>
  </div>`;
  const task = t.task ? `<div class="tr-task">
    <div class="tr-who">任务</div>
    <div class="tr-text">${esc(t.task.text)}${t.task.truncated ? '…' : ''}</div>
    ${ctxHtml(t.task, 'task')}
  </div>` : '';
  const items = t.items.map(itemHtml).join('');
  return head + task + (items || '<div class="tr-loading">这次运行还没有调用</div>');
}

function itemHtml(it, i) {
  if (it.kind === 'run') {
    return `<div class="tr-run">${esc(it.trigger || '请求')} · ${time(it.t)}</div>`;
  }
  if (it.kind === 'http') {
    return `<div class="tr-http${it.ok ? '' : ' bad'}" data-call="${esc(it.callId)}" title="点开看完整响应">
      <span class="tr-tag">HTTP</span><span class="tr-url">${esc(it.method)} ${esc(shortUrl(it.url))}</span>
      <span class="tr-num">${it.status ?? '—'}${it.bytes != null ? ` · ${size(it.bytes)}` : ''}${it.ms != null ? ` · ${ms(it.ms)}` : ''}</span>
    </div>`;
  }
  if (it.side) {
    const out = it.reply?.text || (it.reply?.toolCalls ?? []).map((c) => c.name).join('、') || (it.pending ? '…' : '');
    return `<div class="tr-side" data-call="${esc(it.callId)}" title="另一个对话里的调用 · 点开看完整内容">
      <span class="tr-tag">旁路</span><span class="tr-thread">${esc(it.thread)}</span>
      <span class="tr-arrow">→</span><span class="tr-sideout">${esc(out)}</span>
      <span class="tr-num">${it.ms != null ? ms(it.ms) : ''}</span>
    </div>`;
  }

  const meta = [
    it.model,
    it.pending ? '进行中' : it.ms != null ? ms(it.ms) : '',
    it.tokensIn != null ? `${num(it.tokensIn)}↑ ${num(it.tokensOut)}↓${it.cache ? ` · 缓存 ${num(it.cache)}` : ''}` : '',
  ].filter(Boolean).join(' · ');
  const input = it.input.map((m, j) => msgHtml(m, `${i}.${j}`)).join('');
  const reply = it.pending
    ? '<div class="tr-reply pending"><span class="tr-spin"></span>模型正在回答…</div>'
    : it.reply ? replyHtml(it.reply, i) : it.error ? '' : '<div class="tr-reply dim">（没有回答）</div>';
  return `<div class="tr-round${it.error ? ' bad' : ''}">
    <div class="tr-rh" data-call="${esc(it.callId)}" title="点开看这一轮完整的 prompt、原始请求和响应">
      <span class="tr-rn">第 ${it.round} 轮</span>${it.restart ? '<span class="tr-flag">上下文被重写</span>' : ''}
      <span class="tr-meta">${esc(meta)}</span><span class="tr-more">完整 prompt ›</span>
    </div>
    ${input}
    ${it.error ? `<div class="tr-err">✗ ${esc(it.error)}</div>` : ''}
    ${reply}
  </div>`;
}

function msgHtml(m, k) {
  const parts = [];
  for (const [n, r] of (m.toolResults ?? []).entries()) {
    const lines = r.text.split('\n');
    const head = lines.slice(0, 4).join('\n');
    const more = lines.length > 4 || r.truncated;
    parts.push(`<div class="tr-result${r.isError ? ' bad' : ''}">
      <div class="tr-who">工具结果 · ${esc(r.name)}${r.isError ? ' · 出错' : ''}</div>
      ${more
        ? `<details data-k="r${k}.${n}"><summary><pre>${esc(head)}</pre><span class="tr-expand">展开全部 ${lines.length} 行${r.truncated ? '（只带了前一段，完整的点「完整 prompt」）' : ''}</span></summary><pre>${esc(r.text)}</pre></details>`
        : `<pre>${esc(r.text)}</pre>`}
    </div>`);
  }
  if (m.text) {
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '模型' : m.role === 'system' ? '系统' : m.role;
    parts.push(`<div class="tr-msg ${esc(m.role)}"><div class="tr-who">${who}</div><div class="tr-text">${esc(m.text)}${m.truncated ? '…' : ''}</div>${ctxHtml(m, k)}</div>`);
  }
  for (const c of m.toolCalls ?? []) parts.push(callHtml(c, `m${k}`));
  return parts.join('');
}

function replyHtml(r, i) {
  return `<div class="tr-reply">
    <div class="tr-who">模型</div>
    ${r.text ? `<div class="tr-text">${esc(r.text)}${r.truncated ? '…' : ''}</div>` : ''}
    ${(r.toolCalls ?? []).map((c, j) => callHtml(c, `c${i}.${j}`)).join('')}
  </div>`;
}

/** 工具调用：一行看出调了什么、参数开头是什么；点开看完整参数 */
function callHtml(c, k) {
  const brief = argBrief(c.args);
  return `<details class="tr-call" data-k="${k}"><summary><span class="tr-fn">${esc(c.name)}</span><span class="tr-args">${esc(brief)}</span></summary><pre>${esc(prettyArgs(c.args))}</pre></details>`;
}

function ctxHtml(m, k) {
  return m.context
    ? `<details class="tr-ctx" data-k="x${k}"><summary>附带的运行时上下文 · ${m.context.length} 字</summary><pre>${esc(m.context)}</pre></details>`
    : '';
}

/** 参数的一句话摘要：常见的 command / path / query 直接取值，其余取紧凑 JSON 的开头 */
function argBrief(args) {
  try {
    const o = JSON.parse(args);
    if (o && typeof o === 'object') {
      for (const k of ['command', 'cmd', 'path', 'file_path', 'query', 'q', 'url', 'pattern', 'description']) {
        if (typeof o[k] === 'string') return o[k].replace(/\s+/g, ' ').slice(0, 140);
      }
    }
  } catch { /* 不是 JSON 就按原文 */ }
  return String(args).replace(/\s+/g, ' ').slice(0, 140);
}

function prettyArgs(args) {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return String(args);
  }
}

const time = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '');
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s` : `${n}ms`);
const num = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const size = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

function shortUrl(u) {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u;
  }
}
