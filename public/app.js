/**
 * 重描 · 前端主逻辑
 * 上传 → 量化照片 → 取画稿 → 落笔 → 上签
 */
import { PAINTERS, DEFAULT_PAINTER_ID, getPainter } from './shared/painters.mjs';
import { paintLocally, LOCAL_ENGINE_LABEL } from './demo-engine.js';
import { interpretDirect, verifyKey } from './direct.js';

const el = (id) => document.getElementById(id);

const dom = {
  statusBtn: el('statusBtn'),
  statusDot: el('statusDot'),
  statusText: el('statusText'),
  chips: el('chips'),
  note: el('note'),
  strength: el('strength'),
  strengthOut: el('strengthOut'),
  paintBtn: el('paintBtn'),
  resetBtn: el('resetBtn'),
  file: el('file'),
  pickBtn: el('pickBtn'),
  frame: el('frame'),
  emptyState: el('emptyState'),
  view: el('view'),
  imgOriginal: el('imgOriginal'),
  imgPainted: el('imgPainted'),
  peel: el('peel'),
  working: el('working'),
  workingTitle: el('workingTitle'),
  workingSub: el('workingSub'),
  placardWrap: el('placardWrap'),
  placard: document.querySelector('.placard'),
  plTitle: el('plTitle'),
  plPainter: el('plPainter'),
  plMedium: el('plMedium'),
  plYear: el('plYear'),
  plNote: el('plNote'),
  plPrompt: el('plPrompt'),
  plCredit: el('plCredit'),
  copyPrompt: el('copyPrompt'),
  downloadBtn: el('downloadBtn'),
  againBtn: el('againBtn'),
  history: el('history'),
  historyStrip: el('historyStrip'),
  sheet: el('sheet'),
  veil: el('veil'),
  sheetClose: el('sheetClose'),
  dsState: el('dsState'),
  imgState: el('imgState'),
  sheetNote: el('sheetNote'),
  serverPanel: el('serverPanel'),
  staticPanel: el('staticPanel'),
  keyInput: el('keyInput'),
  keySave: el('keySave'),
  keyClear: el('keyClear'),
  keyStatus: el('keyStatus'),
  toast: el('toast'),
};

const state = {
  painterId: localStorage.getItem('repaint.painter') || DEFAULT_PAINTER_ID,
  /** server：有后端（本地跑）；static：纯静态托管（如 GitHub Pages） */
  mode: 'unknown',
  directKey: localStorage.getItem('repaint.deepseekKey') || '',
  source: null,
  result: null,
  health: null,
  busy: false,
  keepsakes: [],
};

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const strengthValue = () => Number(dom.strength.value) / 100;

/* ------------------------------------------------------------ 画家选择 */

function renderChips() {
  dom.chips.replaceChildren();
  for (const painter of PAINTERS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.id = painter.id;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', 'false');
    chip.title = `${painter.name} · ${painter.label} · ${painter.desc}`;

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.setProperty('--s1', painter.strokes[0]);
    swatch.style.setProperty('--s2', painter.strokes[1]);

    const text = document.createElement('span');
    text.className = 'chip-text';
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = painter.name;
    const latin = document.createElement('span');
    latin.className = 'chip-latin';
    latin.textContent = painter.latin;
    text.append(name, latin);
    chip.append(swatch, text);

    chip.addEventListener('click', () => selectPainter(painter.id));
    dom.chips.append(chip);
  }
  selectPainter(state.painterId, { silent: true });
}

function selectPainter(id, { silent = false } = {}) {
  const painter = getPainter(id) || getPainter(DEFAULT_PAINTER_ID);
  state.painterId = painter.id;
  if (!silent) localStorage.setItem('repaint.painter', painter.id);
  for (const chip of dom.chips.children) {
    chip.setAttribute('aria-checked', String(chip.dataset.id === painter.id));
  }
  const daubs = document.querySelectorAll('.daubs i');
  [painter.strokes[0], painter.strokes[1], painter.strokes[0]].forEach((color, i) => {
    if (daubs[i]) daubs[i].style.setProperty('--daub', color);
  });
  updatePaintButton();
}

