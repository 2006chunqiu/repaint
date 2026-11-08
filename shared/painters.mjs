/**
 * 画家档案 · 服务端与浏览器共用同一份数据
 *
 * 每位画家有三个用途各不相同的字段：
 *   stylePrompt —— 英文，交给图像模型，描述笔法/媒材/调色
 *   palette     —— 六色，本地演示引擎用来做色彩归一
 *   strokes     —— 两色，界面上画笔盒的色标
 */

export const PAINTERS = [
  {
    id: 'van-gogh',
    name: '梵高',
    latin: 'Vincent van Gogh',
    years: '1853—1890',
    medium: '布面油画',
    strokes: ['#2E5EAA', '#E8B23A'],
    palette: ['#1E3A6E', '#2E5EAA', '#6E8FC4', '#E8B23A', '#C9741F', '#3F6B4A'],
    desc: '厚重笔触，旋涡状的蓝与铬黄',
    stylePrompt:
      'Post-Impressionist oil painting in the manner of Vincent van Gogh. Thick impasto paint built up in rhythmic, swirling directional strokes that follow and exaggerate the forms. Vibrating complementary pairs of cobalt blue and chrome yellow. Dark contour lines drawn with a loaded brush. Glowing halo around light sources. Visible canvas weave, energetic and slightly feverish surface.',
    label: '后印象派',
  },
  {
    id: 'monet',
    name: '莫奈',
    latin: 'Claude Monet',
    years: '1840—1926',
    medium: '布面油画',
    strokes: ['#8E86A8', '#6E8C7A'],
    palette: ['#B9AEDB', '#8E86A8', '#6E8C7A', '#C8D5C0', '#E0C48E', '#7A6E8E'],
    desc: '碎笔点彩，光在水面上散开',
    stylePrompt:
      'Impressionist oil sketch in the manner of Claude Monet. Broken dabs and short commas of pure colour laid side by side, wet-on-wet, with no black outlines. Shimmering, vibrating light. Lilac, jade and pale gold atmosphere. The subject dissolves into haze and reflection, edges soft and unfinished, alla prima handling.',
    label: '印象派',
  },
  {
    id: 'picasso',
    name: '毕加索',
    latin: 'Pablo Picasso',
    years: '1881—1973',
    medium: '布面油画',
    strokes: ['#8A7A5E', '#2F4A63'],
    palette: ['#8A7A5E', '#B8A888', '#5C5344', '#2F4A63', '#7E8B8E', '#3A342C'],
    desc: '拆成棱面，正面与侧面同时出现',
    stylePrompt:
      'Analytic Cubist painting in the manner of Pablo Picasso. The image fractured into overlapping angular facets seen from several viewpoints at once. Muted ochre, grey, olive and slate-blue planes. Hard geometric edges, heavy black drawing lines, flattened shallow space, still-life-like massing of forms.',
    label: '立体主义',
  },
  {
    id: 'da-vinci',
    name: '达芬奇',
    latin: 'Leonardo da Vinci',
    years: '1452—1519',
    medium: '木板油画',
    strokes: ['#8A6234', '#4E4A3C'],
    palette: ['#8A6234', '#6B5B3E', '#4E4A3C', '#C4A574', '#2E2A24', '#9C8460'],
    desc: '晕涂柔化，光从左上角来',
    stylePrompt:
      'High Renaissance oil painting in the manner of Leonardo da Vinci. Sfumato modelling with no visible brushwork, every transition softened. Careful chiaroscuro form lit from the upper left. Warm burnt-sienna and umber glazes over a dark prepared ground. Extremely fine detail in the focal area, atmospheric perspective behind, aged varnish tone.',
    label: '文艺复兴',
  },
  {
    id: 'hokusai',
    name: '葛饰北斋',
    latin: 'Katsushika Hokusai',
    years: '1760—1849',
    medium: '木版画',
    strokes: ['#24486B', '#C2503C'],
    palette: ['#24486B', '#3E6E92', '#C2503C', '#E8DCC0', '#8FA9B8', '#1B2C33'],
    desc: '平涂色块，普鲁士蓝与朱红',
    stylePrompt:
      'Ukiyo-e woodblock print in the manner of Katsushika Hokusai. Flat unmodulated areas of colour with no blending. Bold Prussian blue and vermilion in a restricted four to six colour palette. Crisp keyblock outlines, stylised wave, cloud and foam patterns, visible rice-paper grain and printing registration.',
    label: '浮世绘',
  },
  {
    id: 'qi-baishi',
    name: '齐白石',
    latin: 'Qi Baishi',
    years: '1864—1957',
    medium: '宣纸水墨',
    strokes: ['#2A2A26', '#B4443A'],
    palette: ['#2A2A26', '#4A463E', '#7C766A', '#D9D2C0', '#B4443A', '#5E6B5A'],
    desc: '大写意，墨分五色，留白极多',
    stylePrompt:
      'Chinese xieyi ink painting in the manner of Qi Baishi. Wet ink washes with dry-brush feibai texture, spontaneous single-stroke forms, calligraphic rhythm. Vast empty rice-paper negative space, a single vermilion accent seal. No perspective modelling, no cast shadows, ink graded from jet black to pale grey.',
    label: '写意水墨',
  },
];

export const PAINTER_MAP = new Map(PAINTERS.map((p) => [p.id, p]));

export function getPainter(id) {
  return PAINTER_MAP.get(id) || null;
}

export const DEFAULT_PAINTER_ID = PAINTERS[0].id;
