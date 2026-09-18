# UI 集成标准

eNest 插件可以使用任意前端技术（HTML / CSS / Canvas / WebGL / 任意框架）绘制界面。壳子通过 `plugin.json` 的 `ui` 段统一管理：

- **插件条 chrome** — 标题栏下的工具条高度与形态
- **主题 Token** — CSS 变量注入 + 运行时推送
- **背景透明** — 透出壳子壁纸 / 动效背景
- **配色偏好** — 强制 light/dark 或跟随壳子

另有两种 **打开形态**（`form`）：`panel`（主窗大 Tab，缺省）与 `mini`（Quick 命令面板小窗内嵌）——mini 的布局约束见下文「mini 插件（Quick 小窗）」。

插件 **无需依赖壳子 DOM**，也拿不到壳子 React 树；集成面全部通过 `ui` 配置 + `enest.ui.*` / `enest.theme.*` API 完成。

---

## 配置一览

在 `plugin.json` 中声明（全部可选）：

```jsonc
{
  "ui": {
    "chrome": "none",             // none | minimal（default 已废弃，等价 none）
    "themeAware": true,            // 是否接收壳子主题注入与推送
    "background": "opaque",        // opaque | transparent
    "preferredColorScheme": "auto" // light | dark | auto
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `chrome` | `none` | 插件工具条形态：无条全幅 / 细条 28px。`default`（标准 48px）已废弃，运行时等价 `none` |
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
│  插件条                               │  minimal 28 / none 0（缺省）
│  （仅名称）                           │
├──────────────────────────────────────┤
│                                      │
│  插件内容（WebContentsView）          │  高度 = 窗口高 − 标题栏 − 插件条
│                                      │
└──────────────────────────────────────┘
```

| chrome | 插件条高 | 适合 |
|--------|----------|------|
| `none`（缺省） | 0 | 沉浸场景：游戏、看板、可视化、全幅 Canvas；插件页完全由插件自身渲染 |
| `minimal` | 28px | 需要更多纵向空间的界面：仅细条 + 名称 |
| `default` | — | **已废弃**：加载时被归一为 `none`（不再渲染名称 + URL 标准条），仅为兼容旧 manifest 保留枚举值 |

壳子在 `PluginHost.getPluginContentBounds(chromeBarHeight)` 布局时读取 `manifest.ui.chrome`，为 **每个已打开插件单独** 计算内容区边界。多插件并存时各自使用自身 chrome 高度。

### 沉浸式布局检查清单

使用 `chrome: "none"` 时：

- [ ] 页面自身 `margin: 0`，根元素撑满
- [ ] 不要假设顶部还有 48px 安全区
- [ ] 若需要自定义头部，在页面内自己画，并预留窗口控制按钮避让（若有）

---

## mini 插件（Quick 小窗）

`plugin.json` 声明 `"form": "mini"` 的插件优先在 **Quick 命令面板小窗** 内嵌打开（骨架阶段未就绪时仍进主窗 Tab，布局规则同 panel）。mini 插件内容是叠在 Quick 渲染层之上的原生 WebContentsView：

```text
┌────────────────────────────────┐
│  Quick 输入条（渲染层）  64px   │  ← QUICK_BAR_AREA_H，插件不要覆盖
├────────────────────────────────┤
│                                │
│  插件内容（WebContentsView）    │  ← 高度自适应，见下
│  宽 720（QUICK_WIDTH）          │
│                                │
└────────────────────────────────┘
```

| 约束 | 值 | 说明 |
|------|-----|------|
| 宽度 | **720**（`QUICK_WIDTH`） | 固定，勿做横向自适应到其它宽度的假设 |
| 顶部 | **64px** 输入条（`QUICK_BAR_AREA_H`） | 插件 view 从 y=64 铺满剩余高度 |
| 内容高度 | 自适应，见下方优先级 | 上限内滚动，超出裁切 |
| 高度下限 | 120（`QUICK_PLUGIN_MIN_HEIGHT`） | 钳制 |
| 高度上限 | 窗高 520（`QUICK_MAX_HEIGHT`）内可容纳范围 | 超出部分插件内部滚动 |

### 内容高度自适应（优先级）

壳子按以下顺序决定插件区高度（`PluginHost.startQuickHeightWatch`）：

```text
enest.ui.setHeight(px) 上报  >  body scrollHeight 探测  >  manifest window.minHeight  >  默认 300
```

- **主动上报（推荐）**：内容尺寸变化时调 `enest.ui.setHeight(height)`（需 `ui.resize` 权限；主窗 Tab 场景该调用仅记录不动作）。壳子持续观察，可多次上报。
- 未上报时壳子前几轮用 `executeJavaScript` 量 `body.scrollHeight` 兜底。
- 最终高度被钳制到 `[120, 520 − 64]`，窗高 = 64 + 钳制后高度（tween 过渡）。

