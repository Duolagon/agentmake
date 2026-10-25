// 监视屏前端。v0 用原生 JS —— 零依赖零构建是目前的一项资产，等图复杂到需要
// 子图折叠时再考虑引入 React Flow。
//
// 设计前提（架构文档 §13）：这是一块常驻的被动监视器。
// 任何来源的运行都自动出现，用户不需要先在页面上点「开始」。

import { initGraph, renderGraph, setSelected } from './graph.js';
import { initFlow, renderFlow, setSelectedStep, setHighlight, noteLoopEvent, summarize } from './flow.js';
import { initAlerts, renderAlerts, clearAlert } from './alerts.js';
import { initTimeline, renderTimeline } from './timeline.js';
import { initCompare, loadCompare, refreshCompare } from './compare.js';
import { initVerify, loadVerify, noteRegress, progName } from './verify.js';
import { initSpec, loadSpec, flowAnnotations } from './spec.js';
import { initProjects, noteProcEvent } from './projects.js';
import { initHistory, loadHistory, renderHistory, scheduleHistory } from './history.js';
import { focusCall, initTranscript, refreshTranscript, setTranscriptFilter, showTranscript } from './transcript.js';
import { initTiming, loadTiming, markTiming, refreshTiming, setTimingFilter } from './timing.js';
import { initLoopMap, repaintLoopMap } from './loopmap.js';
import { initFlowMap, renderFlowMap, repaintFlowMap } from './flowmap.js';

const $ = (id) => document.getElementById(id);
const calls = new Map();
const runs = new Map();
let selectedCall = null;
let currentRun = null; // null = 全部
let nodeFilter = null; // 调用图上选中的函数节点
let alertFilter = null; // 异常栏选中的那条：{ title, callIds:Set }
let view = 'flow';     // flow = agent 语义流程（默认）| timing = 时序（agent 循环默认）| graph = 函数调用图
/** 视图是用户自己点的（之后不再替他自动切），还是按运行的形状自动选的 */
let viewPicked = false;
/** 循环图上点了某个工具（或它的失败）：{ key, label, ids:Set<模型调用 id> }，时序和完整记录里只亮这几轮 */
let roundFilter = null;

function setRoundFilter(f) {
  roundFilter = f;
  repaintLoopMap();
  repaintFlowMap();
  setTimingFilter(f?.ids ?? null, f?.label ?? '');
  setTranscriptFilter(f?.ids ?? null);
  // 右栏跳到第一处，马上看得到是哪几轮
  const first = f ? [...f.ids][0] : null;
  if (first) jumpToCall(first);
}
let knownProjects = [];

// ── SSE ────────────────────────────────────────────────────

let lastEventId = 0;

function connect() {
  const es = new EventSource(`/api/events?lastEventId=${lastEventId}`);
  es.onopen = () => setStatus(true);
  es.onerror = () => setStatus(false); // EventSource 自带重连
  es.onmessage = (e) => {
    if (e.lastEventId) lastEventId = Number(e.lastEventId);
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    applyEvent(ev);
  };
}

function setStatus(on) {
  const el = $('status');
  el.textContent = on ? '已连接' : '重连中…';
  el.className = 'pill ' + (on ? 'pill-on' : 'pill-off');
}

function applyEvent(ev) {
  switch (ev.type) {
    case 'run.started': {
      const parent = ev.parentRunId ?? null;
      const spawner = ev.spawnedBy ?? null;
      const groupOf = (id) => runs.get(id)?.group_id ?? id;
      runs.set(ev.runId, {
        ...(runs.get(ev.runId) ?? {}),
        run_id: ev.runId, cwd: ev.cwd, argv: ev.argv, started_at: ev.ts,
        kind: ev.kind ?? 'process', parent_run_id: parent, spawned_by: spawner,
        group_id: ev.groupId ?? (parent ? groupOf(parent) : spawner ? groupOf(spawner) : ev.runId),
        trigger: ev.trigger ?? null, replay_of: ev.replayOf ?? null,
      });
      // 新运行开始就跟过去 —— 监视屏应该显示「正在发生的事」。
      // 例外：正看着整个进程（它处理过的所有请求）时，新请求进来不要把视图跳走
      // 验证视图里也不跟：批量回归会一口气冒出一串新运行，正在看的对比不能被它们冲走
      // 被拉起的子进程也不跟（dsh 用 bash 跑的 npm test 之类）—— 除非拉起它的是个自己不调模型的
      // 包装进程（npm start → node agent.mjs），那真正要看的就是这个子进程
      const follow = spawner ? !hasOwnCalls(spawner) : !(parent && currentRun === parent);
      if (follow && view !== 'verify' && currentRun !== ev.runId) {
        currentRun = ev.runId;
        if (!selectedCall) showTranscript(currentRun); // 跟到新运行：右栏换成它的完整记录
      }
      scheduleHistory();
      renderRunPicker();
      renderList();
      scheduleGraph();
      break;
    }

    case 'run.ended': {
      scheduleHistory();
      const r = runs.get(ev.runId);
      if (r) { r.ended_at = ev.ts; if (ev.httpStatus != null) r.http_status = ev.httpStatus; renderRunPicker(); }
      break;
    }

    case 'llm.before':
      calls.set(ev.callId, {
        call_id: ev.callId, run_id: ev.runId, seq: ev.seq, kind: 'llm',
        provider: ev.request.provider, model: ev.request.model,
        system_preview: (ev.request.system || '').slice(0, 160),
        started_at: ev.ts, pending: true,
      });
      renderList(); scheduleGraph(); refreshTranscript(400); refreshTiming(400);
      break;

    case 'llm.after': {
      const row = calls.get(ev.callId);
      if (!row) break;
      Object.assign(row, {
        pending: false, ok: ev.ok ? 1 : 0, status: ev.status,
        duration_ms: ev.durationMs, error: ev.error, streaming: ev.streaming ? 1 : 0,
        response_preview: (ev.response?.text || '').slice(0, 240),
        input_tokens: ev.response?.usage?.inputTokens ?? null,
        output_tokens: ev.response?.usage?.outputTokens ?? null,
        faked: ev.faked ? 1 : 0,
        replayed: ev.replayed ? 1 : 0,
      });
      renderList(); scheduleGraph(); scheduleHistory(2500); refreshTranscript(); refreshTiming();
      if (selectedCall === ev.callId) showDetail(ev.callId);
      break;
    }

    case 'llm.patched': {
      // 断点里改过 prompt —— 列表要立刻打上标记，详情要显示实际发出去的那一份
      const row = calls.get(ev.callId);
      if (row) { row.patched = 1; row.system_preview = (ev.request.system || '').slice(0, 160); }
      renderList();
      if (selectedCall === ev.callId) showDetail(ev.callId);
      break;
    }

    case 'paused':
      onPaused(ev.callId, ev.phase ?? 'llm.before');
      break;

    case 'resumed':
      if (paused?.callId === ev.callId && paused?.phase === ev.phase) hideBreakPane();
      break;

    case 'breakpoints':
      syncBpUI(ev);
      break;

    case 'proc.log':
    case 'proc.exit':
    case 'proc.state':
    case 'projects':
      noteProcEvent(ev);
      break;

    case 'loop.iteration':
    case 'loop.paused':
    case 'loop.resumed':
    case 'loop.exited':
    case 'loop.override':
      // 循环事件不落 calls 表，直接喂给画布 —— 轮次徽章要实时跳
      noteLoopEvent(ev);
      if (ev.type !== 'loop.override') scheduleGraph();
      break;

    case 'scores': {
      // 规则判定 / AI 的 score_call 落库后推过来 —— 列表上的红标、图上的徽章都要跟着变
      const row = ev.callId && calls.get(ev.callId);
      if (row) row.failing = (ev.failing ?? []).join(',');
      renderList();
      scheduleGraph();
      if (selectedCall && selectedCall === ev.callId) showDetail(ev.callId);
      break;
    }

    case 'regress':
      noteRegress(ev);
      break;

    case 'http.body':
      // 工具响应体到了 —— 连线上的数据量和「进了 prompt 多少」要重算
      scheduleGraph();
      break;

    case 'http.call':
      calls.set(ev.callId, {
        call_id: ev.callId, run_id: ev.runId, seq: ev.seq, kind: 'http',
        provider: 'http', method: ev.method, url: ev.url,
        status: ev.status, ok: ev.ok ? 1 : 0, duration_ms: ev.durationMs,
        error: ev.error, started_at: ev.ts,
      });
      renderList(); scheduleGraph(); refreshTranscript(); refreshTiming();
      break;
  }
}

