/**
 * DeepSeek 层（服务端版）
 *
 * 规则都放在 shared/prompt-core.mjs 里，和静态站共用同一份；
 * 这里只负责带 Key 发请求，以及把各种失败翻译成中文。
 */
import { config } from './config.js';
import { buildMessages, localPrompt, readModelReply } from '../shared/prompt-core.mjs';

export { localPrompt };

export async function buildPrompt({ painter, facts, note, strength }) {
  const fallback = localPrompt({ painter, facts, note, strength });

  if (!config.deepseek.configured) {
    return { ...fallback, notice: '未配置 DEEPSEEK_API_KEY，画稿由本地规则生成。' };
  }

  let payload;
  try {
    const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseek.key}`,
      },
      body: JSON.stringify({
        model: config.deepseek.model,
        messages: buildMessages({ painter, facts, note, strength }),
        temperature: config.deepseek.temperature,
        max_tokens: 700,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(config.deepseek.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const reason =
        res.status === 401
          ? 'DEEPSEEK_API_KEY 无效或已过期'
          : res.status === 402
            ? 'DeepSeek 账户余额不足'
            : res.status === 429
              ? 'DeepSeek 请求过于频繁'
              : `DeepSeek 返回 ${res.status}`;
      return { ...fallback, notice: `${reason}，已改用本地画稿。${body.slice(0, 160)}` };
    }

    payload = await res.json();
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ...fallback,
      notice: timeout
        ? 'DeepSeek 响应超时，已改用本地画稿。'
        : `连接 DeepSeek 失败（${err.message}），已改用本地画稿。`,
    };
  }

  const result = readModelReply(payload?.choices?.[0]?.message?.content || '', fallback);
  return { ...result, model: config.deepseek.model };
}
