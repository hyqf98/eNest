# UI 集成标准

eNest 插件可以使用任意前端技术（HTML / CSS / Canvas / WebGL / 任意框架）绘制界面。壳子通过 `plugin.json` 的 `ui` 段统一管理：

- **插件条 chrome** — 标题栏下的工具条高度与形态
- **主题变量** — CSS 变量注入 + 运行时推送
- **背景透明** — 透出壳子壁纸 / 动效背景
- **配色偏好** — 强制 light/dark 或跟随壳子

插件有两种 **启动方式**：`quick`（Quick 命令面板小窗内嵌）与 `shell`（主窗大窗 Tab）。由打开入口决定（缺省跟随入口），用户可为每个插件覆盖；插件运行时可经 `getLaunchMode()` / `onModeChange()` 感知并在两套入口样式间切换——布局约束见下文「双入口样式」。

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

壳子布局插件区时会读取 `manifest.ui.chrome`，为 **每个已打开插件单独** 计算内容区边界。多插件并存时各自使用自身 chrome 高度。

### 沉浸式布局检查清单

使用 `chrome: "none"` 时：

- [ ] 页面自身 `margin: 0`，根元素撑满
- [ ] 不要假设顶部还有 48px 安全区
- [ ] 若需要自定义头部，在页面内自己画，并预留窗口控制按钮避让（若有）

---

## 双入口样式

插件不再有 manifest `form` 区分，渲染容器由打开入口决定：从 Quick 快捷启动打开 → quick 容器（输入条下方小窗内嵌，小窗适配界面）；从主窗（市场 / 圆轨 / Tab）打开 → shell 容器（主窗大窗 Tab，桌面适配界面）。用户可在插件详情中为每插件覆盖启动方式（`settings.pluginLaunch[id]`，`mode: 'quick' | 'shell'`），仅影响 Quick 打开与热键启动，主窗入口恒为 shell。

插件开发者可在同一入口里写两套界面样式：小窗适配 + 桌面适配。桌面样式定位是更复杂、功能更全；两套样式并存，运行时按启动方式选择渲染。quick ↔ shell 容器迁移（⌘Enter 固定到主窗等）**不重载页面**，迁移只是模式切换。

壳子负责原生窗口、输入条和插件内容区边界。插件拥有自己的页面、搜索、滚动区域、断点和宽高设置；壳子不注入插件内部布局，也不会缩放整张页面。

### 感知启动方式

- URL query 携带 `?mode=quick|shell`（与 `?pid` / `?code` 并列），插件首个脚本可同步读取——但这只是**初始值**。
- 运行时以 `enest.getLaunchMode()`（当前值）与 `enest.onModeChange(cb)`（订阅变更）为准；模式变化同时经 `mode-change` 事件推送。
- `onEnter` 载荷也带 `mode: 'quick' | 'shell'`。

```js
function applyMode(mode) {
  document.documentElement.dataset.mode = mode // 小窗样式 / 桌面样式
}
applyMode(enest.getLaunchMode())
enest.onModeChange((mode) => applyMode(mode))
```

模式由入口决定；CSS 容器查询处理当前模式内的宽度变化，不能仅用宽度推断入口。

`await enest.ui.openInShell()` 将调用插件的现有视图移到主窗口，不新建实例、不重连，也不重放查询。使用同一个会话与编辑器 model，分别持久化 Quick 和桌面的布局。`ResizeObserver` 负责在迁移后重新布局终端和编辑器。

### 编辑区焦点与快捷键

使用 `enest.ui.setInputContext('terminal' | 'editor' | 'overlay' | 'workbench')` 声明当前焦点用途。终端、编辑器和临时选择列表优先处理自己的按键，壳子不会抢走 Esc、Ctrl/Cmd+K 或 Ctrl/Cmd+Enter。只有 `workbench` 上下文保留 Quick 的全局搜索、关闭和固定快捷键。中文输入组合期间不拦截。`enest.ui.focus()` 聚焦当前插件；返回全局搜索使用 `enest.ui.focusSearch()`。