// ── 断点 ───────────────────────────────────────────────────

let paused = null;      // 当前挂起的调用（原始 IR + 阶段）
let waitTimer = null;

const BP_KEYS = ['llmBefore', 'llmAfter', 'httpBefore', 'httpAfter'];
const ROLE = { system: '系统提示词', user: '用户消息', assistant: '模型之前的回答', tool: '工具返回', developer: '开发者提示词' };
const PHASE_TITLE = {
  'llm.before': '停住了 · 这段话还没发给模型',
  'llm.after': '停住了 · 模型答完了，你的代码还没看到',
  'http.before': '停住了 · 这个请求还没发出去',
  'http.after': '停住了 · 请求回来了，你的代码还没看到',
};

// 停在断点上的人第一个念头是「我现在能干什么」—— 直接写在面板上，别让他猜
const PHASE_HELP = {
  'llm.before': '你的 agent 正卡在这里等着。改下面的内容再点「按我改的发出去」，改动会真的发给模型；或者「编个回答」直接绕过模型（不花钱）。',
  'llm.after': '模型已经答完，但你的代码还没拿到。改掉它的回答，就能看出下游遇到异常输出会怎么样。',
  'http.before': '请求还没发出去。可以「编个回答」直接伪造返回值 —— 不用真去把上游弄挂。',
  'http.after': '数据回来了但代码还没看到，可以在这里改掉它。',
};

function syncBpUI(bp) {
  for (const k of BP_KEYS) $(`bp_${k}`).checked = !!bp[k];
  $('bpOnce').checked = !!bp.once;
  if (typeof bp.urlContains === 'string' || bp.urlContains === null) {
    if (document.activeElement !== $('bpUrl')) $('bpUrl').value = bp.urlContains ?? '';
  }
  // 主按钮反映「现在会不会停」。任何一个阶段开着都算武装。
  const armed = BP_KEYS.some((k) => bp[k]);
  const btn = $('bpNext');
  btn.classList.toggle('armed', armed);
  btn.textContent = armed ? '● 已武装，下次调用会停下' : '⏸ 停在下一次模型调用';
  btn.title = armed
    ? '再点一次取消。agent 下次调模型时会被停住，你可以改 prompt、编个回答、或让它失败'
    : '点一下，agent 下次调模型时会被停住，让你改 prompt 或伪造回答';
}

async function setBreakpoints(patch) {
  const bp = await fetch('/api/breakpoints', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => r.json());
  syncBpUI(bp);
  if (!BP_KEYS.some((k) => bp[k])) hideBreakPane();
  return bp;
}

