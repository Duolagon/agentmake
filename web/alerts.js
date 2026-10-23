// 「需要你看的」—— 自动发现的异常。
//
// 这一栏是给余光看的：没事的时候它安静地说「没发现异常」，有事的时候按严重程度排好。
// 每条都能点：点一下，图上只亮出相关的路径、调用列表筛到那几次、详情跳到最典型的那一次。
// 再点一下取消。异常本身由服务端算（anomalies.ts），这里只管画和交互。

let onPick = () => {};
let selected = null;
let list = [];

const SEV = { fail: '结果错了', warn: '很可能有问题', info: '值得一看' };

export function initAlerts({ pick }) {
  onPick = pick;
}

export function renderAlerts(items) {
  list = items ?? [];
  // 选中的那条在新快照里不见了（问题修好了 / 换了运行）就取消选中，别让图一直暗着
  if (selected && !list.some((a) => a.id === selected)) {
    selected = null;
    onPick(null);
  }
  paint();
}

export function clearAlert() {
  if (!selected) return;
  selected = null;
  paint();
  onPick(null);
}

function paint() {
  const host = document.getElementById('alerts');
  if (!host) return;
  const head = `<div class="al-head"><span>需要你看的</span><span class="dimtext">${
    list.length ? `${list.length} 条 · 按影响排序` : '自动检查中'
  }</span></div>`;

  if (!list.length) {
    host.innerHTML = `${head}<div class="al-empty">
      <b>没发现异常</b>
      <span>会自动检查：数据在进 prompt 前被丢掉、规则判定失败、调用失败、比平时慢、循环多转、同一请求重复发、工具返回空</span>
    </div>`;
    return;
  }

  host.innerHTML = head + list.map((a) => `
    <button type="button" class="al ${a.severity}${a.id === selected ? ' sel' : ''}" data-al="${esc(a.id)}"
            title="${esc(SEV[a.severity] ?? '')} · 点一下在图上看相关路径">
      <span class="al-top"><span class="al-title">${esc(a.icon)} ${esc(a.title)}</span><span class="al-count">${esc(a.count)}</span></span>
      <span class="al-detail">${esc(a.detail)}</span>
    </button>`).join('');

  for (const el of host.querySelectorAll('[data-al]')) {
    el.onclick = () => {
      const id = el.dataset.al;
      selected = selected === id ? null : id;
      paint();
      onPick(selected ? list.find((a) => a.id === selected) : null);
    };
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
