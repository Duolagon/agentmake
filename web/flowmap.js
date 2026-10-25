// 详细流程图（agent 循环的「流程」）：节奏条 + 步骤流程 + 逐轮的想 / 做 / 得，可展开、可分析。
//
// 调研过的做法里各取一点（说明见 README）：
//   · 顶上的节奏条 —— Agent ATO：一格一轮，按这一轮做的事着色（读 / 执行 / 写 / 测试），阶段自己显出来；
//     失败 ▲、卡住 ⏸ 直接标在格子上；拖选一段 = 只看这一段
//   · 三档详细程度 —— Langfuse 的聚合 / 展开、TraceView 的概览 / 详细：聚合（模型 ⇄ 工具统计）、步骤（默认）、逐轮
//   · 步骤 —— agent 每做一件新事先说一句打算，用它切；标题是「要做的」，下面一行是这一步的「结果」
//   · 连线有含义 —— TraceView 的语义连线（这里规则判）：推进 / 失败或卡住之后换路 / 卡住（标时长）
//   · 想 / 做 / 得 —— TraceView 的 Thought / Action / Result
//   · 悬停预览 —— TraceView 用户研究里呼声最高：鼠标放上去就看到这一步的结果
// 一路没有异常的连续步骤默认收成一行，展开才逐步显示；有异常的单独显示。
// 选中某一轮：节奏条、步骤、时序、完整记录一起亮。数据见服务端 transcript.ts 的 buildFlowMap。

import { renderLoopMap } from './loopmap.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const CAT = {
  read: { name: '读 / 查看', short: '读' },
  exec: { name: '执行', short: '执行' },
  write: { name: '写文件', short: '写' },
  test: { name: '跑测试', short: '测试' },
  other: { name: '其他', short: '其他' },
};

let ctx = { jump: () => {}, filter: () => {}, active: () => null, selected: () => null };
let state = null; // { host, runId, m }
let mode = 'steps'; // agg | steps | rounds
let onlyTrouble = false;
const opened = new Set(); // 展开了的步骤 / 收拢组（key）
let lastSel = null; // 上一次画的时候选中的是哪一轮 —— 选中换了，就把它所在的步骤（和收拢组）展开

export function initFlowMap(c) {
  ctx = c;
}

export async function renderFlowMap(host, runId) {
  if (state?.runId !== runId) {
    opened.clear();
    onlyTrouble = false;
  }
  const m = await fetch(`/api/flowmap?runId=${encodeURIComponent(runId)}`).then((r) => r.json()).catch(() => null);
  if (!m || m.error) {
    host.innerHTML = `<div class="tm-empty">${esc(m?.error ?? '取不到流程')}</div>`;
    return;
  }
  state = { host, runId, m };
  paint();
}

/** 筛选 / 选中变了：重画高亮，不用重新取数据 */
export function repaintFlowMap() {
  if (state?.host.isConnected) paint();
}

const trouble = (s) => s.tags.some((t) => t.kind === 'fail' || t.kind === 'stall' || t.kind === 'turn' || t.kind === 'repeat');

function paint() {
  const { host, m } = state;
  const active = ctx.active();
  const sel = ctx.selected();
  if (sel && sel !== lastSel) {
    // 从时序 / 完整记录 / 节奏条选中了某一轮：流程里展开它所在的步骤，看得到它
    const s = m.steps.find((x) => x.callIds.includes(sel));
    if (s) opened.add(`s${s.n}`).add(`g${groupStart(m, s)}`);
  }
  lastSel = sel;

  host.innerHTML = `<div class="fm">
    ${headHtml(m)}
    ${active ? `<div class="lm-filterbar">只看 <b>${esc(active.label)}</b> 的 ${active.ids.size} 轮 · 时序和完整记录里已标出 <button type="button" class="lm-clear" data-clear>清掉 ✕</button></div>` : ''}
    <div class="fm-body"></div>
  </div>`;
  const body = host.querySelector('.fm-body');

  if (mode === 'agg') {
    renderLoopMap(body, state.runId);
  } else {
    body.innerHTML = flowHtml(m, active, sel);
  }
  bind(host.querySelector('.fm'), m);
}