async function onPaused(callId, phase = 'llm.before') {
  const c = await fetch(`/api/calls/${encodeURIComponent(callId)}`).then((r) => r.json()).catch(() => null);
  if (!c) return;

  paused = {
    callId,
    phase,
    system: c.system ?? '',
    messages: safeParse(c.messages, []),
    model: c.model ?? '',
    params: safeParse(c.params, {}),
    respText: c.response_text ?? '',
  };

  const isReq = phase === 'llm.before';
  const isResp = phase === 'llm.after';
  const isHttp = phase.startsWith('http.');

  $('bpTitle').textContent = PHASE_TITLE[phase] ?? '已暂停';
  $('bpHelp').textContent = PHASE_HELP[phase] ?? '';
  $('bpMeta').textContent = isHttp
    ? `${c.method || 'GET'} ${shortUrl(c.url)}`
    : `${c.provider} · ${c.model || '—'}`;

  $('bpReqSide').hidden = !isReq;
  $('bpResSide').hidden = !isResp;
  $('bpHttpSide').hidden = !isHttp;
  $('bpFakeWrap').hidden = true;
  $('bpFake').value = '';
  // 「伪造响应」只在调用真正发出去之前才有意义
  $('bpFakeBtn').hidden = phase.endsWith('.after');
  // after 阶段没有「原样 vs 应用」的区别，改了就是 replace
  $('bpGo').textContent = phase.endsWith('.after') ? '按我改的交给代码' : '按我改的发出去';

  if (isReq) {
    $('bpSystem').value = paused.system;
    $('bpModel').value = paused.model;
    $('bpParams').value = JSON.stringify(paused.params, null, 2);
    $('bpMsgs').innerHTML = paused.messages
      .map((m, i) =>
        `<label class="fld" data-mi="${i}"><span>${ROLE[m.role] ?? m.role}（第 ${i + 1} 条，${m.content.length} 字）</span>
         <textarea rows="${Math.min(14, Math.max(3, Math.ceil(m.content.length / 90)))}"
                   data-msg="${i}">${esc(m.content)}</textarea>${toolsHtml(m)}</label>`)
      .join('');
  } else if (isResp) {
    $('bpRespText').value = paused.respText;
    // 工具调用这里只读展示 —— 改的是文本，工具块原样交给代码
    $('bpRespTools').innerHTML = toolsHtml({ toolCalls: safeParse(c.response_tool_calls, []) ?? [] });
  } else {
    $('bpHttpInfo').textContent = `${c.method || 'GET'} ${c.url}`;
    $('bpHttpStatus').value = String(c.status || 200);
    $('bpHttpBody').value = '';
  }

  // 标出哪些字段被改过，避免用户不确定「我到底动了什么」
  for (const el of document.querySelectorAll('#breakPane textarea, #breakPane input')) {
    el.oninput = () => el.closest('.fld')?.classList.add('changed');
  }

  $('breakPane').hidden = false;
  const t0 = Date.now();
  clearInterval(waitTimer);
  waitTimer = setInterval(() => {
    $('bpWait').textContent = `已暂停 ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 500);
}

function hideBreakPane() {
  paused = null;
  clearInterval(waitTimer);
  $('breakPane').hidden = true;
  $('bpWait').textContent = '';
}

/** 只把真正改过的字段放进补丁 —— 服务端做保守合并，未出现的键原样透传 */
function collectPatch() {
  const p = {};
  const sys = $('bpSystem').value;
  if (sys !== paused.system) p.system = sys;

  const msgs = [...document.querySelectorAll('#bpMsgs textarea')].map((t) => t.value);
  if (msgs.some((v, i) => v !== paused.messages[i]?.content)) {
    p.messages = paused.messages.map((m, i) => ({ ...m, content: msgs[i] ?? m.content }));
  }

  const model = $('bpModel').value.trim();
  if (model && model !== paused.model) p.model = model;

  try {
    const params = JSON.parse($('bpParams').value || '{}');
    if (JSON.stringify(params) !== JSON.stringify(paused.params)) p.params = params;
  } catch {
    /* 参数 JSON 写坏了就当没改，不要因此挡住放行 */
  }
  return p;
}

/** 「应用并放行」按阶段走不同的语义 */
function decisionForApply() {
  const ph = paused.phase;
  if (ph === 'llm.before') {
    const patch = collectPatch();
    return Object.keys(patch).length ? { action: 'patch', patch } : { action: 'continue' };
  }
  if (ph === 'llm.after') {
    const t = $('bpRespText').value;
    return t !== paused.respText ? { action: 'replace', text: t } : { action: 'continue' };
  }
  // http.*
  const body = $('bpHttpBody').value;
  const status = Number($('bpHttpStatus').value) || 200;
  if (ph === 'http.before') {
    return body ? { action: 'fake', status, body } : { action: 'continue' };
  }
  return body ? { action: 'replace', status, body } : { action: 'continue' };
}

async function resume(decision, armNext = false) {
  if (!paused) return;
  const { callId, phase } = paused;
  hideBreakPane();
  await fetch('/api/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callId, phase, armNext, ...decision }),
  }).catch(() => {});
}

// 图的重算比列表贵，而事件是突发密集的（并发抓取会一口气来几十条）——去抖
let graphTimer = null;
function scheduleGraph() {
  if (graphTimer) return;
  graphTimer = setTimeout(() => { graphTimer = null; loadGraph(); }, 400);
}

async function loadGraph() {
  const q = currentRun ? `?runId=${encodeURIComponent(currentRun)}` : '';
  if (view === 'flow' || view === 'timing') {
    const f = await fetch(`/api/flow${q}`).then((r) => r.json()).catch(() => null);
    if (!f) return;
    lastFlow = f;
    // agent 循环的「流程」画成循环图（模型 ⇄ 工具），不是按代码位置归并的步骤卡片 —— 见 loopmap.js
    const loopMap = isAgentLoop(f) && !!currentRun;
    // agent 循环（同一步反复调模型）默认看时序：流程图会把 103 轮并成一张「×103」的卡片，先后顺序全丢了。
    // 用户自己点过视图就不再替他切
    if (!viewPicked) {
      const want = isAgentLoop(f) ? 'timing' : 'flow';
      if (want !== view) return switchView(want, false);
    }
    if (view === 'timing') {
      renderAlerts(f.anomalies);
      renderSummary(f);
      await loadTiming(currentRun);
      return;
    }
    if (loopMap) {
      await renderFlowMap($('flow'), currentRun);
      renderAlerts(f.anomalies);
      renderSummary(f);
      return;
    }
    // 规格里没画到的实际步骤要在画布上标出来 —— 「跑了但你没画」正是最值钱的那条信息，
    // 藏在另一个标签页里等于没有。
    await loadSpec(currentRun);
    renderFlow(f, flowAnnotations());
    renderAlerts(f.anomalies);
    refreshCompare(currentRun);
    renderSummary(f);
    return;
  }
  if (view === 'spec') {
    await loadSpec(currentRun);
    return;
  }
  if (view === 'verify') {
    await loadVerify(currentRun);
    return;
  }
  const g = await fetch(`/api/graph${q}`).then((r) => r.json()).catch(() => null);
  if (!g) return;
  renderGraph(g);
}

let lastFlow = null;

/**
 * 顶部那句「它刚才干了什么」。
 *
 * 这是页面上最重要的一行。上一版把它写成 `2 步 · 1 个循环 · 1 次 LLM · 11 次工具`，
 * 等于把原始计数丢给用户，让他自己在脑子里翻译成一句话。
 */
/** 这次运行是不是 agent 循环：同一步反复调模型（dsh 那种一轮接一轮） */
const isAgentLoop = (f) => (f?.steps ?? []).some((s) => s.kind === 'llm' && s.calls >= 3);

function renderSummary(f) {
  const host = $('summary');
  const s = summarize(f);
  if (!s) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const bits = [
    `用时 ${s.time}`,
    s.tokens ? `tokens ${s.tokens}` : '',
    s.loops,
    s.errors ? `<b class="bad">${s.errors} 次失败</b>` : '',
  ].filter(Boolean);

  // 重放出来的运行：一键去和基线对比 —— 改完重跑之后最想问的就是「变好了没有」
  const replayed = currentRun && runs.get(currentRun)?.replay_of;
  // 流程 / 时序：两种看法放在最显眼的地方切，不藏进「更多」
  const pick = `<span class="seg sumview">
    <button type="button" class="segbtn${view === 'flow' ? ' on' : ''}" data-v="flow" title="按步骤看它做了什么、数据怎么流">流程</button>
    <button type="button" class="segbtn${view === 'timing' ? ' on' : ''}" data-v="timing" title="按时间一轮一行：每轮模型想了多久、两轮之间工具跑了多久">时序</button>
  </span>`;
  host.innerHTML =
    `<div class="sumtop"><div class="sumline">${esc(s.what)}${replayed ? ' <button type="button" class="btn vf-jump" id="toVerify">和基线对比 ▸</button>' : ''}</div>${pick}</div>` +
    `<div class="submeta">${bits.join(' · ')}</div>`;
  if (replayed) $('toVerify').onclick = () => switchView('verify');
  for (const b of host.querySelectorAll('.sumview [data-v]')) b.onclick = () => switchView(b.dataset.v);
}

/** 验证视图点了一步：右边显示这一步改前改后的 prompt / 输出差异 */
async function showDiff(aCall, bCall, pair) {
  selectedCall = null;
  const d = await fetch(`/api/verify/diff?a=${encodeURIComponent(aCall)}&b=${encodeURIComponent(bCall)}`).then((r) => r.json()).catch(() => null);
  const pane = $('detailPane');
  if (!d || d.error) {
    pane.innerHTML = `<div class="placeholder">${esc(d?.error ?? '取不到差异')}</div>`;
    return;
  }
  const count = (xs, op) => xs.filter((x) => x.op === op).length;
  const lines = (xs) => xs.map((x) => `<div class="df ${x.op}"><i>${x.op === 'add' ? '+' : x.op === 'del' ? '−' : ' '}</i>${esc(x.text)}</div>`).join('');
  pane.innerHTML =
    block(`${esc(pair.label)} · 改前 ⇄ 改后${pair.star ? ' <span class="vf-star">★ 注入点</span>' : ''}`,
      `<div class="df-links"><a href="#" data-call="${esc(aCall)}">看改之前这次的完整内容</a> · <a href="#" data-call="${esc(bCall)}">看改之后的</a></div>`) +
    block(`prompt 差异 <span class="count">+${count(d.prompt, 'add')} 行 · −${count(d.prompt, 'del')} 行</span>`,
      count(d.prompt, 'add') + count(d.prompt, 'del') ? `<div class="dfwrap">${lines(d.prompt)}</div>` : '<p class="dimtext">prompt 完全一样 —— 输出不同是模型采样的随机性</p>') +
    block(`输出差异 <span class="count">${count(d.output, 'add') + count(d.output, 'del') ? '' : '没变'}</span>`, `<div class="dfwrap">${lines(d.output)}</div>`);
  for (const a of pane.querySelectorAll('[data-call]')) a.onclick = (e) => { e.preventDefault(); showDetail(a.dataset.call); };
  pane.scrollTop = 0;
}

/** 流程画布上选中一步 → 下方列表只留这一步的调用 */
function applyStepFilter(stepId, step) {
  loadCompare(currentRun, stepId);
  nodeFilter = stepId;
  setSelectedStep(stepId);
  const tag = $('filterTag');
  // 步骤自带 callIds，不用再回服务端问一次
  nodeCalls = new Set(step?.callIds ?? []);
  tag.hidden = !stepId;
  if (stepId) tag.textContent = step.file ? `${step.label}:${step.line}` : step.label;
  renderList();
}

/**
 * 「怎么接进来」三选一。
 *
 * 三条路子的能力不一样，得说清楚，否则用户会以为代理接入是残缺的实现：
 * Node / Python 的 harness 能拿到调用栈和循环控制；代理接入零改动、任何语言，
 * 但看不到调用栈。
 */
function initAttach(health) {
  const py = health.pyHarnessPath ?? '<agentmake>/src/pyharness';
  const node = health.harnessPath ?? '<agentmake>/src/harness/register.ts';
  const base = health.proxyBase ?? `${location.origin}/p`;

  const RECIPES = {
    node: {
      cmd: `NODE_OPTIONS="--import ${node}" \\\n  node your-app.mjs`,
      note: '完整能力：断点、改 prompt、调用栈、循环实时控制、重放。',
    },
    python: {
      cmd: `PYTHONPATH="${py}" \\\n  python your_agent.py\n\n# 入口脚本里的循环也要实时控制时：\nPYTHONPATH="${py}" \\\n  python -m agentmake your_agent.py`,
      note: '和 Node 同等能力。httpx / requests / urllib 都拦得到，不用装包。',
    },
    other: {
      cmd: `OPENAI_BASE_URL=${base}/openai/v1  <你的启动命令>\nANTHROPIC_BASE_URL=${base}/anthropic  <你的启动命令>\nGemini base url=${base}/gemini`,
      note: '任何语言、零改动，只改环境变量。断点/改 prompt/伪造/重放都在；代价是没有调用栈，画不出函数层级。',
    },
  };

  const show = (k) => {
    $('cmd').textContent = RECIPES[k].cmd;
    $('cmdNote').textContent = RECIPES[k].note;
    for (const b of document.querySelectorAll('[data-attach]')) {
      b.classList.toggle('on', b.dataset.attach === k);
    }
  };
  for (const b of document.querySelectorAll('[data-attach]')) {
    b.onclick = () => show(b.dataset.attach);
  }
  show('node');
}