/* ------------------------------------------------------------ 连接状态 */

async function loadHealth() {
  try {
    const res = await fetch('./api/health', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    state.health = await res.json();
    state.mode = 'server';
  } catch {
    // 拿不到 /api/health 就认定是纯静态托管，改走浏览器直连
    state.health = null;
    state.mode = 'static';
  }
  renderHealth();
}

function renderHealth() {
  const isStatic = state.mode === 'static';
  const ds = isStatic ? Boolean(state.directKey) : Boolean(state.health?.deepseek?.configured);
  const img = isStatic ? false : Boolean(state.health?.image?.configured);

  dom.serverPanel.hidden = isStatic;
  dom.staticPanel.hidden = !isStatic;

  if (state.mode === 'unknown') {
    dom.statusDot.dataset.state = 'unknown';
    dom.statusText.textContent = '正在检查连接';
    return;
  }

  if (isStatic) {
    dom.statusDot.dataset.state = ds ? 'ok' : 'warn';
    dom.statusText.textContent = ds ? '静态版 · DeepSeek 已连' : '静态版 · 内置笔触';
    dom.dsState.textContent = ds ? `已连接 · 浏览器直连 · 尾号 …${state.directKey.slice(-4)}` : '未填 Key · 画稿走本地规则';
    dom.dsState.dataset.ok = String(ds);
    dom.imgState.textContent = '静态版不调用图像模型';
    dom.imgState.dataset.ok = 'false';
    dom.sheetNote.textContent = ds
      ? '画稿与画签由 DeepSeek 在浏览器里直接写成，落笔由内置笔触引擎完成。'
      : '这是纯静态站点，没有后端。填入 DeepSeek Key 就能让真模型写画稿与画签；不填也能出图，只是画稿由内置规则拼。';
    renderKeyPanel();
    return;
  }

  if (!state.health) {
    dom.statusDot.dataset.state = 'off';
    dom.statusText.textContent = '服务未连接';
    dom.dsState.textContent = '未连接';
    dom.imgState.textContent = '未连接';
    dom.dsState.dataset.ok = 'false';
    dom.imgState.dataset.ok = 'false';
    dom.sheetNote.textContent = '连不上本地服务。确认终端里的 node 进程还在跑，再刷新这一页。';
    return;
  }

  dom.statusDot.dataset.state = ds && img ? 'ok' : 'warn';
  dom.statusText.textContent = ds && img ? 'DeepSeek + 图像模型' : ds ? '图像模型未配置' : img ? 'DeepSeek 未配置' : '演示笔触模式';

  const dsInfo = state.health.deepseek;
  const imgInfo = state.health.image;
  dom.dsState.textContent = ds ? `已连接 · ${dsInfo.model} · ${dsInfo.keyTail}` : '未配置 · 画稿走本地规则';
  dom.dsState.dataset.ok = String(ds);
  dom.imgState.textContent = img ? `已连接 · ${imgInfo.provider} · ${imgInfo.model || '默认模型'}` : '未配置 · 出图走内置笔触';
  dom.imgState.dataset.ok = String(img);

  dom.sheetNote.textContent = img
    ? '两层都接上了。画稿由 DeepSeek 写，落笔由图像模型完成。'
    : '图像模型还没接上，现在出图由内置笔触引擎完成。填好 .env 里的 IMAGE_* 四项并重启服务，就会自动换成真模型。';
}

/* ------------------------------------------------------------ 静态模式的 Key */

function renderKeyPanel() {
  const has = Boolean(state.directKey);
  dom.keyInput.placeholder = has ? `已保存 …${state.directKey.slice(-4)}，粘贴新 Key 可替换` : 'sk-…';
  dom.keyStatus.textContent = has ? 'Key 已保存在这台设备的浏览器里。' : '还没有填 Key，画稿与画签会由内置规则生成。';
  dom.keyClear.hidden = !has;
}

async function saveKey() {
  const value = dom.keyInput.value.trim();
  if (!value) {
    showToast('先把 Key 粘进来。', 'error');
    return;
  }
  if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(value)) {
    showToast('这不像 DeepSeek 的 Key，它通常以 sk- 开头。', 'error');
    return;
  }

  dom.keySave.disabled = true;
  dom.keySave.textContent = '验证中';
  try {
    await verifyKey(value);
    state.directKey = value;
    localStorage.setItem('repaint.deepseekKey', value);
    dom.keyInput.value = '';
    renderHealth();
    showToast('Key 可用。画稿和画签现在由 DeepSeek 来写。');
  } catch (err) {
    showToast(err.message || '这个 Key 没通过验证。', 'error');
  } finally {
    dom.keySave.disabled = false;
    dom.keySave.textContent = '保存并验证';
  }
}

