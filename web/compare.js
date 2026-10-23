// 同一步，跨请求看规律 —— 点图上一个节点、或异常栏里一条，图下面就出这张表。
//
// 一行一个请求：上游给了多少、用了多少、丢的是什么、这一步输出了什么、下一步去了哪、有没有被判失败。
// 表头上那句「规律」是服务端算的（stepcompare.ts）：数据被丢的那几次和没丢的那几次，结果是不是不一样。

let onPickCall = () => {};
let current = null; // { runId, stepId }

export function initCompare({ pickCall }) {
  onPickCall = pickCall;
}

export async function loadCompare(runId, stepId) {
  const host = document.getElementById('compare');
  if (!host) return;
  if (!stepId) {
    current = null;
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  current = { runId, stepId };
  const q = new URLSearchParams({ stepId });
  if (runId) q.set('runId', runId);
  const r = await fetch(`/api/steps/compare?${q}`).then((x) => x.json()).catch(() => null);
  // 等待期间用户又点了别的 —— 别把旧结果画上去
  if (!current || current.stepId !== stepId) return;
  if (!r || r.error) {
    host.hidden = true;
    return;
  }
  paint(host, r);
}

/** 新事件进来时刷新（同一步，又多了一个请求） */
export function refreshCompare(runId) {
  if (current) loadCompare(runId, current.stepId);
}

function paint(host, r) {
  host.hidden = false;
  const differs = r.split && /两组结果不一样/.test(r.pattern ?? '');
  const pattern = r.pattern
    ? `<div class="cmp-pattern${differs ? ' warn' : ''}">${differs ? '⚠ ' : ''}${esc(r.pattern)}</div>`
    : '';

  const rows = r.rows.map((x) => {
    const inp = x.input;
    const feed = !inp ? '—'
      : inp.items != null && inp.used != null ? `${inp.items} → ${inp.used} 条${inp.used < inp.items ? ' ✂' : ''}`
      : inp.coverage != null ? `进了 ${Math.round(inp.coverage * 100)}%`
      : fmtBytes(inp.bytes);
    const miss = inp?.missing?.length ? inp.missing.map((m) => `「${m}」`).join(' ') : inp ? '（没丢）' : '';
    const tail = String(x.runId ?? '').split('_').pop();
    return `<tr class="${inp?.dropped ? 'drop' : ''}${x.failing.length || !x.ok ? ' fail' : ''}" data-call="${esc(x.callId)}">
      <td class="mono">${esc(tail)}${x.iteration ? ` · 第 ${x.iteration} 轮` : ''}</td>
      <td class="mono">${esc(feed)}</td>
      <td class="miss" title="${esc(miss)}">${esc(miss)}</td>
      <td class="out" title="${esc(x.out)}">${esc(x.out)}</td>
      <td class="mono">${esc(x.next ?? '（结束）')}</td>
      <td>${x.failing.length ? x.failing.map((f) => `<span class="rb">✗ ${esc(ruleName(f))}</span>`).join(' ') : !x.ok ? '<span class="rb">✗ 失败</span>' : ''}</td>
      <td class="mono">${fmtMs(x.ms)}</td>
    </tr>`;
  }).join('');

  host.innerHTML = `<div class="cmp-head">
      <b>同一步，跨请求看规律 · ${esc(r.step.label)}</b>
      <span class="dimtext">${r.rows.length} 次${r.step.calls > r.rows.length ? `（最近的，共 ${r.step.calls} 次）` : ''} · 点一行看那次的 prompt</span>
      <button type="button" class="xclr" id="cmpClose" aria-label="关掉对比表">✕</button>
    </div>
    ${pattern}
    <div class="cmp-scroll"><table class="cmp">
      <thead><tr><th>请求</th><th>上游给的 → 用了</th><th>丢掉的里面</th><th>输出</th><th>下一步</th><th>判定</th><th>耗时</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  for (const tr of host.querySelectorAll('tr[data-call]')) tr.onclick = () => onPickCall(tr.dataset.call);
  host.querySelector('#cmpClose').onclick = () => loadCompare(null, null);
}

const RULES = {
  'rule.truncated': '被截断',
  'rule.empty_output': '空输出',
  'rule.tool_args_invalid': '工具参数坏了',
  'rule.unknown_tool': '调了不存在的工具',
  'rule.blocked': '被拦截',
};
const ruleName = (n) => RULES[n] ?? n;
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms ?? 0}ms`);
const fmtBytes = (b) => (b >= 1024 ? `${(b / 1024).toFixed(1)}KB` : `${b ?? 0}B`);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