const VIEW_TITLE = { flow: 'Agent 流程 ', timing: '时序 ', spec: '规格 vs 实际 ', graph: '函数调用图 ', verify: '验证 ' };

function switchView(v, picked = true) {
  view = v;
  if (picked) viewPicked = true;
  for (const k of ['flow', 'timing', 'spec', 'graph', 'verify']) {
    $(`tab${k[0].toUpperCase()}${k.slice(1)}`).classList.toggle('on', v === k);
  }
  $('left').classList.toggle('verifyview', v === 'verify');
  $('verifyWrap').hidden = v !== 'verify';
  // 规格页是编辑界面，塞在画布那 45% 的格子里根本不够用 —— 切过去时把左栏
  // 的空间分配反过来：规格占主，调用列表退成一条。
  $('left').classList.toggle('specview', v === 'spec');
  $('flowWrap').hidden = v !== 'flow';
  $('timingWrap').hidden = v !== 'timing';
  $('left').classList.toggle('timingview', v === 'timing');
  $('specWrap').hidden = v !== 'spec';
  $('canvasWrap').hidden = v !== 'graph';
  $('fit').hidden = v !== 'graph';
  // 页面上早就没有这个标题元素了，直接取会抛错、让视图切换整个失灵
  const vt = $('viewTitle');
  if (vt?.firstChild) vt.firstChild.textContent = VIEW_TITLE[v];
  applyNodeFilter(null);
  loadGraph();
}

// ── 列表 ───────────────────────────────────────────────────

function visibleCalls() {
  let list = [...calls.values()];
  if (currentRun) list = list.filter((c) => inRun(c.run_id, currentRun));
  if (nodeFilter) list = list.filter((c) => nodeCalls.has(c.call_id));
  if (alertFilter) list = list.filter((c) => alertFilter.callIds.has(c.call_id));
  return list.sort((a, b) => a.started_at - b.started_at || a.seq - b.seq);
}

/**
 * 异常栏点了一条：图上只亮出相关步骤，调用列表筛到那几次，详情跳到最典型的那一次。
 * a = null 是取消。
 */
function onAlert(a) {
  if (!a) {
    alertFilter = null;
    setHighlight(null);
    loadCompare(null, null);
    renderList();
    return;
  }
  setHighlight(a.stepIds);
  // 对比表看出事的那一步（丢数据的话是下游那一步：它拿到的东西少了）
  loadCompare(currentRun, a.stepIds.at(-1) ?? null);
  alertFilter = a.callIds.length ? { title: a.title, callIds: new Set(a.callIds) } : null;
  if (alertFilter) $('callsBox').open = true;
  renderList();
  if (a.callIds[0]) showDetail(a.callIds.at(-1));
}

/** 切换到某次运行（运行选择器、时间线泳道都走这里） */
/**
 * 补齐一次运行的全部调用。页面打开时只拉了最近 500 次（全局），老运行、调用多的运行
 * 会缺一截 —— 流程图（服务端算）有 81 次，左边列表却是空的。选中时按 runId 单独取。
 */
async function loadRunCalls(runId) {
  if (!runId) return;
  const rows = await fetch(`/api/calls?runId=${encodeURIComponent(runId)}&limit=20000`).then((r) => r.json()).catch(() => []);
  if (!Array.isArray(rows)) return;
  for (const c of rows) calls.set(c.call_id, { ...(calls.get(c.call_id) ?? {}), ...c });
}

async function selectRun(runId) {
  if ((runId || null) !== currentRun && roundFilter) setRoundFilter(null); // 换了运行，上一次的筛选没意义了
  currentRun = runId || null;
  clearAlert();
  renderRunPicker();
  renderHistory();
  // 换了运行：右栏回到这次运行的完整记录（验证视图的右栏是改前改后对比，不动它）
  if (view !== 'verify') {
    selectedCall = null;
    showTranscript(currentRun);
  }
  await loadRunCalls(currentRun);
  await applyNodeFilter(null);
  renderList();
  loadGraph();
}

/**
 * 时间线的泳道：选中进程就是它处理过的各个请求；选中请求就把它放回兄弟请求中间看
 * （这个请求和别的请求比，慢在哪、多了什么）；没选就是最近的几次运行。
 */
function timelineData() {
  const sel = currentRun ? runs.get(currentRun) : null;
  const all = [...runs.values()];
  const kidsOf = (id) => all.filter((r) => r.parent_run_id === id);
  let lane;
  if (sel?.kind === 'request' && sel.parent_run_id) lane = kidsOf(sel.parent_run_id);
  else if (sel) {
    const kids = kidsOf(sel.run_id);
    const grouped = all.filter((r) => r.group_id === sel.run_id && r.run_id !== sel.run_id && !r.parent_run_id);
    lane = kids.length ? [sel, ...kids] : grouped.length ? [sel, ...grouped] : [sel];
  } else lane = all.filter((r) => !r.parent_run_id);

  const byRun = new Map();
  for (const c of calls.values()) {
    if (!byRun.has(c.run_id)) byRun.set(c.run_id, []);
    byRun.get(c.run_id).push(c);
  }
  const lanes = lane
    .map((r) => ({ r, calls: (byRun.get(r.run_id) ?? []).sort((a, b) => a.started_at - b.started_at) }))
    .filter((x) => x.calls.length)
    .sort((a, b) => a.r.started_at - b.r.started_at)
    .map(({ r, calls: cs }) => {
      const bad = cs.filter((c) => c.failing || c.ok === 0 || c.error).length;
      const tail = String(r.run_id).split('_').pop();
      return {
        runId: r.run_id,
        label: r.kind === 'request' ? `${tail} ${r.trigger ?? ''}` : progName(r),
        title: `${r.run_id}${r.trigger ? ` · ${r.trigger}` : ''}${r.http_status ? ` → ${r.http_status}` : ''}`,
        flag: bad ? `✗${bad}` : '',
        calls: cs,
      };
    });
  return { lanes, selectedRun: currentRun };
}

// 节点过滤由服务端算（frames 不下发到列表接口），结果缓存在这里
let nodeCalls = new Set();

async function applyNodeFilter(nodeId) {
  nodeFilter = nodeId;
  setSelected(nodeId);
  const tag = $('filterTag');
  if (!nodeId) {
    nodeCalls = new Set();
    tag.hidden = true;
  } else {
    const q = new URLSearchParams({ node: nodeId });
    if (currentRun) q.set('runId', currentRun);
    const rows = await fetch(`/api/calls?${q}`).then((r) => r.json()).catch(() => []);
    nodeCalls = new Set(rows.map((r) => r.call_id));
    tag.hidden = false;
    tag.textContent = nodeId.split('#')[1];
  }
  renderList();
}

