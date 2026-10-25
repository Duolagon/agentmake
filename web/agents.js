// 本机 agent：扫一遍本机正在跑的 agent，选哪个就只记哪个。
//
// 以前是被动监视：带探针的进程一跑就全记，Codex 也是服务一起就读。现在反过来 —— 先列出本机在跑的
// agent（服务端 agents.ts 认的），每个写清楚点「监控」会做什么：
//   Node 没带探针 → 不重启直接挂上 · Python → 重启并挂上（先确认）· 已带探针 → 记下就行 · Codex → 读会话记录
// 顶栏的「监控中」一个 agent 一个标签，✕ 停止监控（之后它的调用不再记，已经记下的保留）。

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let watches = [];
let onChanged = () => {};
let showOthers = false;
let last = null;
/** 挂不上（调试口被占、Node 太旧）的进程：在那一行就地给「重启并监控」 */
const failed = new Map();

export function initAgents({ changed }) {
  onChanged = changed;
  for (const id of ['scanAgents', 'scanAgents2']) $(id).onclick = open;
  $('agClose').onclick = close;
  $('agRescan').onclick = () => scanNow();
  $('agentPicker').onclick = (e) => { if (e.target.id === 'agentPicker') close(); };
  refreshWatches();
}

export function watchCount() {
  return watches.length;
}

/** 服务端说监控列表变了（别的标签页里点的、进程退了被清掉的） */
export function noteWatchEvent() {
  refreshWatches();
  if (!$('agentPicker').hidden) scanNow(true);
}

async function refreshWatches() {
  const d = await fetch('/api/agents?watchesOnly=1').then((r) => r.json()).catch(() => null);
  watches = d?.watches ?? [];
  renderChips();
  if (d?.candidates) { last = d.candidates; if (!$('agentPicker').hidden) renderList(); }
  onChanged(watches);
}

function renderChips() {
  const bar = $('watchBar');
  bar.innerHTML = watches.length
    ? `<span class="wlbl">监控中</span>${watches.map((w) => `<span class="wchip" title="${esc(w.detail ?? '')}">
        <i class="wdot"></i>${esc(w.label)}${w.pid ? ` <em>pid ${w.pid}</em>` : ''}${w.kind === 'codex' ? ` <em>补读 ${days(w)} 天</em>` : ''}
        <button type="button" class="wx" data-unwatch="${esc(w.id)}" title="停止监控：之后它的调用不再记，已经记下的保留">✕</button></span>`).join('')}`
    : '<span class="wlbl dim">还没有选要监控的 agent</span>';
  for (const b of bar.querySelectorAll('[data-unwatch]')) {
    b.onclick = async () => {
      const w = watches.find((x) => x.id === b.dataset.unwatch);
      if (!confirm(`停止监控「${w?.label}」？\n之后它的调用不再记录，已经记下的保留。`)) return;
      await post('/api/agents/unwatch', { id: b.dataset.unwatch });
      refreshWatches();
    };
  }
}

const days = (w) => {
  try { return JSON.parse(w.opts ?? '{}').days ?? 1; } catch { return 1; }
};

function open() {
  $('agentPicker').hidden = false;
  scanNow();
}
function close() {
  $('agentPicker').hidden = true;
}

async function scanNow(quiet = false) {
  if (!quiet) $('agList').innerHTML = '<div class="agempty">正在扫描本机进程…</div>';
  const d = await fetch('/api/agents').then((r) => r.json()).catch(() => null);
  if (!d || d.error) {
    $('agList').innerHTML = `<div class="agempty">${esc(d?.error ?? '扫描失败')}</div>`;
    return;
  }
  last = d.candidates;
  watches = d.watches;
  renderChips();
  renderList();
  $('agSum').textContent = `刚扫描 · ${last.filter((c) => c.agentLike).length} 个 agent`;
}

