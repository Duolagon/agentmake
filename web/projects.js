// 项目：导入一个工程目录，在页面上直接启动 / 停止，并看到它的输出。
//
// 在这之前，用户要用这个工具必须先去终端敲一长串
// `NODE_OPTIONS="--import /abs/.../register.ts" node server.mjs` —— 路径要拼对、
// 入口要知道是哪个文件、Python 还是另一套写法。页面打开是空的，也没告诉他下一步该干嘛。
//
// 现在：选目录 → 自动认出入口 → 点▶。启动命令一直摆在明面上，认错了可以直接改。

const $ = (id) => document.getElementById(id);

let projects = [];
let logs = new Map(); // id → [{t,s,line}]
let currentLogId = null;
let onChanged = () => {};

export function initProjects({ changed }) {
  onChanged = changed ?? (() => {});
  $('addProject').onclick = openPicker;
  $('addProject2').onclick = openPicker;
  $('pkClose').onclick = closePicker;
  $('pkCancel').onclick = closePicker;
  $('pkConfirm').onclick = confirmImport;
  $('pkPath').onchange = () => browse($('pkPath').value.trim());
  refresh();
}

export async function refresh() {
  projects = await fetch('/api/projects').then((r) => r.json()).catch(() => []);
  for (const p of projects) if (!logs.has(p.id) && p.proc?.log?.length) logs.set(p.id, p.proc.log);
  render();
}

/** SSE 推来的进程输出 / 退出 */
export function noteProcEvent(ev) {
  if (ev.type === 'proc.log') {
    const arr = logs.get(ev.id) ?? [];
    arr.push({ t: ev.t, s: ev.s, line: ev.line });
    if (arr.length > 400) arr.shift();
    logs.set(ev.id, arr);
    if (currentLogId === ev.id || currentLogId == null) renderLog(ev.id);
  }
  if (ev.type === 'proc.exit' || ev.type === 'proc.state' || ev.type === 'projects') refresh();
}

// ── 项目条 ─────────────────────────────────────────────────

function render() {
  const bar = $('projBar');
  if (!projects.length) {
    bar.hidden = true;
    $('empty').classList.toggle('has-projects', false);
    onChanged(projects);
    return;
  }
  bar.hidden = false;

  bar.innerHTML = projects
    .map((p) => {
      const on = p.proc?.running;
      const ranBefore = p.proc?.exitCode != null;
      // ▶ 在三种状态下意思不一样，按钮上就得写清楚，不能都画成一个三角
      const goIcon = on ? '■' : ranBefore ? '↻' : '▶';
      const goTip = on ? '停止' : ranBefore ? '再跑一次' : '启动它，跑起来的过程会自动出现在左边';

      return `<div class="proj ${on ? 'on' : ''}" data-p="${esc(p.id)}">
        <button class="pgo" data-go="${esc(p.id)}" title="${goTip}">${goIcon}</button>
        <span class="pname" title="${esc(p.dir)}">${esc(p.name)}</span>
        <input class="pcmd" data-cmd="${esc(p.id)}" value="${esc(p.cmd)}"
               title="实际执行的命令，认错了直接改" spellcheck="false" />
        ${on ? '<span class="pstate">运行中</span>'
             : ranBefore
               ? `<span class="pstate ${p.proc.exitCode ? 'bad' : ''}">已退出 ${p.proc.exitCode}</span>`
               : ''}
        ${trigCtl(p, on)}
        ${p.proc?.url ? `<a class="popen" href="${esc(p.proc.url)}" target="_blank" rel="noopener"
             title="它自己的界面">打开 ↗</a>` : ''}
        ${p.lastRun && !on ? `<button class="preplay" data-replay="${esc(p.id)}"
             title="拿上次的响应重跑：输入没变的调用直接用缓存，不花钱、不等待">重放</button>` : ''}
        <button class="plog" data-log="${esc(p.id)}" title="看它的输出">输出</button>
        <button class="pdel" data-del="${esc(p.id)}" title="从列表移除（不动你的文件）">✕</button>
      </div>`;
    })
    .join('');

  for (const el of bar.querySelectorAll('[data-go]')) {
    el.onclick = () => toggleRun(el.dataset.go);
  }
  for (const el of bar.querySelectorAll('[data-cmd]')) {
    el.onchange = () =>
      fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: el.dataset.cmd, cmd: el.value }),
      });
  }
  for (const el of bar.querySelectorAll('[data-trig]')) {
    el.onclick = async () => {
      const r = await fetch('/api/projects/trigger', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: el.dataset.trig }),
      }).then((x) => x.json());
      if (r.error) alert(r.error);
      renderLog(el.dataset.trig, true);
    };
  }
  for (const el of bar.querySelectorAll('[data-trigcmd]')) {
    el.onchange = () => {
      fetch('/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: el.dataset.trigcmd, trigger: el.value }),
      }).then(refresh);
    };
  }
  for (const el of bar.querySelectorAll('[data-replay]')) {
    el.onclick = async () => {
      const p = projects.find((x) => x.id === el.dataset.replay);
      logs.set(p.id, []);
      renderLog(p.id, true);
      const r = await fetch('/api/projects/start', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: p.id, replayFrom: p.lastRun }),
      }).then((x) => x.json());
      if (r.error) alert(`启动失败：${r.error}`);
      setTimeout(refresh, 200);
    };
  }
  for (const el of bar.querySelectorAll('[data-log]')) {
    el.onclick = () => renderLog(el.dataset.log, true);
  }
  for (const el of bar.querySelectorAll('[data-del]')) {
    el.onclick = async () => {
      const p = projects.find((x) => x.id === el.dataset.del);
      if (!confirm(`从列表里移除「${p?.name}」？（不会动你的文件）`)) return;
      await fetch(`/api/projects?id=${encodeURIComponent(el.dataset.del)}`, { method: 'DELETE' });
      refresh();
    };
  }
  onChanged(projects);
}