### 键盘约定（主进程拦截）

mini 插件区域持焦时，渲染层收不到键盘事件，由主进程 `before-input-event` 拦截：

| 按键 | 行为 |
|------|------|
| `Esc` | 退出插件态，返回 Quick 列表（插件退 background 并开始休眠计时） |
| `⌘Enter` / `Ctrl+Enter` | **固定到主窗**：同一 webContents 迁移到主窗 Tab，不重载、状态保留 |

插件内自定义快捷键请避开这两个组合。

### mini 插件布局检查清单

- [ ] 按宽 720 设计；根元素 `margin: 0`、`width: 100%`
- [ ] 不渲染顶部输入条（那是 Quick 渲染层；你的内容从 64px 之下开始）
- [ ] 内容高度变化时上报 `enest.ui.setHeight(px)`；同时设 `manifest.window.minHeight` 作为兜底
- [ ] 超过 456px（520−64）的内容自己滚动，不依赖窗口撑高
- [ ] Esc / ⌘Enter 被壳子占用，勿绑定
- [ ] `onEnter` 可重入（Esc 退场后再次呼出可能走冷启动 + session 快照恢复）

```jsonc
// plugin.json
{
  "id": "com.example.calc",
  "form": "mini",
  "window": { "minHeight": 320 },
  "permissions": ["ui.resize", "ui.setTitle"]
}
```

```js
// index.html — 高度上报示例
const api = window.enest
function reportHeight() {
  api?.ui.setHeight(Math.ceil(document.body.scrollHeight))
}
window.addEventListener('resize', reportHeight)
window.addEventListener('load', reportHeight)
```

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
| `--bg` | 页面背景 | `#f3f4f6` | `#0d1118` |
| `--surface` | 卡片 / 主表面 | `#ffffff` | `#161b24` |
| `--surface-2` | 次级表面 | `#f0f2f5` | `#1c2230` |
| `--surface-3` | 浮层表面 | `#e8ebf0` | `#252d3d` |
| `--border` | 常规边框 | `rgba(15,23,42,0.08)` | `rgba(255,255,255,0.09)` |
| `--border-strong` | 强边框 | `rgba(15,23,42,0.14)` | `rgba(255,255,255,0.16)` |
| `--text` | 主文字 | `#0f1420` | `#f3f5f9` |
| `--text-2` | 次级文字 | `#5c6578` | `#b4bdcf` |
| `--text-3` | 弱化文字 | `#8b93a5` | `#7c879c` |
| `--accent` | 强调色 | `#1a1f2e` | `#e8ecf4` |
| `--ok` | 成功色 | `#0d9f6e` | `#3dd68c` |
| `--ok-soft` | 成功色淡底（自动派生） | `rgba(--ok, 0.1)` | `rgba(--ok, 0.12)` |
| `--danger` | 危险色 | `#e11d48` | `#ff7a8e` |

> 预设以 `src/shared/theme/presets.ts` 的 `THEME_TOKEN_PRESETS` 为准；活动主题包与用户 overrides 会覆盖上表。

注入时还会设置：

- `document.documentElement.dataset.theme` = `"light"` | `"dark"`
- `color-scheme` 与之一致（影响滚动条、表单控件原生外观）

### 在 CSS 中使用