function renderList() {
  const agents = last.filter((c) => c.agentLike || c.watchId);
  const others = last.filter((c) => !c.agentLike && !c.watchId);
  $('agList').innerHTML = `
    ${agents.length ? agents.map(row).join('') : '<div class="agempty">没认出正在跑的 agent。下面「其它进程」里有的话，也可以直接选。</div>'}
    ${others.length ? `<button type="button" class="agmore" data-others>${showOthers ? '收起' : `其它 ${others.length} 个 Node / Python 进程（没认出是 agent）`} ${showOthers ? '▴' : '▾'}</button>
      ${showOthers ? others.map(row).join('') : ''}` : ''}`;

  $('agList').querySelector('[data-others]')?.addEventListener('click', () => { showOthers = !showOthers; renderList(); });
  for (const b of $('agList').querySelectorAll('[data-act]')) b.onclick = () => act(Number(b.dataset.pid), b.dataset.act, b);
  for (const b of $('agList').querySelectorAll('[data-unwatch]')) {
    b.onclick = async () => {
      await post('/api/agents/unwatch', { id: b.dataset.unwatch });
      await scanNow(true);
      onChanged(watches);
    };
  }
}

function row(c) {
  const f = failed.get(c.pid);
  const kind = c.kind === 'node' ? 'Node' : c.kind === 'python' ? 'Python' : c.kind === 'codex' ? '原生程序' : '原生程序';
  const state = c.watchId ? '<span class="agon">● 监控中</span>' : c.probe ? '已带探针' : c.kind === 'node' || c.kind === 'python' ? '没带探针' : '';
  const btn = c.watchId
    ? `<button type="button" class="btn" data-unwatch="${esc(c.watchId)}">停止监控</button>`
    : c.action === 'codex'
      ? `<select class="agdays" id="agDays" title="选上之后先补读最近几天的会话"><option value="1">补读今天</option><option value="3">补读 3 天</option><option value="7">补读 7 天</option></select>
         <button type="button" class="btn primary" data-act="codex" data-pid="${c.pid}">监控</button>`
      : c.action === 'attach'
        ? `<button type="button" class="btn primary" data-act="attach" data-pid="${c.pid}">监控</button>`
        : c.action === 'watch'
          ? `<button type="button" class="btn primary" data-act="watch" data-pid="${c.pid}">监控</button>`
          : c.action === 'restart'
            ? `<button type="button" class="btn" data-act="restart" data-pid="${c.pid}">重启并监控</button>`
            : '';
  return `<div class="agrow${c.watchId ? ' on' : ''}">
    <div class="agmain">
      <div class="agname">${esc(c.name)} <span class="agpid">pid ${c.pid} · ${ago(c.startedAt)}</span></div>
      <div class="agmeta">${esc(kind)} · ${esc(c.why)}${state ? ` · ${state}` : ''}${c.cwd ? ` · <span title="${esc(c.cwd)}">${esc(short(c.cwd))}</span>` : ''}</div>
      ${c.note ? `<div class="agnote">${esc(c.note)}</div>` : ''}
      ${f ? `<div class="agerr">${esc(f)} <button type="button" class="btn" data-act="restart" data-pid="${c.pid}">重启并监控</button></div>` : ''}
      <div class="agcmd" title="${esc(c.detail)}">${esc(c.detail)}</div>
    </div>
    <div class="agbtn">${btn}</div>
  </div>`;
}

async function act(pid, mode, btn) {
  const c = last.find((x) => x.pid === pid);
  if (mode === 'restart' && !confirm(
    `重启「${c?.name}」（pid ${pid}）并挂上探针？\n\n` +
    '会先结束它，再用同样的命令、目录和环境变量重新启动。\n' +
    '它原来那个终端里不会再有输出 —— 输出改写到 .agentmake/logs 下的日志文件。\n' +
    '如果它正在干活，手上的进度会丢。')) return;
  btn.disabled = true;
  btn.textContent = mode === 'restart' ? '正在重启…' : mode === 'attach' ? '正在挂探针…' : '…';
  const body = mode === 'codex' ? { codex: true, days: Number($('agDays')?.value ?? 1) } : { pid, mode };
  const r = await post('/api/agents/watch', body);
  if (r.error) {
    if (r.canRestart) failed.set(pid, r.error);
    else alert(r.error);
  } else {
    failed.delete(pid);
    if (r.log) alert(`已经重启，新进程 pid ${r.pid}。\n它的输出在：${r.log}`);
  }
  await scanNow(true);
  onChanged(watches);
}

async function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json()).catch((e) => ({ error: String(e) }));
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚启动';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86400)} 天`;
}
const short = (p) => p.replace(/^\/Users\/[^/]+/, '~');