function headHtml(m) {
  const s = m.summary;
  const total = Math.max(1, Object.values(s.mix).reduce((a, b) => a + b, 0));
  const cells = m.rounds.map((r) => {
    const cls = `fm-cell c-${r.cat ?? 'none'}${r.failed ? ' fail' : ''}${r.stalled ? ' stall' : ''}${ctx.selected() === r.callId ? ' sel' : ''}${ctx.active()?.ids.has(r.callId) ? ' hit' : ''}`;
    const tip = `第 ${r.round} 轮 · ${r.cat ? CAT[r.cat].name : '只说话'}${r.acts.length ? `\n${r.acts.map((a) => `${a.name} ${a.brief}`).join('\n')}` : ''}${r.failed ? '\n✗ 有命令失败' : ''}${r.stalled ? `\n⏸ 之后工具跑了 ${dur(r.gap)}` : ''}`;
    return `<i class="${cls}" data-cell="${esc(r.callId)}" data-i="${r.round}" title="${esc(tip)}"></i>`;
  }).join('');
  const marks = m.rounds.map((r, k) => (r.failed || r.stalled)
    ? `<span class="fm-mark ${r.stalled ? 'stall' : 'fail'}" style="left:${((k + 0.5) / m.rounds.length * 100).toFixed(2)}%" title="第 ${r.round} 轮${r.stalled ? ` 之后卡了 ${dur(r.gap)}` : ' 有命令失败'}">${r.stalled ? '⏸' : '▲'}${r.round}</span>` : '').join('');
  const legend = Object.entries(CAT).filter(([k]) => s.mix[k]).map(([k, c]) =>
    `<span class="fm-lg"><b class="c-${k}"></b>${c.name} ${s.mix[k]}</span>`).join('');
  return `<div class="fm-head">
    <div class="fm-top">
      <span class="fm-sum"><b>${s.steps}</b> 步 · ${s.rounds} 轮 · ${dur(s.ms)}${
        s.fails ? ` · <em class="bad">${s.fails} 失败</em>` : ''}${s.stalls ? ` · <em class="warn">${s.stalls} 卡住</em>` : ''}${
        s.turns ? ` · <em class="info">${s.turns} 换路</em>` : ''}${s.repeats ? ` · ${s.repeats} 重复` : ''}${s.finds ? ` · <em class="find">${s.finds} 发现</em>` : ''}</span>
      <span class="seg fm-mode">
        <button type="button" class="segbtn${mode === 'agg' ? ' on' : ''}" data-mode="agg" title="模型 ⇄ 工具的统计：整体结构">聚合</button>
        <button type="button" class="segbtn${mode === 'steps' ? ' on' : ''}" data-mode="steps" title="按 agent 说的打算切成步骤">步骤</button>
        <button type="button" class="segbtn${mode === 'rounds' ? ' on' : ''}" data-mode="rounds" title="每一轮的想 / 做 / 得全部展开">逐轮</button>
      </span>
    </div>
    <div class="fm-rib" title="一格一轮，按这一轮做的事着色；点一格跳到那一轮，拖选一段只看这段">${cells}</div>
    <div class="fm-marks">${marks}</div>
    <div class="fm-legend">${legend}${mode !== 'agg' ? `<span style="flex:1"></span><label class="fm-only"><input type="checkbox" data-only ${onlyTrouble ? 'checked' : ''}/> 只看有异常的步骤</label>` : ''}</div>
    ${m.splitBy === 'actions' ? '<div class="fm-note">这个 agent 从头到尾没说过打算，步骤是按动作类别变化和长空档切的。</div>' : ''}
  </div>`;
}

