/**
 * 配置读取：.env 文件 + 进程环境变量，环境变量优先。
 * 所有 Key 只存在于服务端，永远不会出现在发给浏览器的 JSON 里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 极简 .env 解析：KEY=VALUE，# 注释，值两侧引号可省 */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile(path.join(ROOT, '.env'));
const pick = (key, fallback = '') => {
  const value = process.env[key] ?? fileEnv[key];
  return value === undefined || value === '' ? fallback : value;
};
const int = (key, fallback) => {
  const value = Number.parseInt(pick(key, ''), 10);
  return Number.isFinite(value) ? value : fallback;
};

const imageProvider = pick('IMAGE_PROVIDER', 'openai-edit').toLowerCase();
const imageKey = pick('IMAGE_API_KEY');
const deepseekKey = pick('DEEPSEEK_API_KEY');

/** 图像模型是否可用：demo 模式或没有 Key 都算不可用，前端会自动退回本地笔触 */
const imageConfigured = imageProvider !== 'demo' && Boolean(imageKey);

export const config = {
  port: int('PORT', 5180),
  host: pick('HOST', '127.0.0.1'),
  maxUploadMb: int('MAX_UPLOAD_MB', 12),

  deepseek: {
    key: deepseekKey,
    baseUrl: pick('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: pick('DEEPSEEK_MODEL', 'deepseek-chat'),
    timeoutMs: int('DEEPSEEK_TIMEOUT_MS', 45000),
    temperature: Number(pick('DEEPSEEK_TEMPERATURE', '0.85')),
    configured: Boolean(deepseekKey),
  },

  image: {
    provider: imageProvider,
    key: imageKey,
    baseUrl: pick('IMAGE_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: pick('IMAGE_MODEL'),
    size: pick('IMAGE_SIZE'),
    sizeField: pick('IMAGE_SIZE_FIELD', 'size'),
    quality: pick('IMAGE_QUALITY'),
    /** openai-generate 模式下是否把参考图放进请求体（有的厂商不认这个字段） */
    passthrough: pick('IMAGE_PASSTHROUGH', 'true').toLowerCase() !== 'false',
    strength: Number(pick('IMAGE_STRENGTH', '0.62')),
    extra: pick('IMAGE_EXTRA_JSON'),
    timeoutMs: int('IMAGE_TIMEOUT_MS', 120000),
    configured: imageConfigured,
  },
};

/** 给 /api/health 的安全摘要：只透露「有没有配」，不透露 Key 本身 */
export function publicStatus() {
  const tail = (value) => (value ? `…${value.slice(-4)}` : '');
  return {
    deepseek: {
      configured: config.deepseek.configured,
      model: config.deepseek.configured ? config.deepseek.model : null,
      host: config.deepseek.configured ? new URL(config.deepseek.baseUrl).host : null,
      keyTail: tail(config.deepseek.key),
    },
    image: {
      configured: config.image.configured,
      provider: config.image.provider,
      model: config.image.configured ? config.image.model || defaultImageModel(config.image.provider) : null,
      host: config.image.configured ? safeHost(config.image.baseUrl) : null,
      keyTail: tail(config.image.key),
    },
    /** 没有图像模型时，前端仍可用内置笔触引擎出图 */
    localEngineAvailable: true,
  };
}

export function defaultImageModel(provider) {
  if (provider === 'stability') return 'sd3.5-large';
  if (provider === 'openai-edit') return 'gpt-image-1';
  return '';
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
