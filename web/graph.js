// 执行图画布：分层布局 + SVG 渲染 + 平移缩放。
//
// 刻意不用 React Flow —— 目前整个项目零依赖零构建，而推导出来的图是调用树形状，
// 分层布局用一百来行就够了。等图复杂到需要子图折叠时再换。

const NODE_W_MIN = 132;
const NODE_H = 46;
const GAP_X = 26;
const GAP_Y = 58;
const CHAR_W = 7.2;
// 自动适配的最小缩放。低于这个值文字就看不清了 —— 宁可让图溢出让用户平移，
// 也不要为了「一屏塞下」把节点缩成看不懂的小方块。
const MIN_FIT = 0.72;

let view = { x: 0, y: 0, k: 1 };
let userMoved = false;
let onSelect = () => {};
let selectedId = null;
let lastGraph = null;

export function initGraph(svg, selectHandler) {
  onSelect = selectHandler;
  installPanZoom(svg);
}

export function setSelected(id) {
  selectedId = id;
  if (lastGraph) paint(lastGraph);
}

export function renderGraph(graph, refit = false) {
  const changed = !lastGraph || lastGraph.nodes.length !== graph.nodes.length;
  lastGraph = graph;
  if (refit || (changed && !userMoved)) fit(graph);
  paint(graph);
}

/** 适配视图：按可读下限钳制缩放，溢出就让用户平移 */
function fit(graph) {
  const svg = document.getElementById('canvas');
  const cw = svg.clientWidth || 700;
  const ch = svg.clientHeight || 400;
  const L = layout(graph);
  if (!L.nodes.length) return;
  const k = Math.min(1, Math.max(MIN_FIT, Math.min((cw - 32) / L.width, (ch - 32) / L.height)));
  view = { k, x: (cw - L.width * k) / 2, y: 16 };
  userMoved = false;
}

// ── 布局 ───────────────────────────────────────────────────

function layout(graph) {
  const rows = new Map();
  for (const n of graph.nodes) {
    const w = Math.max(NODE_W_MIN, n.label.length * CHAR_W + 26);
    const node = { ...n, w, h: NODE_H, x: 0, y: n.depth * (NODE_H + GAP_Y) };
    if (!rows.has(n.depth)) rows.set(n.depth, []);
    rows.get(n.depth).push(node);
  }

  const byId = new Map();
  for (const list of rows.values()) for (const n of list) byId.set(n.id, n);

  // 用重心法降低连线交叉：每个节点向其父节点的平均位置靠拢，从上往下扫两遍。
  const parents = new Map();
  for (const e of graph.edges) {
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to).push(e.from);
  }

  const depths = [...rows.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < 2; pass++) {
    for (const d of depths) {
      const list = rows.get(d);
      if (d > 0) {
        for (const n of list) {
          const ps = (parents.get(n.id) ?? []).map((p) => byId.get(p)).filter(Boolean);
          n._bary = ps.length ? ps.reduce((s, p) => s + p.x + p.w / 2, 0) / ps.length : n.x;
        }
        list.sort((a, b) => a._bary - b._bary);
      }
      let x = 0;
      for (const n of list) {
        n.x = x;
        x += n.w + GAP_X;
      }
    }
  }

  // 各行居中对齐
  const widest = Math.max(...[...rows.values()].map((l) => l.at(-1).x + l.at(-1).w));
  for (const list of rows.values()) {
    const rowW = list.at(-1).x + list.at(-1).w;
    const off = (widest - rowW) / 2;
    for (const n of list) n.x += off;
  }

  const nodes = [...byId.values()];
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { nodes, byId, width: widest, height: maxY };
}

// ── 渲染 ───────────────────────────────────────────────────

function paint(graph) {
  const svg = document.getElementById('canvas');
  if (!graph.nodes.length) {
    svg.innerHTML =
      '<text x="50%" y="50%" text-anchor="middle" class="ph">运行一次 agent，执行图会自动出现</text>';
    return;
  }

  const { nodes, byId } = layout(graph);
  // viewBox 用容器像素尺寸，这样 scale=1 就是 1:1，文字尺寸可控。
  // （早期版本把 viewBox 设成整图包围盒，图一深就被压到看不清。）
  const cw = svg.clientWidth || 700;
  const ch = svg.clientHeight || 400;

  const edges = graph.edges
    .map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return '';
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const my = (y1 + y2) / 2;
      const dim = selectedId && e.from !== selectedId && e.to !== selectedId ? ' dim' : '';
      const label =
        e.count > 1
          ? `<text class="ecount" x="${(x1 + x2) / 2}" y="${my - 2}" text-anchor="middle">×${e.count}</text>`
          : '';
      return `<path class="edge${dim}" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}" marker-end="url(#arrow)"/>${label}`;
    })
    .join('');

  const boxes = nodes
    .map((n) => {
      const kind = n.errors ? 'err' : n.llmCalls ? 'llm' : n.ownCalls ? 'http' : 'plain';
      const sel = n.id === selectedId ? ' sel' : '';
      const dim = selectedId && n.id !== selectedId ? ' dim' : '';
      const stats = n.ownCalls
        ? `${n.llmCalls ? n.llmCalls + ' LLM ' : ''}${n.httpCalls ? n.httpCalls + ' HTTP ' : ''}${fmtMs(n.ownMs)}`
        : `${n.subtreeCalls} 次经过`;
      return `<g class="node ${kind}${sel}${dim}" data-id="${esc(n.id)}" transform="translate(${n.x},${n.y})">
        <rect width="${n.w}" height="${n.h}" rx="7"/>
        <text class="lbl" x="${n.w / 2}" y="19" text-anchor="middle">${esc(trim(n.label, 20))}</text>
        <text class="sub" x="${n.w / 2}" y="34" text-anchor="middle">${esc(stats)}</text>
      </g>`;
    })
    .join('');

  svg.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
  svg.innerHTML = `
    <defs>
      <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0,0 L8,4 L0,8 z"/>
      </marker>
    </defs>
    <g id="vp" transform="translate(${view.x},${view.y}) scale(${view.k})">${edges}${boxes}</g>`;

  for (const g of svg.querySelectorAll('.node')) {
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = g.dataset.id;
      selectedId = selectedId === id ? null : id;
      paint(graph);
      onSelect(selectedId);
    });
  }
  svg.addEventListener('click', () => {
    if (!selectedId) return;
    selectedId = null;
    paint(graph);
    onSelect(null);
  });
}

// ── 平移缩放 ───────────────────────────────────────────────

function installPanZoom(svg) {
  let dragging = false;
  let sx = 0;
  let sy = 0;

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    view.k = Math.min(3, Math.max(0.2, view.k * f));
    userMoved = true;
    apply(svg);
  }, { passive: false });

  svg.addEventListener('pointerdown', (e) => {
    dragging = true;
    sx = e.clientX - view.x;
    sy = e.clientY - view.y;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    view.x = e.clientX - sx;
    view.y = e.clientY - sy;
    userMoved = true;
    apply(svg);
  });
  svg.addEventListener('pointerup', (e) => {
    dragging = false;
    svg.releasePointerCapture?.(e.pointerId);
  });

  document.getElementById('fit')?.addEventListener('click', () => {
    if (lastGraph) renderGraph(lastGraph, true);
  });
}

function apply(svg) {
  const vp = svg.querySelector('#vp');
  if (vp) vp.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
}

// ── 小工具 ─────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const trim = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