function flowHtml(m, active, sel) {
  const parts = [];
  if (m.task) parts.push(`<div class="fm-node fm-task" data-jump="${esc(m.rounds[0]?.callId ?? '')}"><div class="fm-k">任务</div><div class="fm-v">${esc(m.task)}</div></div>`);

  // 一路没有异常的连续步骤收成一组（逐轮模式、只看异常、筛选中都不收）
  const blocks = [];
  for (const s of m.steps) {
    const calm = !trouble(s) && mode === 'steps' && !active;
    const lastB = blocks.at(-1);
    if (calm && lastB?.calm) lastB.steps.push(s);
    else blocks.push({ calm, steps: [s] });
  }

  for (const b of blocks) {
    const first = b.steps[0];
    if (onlyTrouble && b.calm) continue;
    parts.push(edgeHtml(first));
    if (b.calm && b.steps.length > 1 && !opened.has(`g${first.n}`)) {
      const last = b.steps.at(-1);
      const ms = b.steps.reduce((n, s) => n + s.ms, 0);
      const mix = sumMix(b.steps);
      const finds = b.steps.filter((s) => s.tags.some((t) => t.kind === 'find' || t.kind === 'pass'));
      parts.push(`<div class="fm-node fm-group" data-open="g${first.n}" title="点开逐步显示">
        <div class="fm-h"><span class="fm-no">${first.n}–${last.n} 步</span><span class="fm-t">${esc(first.title)}</span><span class="fm-car">▸ ${b.steps.length} 步</span></div>
        ${mixHtml(mix)}
        <div class="fm-meta"><span>第 ${first.from}–${last.to} 轮 · ${dur(ms)}</span>${finds.length ? `<span class="fm-tag find">${finds.length} 步有结论</span>` : ''}<span class="dim">都顺利 · 没有失败、卡住或换路</span></div>
      </div>`);
      continue;
    }
    b.steps.forEach((s, k) => {
      if (k > 0) parts.push(edgeHtml(s));
      parts.push(stepHtml(m, s, active, sel));
    });
  }

  if (m.final) {
    parts.push(`<div class="fm-edge"><i></i></div>`);
    parts.push(`<div class="fm-node fm-final" data-jump="${esc(m.final.callId)}"><div class="fm-k">结论 · 第 ${m.final.round} 轮</div><div class="fm-v">${esc(m.final.text)}</div></div>`);
  }
  return `<div class="fm-flow">${parts.join('')}</div>`;
}

function edgeHtml(s) {
  if (s.edge === 'stall') return `<div class="fm-edge stall"><i></i><span>${esc(s.edgeNote ?? '卡住')}</span></div>`;
  if (s.edge === 'turn') return `<div class="fm-edge turn"><i></i><span>${esc(s.edgeNote ?? '换路')}</span></div>`;
  return '<div class="fm-edge"><i></i></div>';
}

/** 这一步所在的收拢组从第几步开始（组的 key 是 g + 起始步号） */
function groupStart(m, s) {
  let start = s.n;
  for (let k = s.n - 2; k >= 0 && !trouble(m.steps[k]) && !trouble(s); k--) start = m.steps[k].n;
  return start;
}

function stepHtml(m, s, active, sel) {
  const open = mode === 'rounds' || opened.has(`s${s.n}`);
  const hit = active && s.callIds.some((id) => active.ids.has(id));
  const hot = s.tags.some((t) => t.kind === 'fail' || t.kind === 'stall');
  const tags = s.tags.map((t) => `<span class="fm-tag ${t.kind}">${esc(t.text)}</span>`).join('');
  const preview = s.result ? `<div class="fm-pop">结果：${esc(s.result)}</div>` : '';
  const rounds = open ? roundsHtml(m, s, active, sel) : '';
  return `<div class="fm-node fm-step${hot ? ' hot' : ''}${open ? ' open' : ''}${active ? (hit ? ' hit' : ' dim') : ''}" data-open="s${s.n}">
    <div class="fm-h"><span class="fm-no">${s.n} 步</span><span class="fm-t">${esc(s.title)}</span><span class="fm-car">${open ? '▾' : '▸'}</span></div>
    ${mixHtml(s.mix)}
    <div class="fm-meta"><span>第 ${s.from === s.to ? s.from : `${s.from}–${s.to}`} 轮 · ${dur(s.ms)}</span>${tags}</div>
    ${s.result ? `<div class="fm-res">结果：${esc(s.result)}</div>` : ''}
    ${open ? '' : preview}
    ${rounds}
  </div>`;
}

