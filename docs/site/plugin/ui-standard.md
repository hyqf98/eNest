# UI 集成标准

eNest 插件可以使用任意前端技术（HTML / CSS / Canvas / WebGL / 任意框架）绘制界面。壳子通过 `plugin.json` 的 `ui` 段统一管理：

- **插件条 chrome** — 标题栏下的工具条高度与形态
- **主题 Token** — CSS 变量注入 + 运行时推送
- **背景透明** — 透出壳子壁纸 / 动效背景
- **配色偏好** — 强制 light/dark 或跟随壳子

插件 **无需依赖壳子 DOM**，也拿不到壳子 React 树；集成面全部通过 `ui` 配置 + `enest.ui.*` / `enest.theme.*` API 完成。

---

## 配置一览

在 `plugin.json` 中声明（全部可选）：

```jsonc
{
  "ui": {
    "chrome": "default",           // default | minimal | none
    "themeAware": true,            // 是否接收壳子主题注入与推送
    "background": "opaque",        // opaque | transparent
    "preferredColorScheme": "auto" // light | dark | auto
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `chrome` | `default` | 插件工具条形态：标准 48px / 细条 28px / 无条全幅 |
| `themeAware` | `true` | 壳子在加载完成后注入 CSS 变量，主题切换时推送事件 |
| `background` | `opaque` | `transparent` 时 WebContents 底色透明，可透出壳子壁纸 |
| `preferredColorScheme` | `auto` | 强制 light/dark，或跟随壳子与系统主题 |

缺省整段 `ui` 时，行为与上表默认值一致（`DEFAULT_PLUGIN_UI`）。非法枚举值在安装 / 加载时被归一回默认，不会导致安装失败。

> 源码：`src/shared/types/plugin.ts` → `PluginUiConfig` / `resolvePluginUi()`

---

## Chrome 模式

```text
┌──────────────────────────────────────┐
│  壳子标题栏（TITLEBAR 36px）           │  始终存在，渲染层绘制
├──────────────────────────────────────┤
│  插件条                               │  default 48 / minimal 28 / none 0
│  （名称 + 协议 URL / 仅名称）          │
├──────────────────────────────────────┤
│                                      │
│  插件内容（WebContentsView）          │  高度 = 窗口高 − 标题栏 − 插件条
│                                      │
└──────────────────────────────────────┘
```

| chrome | 插件条高 | 适合 |
|--------|----------|------|
| `default` | 48px | 工具类插件：显示插件名 + `enest://` 协议路径 |
| `minimal` | 28px | 需要更多纵向空间的界面：仅细条 + 名称 |
| `none` | 0 | 沉浸场景：游戏、看板、可视化、全幅 Canvas |

壳子在 `PluginHost.getPluginContentBounds(chromeBarHeight)` 布局时读取 `manifest.ui.chrome`，为 **每个已打开插件单独** 计算内容区边界。多插件并存时各自使用自身 chrome 高度。

### 沉浸式布局检查清单

使用 `chrome: "none"` 时：

- [ ] 页面自身 `margin: 0`，根元素撑满
- [ ] 不要假设顶部还有 48px 安全区
- [ ] 若需要自定义头部，在页面内自己画，并预留窗口控制按钮避让（若有）

---

## 主题 Token

### 注入方式（三种）

**1. 自动注入（推荐）** — `themeAware: true` 时：

- 插件页 `did-finish-load` 后壳子 `executeJavaScript` 向 `document.documentElement` 写入 CSS 变量
- 壳子设置页切换主题、系统主题变化（`mode: system`）、主题包切换时 **再次注入**，并 IPC 推送变更

**2. 协议 CSS（首屏兜底）**：

```html
<link rel="stylesheet" href="enest://plugin/<插件id>/__enest_theme.css" />
```

由主进程按当前主题动态生成，适合首屏防闪烁；运行时仍应监听 `onThemeChange`。

**3. JS API（动态 / Canvas 用）**：

```js
const { mode, tokens } = await enest.theme.getTokens()

const off = enest.ui.onThemeChange(({ mode, tokens }) => {
  // 更新 Canvas 取色 / WebGL uniform / 自绘 UI
})
```

### Token 完整列表

| 变量 | 含义 | light 预设 | dark 预设 |
|------|------|-----------|-----------|
| `--bg` | 页面背景 | `#f4f5f7` | `#0a0c10` |
| `--surface` | 卡片 / 主表面 | `#ffffff` | `#12151c` |
| `--surface-2` | 次级表面 | `#f0f2f5` | `#171b24` |
| `--surface-3` | 浮层表面 | `#e8ebf0` | `#1e2430` |
| `--border` | 常规边框 | `rgba(15,23,42,0.08)` | `rgba(255,255,255,0.06)` |
| `--border-strong` | 强边框 | `rgba(15,23,42,0.14)` | `rgba(255,255,255,0.12)` |
| `--text` | 主文字 | `#0f1420` | `#f2f4f8` |
| `--text-2` | 次级文字 | `#5c6578` | `#9aa3b5` |
| `--text-3` | 弱化文字 | `#8b93a5` | `#5e677a` |
| `--accent` | 强调色 | `#1a1f2e` | `#f2f4f8` |
| `--ok` | 成功色 | `#0d9f6e` | `#3ecf8e` |
| `--ok-soft` | 成功色淡底（自动派生） | `rgba(--ok, 0.1)` | `rgba(--ok, 0.12)` |
| `--danger` | 危险色 | `#e11d48` | `#ff6b81` |