/**
 * 没有调用时该说什么。
 *
 * 分成三句是因为它们对应三个完全不同的下一步动作，而上一版一律显示
 * 「先导入一个项目」—— 项目已经导入、甚至已经跑起来了还这么说，等于在骗人。
 */
function renderEmpty() {
  // 选中了一次运行（或者已经有探针接进来的运行）却没有调用：说这次运行的情况，
  // 不要再劝人「先导入一个项目」—— 在终端里挂探针跑的根本不需要导入
  const sel = currentRun ? runs.get(currentRun) : null;
  if (sel || (runs.size && !knownProjects.length)) {
    const ended = !!sel?.ended_at;
    $('emptyTitle').textContent = !sel ? '还没有调用' : ended ? '这次运行没有发出调用' : '这次运行还没有发出调用';
    $('emptyHint').innerHTML = !sel
      ? '在上面选一次运行看它的流程。'
      : ended
        ? `<b>${esc(progName(sel))}</b> 已经结束，全程没有调模型、也没有发 HTTP 请求。如果它只是个包装进程（npm / shell），真正干活的在它下面挂着的子进程里。`
        : `<b>${esc(progName(sel))}</b> 正在跑，它一调模型或抓数据，这里就会出现。也可以先点右上角「停在下一次模型调用」把它拦下来。`;
    $('addProject2').hidden = true;
    return;
  }
  const running = knownProjects.some((p) => p.proc?.running);
  const has = knownProjects.length > 0;
  $('emptyTitle').textContent = !has
    ? '先导入一个项目'
    : running
      ? '已经跑起来了，等它调模型或抓数据'
      : '点项目前面的 ▶ 把它跑起来';
  $('emptyHint').innerHTML = !has
    ? '选中你的工程目录，我会认出入口并加上探针 —— <b>你的代码一行都不用改</b>。'
    : running
      ? '它一发出请求，左边就会出现流程。也可以先点右上角「停在下一次模型调用」，把它拦下来改 prompt。'
      : '启动后它的每一次模型调用、每一次抓数据都会出现在这里。';
  $('addProject2').hidden = has;
}

function renderList() {
  const list = visibleCalls();
  $('empty').style.display = list.length ? 'none' : 'block';
  if (!list.length) renderEmpty();
  $('callsBox').hidden = !list.length;
  $('callsTitle').textContent = nodeFilter ? '这一步的调用' : `全部调用（${list.length}）`;

  const ul = $('calls');
  const atBottom = ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 40;
  ul.innerHTML = list.map(rowHtml).join('');
  for (const li of ul.children) li.onclick = () => jumpToCall(li.dataset.id);
  if ($('follow').checked && atBottom) ul.scrollTop = ul.scrollHeight;
  if (alertFilter) {
    $('filterTag').hidden = false;
    $('filterTag').textContent = `异常：${alertFilter.title}`;
  } else if (!nodeFilter) $('filterTag').hidden = true;
  renderTimeline();

}

function rowHtml(c) {
  const cls = c.call_id === selectedCall ? 'sel' : '';
  const isHttp = c.kind === 'http';
  // 还没收到 llm.after 就是「进行中」（可能正停在断点上），不是错误。
  // 页面在调用进行中刷新时，REST 拿到的 ok=null 曾被误判成 ERR。
  const inFlight = c.pending || (c.ok == null && !c.error);
  const meta = inFlight
    ? `<span class="pending">${paused?.callId === c.call_id ? '⏸ 停在这里' : '进行中…'}</span>`
    : c.ok
      ? `${c.duration_ms}ms${isHttp ? '' : ` · ${fmtNum(c.input_tokens)}↑${fmtNum(c.output_tokens)}↓`}${
          c.faked ? '<span class="badge">编的回答</span>' : ''}${
          c.replayed ? '<span class="badge repl">用了缓存</span>' : ''}${
          c.patched ? '<span class="badge patched">你改过</span>' : ''}${failBadges(c.failing)}`
      : `<span class="bad">${c.status ? 'HTTP ' + c.status : 'ERR'}</span>`;
  const title = isHttp ? `${c.method} ${shortUrl(c.url)}` : c.model || '—';
  const preview = c.error
    ? `<span class="bad">${esc(String(c.error).slice(0, 120))}</span>`
    : esc(isHttp ? c.url || '' : c.response_preview || c.system_preview || '');
  return `<li data-id="${esc(c.call_id)}" class="${cls}">
    <div class="row1">
      <span class="prov">${esc(isHttp ? 'http' : c.provider)}</span>
      <span class="model">${esc(title)}</span>
      <span class="meta">${meta}</span>
    </div>
    <div class="preview">${preview}</div>
  </li>`;
}

/** 和服务端的范围规则一致：选中进程 = 它自己 + 它处理过的请求；选中组 = 组里所有运行 */
function inRun(runId, sel) {
  if (runId === sel) return true;
  const r = runs.get(runId);
  return !!r && (r.parent_run_id === sel || r.group_id === sel);
}

/** 会话栏收起 / 展开，记在本机浏览器里（窄屏默认收起） */
function initRailToggle() {
  let closed = window.innerWidth < 900;
  try {
    const v = localStorage.getItem('am.railClosed');
    if (v != null) closed = v === '1';
  } catch { /* 隐私模式之类读不了，用缺省 */ }
  document.body.classList.toggle('railClosed', closed);
  $('railToggle').onclick = () => {
    const now = !document.body.classList.contains('railClosed');
    document.body.classList.toggle('railClosed', now);
    try { localStorage.setItem('am.railClosed', now ? '1' : '0'); } catch { /* 同上 */ }
  };
}

/**
 * 点了某一次调用（时间线的色块、时序的一行、调用列表的一条）：右栏在完整记录里跳到那一轮，
 * 各处一起高亮这次调用。要看原始 prompt / 请求，再点那一轮标题上的「完整 prompt ›」
 */
async function jumpToCall(callId) {
  selectedCall = callId;
  renderList();
  markTiming(callId);
  repaintFlowMap();
  if (view === 'verify') return showDetail(callId); // 验证视图的右栏是改前改后对比，不动它
  const c = calls.get(callId);
  // 这次调用属于哪次运行：在看「全部运行」时也能跳到它自己那次的记录里
  const runId = currentRun ?? c?.run_id ?? null;
  if (!(await focusCall(runId, callId))) showDetail(callId);
}

/** 这个运行（含它处理过的请求）自己有没有调用 —— 没有的就是 npm / shell 之类的包装进程 */
function hasOwnCalls(runId) {
  if (runs.get(runId)?.call_count > 0) return true; // 历史运行：服务端算好的调用数（含它处理过的请求）
  for (const c of calls.values()) {
    if (c.run_id === runId || runs.get(c.run_id)?.parent_run_id === runId) return true;
  }
  return false;
}

/** 列表里挂在谁下面：请求挂进程，子进程挂拉起它的运行；挂靠对象不在列表里就自己顶格 */
const holderOf = (r) =>
  r.parent_run_id && runs.has(r.parent_run_id) ? r.parent_run_id
  : r.spawned_by && runs.has(r.spawned_by) ? r.spawned_by
  : null;