```css
:root {
  /* 可选：本地兜底，壳子注入后会被覆盖 */
  --bg: #f3f4f6;
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

const api = window.enest // zapi 为 @deprecated 别名，计划 v2 移除
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

完整字段见 [enest API → theme.register](api.md#theme-register-pack)。

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
const api = window.enest // zapi 为 @deprecated 别名

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
      --bg: #0d1118;
      --text: #f3f5f9;
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
    const api = window.enest // zapi 为 @deprecated 别名，计划 v2 移除
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

## 设计语言与样式规范（插件 UI Standard v2）

本节是插件作者的 **视觉与主题契约**。与前文「能注入哪些 Token」互补：这里规定 **必须消费哪些 Token、如何排版层级、主题如何跟随壳子**。权威 Token 源见 `src/renderer/styles/tokens.css`。

### MUST 消费的壳子 Token（`themeAware: true` 时）

`themeAware: true`（缺省）时，壳子在 `did-finish-load` 后向 `document.documentElement` 注入 CSS 变量，并在主题变更时推送；插件 UI **必须** 优先读这些变量，而不是写死与壳子冲突的色值/字号。

| 类别 | Token |
|------|--------|
| 颜色 · 底与表面 | `--bg` `--surface` `--surface-2` `--surface-3` |
| 颜色 · 边框 | `--border` `--border-strong` |
| 颜色 · 文字 | `--text` `--text-2` `--text-3` |
| 颜色 · 强调与语义 | `--accent` `--accent-soft` `--ok` `--ok-soft` `--danger` `--danger-soft` |
| 圆角 | `--radius-xl` `--radius-lg` `--radius-md` `--radius-sm` `--radius-pill` |
| 阴影 | `--shadow-soft` `--shadow-float` |
| 字体与字号 | `--font` `--mono` `--font-size-base` |

> 壳子侧同源定义：`src/renderer/styles/tokens.css`（浅色优先 + `:root[data-theme="dark"]` 覆盖）。注入时还会设置 `document.documentElement.dataset.theme` 与 `color-scheme`。

运行时动态取色（Canvas / WebGL / 无 CSS 变量环境）走 `enest.theme.getTokens()` 与 `enest.ui.onThemeChange`，Token 键名与上表一致（含 `var(--xxx)` 形式的键）。

### 设计语言：简约现代化

与壳子市场页 / 设置页保持同一气质，避免「第三方小部件」割裂感。

| 原则 | 做法 | 反例 |
|------|------|------|
| 少边框、多留白 | 卡片优先 `surface` + 间距分组；边框仅用于分隔必要区域 | 每个控件 1px 描边、密集分割线墙 |
| 层级用 surface / 阴影 / 透明度 | `surface` → `surface-2` → `surface-3` 递进；浮层用 `--shadow-soft` / `--shadow-float` | 用越来越重的描边表示层级 |
| 圆角克制 | 控件与卡片用 `--radius-sm` / `--radius-md`；大容器可用 `--radius-lg`，慎用 `--radius-xl` | 全页混用极大/极小圆角 |
| 主操作轻量 | 主操作优先 **悬浮按钮 FAB** 或 **ghost icon button**，图标 + tooltip | 顶部/底部一整条实心长按钮 |
| 次级操作收纳 | 次级/危险/低频操作进 **右键 context menu** | 工具栏塞满次要按钮 |
| 工具栏克制 | 只保留高频 1–3 个入口；避免「按钮墙」 | 多行工具栏、每项都是长文案按钮 |

### Theme follow：主题跟随约定

| 约定 | 内容 |
|------|------|
| `plugin.json` → `ui.themeAware` | **缺省 `true`**（`DEFAULT_PLUGIN_UI` / `resolvePluginUi()`）。一般插件 **不要** 显式写 `false` |
| 设置项 `followShellTheme` | 插件 **SHOULD** 在设置中暴露布尔项 `followShellTheme`，**缺省 `true`**，经 `enest.settings.register` 或 `contributes.settings` 注册 |
| `followShellTheme: true` | 跟随壳子：消费注入 Token + 响应 `onThemeChange` |
| `followShellTheme: false` | 插件 **自行钉住** 偏好配色：读取本地设置的 `preferredColorScheme`（light/dark），UI 按该配色绘制；不依赖壳子当前 mode。manifest 的 `ui.preferredColorScheme` 仍表示壳子注入时的强制配色，二者应在文档与设置文案中对用户说清 |

> `followShellTheme` 是 **插件侧设置约定**，壳子不会自动代填；未实现该项时，应等价于始终跟随壳子（与 `themeAware: true` 行为一致）。

设置项示意（`contributes.settings` 片段，非完整插件）：

```jsonc
{
  "key": "followShellTheme",
  "type": "switch", // 或 boolean / bool
  "label": "跟随系统/壳子主题",
  "default": true
}
```

### Token 缺失时的兜底调色板

壳子未注入（`themeAware: false`、首屏竞态、独立预览）时，页面应自带兜底，**与 `tokens.css` 预设对齐**，注入后被覆盖即可。

| Token | light 兜底 | dark 兜底 |
|-------|------------|-----------|
| `--bg` | `#f3f4f6` | `#0d1118` |
| `--surface` | `#ffffff` | `#161b24` |
| `--surface-2` | `#f0f2f5` | `#1c2230` |
| `--surface-3` | `#e8ebf0` | `#252d3d` |
| `--border` | `rgba(15,23,42,0.08)` | `rgba(255,255,255,0.09)` |
| `--border-strong` | `rgba(15,23,42,0.14)` | `rgba(255,255,255,0.16)` |
| `--text` | `#0f1420` | `#f3f5f9` |
| `--text-2` | `#5c6578` | `#b4bdcf` |
| `--text-3` | `#8b93a5` | `#7c879c` |
| `--accent` | `#1a1f2e` | `#e8ecf4` |
| `--accent-soft` | `rgba(26,31,46,0.08)` | `rgba(232,236,244,0.1)` |
| `--ok` | `#0d9f6e` | `#3dd68c` |
| `--ok-soft` | `rgba(13,159,110,0.1)` | `rgba(61,214,140,0.14)` |
| `--danger` | `#e11d48` | `#ff7a8e` |
| `--danger-soft` | `rgba(225,29,72,0.1)` | `rgba(255,122,142,0.14)` |

