// 规格（意图图）编辑 + 「意图 vs 实际」对账面板。
//
// 流程画布回答「它实际怎么跑」，这一屏回答「你以为它怎么跑」，以及两者差在哪。
//
// 交互上有一个刻意的取舍：**先跑一次，再改规格**。让用户从零画一张图门槛太高，
// 所以第一个按钮是「按实际运行生成草稿」—— 把真实结构变成起点，用户只需要在上面
// 改意图、加还没实现的步骤。零差异是起点，不是终点。

const $ = (id) => document.getElementById(id);

let spec = null;
let diff = null;
let dirty = false;
let onChanged = () => {};

export function initSpec({ changed }) {
  onChanged = changed ?? (() => {});
  $('specDraft').onclick = draftFromRun;
  $('specSave').onclick = save;
  $('specAdd').onclick = () => {
    spec.steps.push({
      id: `step_${Date.now().toString(36)}`,
      kind: 'llm',
      label: '新步骤',
      intent: '',
      after: [],
    });
    markDirty();
    render();
  };
  $('specGoal').oninput = (e) => {
    spec.goal = e.target.value;
    markDirty();
  };
}

/** 页面切到规格页、或者跑完一次新的运行时调 */
export async function loadSpec(runId) {
  const q = new URLSearchParams({ name: 'agent' });
  if (runId) q.set('runId', runId);
  const d = await fetch(`/api/spec/diff?${q}`).then((r) => r.json()).catch(() => null);
  if (!d) return;
  // 用户正在编辑没保存的内容不能被后台刷新冲掉
  if (!dirty) spec = d.spec;
  diff = d;
  render();
}

/** 流程画布要知道哪些实际步骤「跑了但没画」 */
export function flowAnnotations() {
  const out = new Map();
  for (const f of diff?.findings ?? []) {
    if (f.flowStepId) out.set(f.flowStepId, f);
  }
  return out;
}

function markDirty() {
  dirty = true;
  $('specSave').classList.add('dirty');
  $('specSave').textContent = '保存规格 ●';
}

async function save() {
  const saved = await fetch('/api/spec', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'agent', goal: spec.goal ?? '', steps: spec.steps }),
  }).then((r) => r.json());
  spec = saved;
  dirty = false;
  $('specSave').classList.remove('dirty');
  $('specSave').textContent = '保存规格';
  await loadSpec();
  onChanged();
}

async function draftFromRun() {
  if (spec?.steps?.length && !confirm('会用这次实际运行的结构覆盖当前规格，继续？')) return;
  const d = await fetch('/api/spec/from-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'agent' }),
  }).then((r) => r.json());
  if (d.error) { alert(d.error); return; }
  spec = d;
  dirty = false;
  await loadSpec();
  onChanged();
}

// ── 渲染 ───────────────────────────────────────────────────

const LEVEL_ICON = { blocker: '✗', warn: '!', info: '·' };
const KINDS = [['llm', 'LLM'], ['tool', '工具'], ['loop', '循环']];

function render() {
  if (!spec) return;
  $('specGoal').value = spec.goal ?? '';
  renderDiff();
  renderSteps();
}

function renderDiff() {
  const host = $('specDiff');
  if (!diff) { host.innerHTML = ''; return; }

  const { coverage, findings } = diff;
  const blockers = findings.filter((f) => f.level === 'blocker').length;

  // 还没写规格时不该显示「✓ 一致」—— 没有规格谈不上一致，那是在骗人
  if (!spec.steps.length) {
    host.innerHTML =
      `<div class="dsum"><b>还没有规格</b>` +
      `<span class="dimtext">先跑一次 agent，点「按实际运行生成草稿」拿到起点，再在上面改意图</span></div>`;
    return;
  }

  const bar =
    `<div class="dsum ${findings.length ? (blockers ? 'bad' : 'warn') : 'ok'}">
      <b>${findings.length ? (blockers ? `${blockers} 处对不上` : `${findings.length} 处提醒`) : '✓ 实际行为和规格一致'}</b>
      <span class="dimtext">对上 ${coverage.matched}/${coverage.total} 步${
        coverage.unexpected ? ` · ${coverage.unexpected} 个实际步骤不在规格里` : ''
      }</span>
    </div>`;

  const list = findings.map((f, i) => {
    const cands = f.candidates?.length
      ? `<div class="dcand">对上哪一个？${f.candidates
          .map((c) => `<button class="btn" data-bind="${i}" data-to="${esc(c.id)}">${esc(c.label)}</button>`)
          .join('')}</div>`
      : '';
    return `<li class="dfind ${f.level}">
      <span class="dicon">${LEVEL_ICON[f.level] ?? '·'}</span>
      <div><div>${esc(f.message)}</div>${cands}</div>
    </li>`;
  }).join('');

  host.innerHTML = bar + (list ? `<ul class="dlist">${list}</ul>` : '');

  for (const b of host.querySelectorAll('[data-bind]')) {
    b.onclick = () => {
      const f = diff.findings[Number(b.dataset.bind)];
      const step = spec.steps.find((s) => s.id === f.specStepId);
      if (!step) return;
      // 绑定一次，长期有效 —— 之后改名、重构都不会再断
      step.bind = b.dataset.to;
      markDirty();
      save();
    };
  }
}