function renderRunPicker() {
  const sel = $('runPicker');
  const all = [...runs.values()].sort((a, b) => b.started_at - a.started_at);
  // 请求级运行缩进挂在它的进程下面，被拉起的子进程挂在拉起它的运行下面 —— 不再各自顶到最上面
  const kids = new Map();
  for (const r of all) {
    const h = holderOf(r);
    if (h) kids.set(h, [...(kids.get(h) ?? []), r]);
  }
  const opts = [];
  const seen = new Set();
  const add = (r, depth) => {
    if (seen.has(r.run_id)) return; // 防环：坏数据也不能让页面卡死
    seen.add(r.run_id);
    const ks = kids.get(r.run_id) ?? [];
    const mark = depth ? `${'　'.repeat(depth)}${r.kind === 'request' ? '↳' : '⤷'} ` : '';
    opts.push(`<option value="${esc(r.run_id)}">${esc(mark + shortRun(r, ks))}</option>`);
    for (const k of ks) add(k, depth + 1);
  };
  for (const r of all) if (!holderOf(r)) add(r, 0);
  for (const r of all) add(r, 0); // 万一有环里的运行没被挂上，兜底列出来
  sel.innerHTML = `<option value="">全部运行 (${all.length})</option>` + opts.join('');
  sel.value = currentRun ?? '';
}

function shortRun(r, kids = []) {
  const t = new Date(r.started_at).toLocaleTimeString('zh-CN', { hour12: false });
  const nReq = kids.filter((k) => k.kind === 'request').length;
  const nProc = kids.length - nReq;
  const counts = [nReq ? `${nReq} 个请求` : '', nProc ? `${nProc} 个子进程` : ''].filter(Boolean).join(' · ');
  const what = r.kind === 'request'
    ? `${r.trigger || '请求'}${r.http_status ? ` → ${r.http_status}` : ''}`
    : `${progName(r)}${counts ? `（${counts}）` : ''}`;
  return `${t}  ${what}${r.replay_of ? '  · 重放' : ''}`;
}

// ── 详情：这一屏就是产品的核心价值 ─────────────────────────

async function showDetail(callId) {
  selectedCall = callId;
  markTiming(callId);
  renderList();
  const pane = $('detailPane');

  const res = await fetch(`/api/calls/${encodeURIComponent(callId)}`);
  if (!res.ok) {
    pane.innerHTML = '<div class="placeholder">这次调用还没落库，稍等…</div>';
    return;
  }
  const c = await res.json();
  const parts = [];
  // 从完整记录点进来的：一键回去，不用重新找这次运行
  if (currentRun) parts.push('<button class="btn tr-back" id="trBack">← 回到完整记录</button>');

  parts.push(`<div class="block"><h3>概览</h3><div class="kv">
    <span>类型</span><b>${esc(c.kind === 'http' ? c.method + ' 请求' : c.provider)}</b>
    ${c.kind === 'http' ? '' : `<span>model</span><b>${esc(c.model || '—')}</b>`}
    <span>状态</span><b class="${c.ok ? '' : 'bad'}">${c.ok ? 'OK' : 'HTTP ' + (c.status ?? 'ERR')}</b>
    <span>耗时</span><b>${c.duration_ms ?? '—'}ms</b>
    ${c.kind === 'http' ? '' : `<span>tokens</span><b>${fmtNum(c.input_tokens)}↑ ${fmtNum(c.output_tokens)}↓${
      c.cache_read_tokens ? ` (cache ${fmtNum(c.cache_read_tokens)})` : ''}</b>`}
  </div></div>`);

  parts.push(block('URL', `<pre>${esc(c.url)}</pre>`));
  if (c.error) parts.push(block('错误', `<pre class="bad">${esc(c.error)}</pre>`));

  // 工具返回了什么 —— 顺着数据往上游追，追到这里要能看见原始数据
  if (c.kind === 'http' && c.response_body != null) {
    const n = c.response_bytes ?? c.response_body.length;
    const items = (() => { try { const v = JSON.parse(c.response_body); return Array.isArray(v) ? v.length : null; } catch { return null; } })();
    parts.push(block(`响应体 <span class="count">${items != null ? `${items} 条 · ` : ''}${n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B'}${c.body_truncated ? ' · 只记了前 256KB' : ''}</span>`,
      `<pre>${esc(pretty(c.response_body).slice(0, 20000))}</pre>`));
  }

  // 评分放在最前面：「200 但答坏了」的理由比 prompt 本身更该先被看到
  const scores = await fetch(`/api/scores?callId=${encodeURIComponent(callId)}`).then((r) => r.json()).catch(() => []);
  if (scores.length) {
    parts.push(block(`评分 <span class="count">${scores.filter((x) => x.passed === 0).length} 项失败</span>`,
      scores.map((x) =>
        `<div class="score ${x.passed === 0 ? 'bad' : x.passed === 1 ? 'good' : ''}">` +
        `<b>${x.passed === 0 ? '✗' : x.passed === 1 ? '✓' : '·'} ${esc(scoreName(x.name))}</b>` +
        `<span class="src">${esc(SCORE_SRC[x.source] ?? x.source)}</span>` +
        `${x.value != null ? `<span class="src">值 ${esc(x.value)}</span>` : ''}` +
        `${x.label ? `<span class="src">${esc(x.label)}</span>` : ''}` +
        `${x.comment ? `<div class="why">${esc(x.comment)}</div>` : ''}</div>`).join('')));
  }

  // ★ 追查：这次的 prompt 是怎么拼出来的 —— 每一段从哪来、上游给了却没进来的是哪几条
  if (c.kind === 'llm' && c.status != null) {
    const a = await fetch(`/api/calls/${encodeURIComponent(callId)}/anatomy`).then((r) => r.json()).catch(() => null);
    if (selectedCall !== callId) return; // 等待期间又点了别的
    if (a && !a.error) parts.push(anatomyHtml(a));
  }

  if (c.kind !== 'http') {
    const messages = safeParse(c.messages, []);
    const tools = safeParse(c.tools, []);
    const params = safeParse(c.params, {});

    // ★ 这一段是整个产品存在的理由：代码里推不出来的东西
    if (c.system) {
      parts.push(block(
        `System Prompt <span class="count">${c.system.length} 字符</span>` +
        `<button class="btn wb" data-call="${esc(c.call_id)}" data-field="system">能改回源码吗？</button>`,
        `<pre>${esc(c.system)}</pre><div class="wbResult" data-for="system"></div>`));
    }
    if (messages.length) {
      parts.push(block(`Messages <span class="count">${messages.length} 条</span>`,
        messages.map((m, i) =>
          `<div class="msg"><div class="role">${esc(m.role)}${
            m.rawRole && m.rawRole !== m.role ? ` (原生: ${esc(m.rawRole)})` : ''
          } · ${m.content.length} 字符 <button class="btn wb" data-call="${esc(c.call_id)}" data-field="message:${i}">能改回源码吗？</button></div>` +
          `<pre>${esc(m.content)}</pre>${toolsHtml(m)}<div class="wbResult" data-for="message:${i}"></div></div>`).join('')));
    }
    if (tools.length) {
      parts.push(block(`Tools <span class="count">${tools.length} 个</span>`,
        `<pre>${esc(tools.map((t) => `${t.name}: ${t.description || ''}`).join('\n'))}</pre>`));
    }
    if (Object.keys(params).length) {
      parts.push(block('参数', `<pre>${esc(JSON.stringify(params, null, 2))}</pre>`));
    }
    const respCalls = safeParse(c.response_tool_calls, []) ?? [];
    if (c.response_text || respCalls.length) {
      parts.push(block(`响应 <span class="count">${c.finish_reason ? 'finish: ' + esc(c.finish_reason) : ''}</span>`,
        (c.response_text ? `<pre>${esc(c.response_text)}</pre>` : '') + toolsHtml({ toolCalls: respCalls })));
    }
    if (c.streaming && !c.response_text && !respCalls.length && c.duration_ms != null) {
      parts.push(block('注意', `<pre>流式响应没有拼出正文 —— 原始响应里是收到的全部 SSE 事件</pre>`));
    }
  }

  const frames = safeParse(c.frames, []);
  if (frames.length) {
    parts.push(block('调用路径',
      `<pre>${esc(frames.map((f, i) => '  '.repeat(i) + '└ ' + f.fn + '   ' +
        f.file.split('/').slice(-2).join('/') + ':' + f.line).join('\n'))}</pre>`));
  }

  if (c.raw_request) parts.push(block('原始请求体', `<pre>${esc(pretty(c.raw_request))}</pre>`));
  if (c.raw_response) {
    const raw = typeof c.raw_response === 'string' ? c.raw_response : JSON.stringify(c.raw_response);
    parts.push(block(`原始响应体 <span class="count">${raw.length >= 1024 ? (raw.length / 1024).toFixed(1) + 'KB' : raw.length + 'B'}</span>`,
      `<pre>${esc(prettyRaw(raw).slice(0, 200000))}</pre>`));
  }

  pane.innerHTML = parts.join('');
  $('trBack')?.addEventListener('click', () => {
    selectedCall = null;
    markTiming(null);
    renderList();
    showTranscript(currentRun);
  });
  for (const b of pane.querySelectorAll('.wb')) {
    b.onclick = () => checkWritability(b.dataset.call, b.dataset.field);
  }
  // 点一段「来自 loadHistory 第 8 条」就跳到那次工具调用 —— 顺着数据往上游追
  for (const el of pane.querySelectorAll('[data-jump]')) {
    el.onclick = () => showDetail(el.dataset.jump);
    el.title = '点一下跳到产出这段内容的那次调用';
  }
  pane.scrollTop = 0;
}