快捷键配置应留在插件自己的设置页。通过 `contributes.settings[].items` 注册 `{ "key": "workbench", "type": "page", "label": "工作台与快捷键", "entry": { "code": "settings" } }` 可在壳设置中提供入口；插件用 `onEnter` 处理 `code === 'settings'`。

### 本地文件与原生拖出

`enest.localFiles.pick()` 打开以当前插件容器为父窗口的选择器；`fromDrop([...event.dataTransfer.files])` 将真实磁盘文件转换为插件私有句柄。之后使用句柄 ID 访问所选内容，禁止把远程路径用作本地文件路径。

拖出必须分两步：先准备真实的本地文件并获取 `exportId`，再在用户 `dragstart` 中调用 `enest.localFiles.startDrag(exportId)`。本地文件用 `prepareDrag({ handleIds })`，SSH 远程文件用下载准备接口。`dragend` 调用 `endDrag()` 释放失焦保护。句柄与导出记录随插件运行实例清理。

### 内容区尺寸

```jsonc
{
  "window": {
    "width": 760,
    "height": 400,
    "minWidth": 480,
    "minHeight": 240
  },
  "permissions": []
}
```

Quick 默认呼出显示两行常用项，总高 248px；搜索随结果数量调整高度，最多 545px。进入插件后才统一展开为 720 × 545px：输入区 64px、内容区 480px、底边 1px。插件实际视口为 718 × 480px；屏幕工作区不足时整体缩小。manifest 的 `window.width` / `height` / `minWidth` / `minHeight` 保留兼容，不改变 Quick 外框。

- `await enest.ui.resize({ width, height })`：保留兼容调用及参数校验，支持只传高度；不改变 Quick 或主窗尺寸。
- `await enest.ui.setHeight(height)`：与 `resize({ height })` 等价，调用成功不改变固定视口。
- 两个接口都是无需声明或授权的基础能力，单位均为 CSS px，参数必须是正有限数。
- 显示器空间不足时，插件应响应实际 viewport 大小并自行滚动。不要假定 Quick 永远是 720px 宽，也不要假定同一入口只能在小窗运行。
- 壳子不根据 `body.scrollHeight` 撑大窗口。内容很长时使用内部滚动；需要更大空间时，提供固定到主窗入口。

### 双入口共用的响应式布局

```css
html, body, #app { width: 100%; height: 100%; margin: 0; }
* { box-sizing: border-box; }
#app { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.content { min-width: 0; min-height: 0; overflow: auto; }
.items { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); }
@media (max-width: 640px) {
  .optional-sidebar { display: none; }
}
```

Canvas / 图表可监听 `ResizeObserver` 或 `window.resize`，使用实际内容区宽高重绘。主窗口放大、Quick 所在屏幕工作区缩小或固定到主窗都会改变 viewport，无需重新加载插件——固定到主窗是容器迁移（`mode-change`），插件按 `getLaunchMode()` 切换小窗 / 桌面两套样式即可。

```js
// 需要更大工作区时，将已有插件视图固定到主窗。
async function expandWorkspace() {
  await enest.ui.openInShell()
}
```

### Quick 交互与键盘

输入条始终属于壳子。嵌入插件后，在顶部输入新的全局关键词会先退回搜索结果；插件自身的内容搜索应放在插件页面里。

| 操作 | 行为 |
|------|------|
| `Esc` | 退出插件，回 Quick 列表；再次按下隐藏 Quick |
| `⌘Enter` / `Ctrl+Enter` | 固定到主窗，同一 WebContentsView 迁移，状态保留 |
| `⌘K` / `Ctrl+K` | 回到顶部全局搜索框并选中已有搜索词 |
| 点击输入条返回按钮 | 回到 Quick 列表 |

插件内容获得焦点时，以上键盘约定由主进程拦截。插件自定义快捷键应避开这些组合。插件在 `onOut` 中暂停动画、轮询，在可重入的 `onEnter` 中恢复。

---

## 主题变量

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

### 主题变量完整列表