> 预设以 `src/main/theme/resolveThemeCss.ts` 的 `THEME_TOKEN_PRESETS` 为准；活动主题包与用户 overrides 会覆盖上表。

注入时还会设置：

- `document.documentElement.dataset.theme` = `"light"` | `"dark"`
- `color-scheme` 与之一致（影响滚动条、表单控件原生外观）

### 在 CSS 中使用

```css
:root {
  /* 可选：本地兜底，壳子注入后会被覆盖 */
  --bg: #f4f5f7;
  --text: #0f1420;
  --accent: #1a1f2e;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: Inter, 'PingFang SC', sans-serif;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
}

.card .hint { color: var(--text-2); }

button.primary {
  background: var(--accent);
  color: var(--bg);
  border: none;
  border-radius: 8px;
}

.badge-ok {
  color: var(--ok);
  background: var(--ok-soft);
}
```

### 在 JS 中读取（含 Canvas）

```js
function cssVar(name, fallback) {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim() || fallback
  )
}

let accent = cssVar('--accent', '#5b8cff')

const api = window.enest || window.zapi
api?.theme.getTokens().then(({ tokens }) => {
  accent = tokens['--accent'] || accent
})
api?.ui.onThemeChange(({ tokens }) => {
  accent = tokens['--accent'] || accent
  redraw()
})
```

### 叠加顺序

```text
内置 light/dark 预设
        ↓
活动主题包 tokens
        ↓
用户在设置页的 overrides
        ↓
document.documentElement 上的 CSS 变量
```

`preferredColorScheme: "light" | "dark"` 会 **强制** 该配色（忽略壳子当前 mode）；`auto` 时跟随壳子，壳子为 `system` 则读系统偏好。

`themeAware: false` 时壳子 **不注入、不推送** 主题；你可以在页面内自带完整默认值。

---

## 主题包注册（主题类插件）

主题插件在加载后调用 `enest.theme.register(ThemePack)`：

```js
await enest.theme.register({
  id: 'com.example.forest',
  name: '森林',
  mode: 'dark',
  tokens: {
    '--bg': '#0a1f1c',
    '--surface': '#0f2924',
    '--surface-2': '#14352f',
    '--text': '#e8fff8',
    '--text-2': '#9ccfc0',
    '--text-3': '#6a9a8c',
    '--accent': '#2dd4a8',
    '--border': 'rgba(255,255,255,0.08)',
    '--border-strong': 'rgba(255,255,255,0.14)',
    '--ok': '#3dd68c',
    '--danger': '#ff7a8e'
  },
  background: {
    type: 'color',
    value: 'linear-gradient(160deg,#0a1f1c,#134e4a)',
    opacity: 0.9,
    fit: 'cover'
  }
})
```

壳子会：

1. 写入主题包注册表（`~/eNest/themes/` 相关存储）
2. 推送 `theme-packs-changed`
3. 设置 → 主题 →「主题包」下拉 **即时出现**，用户选择后全壳生效