// ── 可回写性：能不能把改好的 prompt 落回源码 ───────────────

const WB_LABEL = {
  static_literal: ['✎ 可精确写回源码', 'ok'],
  static_composed: ['✎ 模板拼接：静态部分可改', 'warn'],
  runtime_computed: ['⚡ 定位不到源码 —— 但可以直接改产生它的代码', 'dim'],
  unparsable: ['? 源文件无法解析', 'dim'],
};

async function checkWritability(callId, field) {
  const host = $('detailPane').querySelector(`.wbResult[data-for="${CSS.escape(field)}"]`);
  if (!host) return;
  host.innerHTML = '<span class="dimtext">分析中…</span>';

  const r = await fetch(`/api/writability?callId=${encodeURIComponent(callId)}&field=${encodeURIComponent(field)}`)
    .then((x) => x.json()).catch(() => null);
  if (!r || r.error) { host.innerHTML = '<span class="bad">分析失败</span>'; return; }

  const [label, tone] = WB_LABEL[r.writability] ?? ['?', 'dim'];
  const head = `<div class="wbHead ${tone}">${esc(label)}</div><div class="dimtext">${esc(r.note)}</div>`;

  if (!r.segments?.length) { host.innerHTML = head; return; }

  const loc = `<div class="dimtext">${esc(r.file)}:${r.line}
    <a href="vscode://file${esc(r.file)}:${r.line}" class="link">在编辑器中打开</a></div>`;

  const editors = r.segments.map((s, i) =>
    `<label class="fld"><span>片段 ${i + 1} · 行 ${s.line}</span>
      <textarea data-seg="${i}" rows="${Math.min(12, Math.max(2, Math.ceil(s.text.length / 80)))}">${esc(s.text)}</textarea>
     </label>`).join('');

  host.innerHTML = `${head}${loc}${editors}
    <button class="btn primary wbApply">写回源码</button>
    <span class="wbMsg dimtext"></span>`;

  host.querySelector('.wbApply').onclick = async () => {
    const msg = host.querySelector('.wbMsg');
    const areas = [...host.querySelectorAll('textarea[data-seg]')];
    const edits = areas
      .map((a, i) => ({ seg: r.segments[i], text: a.value }))
      .filter((e) => e.text !== e.seg.text);

    if (!edits.length) { msg.textContent = '没有改动'; return; }

    // 几段一次交给服务端：要么全写进去要么都不动，备份也只有一份 —— 撤销才能回到原样
    const res = await fetch('/api/source/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: r.file, fileHash: r.fileHash,
        edits: edits.map((e) => ({ start: e.seg.start, end: e.seg.end, newText: e.text })),
      }),
    }).then((x) => x.json());
    if (!res.ok) { msg.innerHTML = `<span class="bad">${esc(res.error)}</span>`; return; }
    msg.innerHTML = `已写入 ${edits.length} 段 · <a href="#" class="link undo" data-b="${esc(res.backup)}">撤销</a>` +
      ` · <span class="warn">被调试进程仍在跑旧代码，需重启</span>`;
    msg.querySelector('.undo')?.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const res = await fetch('/api/source/revert', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: r.file, backup: ev.target.dataset.b }),
      }).then((x) => x.json());
      msg.textContent = res.ok ? '已撤销' : `撤销失败：${res.error}`;
    });
  };
}

const block = (title, html) => `<div class="block"><h3>${title}</h3>${html}</div>`;

/** 原始响应：JSON 就排版；流式的存的是一个 JSON 字符串（SSE 原文），解开一层显示原文 */
function prettyRaw(raw) {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return raw;
  }
}

// ── prompt 按来源拆开 ──────────────────────────────────────

const SRC = {
  template: { name: '模板', hint: '源码里写死的' },
  tool: { name: '工具结果', hint: '某次工具调用返回的' },
  llm: { name: '模型回答', hint: '前面某一步模型的回答' },
  other: { name: '运行时拼的', hint: '变量、请求体、计算结果 —— 对不上具体来源' },
};

/** [1,2,3,5,8,9] → 「1–3、5、8–9」 */
function ranges(xs) {
  const v = [...new Set(xs)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    out.push(i === j ? `${v[i]}` : `${v[i]}–${v[j]}`);
    i = j;
  }
  return out.join('、');
}

function segLabel(s) {
  if (s.source === 'template') return `模板${s.file ? ` · ${s.file.split('/').pop()}:${s.line}` : ''} · 可写回 ✎`;
  if (s.source === 'tool') return `来自 ${s.from}${s.items.length ? ` 第 ${ranges(s.items)} 条` : ''}`;
  if (s.source === 'llm') return `来自 ${s.from} 的回答`;
  return '运行时拼的（变量 / 请求体）';
}

