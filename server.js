import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const WORKBENCH_DIR = process.cwd();
const PUBLIC_DIR = path.join(WORKBENCH_DIR, 'public');
const STORAGE_DIR = process.env.ARK_WORKBENCH_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Ark Workbench', 'generated-images');
const META_FILE = path.join(STORAGE_DIR, '.ark-workbench.json');
const PORT = Number(process.env.PORT || 8787);
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const DEFAULT_MODEL = 'doubao-seedream-5-0-pro-260628';
const DEFAULT_SIZE = '2K';

await fs.mkdir(STORAGE_DIR, { recursive: true });
await fs.mkdir(PUBLIC_DIR, { recursive: true });

const state = {
  jobs: [],
  events: new Set(),
  running: 0,
  queue: [],
};

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = 'job') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[\u4e00-\u9fa5]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadState() {
  if (await exists(META_FILE)) {
    try {
      const raw = await fs.readFile(META_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      state.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch {
      state.jobs = [];
    }
  } else {
    state.jobs = [];
  }
}

async function saveState() {
  const payload = JSON.stringify({ jobs: state.jobs }, null, 2);
  await fs.writeFile(META_FILE, payload);
}

function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of state.events) {
    res.write(msg);
  }
}

function touchJob(job, patch) {
  Object.assign(job, patch, { updatedAt: nowIso() });
  broadcast('job', job);
  saveState().catch(() => {});
}

function queueSnapshot() {
  return {
    running: state.running,
    queued: state.queue.length,
  };
}

function jobById(id) {
  return state.jobs.find((job) => job.id === id);
}

function inferNameFromFile(filename) {
  return filename.replace(/\.(png|jpg|jpeg|webp)$/i, '').replace(/^\d{8}-\d{6}-/, '');
}

