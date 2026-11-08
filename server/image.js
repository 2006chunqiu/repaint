/**
 * 图像模型适配层：四种 provider，统一输出成 data URL。
 *
 *   openai-edit      真正的图生图：multipart POST /images/edits（gpt-image-1 等）
 *   openai-generate  文生图接口，部分国内厂商接受 image 字段做参考图
 *   stability        Stability SD3.5 的 image-to-image
 *   demo             不出图，前端自动退回内置笔触引擎
 */
import { config, defaultImageModel } from './config.js';

export class PaintError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const MAX_REMOTE_BYTES = 16 * 1024 * 1024;

export function dataUrlToBuffer(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new PaintError('BAD_IMAGE', '收到的图片格式无法识别，请换一张重试。');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length < 1024) throw new PaintError('BAD_IMAGE', '图片太小或已损坏。');
  if (buffer.length > config.maxUploadMb * 1024 * 1024) {
    throw new PaintError('TOO_LARGE', `图片超过 ${config.maxUploadMb}MB，请先压缩。`);
  }
  return { buffer, mime: match[1] };
}

function bufferToDataUrl(buffer, mime) {
  return `data:${mime || 'image/png'};base64,${Buffer.from(buffer).toString('base64')}`;
}

function sizeFor(aspect) {
  if (config.image.size) return config.image.size;
  const ratio = Number(aspect) || 1;
  if (ratio > 1.15) return '1536x1024';
  if (ratio < 0.87) return '1024x1536';
  return '1024x1024';
}

function extraParams() {
  if (!config.image.extra) return {};
  try {
    const parsed = JSON.parse(config.image.extra);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new PaintError('BAD_CONFIG', 'IMAGE_EXTRA_JSON 不是合法 JSON，请检查 .env。');
  }
}

/** 把各家五花八门的返回统一成 data URL */
async function normalizeImageOutput(res) {
  const type = res.headers.get('content-type') || '';

  if (type.startsWith('image/')) {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_REMOTE_BYTES) throw new PaintError('TOO_LARGE', '模型返回的图片过大。');
    return bufferToDataUrl(buffer, type.split(';')[0]);
  }

  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PaintError('UPSTREAM', '图像模型返回了无法解析的内容。', text.slice(0, 300));
  }

  const item = body?.data?.[0] || body?.artifacts?.[0] || body?.images?.[0] || body?.image || null;
  if (!item) {
    throw new PaintError('UPSTREAM', '图像模型没有返回图片。', text.slice(0, 300));
  }

  if (typeof item === 'string' && item.startsWith('data:')) return item;
  if (typeof item === 'string' && /^https?:\/\//.test(item)) return await fetchAsDataUrl(item);
  if (item.b64_json || item.base64) {
    return bufferToDataUrl(Buffer.from(item.b64_json || item.base64, 'base64'), 'image/png');
  }
  if (typeof item?.url === 'string') return await fetchAsDataUrl(item.url);

  throw new PaintError('UPSTREAM', '图像模型的返回里找不到图片数据。', text.slice(0, 300));
}

async function fetchAsDataUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(config.image.timeoutMs) });
  if (!res.ok) throw new PaintError('UPSTREAM', `下载模型返回的图片失败（${res.status}）。`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_REMOTE_BYTES) throw new PaintError('TOO_LARGE', '模型返回的图片过大。');
  const mime = res.headers.get('content-type') || 'image/png';
  return bufferToDataUrl(buffer, mime.split(';')[0]);
}

function mapHttpError(status, text) {
  const detail = (text || '').slice(0, 400);
  if (status === 401 || status === 403) return new PaintError('IMAGE_INVALID_KEY', '图像模型的 Key 无效，或这个 Key 没有该模型的权限。', detail);
  if (status === 402) return new PaintError('IMAGE_NO_CREDIT', '图像模型账户余额不足。', detail);
  if (status === 429) return new PaintError('IMAGE_RATE_LIMIT', '图像模型限流了，等几秒再试。', detail);
  if (status === 404) return new PaintError('IMAGE_BAD_ENDPOINT', '图像接口地址不对，检查 IMAGE_BASE_URL 与 IMAGE_PROVIDER 是否匹配。', detail);
  if (status >= 400 && status < 500) return new PaintError('IMAGE_BAD_REQUEST', `图像模型拒绝了这次请求（${status}）。`, detail);
  return new PaintError('IMAGE_UPSTREAM', `图像模型服务出错（${status}）。`, detail);
}