function clearKey() {
  state.directKey = '';
  localStorage.removeItem('repaint.deepseekKey');
  dom.keyInput.value = '';
  renderHealth();
  showToast('已清除这台设备上的 Key。');
}

/* ------------------------------------------------------------ 读图 */

function computeFacts(canvas, width, height) {
  const S = 80;
  const small = document.createElement('canvas');
  small.width = S;
  small.height = S;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, S, S);
  const { data } = ctx.getImageData(0, 0, S, S);

  const buckets = new Map();
  const grid = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const gridCount = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  let lumaSum = 0;
  let lumaSq = 0;
  let warmth = 0;
  const total = S * S;

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const i = (y * S + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      lumaSum += l;
      lumaSq += l * l;
      warmth += (r - b) / 255;

      const grow = Math.min(3, (y / (S / 4)) | 0);
      const gcol = Math.min(3, (x / (S / 4)) | 0);
      grid[grow][gcol] += l;
      gridCount[grow][gcol] += 1;

      // 5 bit 分桶，先把相近的颜色归到一起
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n += 1;
      buckets.set(key, bucket);
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const picked = [];
  for (const bucket of sorted) {
    const rgb = [bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n];
    const distinct = picked.every((p) => Math.hypot(p[0] - rgb[0], p[1] - rgb[1], p[2] - rgb[2]) > 42);
    if (!distinct) continue;
    picked.push(rgb);
    if (picked.length >= 5) break;
  }

  const meanLuma = lumaSum / total;
  const variance = Math.max(0, lumaSq / total - meanLuma * meanLuma);

  return {
    width,
    height,
    aspect: width / height,
    meanLuma: Number(meanLuma.toFixed(3)),
    contrast: Number(Math.sqrt(variance).toFixed(3)),
    warmth: Number((warmth / total).toFixed(3)),
    palette: picked
      .map((rgb, index) => ({
        hex: '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''),
        ratio: Number((sorted[index]?.n / total || 1 / picked.length).toFixed(3)),
      }))
      .sort((a, b) => b.ratio - a.ratio),
    grid: grid.map((row, r) => row.map((sum, c) => Number((sum / gridCount[r][c]).toFixed(3)))),
  };
}

async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('这张图片读不出来，换一张试试。'));
    image.src = url;
  });

  const MAX = 1600;
  const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(2, Math.round(img.naturalWidth * scale));
  const height = Math.max(2, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(url);

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.92),
    width,
    height,
    aspect: width / height,
    facts: computeFacts(canvas, width, height),
  };
}