async function scanGallery() {
  const entries = await fs.readdir(STORAGE_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const knownFiles = new Set(state.jobs.filter((job) => job.fileName).map((job) => job.fileName));
  for (const fileName of files) {
    if (knownFiles.has(fileName)) continue;
    state.jobs.unshift({
      id: uid('img'),
      kind: 'import',
      status: 'done',
      prompt: '',
      model: '',
      size: '',
      watermark: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      fileName,
      filePath: path.join(STORAGE_DIR, fileName),
      sourceUrl: '',
      note: '本地已有文件',
      title: inferNameFromFile(fileName),
    });
  }
  await saveState();
}

function sortJobs() {
  state.jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

async function downloadFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(dest, Buffer.from(arrayBuffer));
}

async function openPath(target) {
  const child = spawn('open', [target], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function handleGenerate(payload) {
  if (!ARK_API_KEY) throw new Error('未设置 ARK_API_KEY 环境变量');
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw new Error('prompt 不能为空');

  const job = {
    id: uid('job'),
    kind: 'generate',
    status: 'queued',
    prompt,
    model: payload.model || DEFAULT_MODEL,
    size: payload.size || DEFAULT_SIZE,
    watermark: payload.watermark ?? false,
    responseFormat: payload.response_format || 'url',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    fileName: '',
    filePath: '',
    sourceUrl: '',
    title: prompt.slice(0, 80),
    note: '',
    error: '',
  };

  state.jobs.unshift(job);
  state.queue.push(job.id);
  await saveState();
  broadcast('job', job);
  kickQueue();
  return job;
}

async function runJob(job) {
  touchJob(job, { status: 'requesting', note: '正在请求火山方舟接口' });
  const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ARK_API_KEY}`,
    },
    body: JSON.stringify({
      model: job.model,
      prompt: job.prompt,
      response_format: job.responseFormat,
      size: job.size,
      stream: false,
      watermark: job.watermark,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`接口失败: ${response.status} ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const imageUrl = data?.data?.[0]?.url;
  if (!imageUrl) throw new Error('接口返回里没有图片 URL');

  touchJob(job, { status: 'downloading', sourceUrl: imageUrl, note: '正在下载图片' });

  const stamp = new Date();
  const tag = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}${String(stamp.getSeconds()).padStart(2, '0')}`;
  const fileName = `${tag}-${slugify(job.prompt)}.jpeg`;
  const filePath = path.join(STORAGE_DIR, fileName);

  await downloadFile(imageUrl, filePath);
  touchJob(job, {
    status: 'done',
    note: '已完成并保存到本地',
    fileName,
    filePath,
    updatedAt: nowIso(),
  });
}

function kickQueue() {
  while (state.running < 1 && state.queue.length) {
    const id = state.queue.shift();
    const job = jobById(id);
    if (!job || job.status !== 'queued') continue;
    state.running += 1;
    runJob(job)
      .catch((error) => {
        touchJob(job, {
          status: 'failed',
          error: error?.message || String(error),
          note: '任务失败',
        });
      })
      .finally(() => {
        state.running -= 1;
        saveState().catch(() => {});
        kickQueue();
      });
    break;
  }
}

function parseCommand(text) {
  const input = String(text || '').trim();
  if (!input) return { type: 'empty' };
  const parts = input.match(/"([^"]+)"|'([^']+)'|`([^`]+)`|\S+/g)?.map((part) => part.replace(/^["'`]|["'`]$/g, '')) || [];
  const [cmd, ...rest] = parts;
  const flags = {
    watermark: false,
    size: DEFAULT_SIZE,
    model: DEFAULT_MODEL,
  };
  const promptParts = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--nw' || token === '--no-watermark') {
      flags.watermark = false;
      continue;
    }
    if (token === '--watermark') {
      flags.watermark = true;
      continue;
    }
    if (token === '--size' && rest[i + 1]) {
      flags.size = rest[++i];
      continue;
    }
    if (token === '--model' && rest[i + 1]) {
      flags.model = rest[++i];
      continue;
    }
    if (token === '--prompt' && rest[i + 1]) {
      promptParts.push(rest[++i]);
      continue;
    }
    promptParts.push(token);
  }

  if (cmd === 'gen' || cmd === 'generate') {
    return {
      type: 'generate',
      prompt: promptParts.join(' ').trim(),
      ...flags,
    };
  }
  if (cmd === 'list') return { type: 'list' };
  if (cmd === 'reveal' || cmd === 'open-folder') return { type: 'reveal' };
  if (cmd === 'open' && rest[0]) return { type: 'open', id: rest[0] };
  if (cmd === 'delete' && rest[0]) return { type: 'delete', id: rest[0] };
  if (cmd === 'rerun' && rest[0]) return { type: 'rerun', id: rest[0] };

  return {
    type: 'generate',
    prompt: input,
    ...flags,
  };
}

async function deleteJob(id) {
  const idx = state.jobs.findIndex((job) => job.id === id);
  if (idx === -1) return null;
  const job = state.jobs[idx];
  if (job.filePath && await exists(job.filePath)) {
    await fs.unlink(job.filePath);
  }
  state.jobs.splice(idx, 1);
  await saveState();
  broadcast('job-deleted', { id });
  return job;
}

async function rerunJob(id) {
  const job = jobById(id);
  if (!job) throw new Error('找不到任务');
  return handleGenerate({
    prompt: job.prompt,
    model: job.model || DEFAULT_MODEL,
    size: job.size || DEFAULT_SIZE,
    watermark: job.watermark ?? false,
    response_format: job.responseFormat || 'url',
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/') {
    const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return sendText(res, 200, html, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/app.js') {
    const js = await fs.readFile(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    return sendText(res, 200, js, 'application/javascript; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/styles.css') {
    const css = await fs.readFile(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    return sendText(res, 200, css, 'text/css; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    return json(res, 200, {
      ok: true,
      apiKeyConfigured: Boolean(ARK_API_KEY),
      storageDir: STORAGE_DIR,
      ...queueSnapshot(),
      jobs: state.jobs,
    });
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('\n');
    state.events.add(res);
    req.on('close', () => state.events.delete(res));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/command') {
    try {
      const payload = await readJson(req);
      const parsed = parseCommand(payload.command);

      if (parsed.type === 'generate') {
        const job = await handleGenerate(parsed);
        return json(res, 200, { ok: true, action: 'generate', job });
      }
      if (parsed.type === 'reveal') {
        await openPath(STORAGE_DIR);
        return json(res, 200, { ok: true, action: 'reveal' });
      }
      if (parsed.type === 'open') {
        const job = jobById(parsed.id);
        if (!job?.filePath) throw new Error('找不到图片文件');
        await openPath(job.filePath);
        return json(res, 200, { ok: true, action: 'open', id: parsed.id });
      }
      if (parsed.type === 'delete') {
        await deleteJob(parsed.id);
        return json(res, 200, { ok: true, action: 'delete', id: parsed.id });
      }
      if (parsed.type === 'rerun') {
        const job = await rerunJob(parsed.id);
        return json(res, 200, { ok: true, action: 'rerun', job });
      }
      return json(res, 200, { ok: true, action: 'noop' });
    } catch (error) {
      return json(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/generate') {
    try {
      const payload = await readJson(req);
      const job = await handleGenerate(payload);
      return json(res, 200, { ok: true, job });
    } catch (error) {
      return json(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/reveal') {
    await openPath(STORAGE_DIR);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/jobs/')) {
    const id = pathname.split('/').pop();
    try {
      await deleteJob(id);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  if (req.method === 'POST' && pathname.startsWith('/api/jobs/') && pathname.endsWith('/rerun')) {
    const id = pathname.split('/')[3];
    try {
      const job = await rerunJob(id);
      return json(res, 200, { ok: true, job });
    } catch (error) {
      return json(res, 400, { ok: false, error: error?.message || String(error) });
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/images/')) {
    const file = pathname.replace('/images/', '');
    const filePath = path.join(STORAGE_DIR, file);
    if (!(await exists(filePath))) return sendText(res, 404, 'Not found');
    const data = await fs.readFile(filePath);
    const ext = path.extname(file).slice(1).toLowerCase();
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    return res.end(data);
  }

  return sendText(res, 404, 'Not found');
}

await loadState();
await scanGallery();
sortJobs();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    json(res, 500, { ok: false, error: error?.message || String(error) });
  });
});

server.listen(PORT, () => {
  console.log(`Ark Workbench running at http://localhost:${PORT}`);
  console.log(`Storage: ${STORAGE_DIR}`);
  if (!ARK_API_KEY) {
    console.log('Warning: ARK_API_KEY is not set.');
  }
});