| 变量 | 含义 | light 预设 | dark 预设 |
|------|------|-----------|-----------|
| `--bg` | 页面背景 | `#f6f6f4` | `#17191b` |
| `--surface` | 卡片 / 主表面 | `#ffffff` | `#202326` |
| `--surface-2` | 次级表面 | `#eeefed` | `#292d31` |
| `--surface-3` | 浮层表面 | `#e5e7e4` | `#33383d` |
| `--border` | 常规边框 | `rgba(41,44,46,0.08)` | `rgba(242,243,243,0.09)` |
| `--border-strong` | 强边框 | `rgba(41,44,46,0.16)` | `rgba(242,243,243,0.16)` |
| `--text` | 主文字 | `#292c2e` | `#f2f3f3` |
| `--text-2` | 次级文字 | `#666c70` | `#adb3b8` |
| `--text-3` | 弱化文字 | `#82888b` | `#7e878f` |
| `--accent` | 强调色 | `#bd542b` | `#e98654` |
| `--ok` | 成功色 | `#318469` | `#77bfa4` |
| `--ok-soft` | 成功色淡底（自动派生） | `color-mix(in srgb, --ok 12%, transparent)` | `color-mix(in srgb, --ok 16%, transparent)` |
| `--danger` | 危险色 | `#c54f46` | `#e79589` |
| `--link` | 链接色 | `#bd542b` | `#e98654` |

> 预设以 `src/shared/theme/presets.ts` 的 `THEME_TOKEN_PRESETS` 为准；活动主题包与用户 overrides 会覆盖上表。`--accent-soft` / `--ok-soft` / `--danger-soft` / `--link` / `--glow-color` / `--bg-dot` / `--border-dashed` 为派生 token（`resolveThemePalette`，soft 比例 light 12% / dark 16%）。

注入时还会设置：

- `document.documentElement.dataset.theme` = `"light"` | `"dark"`
- `color-scheme` 与之一致（影响滚动条、表单控件原生外观）

### 在 CSS 中使用

```css
:root {
  /* 可选：本地兜底，壳子注入后会被覆盖 */
  --bg: #f6f6f4;
  --text: #292c2e;
  --accent: #bd542b;
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
    value: '#0a1f1c',
    opacity: 0.9,
    fit: 'cover'
  }
})
```

壳子会：

1. 写入主题包注册表（`~/.eNest` 数据根下 `themes/registry.json`；同一 `enest.db` 生态的持久化存储）
2. 推送 `theme-packs-changed`
3. 设置 → 主题 →「主题包」下拉 **即时出现**，用户选择后全壳生效