function renderSteps() {
  const host = $('specSteps');
  if (!spec.steps.length) {
    host.innerHTML =
      '<div class="ph">还没有规格。<br>先跑一次 agent，然后点「按实际运行生成草稿」拿到起点。</div>';
    return;
  }

  const loops = spec.steps.filter((s) => s.kind === 'loop');

  host.innerHTML = spec.steps.map((s, i) => {
    const isLoop = s.kind === 'loop';
    const matched = diff?.matches?.[s.id];
    return `<div class="sstep ${isLoop ? 'loop' : ''}" data-i="${i}">
      <div class="ss1">
        <select data-f="kind" data-i="${i}">${
          KINDS.map(([v, t]) => `<option value="${v}" ${s.kind === v ? 'selected' : ''}>${t}</option>`).join('')
        }</select>
        <input class="sslabel" data-f="label" data-i="${i}" value="${esc(s.label ?? '')}" placeholder="步骤名" />
        <span class="ssbind ${matched ? 'on' : ''}" title="${matched ? esc(matched) : '还没对上实际步骤'}">${
          matched ? '● 已对上' : '○ 未对上'}</span>
        <button class="btn ssdel" data-del="${i}" title="删掉这一步">✕</button>
      </div>
      <input class="ssintent" data-f="intent" data-i="${i}" value="${esc(s.intent ?? '')}"
             placeholder="这一步要做什么 —— 这段话会作为规格交给 AI" />
      ${isLoop
        ? `<div class="ss2"><label>最多 <input type="number" min="1" class="ssnum" data-f="maxIterations"
             data-i="${i}" value="${s.maxIterations ?? ''}" placeholder="不限" /> 轮</label></div>`
        : `<div class="ss2">
             <label>在 <select data-f="parentId" data-i="${i}">
               <option value="">（不在循环里）</option>
               ${loops.map((l) => `<option value="${esc(l.id)}" ${s.parentId === l.id ? 'selected' : ''}>${esc(l.label)}</option>`).join('')}
             </select> 内</label>
             <label>在 <select data-f="after" data-i="${i}">
               <option value="">（无前置）</option>
               ${spec.steps.filter((x) => x.id !== s.id && x.kind !== 'loop')
                 .map((x) => `<option value="${esc(x.id)}" ${(s.after ?? [])[0] === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
             </select> 之后</label>
             <label title="它本来就在 if 里，不是每轮都跑"><input type="checkbox" data-f="optional"
               data-i="${i}" ${s.optional ? 'checked' : ''} /> 可选（分支）</label>
             <label title="允许和同排的步骤并发"><input type="checkbox" data-f="parallel"
               data-i="${i}" ${s.parallel ? 'checked' : ''} /> 可并发</label>
           </div>`}
    </div>`;
  }).join('');

  for (const el of host.querySelectorAll('[data-f]')) {
    const i = Number(el.dataset.i);
    const f = el.dataset.f;
    const handler = () => {
      const s = spec.steps[i];
      if (f === 'after') s.after = el.value ? [el.value] : [];
      else if (f === 'optional' || f === 'parallel') s[f] = el.checked || undefined;
      else if (f === 'maxIterations') s[f] = el.value === '' ? null : Number(el.value);
      else if (f === 'parentId') s[f] = el.value || null;
      else s[f] = el.value;
      markDirty();
      if (f === 'kind' || f === 'label') render();
    };
    if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'number') el.onchange = handler;
    else el.oninput = handler;
  }
  for (const b of host.querySelectorAll('[data-del]')) {
    b.onclick = () => {
      spec.steps.splice(Number(b.dataset.del), 1);
      markDirty();
      render();
    };
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