完整字段见 [zapi API → theme.register](api.md#theme-register-pack)。

---

## 透明背景（background: transparent）

当 `background: "transparent"` 时：

- 主进程将插件 `webContents` 背景设为 `#00000000`，加载完成后再确认一次
- 插件页 **必须** 使用 `background: transparent`，否则会盖住壳子背景
- 可透出壳子的纯色 / 图片 / 视频背景，适合动态壁纸上的小组件与可视化

```css
html, body {
  margin: 0;
  height: 100%;
  background: transparent !important;
}
```

!> 忘记把 `body` 背景改透明，是最常见的「透明不生效」原因。

---

## Canvas / WebGL 动态绘制

壳子 **不限制** 绘制技术：Canvas2D、WebGL、WebGL2、SVG、WebGPU 均可。

### 必须遵守

1. **透明底**：`background: transparent` 时，Canvas 用每帧 `clearRect`，WebGL 创建上下文时 `alpha: true`，勿绘制不透明底色。
2. **取色走 Token**：优先读 `--accent` / `--text` 等变量或 `theme.getTokens()`，避免写死与壳子冲突的色值。
3. **主题变更重绘**：`onThemeChange` 时更新 uniform / 重画一帧。
4. **性能自控**：壳子不会替你降帧；不可见时在 `onOut` / `visibilitychange` 里暂停 rAF。

### Canvas2D 骨架

```js
const canvas = document.getElementById('c')
const ctx = canvas.getContext('2d')

function resize() {
  canvas.width = canvas.clientWidth * devicePixelRatio
  canvas.height = canvas.clientHeight * devicePixelRatio
}
window.addEventListener('resize', resize)
resize()

let accent = '#5b8cff'
const api = window.enest || window.zapi

function applyTokens(tokens) {
  accent = tokens['--accent'] || accent
}

api?.theme.getTokens().then(({ tokens }) => applyTokens(tokens))
api?.ui.onThemeChange(({ tokens }) => applyTokens(tokens))

let raf = 0
function frame(t) {
  // 透明底：每帧清空，勿 fillStyle 不透明矩形铺底
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = accent
  const r = 40 + Math.sin(t / 400) * 12
  ctx.beginPath()
  ctx.arc(canvas.width / 2, canvas.height / 2, r * devicePixelRatio, 0, Math.PI * 2)
  ctx.fill()
  raf = requestAnimationFrame(frame)
}

api?.onEnter(() => { if (!raf) raf = requestAnimationFrame(frame) })
api?.onOut(() => { cancelAnimationFrame(raf); raf = 0 })
```

### WebGL 要点

```js
const gl = canvas.getContext('webgl', {
  alpha: true,          // 透明底必需
  premultipliedAlpha: true
})

// 清屏用透明色
gl.clearColor(0, 0, 0, 0)
gl.clear(gl.COLOR_BUFFER_BIT)
```

仓库可运行示例：`plugins-samples/canvas-demo/`（`chrome: none` + 透明底 + 主题感知动画）。

---

## 完整示例：沉浸式 Canvas 插件

**plugin.json**

```json
{
  "id": "com.example.viz",
  "name": "可视化",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": ["ui.setTitle"],
  "ui": {
    "chrome": "none",
    "themeAware": true,
    "background": "transparent",
    "preferredColorScheme": "auto"
  }
}
```

**index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>可视化</title>
  <style>
    :root {
      --bg: #0a0c10;
      --text: #f2f4f8;
      --accent: #5b8cff;
    }
    html, body {
      margin: 0;
      height: 100%;
      overflow: hidden;
      background: transparent !important;
      font-family: Inter, 'PingFang SC', system-ui, sans-serif;
      color: var(--text);
    }
    canvas { width: 100%; height: 100%; display: block; }
    .hud {
      position: fixed; left: 16px; bottom: 16px;
      padding: 10px 14px; border-radius: 10px;
      background: color-mix(in srgb, var(--bg) 70%, transparent);
      border: 1px solid color-mix(in srgb, var(--text) 12%, transparent);
      font-size: 12px; color: var(--text);
      backdrop-filter: blur(8px);
      pointer-events: none;
    }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div class="hud">theme-aware · transparent · chrome=none</div>
  <script>
    const api = window.enest || window.zapi
    const canvas = document.getElementById('c')
    const ctx = canvas.getContext('2d')
    let accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent').trim() || '#5b8cff'

    function resize() {
      canvas.width = canvas.clientWidth * devicePixelRatio
      canvas.height = canvas.clientHeight * devicePixelRatio
    }
    window.addEventListener('resize', resize)
    resize()

    api?.theme.getTokens().then(({ tokens }) => {
      accent = tokens['--accent'] || accent
    })
    api?.ui.onThemeChange(({ tokens }) => {
      accent = tokens['--accent'] || accent
    })
    api?.ui.setTitle('可视化')

    let raf = 0
    function frame(t) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.strokeStyle = accent
      ctx.lineWidth = 2 * devicePixelRatio
      for (let i = 0; i < 6; i++) {
        const phase = t / 1000 + i
        ctx.beginPath()
        for (let x = 0; x <= canvas.width; x += 8) {
          const y = canvas.height / 2 +
            Math.sin(x / 80 + phase) * (30 + i * 10) * devicePixelRatio
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.globalAlpha = 0.2 + i * 0.1
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }
    api?.onEnter(() => { if (!raf) raf = requestAnimationFrame(frame) })
    api?.onOut(() => { cancelAnimationFrame(raf); raf = 0 })
  </script>
</body>
</html>
```

---

## 校验与兼容

| 情况 | 行为 |
|------|------|
| 整段 `ui` 缺失 | 使用全部默认值 |
| 字段非法枚举 | 回退该字段默认，不影响安装 |
| 旧插件不写 `ui` | 保持原行为：标准插件条 + 不透明底 + 跟随主题 |
| `themeAware: false` | 不注入、不推送主题；`chrome` / `background` 仍生效 |
| `preferredColorScheme: light/dark` | 强制配色；`theme.getTokens()` 返回强制后的 mode |

---

## 相关文档

- [zapi API](api.md) — `ui.*` / `theme.*` 完整签名
- [plugin.json](manifest.md) — 清单字段
- [示例插件](examples.md) — 可运行样例
