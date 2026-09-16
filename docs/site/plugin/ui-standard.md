# UI 集成标准

eNest 插件可以使用任意前端技术（HTML/CSS/Canvas/WebGL）绘制界面。壳子通过 `plugin.json` 的 `ui` 段统一管理 **插件条 chrome**、**主题 Token** 与 **背景透明**，插件无需依赖壳子 DOM。

## 配置一览

在 `plugin.json` 中声明（全部可选）：

```jsonc
{
  "ui": {
    "chrome": "default",           // default | minimal | none
    "themeAware": true,            // 是否接收壳子主题注入
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

> 缺省整段 `ui` 时，行为与上表默认值一致。

## Chrome 模式

```
┌─────────────────────────────┐
│ 标题栏 TITLEBAR 48px        │  始终存在
├─────────────────────────────┤
│ 插件条                      │  default 48 / minimal 28 / none 0
├─────────────────────────────┤
│                             │
│   插件内容（WebContents）    │  高度 = 窗口高 − 标题栏 − 插件条
│                             │
└─────────────────────────────┘
```

- **default**：显示插件名 + `enest://` 协议路径，适合工具类插件。
- **minimal**：仅保留细条与名称，适合需要更多纵向空间的界面。
- **none**：不渲染插件条，内容全幅（标题栏以下），适合游戏、看板、可视化等沉浸场景。

壳子在 `PluginHost` 布局时读取 `manifest.ui.chrome`，为每个已打开插件单独计算内容区边界。

## 主题 Token

### 注入方式

1. **自动注入（推荐）**  
   `themeAware: true` 时，插件页 `did-finish-load` 后壳子执行脚本，向 `document.documentElement` 写入 CSS 变量；壳子设置页切换主题、或系统主题变化（`mode: system`）时再次注入，并通过 IPC 推送变更。

2. **协议 CSS（可选）**  
   ```html
   <link rel="stylesheet" href="enest://plugin/<插件id>/__enest_theme.css" />
   ```
   文件由主进程按当前主题动态生成，适合作为首屏兜底；运行时仍建议监听 `onThemeChange`。

3. **JS API**  
   ```js
   const { mode, tokens } = await enest.theme.getTokens()
   const off = enest.ui.onThemeChange(({ mode, tokens }) => {
     // 更新 Canvas 取色 / WebGL uniform
   })
   ```

### Token 列表

| 变量 | 含义 |
|------|------|
| `--bg` | 页面背景 |
| `--surface` / `--surface-2` / `--surface-3` | 卡片 / 次级 / 浮层表面 |
| `--border` / `--border-strong` | 边框 |
| `--text` / `--text-2` / `--text-3` | 主 / 次 / 弱化文字 |
| `--accent` | 强调色 |
| `--ok` / `--ok-soft` | 成功色及其淡底 |
| `--danger` | 危险色 |

同时会设置：

- `document.documentElement.dataset.theme` = `"light"` | `"dark"`
- `color-scheme` 与之一致（影响滚动条、表单控件）

### 叠加顺序

```
内置 light/dark 预设  →  活动主题包 tokens  →  用户在设置页的 overrides
```

`preferredColorScheme: "light" | "dark"` 会**强制**该配色（忽略壳子当前 mode）；`auto` 时跟随壳子，壳子为 `system` 则读系统偏好。

### 在 CSS 中使用

```css
body {
  background: var(--bg);
  color: var(--text);
  font-family: Inter, 'PingFang SC', sans-serif;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
}
button.primary {
  background: var(--accent);
  color: var(--bg);
}
```

> 未设置 `themeAware: false` 时，壳子仍会注入变量；你也可以在页面内自带默认值，注入后会被覆盖。

## 透明背景与动态绘制

当 `background: "transparent"`：

- 主进程将插件 `webContents` 背景设为 `#00000000`，并在加载完成后再确认一次。
- 插件页应使用 `background: transparent`，Canvas 用 `clearRect`，WebGL 建议 `alpha: true`。
- 可透出壳子的纯色 / 图片 / 视频背景，适合动态壁纸上的小组件与可视化。

**Canvas / WebGL 注意事项**

- 壳子不限制绘制 API；请自行控制帧率与功耗。
- 取色优先读 Token（`getComputedStyle` 或 `theme.getTokens()`），避免与壳子主题脱节。
- 参考示例：仓库内 `plugins-samples/canvas-demo/`。

## 完整示例：沉浸式 Canvas 插件

`plugin.json`：

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

`index.html`（节选）：

```html
<style>
  html, body { margin: 0; height: 100%; background: transparent; }
  canvas { width: 100%; height: 100%; display: block; }
</style>
<canvas id="c"></canvas>
<script>
  const api = window.enest || window.zapi
  let accent = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#5b8cff'

  api?.theme.getTokens().then(({ tokens }) => {
    accent = tokens['--accent'] || accent
  })
  api?.ui.onThemeChange(({ tokens }) => {
    accent = tokens['--accent'] || accent
  })
</script>
```

## 校验与兼容

- 安装器对 `ui` 做归一：非法枚举值回退默认，不影响安装。
- 旧插件不写 `ui` 即保持原行为（标准插件条 + 不透明底 + 跟随主题）。
- `themeAware: false` 时壳子不注入、不推送主题；`chrome` / `background` 仍生效。
