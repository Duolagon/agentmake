// 循环图：agent 循环的「流程」—— 中间是模型，右边是它用过的工具，左边任务进、下面结论出。
//
// 流程图按「哪一行代码发的调用」归并步骤：dsh 的 103 轮都从同一处发出，只剩一张名字是 system prompt
// 开头的「×103」卡片，它用 bash 跑了 148 次命令、4 次退出码不为 0、杀掉一个卡住的任务 —— 图上一个都没有。
// 这里一个工具一张卡：调了几次、失败几次、花了多久、最近一次跑的什么、回来什么；连线越粗调得越多。
// 点一个工具（或它的「N 次失败」）→ 时序和完整记录里只亮那几轮；点模型 / 结论 / 旁路 → 跳到那一轮。
// 数据见服务端 transcript.ts 的 buildLoopMap。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 工具卡最多摆几张；再多的收进「另 N 个工具」 */
const MAX_TOOLS = 7;

let ctx = { jump: () => {}, filter: () => {}, active: () => null };
let last = null;
let showAll = false;

export function initLoopMap(c) {
  ctx = c;
}

export async function renderLoopMap(host, runId) {
  const m = await fetch(`/api/loopmap?runId=${encodeURIComponent(runId)}`).then((r) => r.json()).catch(() => null);
  if (!m || m.error) {
    host.innerHTML = `<div class="tm-empty">${esc(m?.error ?? '取不到循环图')}</div>`;
    return;
  }
  last = { host, m };
  paint();
}

/** 筛选变了（点了别的工具 / 清掉了）：重画高亮，不用重新取数据 */
export function repaintLoopMap() {
  if (last && last.host.isConnected) paint();
}

function paint() {
  const { host, m } = last;
  const active = ctx.active();
  const tools = showAll ? m.tools : m.tools.slice(0, MAX_TOOLS);
  const rest = m.tools.length - tools.length;
  const maxMs = Math.max(1, ...m.tools.map((t) => t.ms));

  const toolCard = (t) => {
    const on = active?.key === `tool:${t.name}`;
    const failOn = active?.key === `fail:${t.name}`;
    return `<div class="lm-tool${t.failed ? ' bad' : ''}${on || failOn ? ' on' : ''}" data-tool="${esc(t.name)}" title="点一下：时序和完整记录里只看用了 ${esc(t.name)} 的那几轮">
      <div class="lm-tn"><span class="lm-name">${esc(t.name)}</span><span class="lm-cnt">${t.count} 次</span></div>
      <div class="lm-ts">${dur(t.ms)}${t.outChars ? ` · 结果 ${size(t.outChars)}` : ''}${
        t.failed ? ` · <button type="button" class="lm-fail${failOn ? ' on' : ''}" data-fail="${esc(t.name)}" title="只看失败的那几轮">${t.failed} 次失败</button>` : ''}</div>
      <div class="lm-bar"><i style="width:${Math.max(2, (t.ms / maxMs) * 100).toFixed(1)}%"></i></div>
      ${t.last ? `<div class="lm-last">→ ${esc(t.last.args)}</div>${t.last.result ? `<div class="lm-res">${esc(t.last.result)}</div>` : ''}` : ''}
    </div>`;
  };

  const model = m.model;
  host.innerHTML = `<div class="lm">
    ${active ? `<div class="lm-filterbar">只看 <b>${esc(active.label)}</b> 的 ${active.ids.size} 轮 · 时序和完整记录里已标出 <button type="button" class="lm-clear" data-clear>清掉 ✕</button></div>` : ''}
    <div class="lm-grid">
      <div class="lm-col lm-left">
        <div class="lm-node lm-task" data-jump="${esc(model.firstCallId ?? '')}" title="跳到第 1 轮">
          <div class="lm-k">任务</div><div class="lm-v">${esc(m.task ?? '（没认出任务）')}</div>
        </div>
      </div>
      <div class="lm-col lm-mid">
        <div class="lm-node lm-model${m.running ? ' run' : ''}" data-jump="${esc(model.firstCallId ?? '')}" title="跳到第 1 轮">
          <div class="lm-k">模型${m.running ? ' · 还在跑' : ''}</div>
          <div class="lm-big">${model.rounds} 轮</div>
          <div class="lm-v">${esc(model.models.join(' · ') || '—')}</div>
          <div class="lm-sub">想了 ${dur(model.ms)} · ${num(model.tokensIn)}↑ ${num(model.tokensOut)}↓</div>
        </div>
        ${m.side.map((s) => `<div class="lm-node lm-side" data-jump="${esc(s.callIds[0])}" title="旁路调用：换了 system prompt 的另一个对话">
          <div class="lm-k">旁路 · ${s.count} 次</div><div class="lm-v">${esc(s.name)}</div></div>`).join('')}
        ${m.http.count ? `<div class="lm-node lm-side" data-jump="${esc(m.http.callIds[0])}"><div class="lm-k">HTTP 请求 · ${m.http.count} 次</div></div>` : ''}
      </div>
      <div class="lm-col lm-right">
        ${tools.length ? tools.map(toolCard).join('') : '<div class="lm-none">这次运行没有调用工具 —— 模型直接作答</div>'}
        ${rest > 0 ? `<button type="button" class="lm-more" data-more>另外 ${rest} 个工具 ▾</button>` : ''}
        ${showAll && m.tools.length > MAX_TOOLS ? '<button type="button" class="lm-more" data-more>收起 ▴</button>' : ''}
        ${m.final ? `<div class="lm-node lm-final" data-jump="${esc(m.final.callId)}" title="跳到最后一轮">
          <div class="lm-k">结论 · 第 ${m.final.round} 轮</div><div class="lm-v">${esc(m.final.text)}</div></div>` : ''}
      </div>
    </div>
    <svg class="lm-wires" aria-hidden="true"></svg>
  </div>`;

  wire(host, m, tools);
  const box = host.querySelector('.lm');
  box.onclick = (e) => {
    if (e.target.closest('[data-clear]')) return ctx.filter(null);
    if (e.target.closest('[data-more]')) { showAll = !showAll; return paint(); }
    const f = e.target.closest('[data-fail]');
    if (f) {
      const t = m.tools.find((x) => x.name === f.dataset.fail);
      return ctx.filter(active?.key === `fail:${t.name}` ? null : { key: `fail:${t.name}`, label: `${t.name} 失败`, ids: new Set(t.failedCallIds) });
    }
    const tl = e.target.closest('[data-tool]');
    if (tl) {
      const t = m.tools.find((x) => x.name === tl.dataset.tool);
      return ctx.filter(active?.key === `tool:${t.name}` ? null : { key: `tool:${t.name}`, label: t.name, ids: new Set(t.callIds) });
    }
    const j = e.target.closest('[data-jump]');
    if (j?.dataset.jump) ctx.jump(j.dataset.jump);
  };
}

