/**
 * 内置笔触引擎
 *
 * 没有配置图像模型时，浏览器用 Canvas 现场重画一遍：
 * 压掉照片细节 → 把颜色收进画家的调色盘 → 铺笔触 / 拆棱面 / 分墨阶 → 上罩染与纹理。
 *
 * 一条经验：让人看出是「谁的画」，调色盘的改写比笔触形状更管用。
 * 所以每套画法都先大幅改色，再用笔触把形体重新搭起来。
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 画面显示宽度通常不到 1000px，按 1100 渲染足够，还能省一半算力 */
const MAX_SIDE = 1100;

function toRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

function samplePixel(data, w, h, x, y) {
  const px = clamp(x | 0, 0, w - 1);
  const py = clamp(y | 0, 0, h - 1);
  const i = (py * w + px) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function lumaAt(data, w, h, x, y) {
  const [r, g, b] = samplePixel(data, w, h, x, y);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/* ---------------------------------------------------------------- 色彩 */

function grade(ctx, w, h, { saturation = 1, contrast = 1, brightness = 0, warmth = 0 } = {}) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    if (saturation !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * saturation;
      g = l + (g - l) * saturation;
      b = l + (b - l) * saturation;
    }
    if (contrast !== 1) {
      r = (r - 128) * contrast + 128;
      g = (g - 128) * contrast + 128;
      b = (b - 128) * contrast + 128;
    }
    if (brightness) {
      r += brightness * 255;
      g += brightness * 255;
      b += brightness * 255;
    }
    if (warmth) {
      r += warmth * 22;
      g += warmth * 7;
      b -= warmth * 22;
    }
    d[i] = clamp(r, 0, 255);
    d[i + 1] = clamp(g, 0, 255);
    d[i + 2] = clamp(b, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 把像素往画家调色盘上拉。
 * 用的是「按亮度分档 + 就近取色」的混合策略：既保住明暗结构，又把色相锁定在画家的色域里。
 */
function remapPalette(ctx, w, h, palette, amount) {
  const targets = palette.map(toRgb);
  // 按亮度给调色盘排好序，方便按明暗档位取色
  const ramps = targets
    .map((rgb) => ({ rgb, l: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] }))
    .sort((a, b) => a.l - b.l)
    .map((x) => x.rgb);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

    // 先按明暗比重在调色盘里找同档位的颜色
    const slot = clamp(Math.round(l * (ramps.length - 1)), 0, ramps.length - 1);
    const around = ramps.slice(Math.max(0, slot - 1), Math.min(ramps.length, slot + 2));
    let pick = around[0];
    let bestDist = Infinity;
    for (const candidate of around) {
      const dr = r - candidate[0];
      const dg = g - candidate[1];
      const db = b - candidate[2];
      const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (dist < bestDist) {
        bestDist = dist;
        pick = candidate;
      }
    }

    d[i] = r + (pick[0] - r) * amount;
    d[i + 1] = g + (pick[1] - g) * amount;
    d[i + 2] = b + (pick[2] - b) * amount;
  }
  ctx.putImageData(img, 0, 0);
}

function softBlur(ctx, w, h, radius, amount = 1) {
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const t = tmp.getContext('2d');
  t.filter = `blur(${radius}px)`;
  t.drawImage(ctx.canvas, 0, 0);
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

/* ---------------------------------------------------------------- 笔触 */

function drawStroke(ctx, x, y, angle, len, width, color, alpha, curl, highlight) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgb(${color[0] | 0},${color[1] | 0},${color[2] | 0})`;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(-len / 2, 0);
  ctx.quadraticCurveTo(0, curl * len * 0.34, len / 2, 0);
  ctx.stroke();

  if (highlight) {
    // 厚涂的提亮：只压一小部分笔触，颜色取笔触本身的亮部而不是纯白
    const hl = color.map((v) => clamp(v + 46, 0, 255));
    ctx.globalAlpha = alpha * 0.5;
    ctx.strokeStyle = `rgb(${hl[0] | 0},${hl[1] | 0},${hl[2] | 0})`;
    ctx.lineWidth = Math.max(0.8, width * 0.34);
    ctx.beginPath();
    ctx.moveTo(-len * 0.4, -width * 0.22);
    ctx.quadraticCurveTo(0, curl * len * 0.34 - width * 0.22, len * 0.4, -width * 0.22);
    ctx.stroke();
  }
  ctx.restore();
}

function brushPass(ctx, w, h, painter, strength, cfg) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const targets = painter.palette.map(toRgb);
  const count = Math.round((w * h) / cfg.density);
  const cx = w / 2;
  const cy = h / 2;

  for (let i = 0; i < count; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const sample = samplePixel(src, w, h, x, y);

    const lx = lumaAt(src, w, h, x + 5, y) - lumaAt(src, w, h, x - 5, y);
    const ly = lumaAt(src, w, h, x, y + 5) - lumaAt(src, w, h, x, y - 5);
    let angle = Math.atan2(ly, lx) + Math.PI / 2;

    if (cfg.swirl > 0) {
      const swirlAngle = Math.atan2(y - cy, x - cx) + Math.PI / 2;
      angle = angle * (1 - cfg.swirl) + swirlAngle * cfg.swirl;
    }
    angle += (Math.random() - 0.5) * cfg.spread;

    let color = sample;
    if (Math.random() < cfg.paletteChance) {
      const pick = targets[(Math.random() * targets.length) | 0];
      const mix = 0.3 + Math.random() * 0.4;
      color = [0, 1, 2].map((k) => sample[k] + (pick[k] - sample[k]) * mix);
    }
    const jitter = (Math.random() - 0.5) * (cfg.jitter ?? 20);
    const lift = cfg.lift ?? 0;
    color = color.map((v) => clamp(v + jitter + lift, 0, 255));

    const len = cfg.len[0] + Math.random() * (cfg.len[1] - cfg.len[0]);
    const width = cfg.width[0] + Math.random() * (cfg.width[1] - cfg.width[0]);
    const alpha = clamp(
      (cfg.alpha[0] + Math.random() * (cfg.alpha[1] - cfg.alpha[0])) * (0.72 + strength * 0.35),
      0,
      1
    );

    drawStroke(ctx, x, y, angle, len, width, color, alpha, (Math.random() - 0.5) * 0.9, Math.random() < cfg.highlight);
  }
}

/* ---------------------------------------------------------------- 立体主义 */

function paintFacets(ctx, w, h, painter, strength) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const targets = painter.palette.map(toRgb);
  const cell = Math.max(26, Math.round(Math.min(w, h) / (12 + strength * 4)));
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;

  const pts = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const edgeX = c === 0 || c === cols - 1;
      const edgeY = r === 0 || r === rows - 1;
      const jx = edgeX ? 0 : (Math.random() - 0.5) * cell * 0.95;
      const jy = edgeY ? 0 : (Math.random() - 0.5) * cell * 0.95;
      pts.push([clamp(c * cell + jx, 0, w), clamp(r * cell + jy, 0, h)]);
    }
  }
  const at = (c, r) => pts[r * cols + c];

  const tri = (a, b, c) => {
    const mx = (a[0] + b[0] + c[0]) / 3;
    const my = (a[1] + b[1] + c[1]) / 3;
    let [r, g, bl] = samplePixel(src, w, h, mx, my);
    if (Math.random() < 0.65) {
      const p = targets[(Math.random() * targets.length) | 0];
      const mix = 0.3 + Math.random() * 0.35;
      r += (p[0] - r) * mix;
      g += (p[1] - g) * mix;
      bl += (p[2] - bl) * mix;
    }
    // 平面化：压掉细节，只留大色块
    const flat = 0.45 + Math.random() * 0.55;
    const shade = [r, g, bl].map((v) => clamp(Math.round(v * flat + 96 * (1 - flat)), 0, 255));

    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.closePath();
    ctx.fillStyle = `rgb(${shade[0]},${shade[1]},${shade[2]})`;
    ctx.fill();

    if (Math.random() < 0.34 + strength * 0.16) {
      ctx.strokeStyle = `rgba(38,30,20,${0.28 + Math.random() * 0.42})`;
      ctx.lineWidth = 1 + Math.random() * 1.5;
      ctx.stroke();
    }
  };

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const p00 = at(c, r);
      const p10 = at(c + 1, r);
      const p01 = at(c, r + 1);
      const p11 = at(c + 1, r + 1);
      if ((c + r) % 2 === 0) {
        tri(p00, p10, p01);
        tri(p11, p01, p10);
      } else {
        tri(p00, p10, p11);
        tri(p00, p11, p01);
      }
    }
  }
}

/* ---------------------------------------------------------------- 浮世绘 */

function paintUkiyoe(ctx, w, h, painter, strength) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const bands = [0.2, 0.4, 0.58, 0.74, 0.87];
  const ramps = painter.palette
    .map((hex) => ({ hex, l: 0.2126 * toRgb(hex)[0] + 0.7152 * toRgb(hex)[1] + 0.0722 * toRgb(hex)[2] }))
    .sort((a, b) => a.l - b.l)
    .map((x) => toRgb(x.hex));

  const img = ctx.createImageData(w, h);
  const out = img.data;
  const luma = new Float32Array(w * h);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = (y * w + x) * 4;
      const l = (0.2126 * src[si] + 0.7152 * src[si + 1] + 0.0722 * src[si + 2]) / 255;
      luma[y * w + x] = l;
      let band = bands.findIndex((b) => l < b);
      if (band < 0) band = bands.length;
      const pick = ramps[clamp(Math.round((band / bands.length) * (ramps.length - 1)), 0, ramps.length - 1)];
      out[si] = pick[0];
      out[si + 1] = pick[1];
      out[si + 2] = pick[2];
      out[si + 3] = 255;
    }
  }

  // 边缘 → 主版的黑线
  const threshold = (0.1 + (1 - strength) * 0.06) * 3;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const gx =
        luma[y * w + x + 1] + luma[(y - 1) * w + x + 1] + luma[(y + 1) * w + x + 1] -
        (luma[y * w + x - 1] + luma[(y - 1) * w + x - 1] + luma[(y + 1) * w + x - 1]);
      const gy =
        luma[(y + 1) * w + x] + luma[(y + 1) * w + x - 1] + luma[(y + 1) * w + x + 1] -
        (luma[(y - 1) * w + x] + luma[(y - 1) * w + x - 1] + luma[(y - 1) * w + x + 1]);
      if (Math.abs(gx) + Math.abs(gy) > threshold) {
        const i = (y * w + x) * 4;
        out[i] = 27;
        out[i + 1] = 44;
        out[i + 2] = 51;
      }
    }
  }

  ctx.putImageData(img, 0, 0);

  // 和纸的纤维
  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = '#efe6d0';
  for (let i = 0; i < 1800; i += 1) {
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 12, 1);
  }
  ctx.restore();
}

/* ---------------------------------------------------------------- 水墨 */

function paintInk(ctx, w, h, painter, strength) {
  grade(ctx, w, h, { saturation: 0.08, contrast: 1.34, brightness: 0.02 });
  const src = ctx.getImageData(0, 0, w, h).data;
  const img = ctx.createImageData(w, h);
  const out = img.data;
  const paper = [239, 233, 218];
  const ink = [24, 23, 21];

  for (let i = 0; i < src.length; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

    // 亮部直接留白——写意画的呼吸都在空白里
    const raw = clamp((0.8 - l) / 0.8, 0, 1);
    let density = Math.round(Math.pow(raw, 1.15) * 4) / 4;
    if (density < 0.25) density = 0;

    let [or, og, ob] = paper.map((p, k) => p + (ink[k] - p) * density);

    // 只给真正浓艳的暖色留一点朱砂，避免整幅泛红
    const warm = (r - b) / 255;
    const sat = Math.max(r, g, b) === 0 ? 0 : (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
    if (warm > 0.32 && sat > 0.34) {
      const mix = Math.min(0.7, (warm - 0.3) * 2.2) * (0.5 + strength * 0.4);
      or += (174 - or) * mix;
      og += (60 - og) * mix;
      ob += (50 - ob) * mix;
    }
    out[i] = clamp(or, 0, 255);
    out[i + 1] = clamp(og, 0, 255);
    out[i + 2] = clamp(ob, 0, 255);
    out[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // 飞白：干笔擦出的亮痕
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#f8f3e4';
  ctx.lineWidth = 1;
  for (let i = 0; i < 120; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 16 + Math.random() * 28, y + (Math.random() - 0.5) * 7);
    ctx.stroke();
  }
  ctx.restore();

  // 几笔重墨，压住结构
  brushPass(ctx, w, h, painter, strength, {
    density: 900,
    len: [26, 64],
    width: [2, 6],
    alpha: [0.35, 0.6],
    swirl: 0.2,
    spread: 0.9,
    paletteChance: 0.5,
    highlight: 0.05,
    jitter: 8,
  });

  // 印章
  const size = Math.max(26, Math.round(Math.min(w, h) * 0.055));
  const sx = w - size - Math.round(w * 0.045);
  const sy = h - size - Math.round(h * 0.045);
  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = '#b4443a';
  ctx.fillRect(sx, sy, size, size);
  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = '#f0e7d2';
  ctx.lineWidth = Math.max(1.4, size * 0.075);
  ctx.strokeRect(sx + size * 0.14, sy + size * 0.14, size * 0.72, size * 0.72);
  ctx.restore();
}

/* ---------------------------------------------------------------- 收尾 */

function addCanvasTexture(ctx, w, h, alpha = 0.05) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(70,58,40,0.9)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 4) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 4) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function addVignette(ctx, w, h, strength = 0.3) {
  const g = ctx.createRadialGradient(w * 0.44, h * 0.4, Math.min(w, h) * 0.16, w / 2, h / 2, Math.max(w, h) * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.6, `rgba(30,20,10,${strength * 0.3})`);
  g.addColorStop(1, `rgba(26,16,6,${strength})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** 老油画的罩染与龟裂 */
function addVarnish(ctx, w, h) {
  ctx.save();
  for (let i = 0; i < 34; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = Math.min(w, h) * (0.08 + Math.random() * 0.26);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(146,96,34,${0.06 + Math.random() * 0.1})`);
    g.addColorStop(1, 'rgba(146,96,34,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 细裂纹：老油画最好认的一张脸
  ctx.strokeStyle = 'rgba(46,30,12,0.26)';
  ctx.lineWidth = 1;
  const count = Math.round((w * h) / 2600);
  for (let i = 0; i < count; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const a = Math.random() * Math.PI * 2;
    const len = 5 + Math.random() * 22;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.restore();
}

function addGrain(ctx, w, h) {
  const gw = Math.max(64, Math.round(w / 2));
  const gh = Math.max(64, Math.round(h / 2));
  const noise = document.createElement('canvas');
  noise.width = gw;
  noise.height = gh;
  const nctx = noise.getContext('2d');
  const img = nctx.createImageData(gw, gh);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 120 + Math.random() * 90;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 24;
  }
  nctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(noise, 0, 0, w, h);
  ctx.restore();
}

/* ---------------------------------------------------------------- 画法 */

const PIPELINES = {
  'van-gogh': (ctx, w, h, painter, strength) => {
    softBlur(ctx, w, h, 1.4 * (0.6 + strength), 1);
    grade(ctx, w, h, { saturation: 1.34, contrast: 1.06 });
    remapPalette(ctx, w, h, painter.palette, 0.3 + strength * 0.18);
    brushPass(ctx, w, h, painter, strength, {
      density: 128,
      len: [17, 40],
      width: [5, 10.5],
      alpha: [0.6, 0.92],
      swirl: 0.8,
      spread: 0.55,
      paletteChance: 0.56,
      highlight: 0.3,
    });
    addCanvasTexture(ctx, w, h, 0.05);
    addVignette(ctx, w, h, 0.22);
  },

  monet: (ctx, w, h, painter, strength) => {
    softBlur(ctx, w, h, 1.8 + strength * 1.6, 1);
    grade(ctx, w, h, { saturation: 1.42, brightness: 0.03, contrast: 0.95 });
    remapPalette(ctx, w, h, painter.palette, 0.26 + strength * 0.16);
    brushPass(ctx, w, h, painter, strength, {
      density: 118,
      len: [11, 26],
      width: [6.5, 13],
      alpha: [0.5, 0.8],
      swirl: 0.14,
      spread: 2.6,
      paletteChance: 0.4,
      highlight: 0.16,
      jitter: 16,
      lift: 8,
    });
    addCanvasTexture(ctx, w, h, 0.045);
    addVignette(ctx, w, h, 0.16);
  },

  picasso: (ctx, w, h, painter, strength) => {
    softBlur(ctx, w, h, 2.5, 1);
    grade(ctx, w, h, { saturation: 0.58, contrast: 1.06, warmth: -0.08 });
    remapPalette(ctx, w, h, painter.palette, 0.4);
    paintFacets(ctx, w, h, painter, strength);
    addCanvasTexture(ctx, w, h, 0.05);
    addVignette(ctx, w, h, 0.3);
  },

  'da-vinci': (ctx, w, h, painter, strength) => {
    softBlur(ctx, w, h, 3.2 + strength * 2.2, 1);
    grade(ctx, w, h, { saturation: 0.64, contrast: 1.14, warmth: 0.55 });
    remapPalette(ctx, w, h, painter.palette, 0.42 + strength * 0.14);
    addVarnish(ctx, w, h);

    // 暖色罩染：正片叠底压出陈年光油的黄
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(228,198,146,0.32)';
    ctx.fillRect(0, 0, w, h);
    // 左上角来光
    const glow = ctx.createRadialGradient(w * 0.3, h * 0.22, 0, w * 0.3, h * 0.22, Math.max(w, h) * 0.7);
    glow.addColorStop(0, 'rgba(255,239,204,0.5)');
    glow.addColorStop(1, 'rgba(255,239,204,0)');
    ctx.globalCompositeOperation = 'soft-light';
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    addCanvasTexture(ctx, w, h, 0.04);
    addVignette(ctx, w, h, 0.52);
  },

  hokusai: (ctx, w, h, painter, strength) => {
    softBlur(ctx, w, h, 1.2 + strength, 1);
    paintUkiyoe(ctx, w, h, painter, strength);
    addVignette(ctx, w, h, 0.1);
  },

  'qi-baishi': (ctx, w, h, painter, strength) => {
    softBlur(ctx, w, h, 0.9 + strength, 1);
    paintInk(ctx, w, h, painter, strength);
  },
};

const DEFAULT_PIPELINE = (ctx, w, h, painter, strength) => {
  softBlur(ctx, w, h, 1.5, 1);
  grade(ctx, w, h, { saturation: 1.1, contrast: 1.05 });
  remapPalette(ctx, w, h, painter.palette, 0.3);
  brushPass(ctx, w, h, painter, strength, {
    density: 180,
    len: [8, 22],
    width: [3.5, 8],
    alpha: [0.4, 0.75],
    swirl: 0.3,
    spread: 1.1,
    paletteChance: 0.5,
    highlight: 0.2,
  });
  addVignette(ctx, w, h, 0.2);
};

/**
 * @param {string} dataUrl 原图
 * @param {object} painter 画家档案
 * @param {{strength?: number, maxSide?: number}} options
 * @returns {Promise<string>} 新图的 data URL
 */
export async function paintLocally(dataUrl, painter, options = {}) {
  const strength = clamp(Number(options.strength ?? 0.62), 0, 1);
  const maxSide = options.maxSide || MAX_SIDE;

  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#e9e2d2';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const pipeline = PIPELINES[painter.id] || DEFAULT_PIPELINE;
  pipeline(ctx, w, h, painter, strength);

  // 水墨自己带纸纹，其余补一层布纹与颗粒
  if (painter.id !== 'qi-baishi') {
    addGrain(ctx, w, h);
  }

  return canvas.toDataURL('image/jpeg', 0.93);
}

export const LOCAL_ENGINE_LABEL = '内置笔触引擎';