async function handleFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('这不是图片文件。JPG、PNG、WebP 都可以。', 'error');
    return;
  }
  if (file.size > 24 * 1024 * 1024) {
    showToast('照片超过 24MB，先压缩一下再传。', 'error');
    return;
  }
  try {
    const prepared = await prepareImage(file);
    state.source = prepared;
    state.result = null;

    dom.imgOriginal.src = prepared.dataUrl;
    dom.imgPainted.removeAttribute('src');
    setPos(50);
    dom.frame.style.setProperty('--frame-aspect', `${clamp(prepared.aspect, 0.62, 1.9)}`);
    dom.placardWrap.hidden = true;
    dom.resetBtn.hidden = false;
    setFrameState('view');
    updatePaintButton();
    dom.paintBtn.focus({ preventScroll: true });
  } catch (err) {
    showToast(err.message || '这张图片读不出来。', 'error');
  }
}

/* ------------------------------------------------------------ 作画 */

async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 保留 data 为 null */
    }
    if (!res.ok || !data?.ok) {
      const error = new Error(data?.message || `请求失败（${res.status}）`);
      error.code = data?.code;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function paint() {
  if (!state.source || state.busy) return;
  const painter = getPainter(state.painterId);
  const hadResult = Boolean(state.result);
  const notices = [];

  state.busy = true;
  dom.paintBtn.disabled = true;
  dom.paintBtn.textContent = '正在作画';
  dom.againBtn.disabled = true;
  dom.workingTitle.textContent = '正在读你的照片';
  dom.workingSub.textContent = '量明暗、取主色、看构图';
  setFrameState('working');

  try {
    await nextFrame();

    const deepseekReady =
      state.mode === 'server' ? Boolean(state.health?.deepseek?.configured) : Boolean(state.directKey);
    dom.workingTitle.textContent = deepseekReady ? '正在请 DeepSeek 写画稿' : '正在按画家档案排画稿';
    dom.workingSub.textContent = `${painter.name}：${painter.desc}`;
    await nextFrame();

    const note = dom.note.value.trim();
    const strength = strengthValue();
    const interp =
      state.mode === 'static'
        ? await interpretDirect({ painter, facts: state.source.facts, note, strength, key: state.directKey })
        : await postJson('./api/interpret', {
            painterId: painter.id,
            note,
            strength,
            facts: state.source.facts,
          });
    if (interp.notice) notices.push(interp.notice);

    let painted = null;
    let provider = LOCAL_ENGINE_LABEL;

    if (state.health?.image?.configured) {
      dom.workingTitle.textContent = '正在下笔';
      dom.workingSub.textContent = '图像模型照着你的照片重画';
      await nextFrame();
      try {
        const out = await postJson('./api/paint', {
          painterId: painter.id,
          prompt: interp.prompt,
          dataUrl: state.source.dataUrl,
          facts: state.source.facts,
        });
        painted = out.image;
        provider = out.model ? `${out.provider} · ${out.model}` : out.provider;
      } catch (err) {
        notices.push(`${err.message}这次改由内置笔触引擎完成。`);
      }
    }

    if (!painted) {
      dom.workingTitle.textContent = '正在下笔';
      dom.workingSub.textContent = '内置笔触引擎：铺色、压笔、上光';
      await nextFrame();
      painted = await paintLocally(state.source.dataUrl, painter, { strength: strengthValue() });
    }

    state.result = {
      dataUrl: painted,
      title: interp.title,
      label: interp.label,
      prompt: interp.prompt,
      painterId: painter.id,
      provider,
      source: interp.source,
    };

    renderResult();
    rememberKeepsake(state.result);
    if (notices.length) showToast(notices[0]);
  } catch (err) {
    setFrameState(hadResult ? 'result' : 'view');
    showToast(err.message || '作画失败了，再试一次。', 'error');
  } finally {
    state.busy = false;
    dom.againBtn.disabled = false;
    updatePaintButton();
  }
}

function updatePaintButton() {
  if (state.busy) return;
  const painterChanged = state.result && state.result.painterId !== state.painterId;
  dom.paintBtn.textContent = painterChanged ? '换这位画家重画' : state.result ? '再画一张' : '开始作画';
  dom.paintBtn.disabled = !state.source;
}

/* ------------------------------------------------------------ 结果 */

function renderResult() {
  const result = state.result;
  const painter = getPainter(result.painterId);

  dom.imgPainted.src = result.dataUrl;
  dom.view.hidden = false;
  setFrameState('result');
  dom.placardWrap.hidden = false;
  dom.placard.style.setProperty('--pl-pigment', painter.strokes[0]);

  dom.plTitle.textContent = result.title;
  dom.plPainter.textContent = `${painter.name}　${painter.latin}`;
  dom.plMedium.textContent = `${painter.medium}（数字）`;
  dom.plYear.textContent = String(new Date().getFullYear());
  dom.plNote.textContent = result.label;
  dom.plPrompt.textContent = result.prompt;
  dom.plCredit.textContent = `画签由 ${result.source === 'deepseek' ? 'DeepSeek' : '本地规则'} 撰写 · 笔触由 ${result.provider} 绘制`;

  revealPainting();
}

function setPos(value) {
  const v = clamp(Number(value), 0, 100);
  dom.view.style.setProperty('--pos', `${v}%`);
  if (dom.peel.value !== String(Math.round(v))) dom.peel.value = String(Math.round(v));
  dom.peel.setAttribute('aria-valuetext', `${Math.round(v)}% 画作`);
}

function revealPainting() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setPos(50);
    return;
  }
  const from = 100;
  const to = 50;
  const duration = 720;
  const start = performance.now();
  setPos(from);
  const step = (now) => {
    const k = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    setPos(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setFrameState(next) {
  dom.frame.dataset.state = next;
  dom.emptyState.hidden = next !== 'empty';
  dom.working.hidden = next !== 'working';
  dom.view.hidden = !(next === 'view' || next === 'result' || next === 'working');
}

/* ------------------------------------------------------------ 手稿 */

function rememberKeepsake(result) {
  state.keepsakes.unshift(result);
  state.keepsakes = state.keepsakes.slice(0, 8);
  dom.historyStrip.replaceChildren();
  for (const item of state.keepsakes) {
    const painter = getPainter(item.painterId);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'keepsake';
    button.title = `${item.title} · ${painter.name}`;
    const img = document.createElement('img');
    img.src = item.dataUrl;
    img.alt = item.title;
    const caption = document.createElement('span');
    caption.textContent = painter.name;
    button.append(img, caption);
    button.addEventListener('click', () => {
      state.result = item;
      selectPainter(item.painterId, { silent: true });
      renderResult();
      dom.placardWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    dom.historyStrip.append(button);
  }
  dom.history.hidden = state.keepsakes.length === 0;
}

/* ------------------------------------------------------------ 下载与复制 */

function download() {
  if (!state.result) return;
  const painter = getPainter(state.result.painterId);
  const ext = state.result.dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
  const safeTitle = state.result.title.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 24) || '画作';
  const link = document.createElement('a');
  link.href = state.result.dataUrl;
  link.download = `重描-${painter.name}-${safeTitle}.${ext}`;
  document.body.append(link);
  link.click();
  link.remove();
  showToast('画作已存到下载文件夹。');
}

async function copyPrompt() {
  if (!state.result) return;
  try {
    await navigator.clipboard.writeText(state.result.prompt);
    showToast('画稿已复制。');
  } catch {
    showToast('浏览器不允许自动复制，可以手动选中。', 'error');
  }
}

/* ------------------------------------------------------------ 提示条 */

let toastTimer = 0;
function showToast(message, kind = 'info') {
  dom.toast.textContent = message;
  dom.toast.dataset.kind = kind;
  dom.toast.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.dataset.show = 'false';
  }, kind === 'error' ? 7000 : 4200);
}

/* ------------------------------------------------------------ 配置抽屉 */

function openSheet() {
  dom.sheet.dataset.open = 'true';
  dom.veil.dataset.open = 'true';
  dom.sheet.setAttribute('aria-hidden', 'false');
  dom.statusBtn.setAttribute('aria-expanded', 'true');
  dom.sheetClose.focus();
}

function closeSheet() {
  dom.sheet.dataset.open = 'false';
  dom.veil.dataset.open = 'false';
  dom.sheet.setAttribute('aria-hidden', 'true');
  dom.statusBtn.setAttribute('aria-expanded', 'false');
  dom.statusBtn.focus();
}

/* ------------------------------------------------------------ 事件绑定 */

function reset() {
  state.source = null;
  state.result = null;
  dom.imgOriginal.removeAttribute('src');
  dom.imgPainted.removeAttribute('src');
  dom.frame.style.removeProperty('--frame-aspect');
  dom.placardWrap.hidden = true;
  dom.resetBtn.hidden = true;
  dom.file.value = '';
  dom.note.value = '';
  setFrameState('empty');
  updatePaintButton();
  dom.pickBtn.focus({ preventScroll: true });
}

function bindEvents() {
  dom.pickBtn.addEventListener('click', () => dom.file.click());
  dom.file.addEventListener('change', (event) => handleFile(event.target.files?.[0]));

  dom.paintBtn.addEventListener('click', paint);
  dom.againBtn.addEventListener('click', paint);
  dom.resetBtn.addEventListener('click', reset);
  dom.downloadBtn.addEventListener('click', download);
  dom.copyPrompt.addEventListener('click', copyPrompt);

  dom.keySave.addEventListener('click', saveKey);
  dom.keyClear.addEventListener('click', clearKey);
  dom.keyInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveKey();
  });

  dom.peel.addEventListener('input', (event) => setPos(event.target.value));

  dom.strength.addEventListener('input', () => {
    dom.strengthOut.textContent = strengthValue().toFixed(2);
  });

  // 拖拽
  for (const type of ['dragenter', 'dragover']) {
    dom.frame.addEventListener(type, (event) => {
      event.preventDefault();
      dom.frame.classList.add('is-drag');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    dom.frame.addEventListener(type, () => dom.frame.classList.remove('is-drag'));
  }
  dom.frame.addEventListener('drop', (event) => {
    event.preventDefault();
    dom.frame.classList.remove('is-drag');
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  // 粘贴
  document.addEventListener('paste', (event) => {
    const item = [...(event.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (file) handleFile(file);
  });

  // 配置抽屉
  dom.statusBtn.addEventListener('click', openSheet);
  dom.sheetClose.addEventListener('click', closeSheet);
  dom.veil.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dom.sheet.dataset.open === 'true') closeSheet();
  });

  // 画家组的方向键
  dom.chips.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const index = PAINTERS.findIndex((p) => p.id === state.painterId);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = PAINTERS[(index + delta + PAINTERS.length) % PAINTERS.length];
    event.preventDefault();
    selectPainter(next.id);
    dom.chips.querySelector(`[data-id="${next.id}"]`)?.focus();
  });
}

/* ------------------------------------------------------------ 启动 */

renderChips();
bindEvents();
dom.strengthOut.textContent = strengthValue().toFixed(2);
updatePaintButton();
loadHealth();

// 打字机式的手感细节：切走再回来，把手稿留在原处即可，不做额外处理
window.addEventListener('beforeunload', (event) => {
  if (state.busy) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// ?demo=1 → 用自带示例照片跑一遍完整流程，方便快速看效果
if (new URLSearchParams(location.search).has('demo')) {
  fetch('./sample.jpg')
    .then((res) => {
      if (!res.ok) throw new Error('没有示例照片');
      return res.blob();
    })
    .then((blob) => handleFile(new File([blob], 'sample.jpg', { type: 'image/jpeg' })))
    .then(() => paint())
    .catch(() => {
      /* 示例照片缺失时静默，不影响正常使用 */
    });
}