async function toggleRun(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  if (p.proc?.running) {
    await fetch('/api/projects/stop', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });
  } else {
    logs.set(id, []);
    renderLog(id, true);
    const r = await fetch('/api/projects/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    }).then((x) => x.json());
    if (r.error) alert(`启动失败：${r.error}`);
  }
  setTimeout(refresh, 200);
}

/**
 * 触发控件。
 *
 * 常驻服务型的 agent，点▶只是把它 boot 起来，页面会一直是空的 —— 因为没人去戳它。
 * 这里给一个可填的触发命令（一条 curl 就够），跑起来之后点⚡就能让它真的干活。
 * 一次性脚本用不上，所以只在「正在跑」时才显示。
 */
function trigCtl(p, on) {
  if (!on) return '';
  return `<input class="ptrig" data-trigcmd="${esc(p.id)}" value="${esc(p.trigger ?? '')}"
            placeholder="触发命令（如 curl -X POST localhost:5717/api/run）" spellcheck="false" />
          <button class="ptrigbtn" data-trig="${esc(p.id)}"
            title="跑一次触发命令，让这个服务真的干活" ${p.trigger ? '' : 'disabled'}>⚡ 触发</button>`;
}

// ── 输出面板 ───────────────────────────────────────────────

function renderLog(id, open = false) {
  currentLogId = id;
  const box = $('procBox');
  const p = projects.find((x) => x.id === id);
  $('procTitle').textContent = p ? `${p.name} 的输出` : '输出';
  if (open) box.open = true;

  const arr = logs.get(id) ?? [];
  const pre = $('procLog');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.innerHTML = arr.length
    ? arr.map((l) => `<span class="${l.s === 'err' ? 'lerr' : ''}">${esc(l.line)}</span>`).join('\n')
    : '<span class="dimtext">（还没有输出）</span>';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  box.hidden = false;
}

// ── 导入向导 ───────────────────────────────────────────────
//
// 浏览器的目录选择器出于安全考虑拿不到真实绝对路径，而我们要 cd 进去跑，
// 必须有绝对路径 —— 所以目录树由服务端提供（这是个只监听 127.0.0.1 的本地工具）。

let picked = null;

function openPicker() {
  $('picker').hidden = false;
  picked = null;
  $('pkConfirm').disabled = true;
  $('pkNote').textContent = '';
  browse('');
}

function closePicker() {
  $('picker').hidden = true;
}

async function browse(target) {
  const d = await fetch(`/api/fs${target ? `?path=${encodeURIComponent(target)}` : ''}`)
    .then((r) => r.json()).catch(() => null);
  if (!d) return;
  $('pkPath').value = d.path;
  await choose(d.path);

  const rows = [
    d.parent ? `<button class="pkrow up" data-dir="${esc(d.parent)}">⬑ 上一级</button>` : '',
    ...d.dirs.map(
      (x) => `<button class="pkrow" data-dir="${esc(x.path)}">
        <span>📁 ${esc(x.name)}</span>${x.hint ? `<em>${esc(x.hint)}</em>` : ''}</button>`,
    ),
  ].join('');
  $('pkList').innerHTML = rows || '<div class="dimtext" style="padding:10px">（这个目录里没有子文件夹）</div>';
  for (const el of $('pkList').querySelectorAll('[data-dir]')) {
    el.onclick = () => browse(el.dataset.dir);
  }
}

/** 每进一层就探测一次 —— 让用户在点「导入」之前就看到「我打算怎么启动它」 */
async function choose(dir) {
  picked = dir;
  const det = await fetch(`/api/projects/detect?dir=${encodeURIComponent(dir)}`)
    .then((r) => r.json()).catch(() => null);
  const ok = det && det.kind !== 'unknown';
  $('pkConfirm').disabled = false;
  $('pkCmd').value = det?.cmd ?? '';
  $('pkNote').innerHTML = ok
    ? `将以 <b>${det.kind === 'python' ? 'Python' : 'Node'}</b> 方式启动 · ${esc(det.note)}`
    : `<span class="warn">${esc(det?.note ?? '没认出这是什么项目')}</span> —— 自己填启动命令也行`;
}

async function confirmImport() {
  if (!picked) return;
  const r = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: picked, cmd: $('pkCmd').value.trim() || undefined }),
  }).then((x) => x.json());
  if (r.error) { alert(r.error); return; }
  closePicker();
  await refresh();
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
