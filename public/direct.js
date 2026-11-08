/**
 * 静态部署模式：浏览器直连 DeepSeek
 *
 * GitHub Pages 这类纯静态托管没有后端，Key 也不能写进仓库。
 * 所以改由访客自己在页面里填 Key，存在本机 localStorage，
 * 请求直接从浏览器发往 api.deepseek.com（该接口允许跨域）。
 */
import { buildMessages, localPrompt, readModelReply } from './shared/prompt-core.mjs';

const BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-chat';

async function callDeepSeek(key, body, timeoutMs) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function reasonFor(status) {
  if (status === 401) return 'Key 无效或已过期';
  if (status === 402) return 'DeepSeek 账户余额不足';
  if (status === 429) return '请求过于频繁，等几秒再试';
  return `DeepSeek 返回 ${status}`;
}

/** 写画稿 + 画签；没有 Key 或失败时返回本地兜底 */
export async function interpretDirect({ painter, facts, note, strength, key }) {
  const fallback = localPrompt({ painter, facts, note, strength });
  if (!key) return fallback;

  try {
    const res = await callDeepSeek(
      key,
      {
        model: MODEL,
        messages: buildMessages({ painter, facts, note, strength }),
        temperature: 0.85,
        max_tokens: 700,
        response_format: { type: 'json_object' },
      },
      60000
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ...fallback, notice: `${reasonFor(res.status)}，已改用本地画稿。${text.slice(0, 120)}` };
    }

    const payload = await res.json();
    return readModelReply(payload?.choices?.[0]?.message?.content || '', fallback);
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ...fallback,
      notice: timeout ? 'DeepSeek 响应超时，已改用本地画稿。' : `直连 DeepSeek 失败（${err.message}），已改用本地画稿。`,
    };
  }
}

/** 保存 Key 前先验一下，避免存进去一个错的 */
export async function verifyKey(key) {
  let res;
  try {
    res = await callDeepSeek(
      key,
      { model: MODEL, messages: [{ role: 'user', content: '只回一个字：好' }], max_tokens: 4 },
      20000
    );
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new Error(timeout ? '连接 DeepSeek 超时，检查网络后再试。' : `连不上 api.deepseek.com（${err.message}）。`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${reasonFor(res.status)}。${text.slice(0, 120)}`);
  }
  return true;
}