function anatomyHtml(a) {
  const total = Object.values(a.totals).reduce((n, x) => n + x, 0) || 1;
  const bar = ['template', 'tool', 'llm', 'other']
    .filter((k) => a.totals[k])
    .map((k) => `<i class="an-${k}" style="width:${((a.totals[k] / total) * 100).toFixed(1)}%" title="${SRC[k].name} ${Math.round((a.totals[k] / total) * 100)}%"></i>`)
    .join('');
  const legend = ['template', 'tool', 'llm', 'other']
    .filter((k) => a.totals[k])
    .map((k) => `<span title="${esc(SRC[k].hint)}"><i class="an-dot an-${k}"></i>${SRC[k].name} ${Math.round((a.totals[k] / total) * 100)}%</span>`)
    .join('');

  const dropped = a.dropped.map((d) => `<div class="an-drop">
      <div class="an-drop-h">✂ 没进 prompt · ${esc(d.from)} 第 ${ranges(d.items.map((x) => x.index))} 条
        <span class="dimtext">上游给了 ${d.total} 条，只用了 ${d.used} 条</span></div>
      ${d.items.slice(0, 6).map((x) => `<div class="an-item"><b>#${x.index}</b> ${esc(x.text)}</div>`).join('')}
      ${d.items.length > 6 ? `<div class="dimtext">…还有 ${d.items.length - 6} 条</div>` : ''}
    </div>`).join('');

  const suspects = a.suspects.length ? `<div class="an-sus">
      <div class="an-sus-h">可能是这几行把数据丢掉的</div>
      ${a.suspects.map((s) => `<div class="an-sus-row">
        <a class="link mono" href="vscode://file${esc(s.file)}:${s.line}" title="在编辑器中打开">${esc(s.file.split('/').pop())}:${s.line}</a>
        <span class="rb warn">${esc(s.reason)}</span>
        <code>${esc(s.code)}</code></div>`).join('')}
    </div>` : '';

  const partsHtml = a.parts.map((p) => `<div class="an-part">
      <div class="an-role">${esc(p.key === 'system' ? 'system' : `${p.role} · 第 ${Number(p.key.split(':')[1]) + 1} 条`)}</div>
      ${p.segments.map((s) => `<div class="an-seg an-${s.source}"${s.callId ? ` data-jump="${esc(s.callId)}"` : ''}>
        <span class="an-lab">${esc(segLabel(s))}</span>
        <span class="an-txt">${esc(s.text)}${s.length > s.text.length ? '…' : ''}</span></div>`).join('')}
    </div>`).join('');

  return block(`prompt 是怎么拼出来的 <span class="count">${a.dropped.length ? `${a.dropped.length} 处数据没进来` : '按来源拆开'}</span>`,
    `<div class="an-bar">${bar}</div><div class="an-legend">${legend}</div>${dropped}${suspects}${partsHtml}`);
}

// 规则判定的显示名，和服务端 rules.ts 的 RULE_LABELS 保持一致
const RULE_LABEL = {
  'rule.truncated': '被截断',
  'rule.empty_output': '空输出',
  'rule.tool_args_invalid': '工具参数坏了',
  'rule.unknown_tool': '调了不存在的工具',
  'rule.blocked': '被拦截',
};
const SCORE_SRC = { rule: '规则', ai: 'AI 判定', human: '人工' };
const scoreName = (n) => RULE_LABEL[n] ?? n;
const failBadges = (failing) =>
  String(failing || '').split(',').filter(Boolean)
    .map((n) => `<span class="badge fail">✗ ${esc(scoreName(n))}</span>`).join('');

// 工具调用 / 结果的一行形式，和服务端 shared/tooltext.ts 保持同一种写法
const toolCallLine = (c) =>
  `${c.name || '?'}(${typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {})})` +
  (c.argsInvalid ? '  ⚠ 参数不是合法 JSON' : '');
const toolResultLine = (r) => `${r.isError ? '✗ ' : ''}${r.name ?? r.callId ?? '?'} → ${r.content}`;

/** 消息里的工具块。content 里只有 «toolUse x» 占位，真东西在这里 */
function toolsHtml(m) {
  const lines = [
    ...(m.toolCalls ?? []).map((c) => `<div class="tcall">调用 ${esc(toolCallLine(c))}</div>`),
    ...(m.toolResults ?? []).map((r) => `<div class="tres${r.isError ? ' bad' : ''}">结果 ${esc(toolResultLine(r))}</div>`),
  ];
  return lines.length ? `<div class="toolblk">${lines.join('')}</div>` : '';
}

// ── 工具函数 ───────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtNum = (n) => (n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const safeParse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s ?? ''; } };
const shortUrl = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u); } };

// ── 启动 ───────────────────────────────────────────────────

async function boot() {
  initGraph($('canvas'), applyNodeFilter);
  initFlow({ pickCall: showDetail, pickStep: applyStepFilter });
  initAlerts({ pick: onAlert });
  initTimeline({ pickCall: jumpToCall, pickRun: selectRun, data: timelineData, selected: () => selectedCall });
  initCompare({ pickCall: showDetail });
  initVerify({ showDiff, showCall: showDetail, runs: () => runs });
  initSpec({ changed: () => loadGraph() });
  initProjects({ changed: (ps) => { knownProjects = ps; renderList(); } });

  const health = await fetch('/api/health').then((r) => r.json()).catch(() => ({}));
  initAttach(health);

  // 先补历史，再接实时流
  // 运行本身很轻（一行一个），多拿一些；只拿 50 条时，常驻服务的请求级运行一多，进程和它的请求就对不上了
  const history = await fetch('/api/runs?limit=2000').then((r) => r.json());
  for (const r of history) runs.set(r.run_id, r);
  // 默认聚焦最近一次运行 —— 「全部运行」会把互不相干的进程画进同一张图，
  // 对监视屏来说没有意义。要横向对比时再手动切到全部。
  for (const c of await fetch('/api/calls').then((r) => r.json())) calls.set(c.call_id, c);
  // 默认打开最近一次真正干过活的（历史里的第一条）—— 不是最新冒出来的空进程或子进程
  initHistory({ select: selectRun, current: () => currentRun });
  currentRun = (await loadHistory())
    ?? history.find((r) => !r.spawned_by || !runs.has(r.spawned_by) || !hasOwnCalls(r.spawned_by))?.run_id
    ?? history[0]?.run_id ?? null;
  renderHistory();
  initRailToggle();
  renderRunPicker();
  initTranscript({ openCall: showDetail, current: () => currentRun });
  initTiming({ openCall: jumpToCall, current: () => currentRun, selected: () => selectedCall, clearFilter: () => setRoundFilter(null) });
  initLoopMap({ jump: jumpToCall, filter: setRoundFilter, active: () => roundFilter });
  initFlowMap({ jump: jumpToCall, filter: setRoundFilter, active: () => roundFilter, selected: () => selectedCall });
  showTranscript(currentRun); // 右栏默认就是完整记录，不再空着等人点
  await loadRunCalls(currentRun);
  renderList();
  await loadGraph();

  const bp = await fetch('/api/breakpoints').then((r) => r.json()).catch(() => ({}));
  syncBpUI(bp);
  if (bp.pending?.length) onPaused(bp.pending[0].callId, bp.pending[0].phase);

  for (const k of BP_KEYS) {
    $(`bp_${k}`).onchange = (e) => setBreakpoints({ [k]: e.target.checked });
  }
  $('bpOnce').onchange = (e) => setBreakpoints({ once: e.target.checked });
  $('bpUrl').onchange = (e) => setBreakpoints({ urlContains: e.target.value.trim() || null });

  $('bpPass').onclick = () => resume({ action: 'continue' });
  $('bpGo').onclick = () => resume(decisionForApply());
  $('bpStep').onclick = () => resume(decisionForApply(), true);
  $('bpAbort').onclick = () => resume({ action: 'abort', message: 'aborted from agentmake' });
  $('bpFakeBtn').onclick = () => {
    const w = $('bpFakeWrap');
    if (w.hidden) { w.hidden = false; $('bpFake').focus(); return; }
    resume({ action: 'fake', text: $('bpFake').value });
  };

  // 主按钮：一次点击等于「llmBefore + 只停一次」，再点一次全关。
  // 上一版要求用户先理解「请求前/响应后/工具前/工具后」四个阶段才敢动手 ——
  // 那是调试器的内部模型，不该是第一屏的门槛。
  $('bpNext').onclick = async () => {
    const bp = await fetch('/api/breakpoints').then((r) => r.json());
    const armed = BP_KEYS.some((k) => bp[k]);
    await setBreakpoints(
      armed
        ? { llmBefore: false, llmAfter: false, httpBefore: false, httpAfter: false }
        : { llmBefore: true, llmAfter: false, httpBefore: false, httpAfter: false, once: true },
    );
  };
  $('moreBtn').onclick = () => {
    const p = $('morePanel');
    p.hidden = !p.hidden;
    $('moreBtn').textContent = p.hidden ? '更多 ▾' : '更多 ▴';
  };

  $('tabFlow').onclick = () => switchView('flow');
  $('tabTiming').onclick = () => switchView('timing');
  $('tabSpec').onclick = () => switchView('spec');
  $('tabGraph').onclick = () => switchView('graph');
  $('tabVerify').onclick = () => switchView('verify');

  $('runPicker').onchange = (e) => selectRun(e.target.value);

  connect();
}

boot();
