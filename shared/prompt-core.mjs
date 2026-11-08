/**
 * 画稿规则核心 · 前后端共用
 *
 * 这里只有纯函数：怎么把「画家档案 + 照片量化特征 + 用户一句话」编译成
 * 给 DeepSeek 的消息，以及怎么解析它返回的 JSON。
 * 不含任何 Node 或浏览器专有 API，所以服务端和静态站都能直接 import。
 */

export const SYSTEM = `你是一位在美术馆工作多年的艺术总监，职责是替一位画家写「作画指令」。

你会收到三样东西：
1. 一位画家的笔法档案（英文）
2. 一张照片的量化特征：主色、明暗分布、构图比例
3. 用户可能留下的一句话要求

你要输出严格的 JSON，只有三个字段：
{
  "title": "中文画作标题，6 到 14 个字，像真画册里的名字，不要引号、不要解释",
  "prompt": "英文，60 到 90 个单词，写给图像生成模型",
  "label": "中文画签，一到两句，40 到 70 字，用美术馆展签的语气说明这位画家对这张照片做了什么"
}

prompt 的写法要求：
- 以画家档案里的媒材与笔法为骨架，再嵌入这张照片真实的主色和明暗结构
- 必须明确说明：以参考照片的构图与主体为准，不要另起炉灶编一个新场景
- 只描述画面：媒材、笔触、光、色调、质感、构图处理
- 不要出现 "photo of"、"a picture of"、"8k"、"trending on artstation"、"masterpiece" 这类空话
- 不要出现文字、签名、水印、边框

label 的写法要求：
- 不要复述 prompt，不要用「这幅画展现了」开头
- 说清楚保留了什么、改写了什么
- 不要套用任何固定句式或现成的说法，每一句都要针对这一张照片重新想

只输出 JSON，不要代码块，不要任何额外说明。`;

/** 把量化特征渲染成一段模型能读的文字 */
export function factsToText(facts) {
  if (!facts) return '（没有图像特征，请按画家档案自由发挥）';
  const lines = [];
  const orient = facts.aspect >= 1.15 ? '横向' : facts.aspect <= 0.87 ? '纵向' : '方形';
  lines.push(`构图：${orient}，宽高比 ${Number(facts.aspect || 1).toFixed(2)}`);
  if (Array.isArray(facts.palette) && facts.palette.length) {
    lines.push(
      `主色：${facts.palette.map((c) => `${c.hex}（约占 ${Math.round((c.ratio || 0) * 100)}%）`).join('、')}`
    );
  }
  if (typeof facts.warmth === 'number') {
    lines.push(
      `色温：${facts.warmth > 0.12 ? '偏暖' : facts.warmth < -0.12 ? '偏冷' : '中性'}（${facts.warmth.toFixed(2)}）`
    );
  }
  if (typeof facts.meanLuma === 'number') {
    lines.push(
      `整体明度：${facts.meanLuma.toFixed(2)}（0 为全黑，1 为全白），对比度 ${Number(facts.contrast || 0).toFixed(2)}`
    );
  }
  if (Array.isArray(facts.grid) && facts.grid.length) {
    lines.push('明暗分布（从左到右、从上到下，0 为最暗 1 为最亮）：');
    for (const row of facts.grid) {
      lines.push('  ' + row.map((v) => Number(v).toFixed(2)).join('  '));
    }
    const flat = facts.grid.flat();
    let maxI = 0;
    flat.forEach((v, i) => {
      if (v > flat[maxI]) maxI = i;
    });
    const cols = facts.grid[0].length;
    const rowName = ['上', '上中', '中', '下中', '下'][Math.floor(maxI / cols)] || '中';
    const colName = ['左', '中左', '中', '中右', '右'][maxI % cols] || '中';
    lines.push(`最亮处位于画面${rowName}${colName}一侧，可据此安排光源方向`);
  }
  if (facts.subjects) lines.push(`用户描述的画面内容：${facts.subjects}`);
  return lines.join('\n');
}

export function strengthWord(strength) {
  const s = Number.isFinite(strength) ? strength : 0.62;
  if (s < 0.4) return '贴近原照：严格保留主体轮廓、透视与细节层级，只替换媒材与笔触。';
  if (s < 0.72) return '中度改写：保留构图与主体识别度，允许笔触与色彩自由发挥。';
  return '大胆重画：可以把形体拆解、简化、变形，让画家的语言占主导。';
}

/** 无 Key / 调用失败时的本地兜底画稿，保证功能永远不空转 */
export function localPrompt({ painter, facts, note, strength }) {
  const palette = (facts?.palette || []).slice(0, 4).map((c) => c.hex).join(', ');
  const bits = [painter.stylePrompt];
  if (palette) bits.push(`Colour anchored to the reference palette: ${palette}.`);
  bits.push(
    `Keep the composition and subject of the reference image; repaint it, do not invent a new scene. Light coming from ${
      facts?.lightFrom || 'the upper left'
    }.`
  );
  if (note) bits.push(`Additional direction from the sender: ${note}.`);
  if (Number(strength) >= 0.72) bits.push('Push the stylisation hard, let the brushwork dominate.');
  return {
    title: `${painter.name}笔下的这一刻`,
    prompt: bits.join(' '),
    label: `按${painter.label}的路数重画这张照片：${painter.desc}。构图与主体留在原处，颜料换了一套。`,
    source: 'local',
  };
}

/** 组装发给 DeepSeek 的两条消息 */
export function buildMessages({ painter, facts, note, strength }) {
  const userMessage = [
    `【画家档案】${painter.name}（${painter.latin}，${painter.years}，${painter.medium}，${painter.label}）`,
    painter.stylePrompt,
    '',
    '【照片特征】',
    factsToText(facts),
    '',
    `【风格强度】${Number(strength).toFixed(2)} → ${strengthWord(strength)}`,
    note ? `【用户要求】${note}` : '【用户要求】无',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userMessage },
  ];
}

/** DeepSeek 偶尔会包一层 ```json，这里宽容地剥掉 */
export function parseModelJson(text) {
  if (!text) return null;
  const withoutFence = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  const end = withoutFence.lastIndexOf('}');
  const candidates = [withoutFence];
  if (withoutFence.indexOf('{') >= 0 && end > 0) {
    candidates.push(withoutFence.slice(withoutFence.indexOf('{'), end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  return null;
}

export function cleanField(value, fallback, max) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/^["'「『《]|["'」』》]$/g, '');
  return trimmed ? trimmed.slice(0, max) : fallback;
}

/**
 * 把模型返回的原始文本整理成最终结果。
 * 解析失败时退回本地画稿，并说明原因。
 */
export function readModelReply(raw, fallback) {
  const parsed = parseModelJson(raw);
  if (!parsed || typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) {
    return { ...fallback, notice: 'DeepSeek 返回的画稿格式不对，已改用本地画稿。' };
  }
  return {
    title: cleanField(parsed.title, fallback.title, 40),
    prompt: cleanField(parsed.prompt, fallback.prompt, 1200),
    label: cleanField(parsed.label, fallback.label, 300),
    source: 'deepseek',
  };
}
