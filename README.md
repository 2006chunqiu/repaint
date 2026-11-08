# 重描 · REPAINT

上传一张照片，选一位画家，得到一张重画的画。梵高、莫奈、毕加索、达芬奇、葛饰北斋、齐白石，六位。

**在线看看**：<https://2006chunqiu.github.io/repaint/> —— 静态版，浏览器直连 DeepSeek。不填 Key 也能用内置笔触引擎出图。

---

## 先说清楚一件事

**DeepSeek 官方 API 是纯文本模型**（`deepseek-chat` / `deepseek-reasoner`），既不接受图片输入，也不能输出图片。所以「用 DeepSeek 把照片画成梵高」单靠它做不到。

这个项目把工作拆成两层，各做各擅长的：

| 层 | 谁来做 | 做什么 |
| --- | --- | --- |
| 眼与脑 | **DeepSeek** | 读照片的量化特征，写出这位画家的笔法、调色、构图指令，并写一篇中文画签 |
| 手 | **图像模型** | 拿着你的照片当底稿，按画稿重画 |
| 兜底 | **内置笔触引擎** | 没有图像模型 Key 时，浏览器用 Canvas 现场重画，功能不空转 |

DeepSeek 看不到图片，那它怎么"读"照片？浏览器先把照片量成一份**体检单**——主色及占比、明暗分布（4×4 网格）、色温、构图比例——再把这份纯数据交给它。这是本项目最关键的一处设计。

---

## 快速开始

需要 Node.js 18 或更高版本。项目零依赖，不用 `npm install`。

```bash
# 双击 启动.bat，或者：
npm start
```

打开 <http://127.0.0.1:5180>。

**不填任何 Key 也能用**：内置笔触引擎会当场把照片重画一遍，六种画法都能出图。想换成真模型，接着往下看。

---

## 接上 DeepSeek

1. 到 <https://platform.deepseek.com/api_keys> 申请 Key
2. 把 `.env.example` 复制成 `.env`
3. 填 `DEEPSEEK_API_KEY=sk-...`
4. 重启服务

不填也能跑，只是画稿由本地规则拼出来，画签是固定的模板句式——不如模型写得准。

---

## 接上图像模型

在 `.env` 里选一条路。三种适配器都实现了，改 `IMAGE_PROVIDER` 即可切换。

### A. 标准图生图（推荐，效果最接近"重画"）

`openai-edit`，走 `POST {base}/images/edits` 的 multipart 接口，把照片作为底图交给模型。

```env
IMAGE_PROVIDER=openai-edit
IMAGE_BASE_URL=https://api.openai.com/v1
IMAGE_API_KEY=sk-...
IMAGE_MODEL=gpt-image-1
IMAGE_QUALITY=high
```

> 实测：国内网络到 `api.openai.com` 会超时。如果你在国内，优先看下面两条。

### B. 文生图 + 参考图（国内厂商常用）

`openai-generate`，走 `POST {base}/images/generations`，把照片以 base64 放进 `image` 字段。

```env
IMAGE_PROVIDER=openai-generate
IMAGE_BASE_URL=https://api.siliconflow.cn/v1
IMAGE_API_KEY=sk-...
IMAGE_MODEL=Kwai-Kolors/Kolors
IMAGE_SIZE_FIELD=image_size
IMAGE_PASSTHROUGH=true
```

不同厂商的参数名不一样（`size` 还是 `image_size`、要不要参考图），用这两个开关调：

- `IMAGE_SIZE_FIELD`：尺寸参数叫什么
- `IMAGE_EXTRA_JSON`：把任意私有参数塞进请求体，例如
  `IMAGE_EXTRA_JSON={"image_size":"1024x1024","num_inference_steps":30,"guidance_scale":7.5}`

如果厂商不认参考图字段，把 `IMAGE_PASSTHROUGH=false`，它就退化成纯文生图（效果会差一些，但至少能出图）。

### C. Stability SD3.5 图生图

```env
IMAGE_PROVIDER=stability
IMAGE_BASE_URL=https://api.stability.ai
IMAGE_API_KEY=sk-...
IMAGE_MODEL=sd3.5-large
IMAGE_STRENGTH=0.7
```

`IMAGE_STRENGTH`：0.1 只改一点，0.95 几乎重画。

---

## 它怎么工作

一次作画经过三道手续（页面上也是这么写的）：

1. **量一遍** —— 浏览器把照片缩到 1600px，取 80×80 采样，算出主色（5 个，按占比排序）、明暗分布（4×4 网格平均值）、对比度、色温、构图比例。照片本身不会上传。
2. **写画稿** —— `POST /api/interpret` 把这份数据 + 画家档案（英文笔法描述）发给 DeepSeek，要求它返回严格 JSON：`{title, prompt, label}`。标题和画签是中文，给图像模型的是 60–90 词的英文画稿。
3. **下笔** —— `POST /api/paint` 把照片和画稿转给图像模型，返回统一成 data URL 的成品。失败则自动退回内置笔触引擎，并把原因告诉你。

---