/** 连线：任务 → 模型 → 每个工具（越粗调得越多）→ 结论；旁路虚线 */
function wire(host, m, tools) {
  const box = host.querySelector('.lm');
  const svg = host.querySelector('.lm-wires');
  const draw = () => {
    if (!box.isConnected) return;
    // 中间栏窄（历史栏、异常栏、完整记录都开着）放不下三列：任务和模型并排在上，工具排在下面
    const narrow = box.clientWidth < 640;
    box.classList.toggle('narrow', narrow);
    const b = box.getBoundingClientRect();
    svg.setAttribute('width', b.width);
    svg.setAttribute('height', box.scrollHeight);
    const at = (el, side) => {
      const r = el.getBoundingClientRect();
      const y = r.top - b.top + Math.min(r.height / 2, 30);
      return side === 'r' ? [r.right - b.left, y] : [r.left - b.left, y];
    };
    const curve = ([x1, y1], [x2, y2]) => {
      const dx = Math.max(20, (x2 - x1) / 2);
      return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    };
    const model = box.querySelector('.lm-model');
    const task = box.querySelector('.lm-task');
    const paths = [];
    if (task && model) paths.push(`<path d="${curve(at(task, 'r'), at(model, 'l'))}" class="w"/>`);
    const maxC = Math.max(1, ...tools.map((t) => t.count));
    // 窄排法：从模型底部拉一条竖的主干，沿着工具列左边往下，每个工具分一根横枝
    const mr = model?.getBoundingClientRect();
    const spineX = narrow ? 12 : 0;
    const from = (el) => {
      if (!narrow) return curve(at(model, 'r'), at(el, 'l'));
      const r = el.getBoundingClientRect();
      const y = r.top - b.top + Math.min(r.height / 2, 22);
      const x0 = mr.left - b.left + mr.width / 2;
      const y0 = mr.bottom - b.top;
      return `M${x0},${y0} C${x0},${y0 + 18} ${spineX},${y0 + 4} ${spineX},${y0 + 26} L${spineX},${y - 8} Q${spineX},${y} ${spineX + 8},${y} L${r.left - b.left},${y}`;
    };
    for (const el of box.querySelectorAll('.lm-tool')) {
      const t = tools.find((x) => x.name === el.dataset.tool);
      const w = 1.5 + 6 * Math.log1p(t.count) / Math.log1p(maxC);
      paths.push(`<path d="${from(el)}" class="w tool${t.failed ? ' bad' : ''}${el.classList.contains('on') ? ' on' : ''}" style="stroke-width:${w.toFixed(1)}px"/>`);
    }
    const fin = box.querySelector('.lm-final');
    if (fin && model) paths.push(`<path d="${from(fin)}" class="w fin"/>`);
    svg.innerHTML = paths.join('');
  };
  requestAnimationFrame(draw);
  // 栏宽变了（拖窗口、收起历史栏）要重画线
  if (!box._ro) {
    box._ro = new ResizeObserver(() => requestAnimationFrame(draw));
    box._ro.observe(box);
  }
}

function dur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${Math.round(s % 60)} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
const num = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const size = (chars) => (chars >= 10_000 ? `${Math.round(chars / 1000)}k 字` : chars >= 1000 ? `${(chars / 1000).toFixed(1)}k 字` : `${chars} 字`);