function authHeader() {
  return { Authorization: `Bearer ${config.image.key}` };
}

async function runOpenAIImageEdit({ buffer, mime, prompt, facts }) {
  const form = new FormData();
  form.set('model', config.image.model || defaultImageModel('openai-edit'));
  form.set('prompt', prompt);
  form.set('image', new Blob([buffer], { type: mime }), 'reference.png');
  form.set('n', '1');
  const size = sizeFor(facts?.aspect);
  if (config.image.sizeField) form.set(config.image.sizeField, size);
  if (config.image.quality) form.set('quality', config.image.quality);
  for (const [key, value] of Object.entries(extraParams())) {
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const res = await fetch(`${config.image.baseUrl}/images/edits`, {
    method: 'POST',
    headers: authHeader(),
    body: form,
    signal: AbortSignal.timeout(config.image.timeoutMs),
  });
  if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));
  return normalizeImageOutput(res);
}

async function runOpenAIImageGenerate({ buffer, mime, prompt, facts }) {
  const size = sizeFor(facts?.aspect);
  const body = {
    model: config.image.model || undefined,
    prompt,
    n: 1,
    [config.image.sizeField || 'size']: size,
    ...extraParams(),
  };
  // 部分厂商（如硅基流动的 Kolors、智谱 CogView）在文生图接口里接受参考图
  if (config.image.passthrough) {
    body.image = `data:${mime};base64,${buffer.toString('base64')}`;
  }

  const res = await fetch(`${config.image.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.image.timeoutMs),
  });
  if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));
  return normalizeImageOutput(res);
}

async function runStability({ buffer, mime, prompt, facts }) {
  const form = new FormData();
  form.set('prompt', prompt);
  form.set('mode', 'image-to-image');
  form.set('model', config.image.model || defaultImageModel('stability'));
  form.set('image', new Blob([buffer], { type: mime }), 'reference.png');
  form.set('strength', String(Math.min(0.95, Math.max(0.1, config.image.strength))));
  form.set('output_format', 'png');
  for (const [key, value] of Object.entries(extraParams())) {
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  const res = await fetch(`${config.image.baseUrl}/v2beta/stable-image/generate/sd3`, {
    method: 'POST',
    headers: { ...authHeader(), Accept: 'image/*' },
    body: form,
    signal: AbortSignal.timeout(config.image.timeoutMs),
  });
  if (!res.ok) throw mapHttpError(res.status, await res.text().catch(() => ''));
  return normalizeImageOutput(res);
}

export async function paint({ dataUrl, prompt, facts }) {
  if (!config.image.configured) {
    throw new PaintError('IMAGE_NOT_CONFIGURED', '还没有配置图像模型，先用内置笔触引擎出图。');
  }
  const { buffer, mime } = dataUrlToBuffer(dataUrl);
  const args = { buffer, mime, prompt, facts };

  try {
    switch (config.image.provider) {
      case 'openai-edit':
        return await runOpenAIImageEdit(args);
      case 'openai-generate':
        return await runOpenAIImageGenerate(args);
      case 'stability':
        return await runStability(args);
      default:
        throw new PaintError(
          'BAD_CONFIG',
          `未知的 IMAGE_PROVIDER：${config.image.provider}，可选 openai-edit / openai-generate / stability / demo。`
        );
    }
  } catch (err) {
    if (err instanceof PaintError) throw err;
    const code = err?.cause?.code || err?.code || '';
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new PaintError(
        'IMAGE_TIMEOUT',
        `图像模型 ${Math.round(config.image.timeoutMs / 1000)} 秒内没有返回，可能模型在排队，或网络被阻断。`,
        code
      );
    }
    throw new PaintError(
      'IMAGE_NETWORK',
      `连不上图像模型（${config.image.baseUrl}）。检查 IMAGE_BASE_URL 是否可达。`,
      code || err?.message || ''
    );
  }
}