## 目录结构

```
ai-atelier/
├── server/
│   ├── server.js        零依赖 HTTP 服务：静态文件 + 三个接口
│   ├── config.js        .env 读取、状态摘要（不泄露 Key）
│   ├── prompt.js        DeepSeek 层（服务端版）：带 Key 发请求
│   └── image.js         图像模型层：三个 provider + 错误归一
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── app.js           上传、量化、调接口、对比滑块、下载
│   ├── direct.js        静态模式：浏览器直连 DeepSeek
│   └── demo-engine.js   内置笔触引擎：六套画法
├── shared/
│   ├── painters.mjs     六位画家的档案（前后端共用）
│   └── prompt-core.mjs  画稿规则（前后端共用，纯函数）
├── scripts/
│   └── build-pages.mjs  生成 docs/：GitHub Pages 用的静态站
├── docs/                构建产物，Pages 直接托管这个目录
├── .env.example
└── 启动.bat
```

---

## 部署到 GitHub Pages（纯静态）

这个站有两种运行形态，区别只在「谁持有 Key」：

| | 服务端模式（`npm start`） | 静态模式（GitHub Pages） |
| --- | --- | --- |
| DeepSeek 调用 | 服务端，Key 在 `.env` | 访客浏览器，Key 在 localStorage |
| 图像模型 | 可以接入 | 调不了，落笔固定用内置引擎 |
| Key 会不会进仓库 | 不会（`.gitignore` 排除） | 不会（仓库里根本没有 Key） |

构建并发布：

```bash
npm run build:pages
```

它会把 `public/` 和 `shared/` 原样拷进 `docs/`（路径全用相对路径，所以能挂在 `/<仓库名>/` 这种子路径下），并顺手扫描产物里有没有 API Key——发现就中止构建。

然后把仓库推到 GitHub，在 **Settings → Pages → Source** 选 **main 分支 /docs 目录**。

访客打开站点后的体验：

- 不填任何东西：内置笔触引擎当场出图，六种画法都能玩
- 点右上角状态药丸 → 在抽屉里填自己的 DeepSeek Key：画稿与画签立刻换成真模型写的
- Key 只存那台设备的 localStorage，换台电脑要重新填

想要「人人打开就能用、不用自己填 Key」，就必须有服务端来藏 Key——那得用 Vercel / Netlify / 自己的服务器跑 `server/server.js`，在平台环境变量里配 `DEEPSEEK_API_KEY`，而不是 GitHub Pages。

---

## 换画家、加画家

改 `shared/painters.mjs`，加一条对象：

```js
{
  id: 'turner',
  name: '透纳',
  latin: 'J. M. W. Turner',
  years: '1775—1851',
  medium: '布面油画',
  strokes: ['#C9A227', '#6E7F8D'],       // 画笔盒上的双色标
  palette: ['#...'],                      // 六个色，内置引擎用来归一色彩
  desc: '一句话，显示在作画中的状态里',
  stylePrompt: '英文笔法描述，直接进 DeepSeek 的提示词',
  label: '浪漫主义',
}
```

前端会自动出现新的画笔盒选项，不需要改其它地方。想让内置引擎也有专门画法，在 `public/demo-engine.js` 的 `PIPELINES` 里加一个函数；不加就走默认笔触。

---

## 常见问题

**页面右上角显示「演示笔触模式」**
没有配图像模型。填好 `.env` 的 `IMAGE_*` 四项后重启；页面上点右上角的状态药丸能看到每一层的连接情况。

**图像模型报 400**
不同厂商参数差异很大。服务端会把厂商返回的原文放进响应的 `detail` 字段，看它要什么参数，再用 `IMAGE_EXTRA_JSON` 补上。注意 `IMAGE_SIZE_FIELD` 是不是该叫 `image_size`。

**想先看看效果**
访问 `http://127.0.0.1:5180/?demo=1`，会用项目自带的示例照片跑完整流程。示例图可以换成你自己的 `public/sample.jpg`，或者删掉。

**静态版里画不出「真 AI 的画」**
正常。静态站没有后端，调不了图像模型，落笔只能交给内置笔触引擎。DeepSeek 那一层（画稿、画签）在静态版里是真在跑的，前提是填了 Key。想要图像模型落笔，用服务端模式部署到有 Node 运行时的地方。

**端口被占用**
改 `.env` 里的 `PORT`。

**换一张照片**
点「换一张」，或直接拖新的图进来，也可以 Ctrl/⌘ + V 粘贴。

---

## 安全

- Key 只存在于服务端 `.env`，浏览器拿不到；`/api/health` 只回「有没有配」和尾号
- 默认只监听 `127.0.0.1`，局域网访问不了；要对外开放改 `HOST`，并自行加 HTTPS
- 照片在浏览器里缩放后才会发出，服务端不落盘、不记录
- 响应带 CSP（`default-src 'self'`）、`nosniff`、`frame-ancestors 'none'`
- 上传体积上限 12MB（`MAX_UPLOAD_MB`），静态文件的路径穿越已做校验