运行时和声明式主题注册都是基础能力，无需在 `permissions` 声明或单项授权；完整字段与限制见 [enest API → theme.register](api.md#theme-register-pack)。

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
2. **取色走主题变量**：优先读 `--accent` / `--text` 等变量或 `theme.getTokens()`，避免写死与壳子冲突的色值。
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

入口、市场资源与构建方式遵循 [工程结构](structure.md)。

---

## 完整示例：沉浸式 Canvas 插件

**plugin.json**

```json
{
  "id": "com.example.viz",
  "name": "可视化",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": [],
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
      --bg: #17191b;
      --text: #f2f3f3;
      --accent: #e98654;
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
  <script type="module" src="./src/main.js"></script>

</body>
</html>
```

**src/main.js**

```js
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
```

---

## 设计语言与样式规范（插件 UI 集成标准）

本节是插件作者的 **视觉与主题契约**。与前文「能注入哪些主题变量」互补：这里规定 **必须使用哪些主题变量、如何排版层级、主题如何跟随壳子**。

### 必须使用的壳子主题变量（`themeAware: true` 时）

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

> 注入时还会同步设置 `document.documentElement.dataset.theme` 与 `color-scheme`，便于第三方样式库自适应。

运行时动态取色（Canvas / WebGL / 无 CSS 变量环境）走 `enest.theme.getTokens()` 与 `enest.ui.onThemeChange`，变量名与上表一致（含 `var(--xxx)` 形式的键）。

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
| `followShellTheme: true` | 跟随壳子：消费注入主题变量 + 响应 `onThemeChange` |
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

### 无主题注入时的默认色板

壳子未注入（`themeAware: false`、首屏竞态、独立预览）时，页面应自带兜底色板，注入后由主题变量覆盖即可。

| Token | light 兜底 | dark 兜底 |
|-------|------------|-----------|
| `--bg` | `#f6f6f4` | `#17191b` |
| `--surface` | `#ffffff` | `#202326` |
| `--surface-2` | `#eeefed` | `#292d31` |
| `--surface-3` | `#e5e7e4` | `#33383d` |
| `--border` | `rgba(41,44,46,0.08)` | `rgba(242,243,243,0.09)` |
| `--border-strong` | `rgba(41,44,46,0.16)` | `rgba(242,243,243,0.16)` |
| `--text` | `#292c2e` | `#f2f3f3` |
| `--text-2` | `#666c70` | `#adb3b8` |
| `--text-3` | `#82888b` | `#7e878f` |
| `--accent` | `#bd542b` | `#e98654` |
| `--accent-soft` | `color-mix(in srgb, #bd542b 12%, transparent)` | `color-mix(in srgb, #e98654 16%, transparent)` |
| `--ok` | `#318469` | `#77bfa4` |
| `--ok-soft` | `color-mix(in srgb, #318469 12%, transparent)` | `color-mix(in srgb, #77bfa4 16%, transparent)` |
| `--danger` | `#c54f46` | `#e79589` |
| `--danger-soft` | `color-mix(in srgb, #c54f46 12%, transparent)` | `color-mix(in srgb, #e79589 16%, transparent)` |

结构与字体变量（两套主题共用）：

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
| 安全边距 | 尊重页面 `padding` 与小窗（Quick）/ 透明布局的安全区（避免贴边、避开滚动条） |
| 尺寸与命中 | 触控/鼠标友好（建议 ≥ 36–40px）；图标用 `--accent` 或 surface+accent 组合，配 tooltip |
| 阴影与状态 | 使用 `--shadow-float` 托起；禁用态降低透明度，勿换与主题冲突的硬编码色 |
| 冲突 | 同屏仅一个主 FAB；次级动作进 context menu 或展开菜单，不并排堆多个 FAB |

### 插件作者检查清单

- [ ] `plugin.json` 未无故关闭 `ui.themeAware`（缺省已是 `true`）
- [ ] 颜色、圆角、阴影、字体全部读上表主题变量；本地仅保留对齐默认主题的兜底色板
- [ ] 设置中提供 `followShellTheme`（boolean，缺省 `true`）；`false` 时钉住 `preferredColorScheme` 并自行绘制
- [ ] 主题变更：`onThemeChange` 更新 CSS 变量消费者 / Canvas uniform / 自绘控件
- [ ] 层级用 surface + 阴影，而非密集描边
- [ ] 主操作为 FAB 或 ghost icon button；工具栏无长条按钮墙
- [ ] 次级/危险操作进入右键菜单；菜单支持 Esc 与点击外部关闭
- [ ] FAB 右下或侧栏、z-index 正确、尊重安全边距
- [ ] `themeAware: false` 或独立打开时，兜底调色板不「白屏/黑屏」
- [ ] 小窗（Quick）与主窗两种启动方式下均不遮挡壳子标题栏 / Quick 输入条；模式切换经 `onModeChange` 切换对应入口样式

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


## 响应式空间约定

Quick/主窗使用真实启动模式；不要用 600px 断点猜测模式。宽度只决定是否收起侧栏、换行工具栏或调整列数。固定图标、1px 边框和 36px 宿主标题栏可保留像素；内容尺寸随容器变化。

```css
html, body, #app { margin: 0; width: 100%; height: 100%; min-width: 0; }
body { font: var(--font-size-base, 14px)/1.5 var(--font, sans-serif); }
.workspace { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; min-height: 0; }
.toolbar { display: flex; flex-wrap: wrap; gap: .5rem; }
.content { min-width: 0; min-height: 0; overflow: auto; padding: clamp(.75rem, 2vw, 1.5rem); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 1rem; }
.table-scroll { max-width: 100%; overflow: auto; }
```

容器查询的 container-type 设置在被查询组件的祖先上，不能通过查询自身改变自己的大小。不要用 body overflow:hidden 掩盖不可达的按钮。至少验收窄 Quick、桌面主窗和 150% 字号，表格/终端可局部横向滚动，页面本身不应意外横溢出。
