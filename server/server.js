/**
 * 重描 · HTTP 服务
 * 零依赖：只用 Node 内置模块。负责静态文件、DeepSeek 画稿、图像模型转发。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, publicStatus, ROOT } from './config.js';
import { PAINTERS } from '../shared/painters.mjs';
import { getPainter, DEFAULT_PAINTER_ID } from '../shared/painters.mjs';
import { buildPrompt } from './prompt.js';
import { paint, PaintError } from './image.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  const limit = config.maxUploadMb * 1024 * 1024 + 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new PaintError('TOO_LARGE', `请求体超过 ${config.maxUploadMb}MB 上限。`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new PaintError('BAD_JSON', '请求体不是合法 JSON。'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  const base = rel.startsWith('/shared/') ? SHARED_DIR : PUBLIC_DIR;
  if (rel.startsWith('/shared/')) rel = rel.slice('/shared'.length);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.resolve(base, '.' + rel);
  if (!target.startsWith(base + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404, SECURITY_HEADERS).end('404');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const body = await fs.readFile(target);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
  });
  res.end(body);
}

async function handleInterpret(body) {
  const painter = getPainter(body.painterId) || getPainter(DEFAULT_PAINTER_ID);
  const strength = clamp01(body.strength);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
  const facts = sanitizeFacts(body.facts);

  const result = await buildPrompt({ painter, facts, note, strength });
  return {
    ok: true,
    painter: { id: painter.id, name: painter.name, latin: painter.latin, medium: painter.medium, label: painter.label },
    ...result,
  };
}

async function handlePaint(body) {
  const painter = getPainter(body.painterId) || getPainter(DEFAULT_PAINTER_ID);
  const facts = sanitizeFacts(body.facts);
  if (!body.dataUrl) throw new PaintError('BAD_IMAGE', '缺少图片数据。');
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : '';
  if (!prompt) throw new PaintError('BAD_PROMPT', '缺少画稿，请先生成画稿。');

  const image = await paint({ dataUrl: body.dataUrl, prompt, facts });
  return { ok: true, image, provider: config.image.provider, model: config.image.model || null, painter: painter.id };
}

/** 只接受结构化的量化特征，避免把任意大对象传进提示词 */
function sanitizeFacts(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const hue = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
  const palette = Array.isArray(facts.palette)
    ? facts.palette
        .slice(0, 6)
        .filter((c) => c && /^#[0-9a-fA-F]{6}$/.test(String(c.hex)))
        .map((c) => ({ hex: String(c.hex).toLowerCase(), ratio: clamp01(c.ratio) }))
    : [];
  const grid = Array.isArray(facts.grid)
    ? facts.grid.slice(0, 6).map((row) => (Array.isArray(row) ? row.slice(0, 6).map(clamp01) : []))
    : [];
  return {
    width: hue(facts.width, 20000),
    height: hue(facts.height, 20000),
    aspect: Math.max(0.1, Math.min(10, Number(facts.aspect) || 1)),
    meanLuma: clamp01(facts.meanLuma),
    contrast: clamp01(facts.contrast),
    warmth: Math.max(-1, Math.min(1, Number(facts.warmth) || 0)),
    palette,
    grid,
    lightFrom: typeof facts.lightFrom === 'string' ? facts.lightFrom.slice(0, 40) : '',
    subjects: typeof facts.subjects === 'string' ? facts.subjects.slice(0, 200) : '',
  };
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  try {
    if (route === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ...publicStatus(), painters: PAINTERS.length });
    }

    if (route === '/api/painters' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, painters: PAINTERS });
    }

    if (route === '/api/interpret' && req.method === 'POST') {
      const result = await handleInterpret(await readJsonBody(req));
      console.log(`  · 画稿 ${result.painter.id} ← ${result.source} (${Date.now() - started}ms)`);
      return sendJson(res, 200, result);
    }

    if (route === '/api/paint' && req.method === 'POST') {
      const result = await handlePaint(await readJsonBody(req));
      console.log(`  · 出图 ${result.painter} ← ${result.provider} (${Date.now() - started}ms)`);
      return sendJson(res, 200, result);
    }

    if (route.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, code: 'NO_ROUTE', message: '没有这个接口。' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS).end('Method Not Allowed');
      return;
    }

    return await serveStatic(req, res, route);
  } catch (err) {
    const status = err instanceof PaintError ? statusForCode(err.code) : 500;
    if (!(err instanceof PaintError)) console.error('  服务端异常：', err);
    else console.warn(`  · ${err.code}: ${err.message}`);
    if (!res.headersSent) {
      sendJson(res, status, {
        ok: false,
        code: err.code || 'INTERNAL',
        message: err.message || '服务器内部错误。',
        detail: err.detail || '',
      });
    } else {
      res.end();
    }
  }
});

function statusForCode(code) {
  if (code === 'TOO_LARGE') return 413;
  if (code === 'BAD_IMAGE' || code === 'BAD_JSON' || code === 'BAD_PROMPT') return 400;
  if (code === 'IMAGE_NOT_CONFIGURED') return 503;
  if (code === 'IMAGE_INVALID_KEY') return 502;
  if (code?.startsWith('IMAGE_')) return 502;
  if (code === 'BAD_CONFIG') return 500;
  return 500;
}

server.listen(config.port, config.host, () => {
  const status = publicStatus();
  const line = (label, ok, detail) =>
    `  ${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[33m—\u001b[0m'} ${label.padEnd(10)} ${detail}`;
  console.log('');
  console.log('  重描 · REPAINT');
  console.log(line('服务地址', true, `http://${config.host}:${config.port}`));
  console.log(
    line('DeepSeek', status.deepseek.configured, status.deepseek.configured ? `${status.deepseek.model} @ ${status.deepseek.host}` : '未配置，画稿走本地规则')
  );
  console.log(
    line(
      '图像模型',
      status.image.configured,
      status.image.configured ? `${status.image.provider} / ${status.image.model} @ ${status.image.host}` : '未配置，出图走内置笔触引擎'
    )
  );
  console.log('');
});