function roundsHtml(m, s, active, sel) {
  const rs = m.rounds.filter((r) => s.callIds.includes(r.callId));
  return `<div class="fm-tar">${rs.map((r) => {
    const acts = r.acts.map((a) => `<span class="fm-act c-${a.cat}" title="${esc(`${a.name} ${a.brief}`)}">${esc(a.name)} ${esc(a.brief)}</span>`).join('');
    const got = r.got.map((g) => `<div class="fm-got${g.failed ? ' bad' : ''}" title="${esc(g.brief)}">${g.failed ? `✗ 退出码 ${g.code} · ` : ''}${esc(g.brief || '（没有输出）')}</div>`).join('');
    const cls = `fm-round${sel === r.callId ? ' sel' : ''}${active ? (active.ids.has(r.callId) ? ' hit' : ' dim') : ''}`;
    return `<div class="${cls}" data-round="${esc(r.callId)}" title="点一下：右栏完整记录跳到第 ${r.round} 轮">
      <span class="fm-rn">第 ${r.round} 轮</span>
      <div class="fm-trio">
        <div><span class="fm-k3">想</span>${r.said ? `<span class="fm-said">${esc(r.said)}</span>` : '<span class="dim">（没说话，直接动手）</span>'}</div>
        ${acts ? `<div><span class="fm-k3">做</span><span class="fm-acts">${acts}</span></div>` : ''}
        ${got ? `<div><span class="fm-k3">得</span><span class="fm-gots">${got}</span></div>` : r.pending ? '<div><span class="fm-k3">得</span><span class="dim">模型还在回答…</span></div>' : ''}
      </div>
    </div>${r.stalled ? `<div class="fm-gap">↓ 工具跑了 ${dur(r.gap)}，之后才回到模型</div>` : ''}`;
  }).join('')}</div>`;
}

function mixHtml(mix) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  if (!total) return '';
  return `<div class="fm-mix" title="${esc(Object.entries(mix).filter(([, n]) => n).map(([k, n]) => `${CAT[k].name} ${n}`).join(' · '))}">${
    Object.entries(mix).filter(([, n]) => n).map(([k, n]) => `<i class="c-${k}" style="width:${(n / total * 100).toFixed(1)}%"></i>`).join('')}</div>`;
}

function sumMix(steps) {
  const out = { read: 0, exec: 0, write: 0, test: 0, other: 0 };
  for (const s of steps) for (const k of Object.keys(out)) out[k] += s.mix[k];
  return out;
}

function bind(box, m) {
  // 节奏条：点一格跳到那一轮；按住拖选一段 → 只看这段
  const rib = box.querySelector('.fm-rib');
  let dragFrom = null;
  rib.onmousedown = (e) => {
    const c = e.target.closest('[data-cell]');
    if (!c) return;
    dragFrom = Number(c.dataset.i);
    e.preventDefault();
  };
  rib.onmouseup = (e) => {
    const c = e.target.closest('[data-cell]');
    if (dragFrom == null || !c) return (dragFrom = null);
    const to = Number(c.dataset.i);
    const [a, b] = dragFrom <= to ? [dragFrom, to] : [to, dragFrom];
    dragFrom = null;
    if (a === b) return ctx.jump(c.dataset.cell);
    const ids = new Set(m.rounds.filter((r) => r.round >= a && r.round <= b).map((r) => r.callId));
    ctx.filter({ key: `range:${a}-${b}`, label: `第 ${a}–${b} 轮`, ids });
  };
  rib.onmouseover = (e) => {
    if (dragFrom == null) return;
    const c = e.target.closest('[data-cell]');
    if (!c) return;
    const to = Number(c.dataset.i);
    const [a, b] = dragFrom <= to ? [dragFrom, to] : [to, dragFrom];
    for (const el of rib.children) el.classList.toggle('drag', Number(el.dataset.i) >= a && Number(el.dataset.i) <= b);
  };

  box.onclick = (e) => {
    if (e.target.closest('[data-clear]')) return ctx.filter(null);
    const md = e.target.closest('[data-mode]');
    if (md) { mode = md.dataset.mode; return paint(); }
    if (e.target.closest('[data-only]')) { onlyTrouble = e.target.checked; return paint(); }
    if (e.target.closest('.fm-rib')) return;
    const rd = e.target.closest('[data-round]');
    if (rd) return ctx.jump(rd.dataset.round);
    const j = e.target.closest('[data-jump]');
    if (j?.dataset.jump) return ctx.jump(j.dataset.jump);
    const o = e.target.closest('[data-open]');
    if (o && mode !== 'agg') {
      const k = o.dataset.open;
      if (opened.has(k)) opened.delete(k);
      else opened.add(k);
      // 点开一个步骤：右栏也跳到它的第一轮
      if (k.startsWith('s')) {
        const s = m.steps.find((x) => `s${x.n}` === k);
        if (s && opened.has(k)) ctx.jump(s.callIds[0], { keepFlow: true });
      }
      paint();
    }
  };
}

function dur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${Math.round(s % 60)} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
