// 循环图：agent 循环的「流程」—— 任务 → 模型 ⇄ 工具 → 结论，从上往下读。
//
// 流程图按「哪一行代码发的调用」归并步骤：dsh 的 103 轮都从同一处发出，只剩一张名字是 system prompt
// 开头的「×103」卡片，它用 bash 跑了 148 次命令、4 次退出码不为 0、杀掉一个卡住的任务 —— 图上一个都没有。
// 这里把工具拎出来排成一张条形列表：条越长调得越多，后面是次数、花的时间、失败；只调过一次的合成一行。
// 模型和工具之间那对箭头就是循环本身（发起工具调用 ↓ / 结果回到模型 ↑）。
// 第一版画的是曲线连线：七根半透明的线挤在一条主干上叠成一坨，到处是红色，一串「1 次」的卡片和 148 次的
// 一样大 —— 难看也难读，换成了现在这样只靠对齐和留白的排法。
// 点一个工具（或它的「N 次失败」）→ 时序和完整记录里只亮那几轮，这一行下面展开最近一次的命令和返回；
// 点任务 / 模型 / 结论 / 旁路 → 跳到那一轮。数据见服务端 transcript.ts 的 buildLoopMap。

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
  // 调过不止一次的工具一行一个；只调过一次的合成一行 —— 不让一串「1 次」把真正干活的那个挤下去
  const many = m.tools.filter((t) => t.count > 1 || t.failed);
  const once = m.tools.filter((t) => t.count <= 1 && !t.failed);
  const rows = showAll ? m.tools : many;
  const maxC = Math.max(1, ...m.tools.map((t) => t.count));
  const model = m.model;

  const toolRow = (t) => {
    const on = active?.key === `tool:${t.name}` || active?.key === `fail:${t.name}`;
    return `<div class="lm-row${on ? ' on' : ''}" data-tool="${esc(t.name)}" title="点一下：时序和完整记录里只看用了 ${esc(t.name)} 的那几轮">
      <span class="lm-name">${esc(t.name)}</span>
      <span class="lm-bar"><i style="width:${Math.max(1.5, (t.count / maxC) * 100).toFixed(1)}%"></i></span>
      <span class="lm-cnt">${t.count}</span>
      <span class="lm-time">${dur(t.ms)}</span>
      <span class="lm-flag">${t.failed ? `<button type="button" class="lm-fail${active?.key === `fail:${t.name}` ? ' on' : ''}" data-fail="${esc(t.name)}" title="只看失败的那几轮">${t.failed} 次失败</button>` : ''}</span>
    </div>
    ${on && t.last ? `<div class="lm-detail">
      <div><span class="lm-dk">最近一次</span><code>${esc(t.last.args)}</code></div>
      ${t.last.result ? `<div><span class="lm-dk">返回</span><code class="dim">${esc(t.last.result)}</code></div>` : ''}
      <div class="lm-dk">回到模型的数据 ${size(t.outChars)}</div>
    </div>` : ''}`;
  };

  const chips = [
    ...m.side.map((s) => `<button type="button" class="lm-chip" data-jump="${esc(s.callIds[0])}" title="${esc(s.name)}">旁路 · ${esc(short(s.name))} · ${s.count} 次</button>`),
    m.http.count ? `<button type="button" class="lm-chip" data-jump="${esc(m.http.callIds[0])}">HTTP 请求 · ${m.http.count} 次</button>` : '',
  ].filter(Boolean).join('');

  host.innerHTML = `<div class="lm">
    ${active ? `<div class="lm-filterbar">只看 <b>${esc(active.label)}</b> 的 ${active.ids.size} 轮 · 时序和完整记录里已标出 <button type="button" class="lm-clear" data-clear>清掉 ✕</button></div>` : ''}

    <div class="lm-box lm-task" data-jump="${esc(model.firstCallId ?? '')}" title="跳到第 1 轮">
      <div class="lm-k">任务</div>
      <div class="lm-v">${esc(m.task ?? '（没认出任务）')}</div>
    </div>
    <div class="lm-down"></div>

    <div class="lm-loop">
      <div class="lm-box lm-model${m.running ? ' run' : ''}" data-jump="${esc(model.firstCallId ?? '')}" title="跳到第 1 轮">
        <div class="lm-k">模型${m.running ? ' · 还在跑' : ''} · ${esc(model.models.join(' · ') || '—')}</div>
        <div class="lm-modelline"><b>${model.rounds}</b> 轮 <span>想了 ${dur(model.ms)} · ${num(model.tokensIn)}↑ ${num(model.tokensOut)}↓</span></div>
      </div>
      ${m.tools.length ? `<div class="lm-cycle"><span>↓ 发起工具调用</span><span>结果回到模型 ↑</span></div>
      <div class="lm-box lm-tools">
        <div class="lm-k">工具 · ${m.tools.reduce((n, t) => n + t.count, 0)} 次调用 · 点一行只看它的那几轮</div>
        ${rows.map(toolRow).join('')}
        ${!showAll && once.length ? `<button type="button" class="lm-onces" data-more>另外 ${once.length} 个各调了 1 次：${once.map((t) => esc(t.name)).join(' · ')} ▾</button>` : ''}
        ${showAll && once.length ? '<button type="button" class="lm-onces" data-more>收起只调过 1 次的 ▴</button>' : ''}
      </div>` : '<div class="lm-none">这次运行没有调用工具 —— 模型直接作答</div>'}
    </div>

    ${m.final ? `<div class="lm-down"></div>
    <div class="lm-box lm-final" data-jump="${esc(m.final.callId)}" title="跳到最后一轮">
      <div class="lm-k">结论 · 第 ${m.final.round} 轮</div>
      <div class="lm-v">${esc(m.final.text)}</div>
    </div>` : ''}

    ${chips ? `<div class="lm-chips">${chips}</div>` : ''}
  </div>`;

  host.querySelector('.lm').onclick = (e) => {
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

const short = (s) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

function dur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${Math.round(s % 60)} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
const num = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const size = (chars) => (chars >= 10_000 ? `${Math.round(chars / 1000)}k 字` : chars >= 1000 ? `${(chars / 1000).toFixed(1)}k 字` : `${chars} 字`);