结构 Token（两套主题共用）：

| Token | 兜底 |
|-------|------|
| `--radius-xl` | `24px` |
| `--radius-lg` | `18px` |
| `--radius-md` | `14px` |
| `--radius-sm` | `10px` |
| `--radius-pill` | `999px` |
| `--shadow-soft` | light：`0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.05)`；dark：`0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 28px rgba(0,0,0,0.4)` |
| `--shadow-float` | light：`0 16px 40px rgba(15,23,42,0.1)`；dark：`0 16px 48px rgba(0,0,0,0.55)` |
| `--font` | `"Inter", "SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif` |
| `--mono` | `"JetBrains Mono", "SF Mono", ui-monospace, monospace` |
| `--font-size-base` | `14px` |

活动主题包与用户 overrides 会覆盖上表；兜底仅作「无壳子注入」时的保底。

### 右键 Context Menu 模式

插件内浮层菜单不依赖壳子 DOM，由插件自绘：

| 要求 | 说明 |
|------|------|
| 自定义浮层 | `position: fixed/absolute`，`z-index` 高于内容层；表面用 `--surface-3`（或 `--surface` + `--shadow-float`），文字 `--text` / `--text-2`，圆角 `--radius-sm`/`--radius-md` |
| 键盘 Esc | 打开后监听 `keydown`，`Esc` 关闭并 `preventDefault`（若插件无更优先快捷键） |
| 点击外部关闭 | `pointerdown` 目标不在菜单内时关闭；注意与拖拽、滚动的边界 |
| 定位与视口 | 菜单展开方向避开视口边缘；必要时翻转对齐（右/下溢出则向左/上弹出） |
| 项层级 | 破坏性操作用 `--danger` 着色并靠后；分隔线用 `--border`，避免过重 |

### FAB（悬浮主操作）放置

| 指南 | 说明 |
|------|------|
| 位置 | 缺省 **右下角**；有侧栏时可靠右侧 rail，与内容流脱钩 |
| 层级 | `z-index` 必须高于滚动内容与列表，低于 context menu / 模态 |
| 安全边距 | 尊重页面 `padding` 与 mini/透明布局的安全区（避免贴边、避开滚动条） |
| 尺寸与命中 | 触控/鼠标友好（建议 ≥ 36–40px）；图标用 `--accent` 或 surface+accent 组合，配 tooltip |
| 阴影与状态 | 使用 `--shadow-float` 托起；禁用态降低透明度，勿换与主题冲突的硬编码色 |
| 冲突 | 同屏仅一个主 FAB；次级动作进 context menu 或展开菜单，不并排堆多个 FAB |

### 插件作者检查清单

- [ ] `plugin.json` 未无故关闭 `ui.themeAware`（缺省已是 `true`）
- [ ] 颜色、圆角、阴影、字体全部读上表 Token；本地仅保留与 `tokens.css` 对齐的兜底
- [ ] 设置中提供 `followShellTheme`（boolean，缺省 `true`）；`false` 时钉住 `preferredColorScheme` 并自行绘制
- [ ] 主题变更：`onThemeChange` 更新 CSS 变量消费者 / Canvas uniform / 自绘控件
- [ ] 层级用 surface + 阴影，而非密集描边
- [ ] 主操作为 FAB 或 ghost icon button；工具栏无长条按钮墙
- [ ] 次级/危险操作进入右键菜单；菜单支持 Esc 与点击外部关闭
- [ ] FAB 右下或侧栏、z-index 正确、尊重安全边距
- [ ] `themeAware: false` 或独立打开时，兜底调色板不「白屏/黑屏」
- [ ] mini（Quick）与 panel 布局下均不遮挡壳子标题栏 / Quick 输入条

---

## 校验与兼容

| 情况 | 行为 |
|------|------|
| 整段 `ui` 缺失 | 使用全部默认值（chrome=none 全幅渲染，无插件名条） |
| 字段非法枚举 | 回退该字段默认，不影响安装 |
| 写 `chrome: "default"`（旧插件） | 已废弃：加载时归一为 `none`，不再渲染标准条 |
| `themeAware: false` | 不注入、不推送主题；`chrome` / `background` 仍生效 |
| `preferredColorScheme: light/dark` | 强制配色；`theme.getTokens()` 返回强制后的 mode |

---

## 相关文档

- [enest API](api.md) — `ui.*` / `theme.*` 完整签名
- [plugin.json](manifest.md) — 清单字段
- [示例插件](examples.md) — 可运行样例
