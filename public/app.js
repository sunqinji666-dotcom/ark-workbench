const state = {
  jobs: [],
  apiKeyConfigured: false,
  running: 0,
  queued: 0,
};

const $ = (sel) => document.querySelector(sel);
const jobsEl = $('#jobs');
const galleryEl = $('#gallery');
const statsEl = $('#stats');
const apiStateEl = $('#apiState');
const commandInput = $('#commandInput');
const searchInput = $('#searchInput');

function fmtDate(iso) {
  if (!iso) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function short(text, len = 80) {
  const s = String(text || '');
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败: ${res.status}`);
  }
  return data;
}

function renderStats() {
  const completed = state.jobs.filter((j) => j.status === 'done').length;
  const failed = state.jobs.filter((j) => j.status === 'failed').length;
  statsEl.innerHTML = [
    ['总任务', state.jobs.length],
    ['已完成', completed],
    ['失败', failed],
    ['排队中', state.queued],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  apiStateEl.textContent = state.apiKeyConfigured ? 'API Key 已连接' : '未检测到 API Key';
}

function actionButtons(job) {
  const buttons = [];
  if (job.filePath || job.fileName) {
    buttons.push(`<button class="mini" data-action="open" data-id="${job.id}">打开</button>`);
  }
  buttons.push(`<button class="mini" data-action="rerun" data-id="${job.id}">重跑</button>`);
  buttons.push(`<button class="mini danger" data-action="delete" data-id="${job.id}">删除</button>`);
  return buttons.join('');
}

function renderJobs() {
  const list = state.jobs.slice(0, 12);
  if (!list.length) {
    jobsEl.innerHTML = '<div class="empty">还没有任务。先在上面输入一条 `gen` 命令试试。</div>';
    return;
  }
  jobsEl.innerHTML = list.map((job) => `
    <article class="job-card">
      <div class="job-top">
        <strong class="job-title">${escapeHtml(job.title || job.id)}</strong>
        <span class="job-status">${escapeHtml(job.status || 'unknown')}</span>
      </div>
      <p class="job-prompt">${escapeHtml(short(job.prompt || job.note || '本地导入文件'))}</p>
      <div class="job-meta">
        <span class="chip">${escapeHtml(job.model || 'local')}</span>
        <span class="chip">${escapeHtml(job.size || '-')}</span>
        <span class="chip">${job.watermark === false ? '无水印' : job.watermark === true ? '有水印' : '本地导入'}</span>
        <span class="chip">${escapeHtml(fmtDate(job.createdAt))}</span>
      </div>
      ${job.error ? `<p class="job-prompt" style="color:var(--danger)">${escapeHtml(job.error)}</p>` : ''}
      <div class="job-actions">
        <button class="mini" data-action="copy" data-id="${job.id}">复制命令</button>
        ${actionButtons(job)}
      </div>
    </article>
  `).join('');
}

function renderGallery() {
  const keyword = searchInput.value.trim().toLowerCase();
  const list = state.jobs.filter((job) => {
    if (job.status !== 'done' && job.kind !== 'import') return false;
    if (!keyword) return true;
    return [job.prompt, job.title, job.fileName, job.model, job.note].some((v) => String(v || '').toLowerCase().includes(keyword));
  });
  if (!list.length) {
    galleryEl.innerHTML = '<div class="empty">没有符合条件的图片。</div>';
    return;
  }
  galleryEl.innerHTML = list.map((job) => `
    <article class="image-card">
      <a class="image-link" href="/images/${encodeURIComponent(job.fileName)}" target="_blank" rel="noreferrer">
        <img class="image-thumb" src="/images/${encodeURIComponent(job.fileName)}" alt="" loading="lazy" />
      </a>
      <div class="image-body">
        <strong class="image-title">${escapeHtml(job.title || job.fileName)}</strong>
        <p class="image-prompt">${escapeHtml(short(job.prompt || job.note || job.fileName, 120))}</p>
        <div class="image-meta">
          <span class="chip">${escapeHtml(job.fileName || '')}</span>
          <span class="chip">${escapeHtml(fmtDate(job.createdAt))}</span>
        </div>
        <div class="job-actions">
          <button class="mini" data-action="open" data-id="${job.id}">打开</button>
          <button class="mini" data-action="rerun" data-id="${job.id}">重跑</button>
          <button class="mini danger" data-action="delete" data-id="${job.id}">删除</button>
        </div>
      </div>
    </article>
  `).join('');
}

function renderAll() {
  renderStats();
  renderJobs();
  renderGallery();
}

async function refresh() {
  const data = await api('/api/state', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
  state.jobs = data.jobs || [];
  state.apiKeyConfigured = Boolean(data.apiKeyConfigured);
  state.running = data.running || 0;
  state.queued = data.queued || 0;
  renderAll();
}

async function runCommand() {
  const command = commandInput.value.trim();
  if (!command) return;
  await api('/api/command', {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
  commandInput.value = '';
  await refresh();
}

async function handleAction(action, id) {
  if (action === 'copy') {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) return;
    const command = job.prompt ? `gen ${job.prompt}${job.watermark === false ? ' --nw' : ''}` : `rerun ${id}`;
    await navigator.clipboard.writeText(command);
    return;
  }
  await api(`/api/jobs/${encodeURIComponent(id)}${action === 'rerun' ? '/rerun' : ''}`, {
    method: action === 'delete' ? 'DELETE' : 'POST',
  });
  await refresh();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  handleAction(target.dataset.action, target.dataset.id).catch((error) => alert(error.message));
});

commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    runCommand().catch((error) => alert(error.message));
  }
});

searchInput.addEventListener('input', renderGallery);

$('#runCommand').addEventListener('click', () => runCommand().catch((error) => alert(error.message)));
$('#openFolder').addEventListener('click', () => {
  api('/api/reveal', { method: 'POST' }).catch((error) => alert(error.message));
});

const source = new EventSource('/api/events');
source.addEventListener('job', () => refresh().catch(() => {}));
source.addEventListener('job-deleted', () => refresh().catch(() => {}));

refresh().catch((error) => {
  jobsEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
});
