# eNest 插件协议规范 v0.1

## 目录结构

```
my-plugin/
├── plugin.json      # 必选清单
├── logo.png         # 可选 512×512
├── index.html       # 主界面入口
├── preload.js       # 可选（壳子会注入 enest API，一般无需自带）
└── settings.html    # 可选设置面板
```

## plugin.json

```jsonc
{
  "id": "com.example.hello",
  "name": "Hello 工具",
  "version": "1.0.0",
  "description": "示例插件",
  "author": "dev",
  "logo": "logo.png",
  "main": "index.html",
  "settings": "settings.html",
  "engines": { "enest": ">=0.1.0" },
  "permissions": [
    "clipboard.read",
    "clipboard.write",
    "shell.openExternal",
    "storage.local",
    "notify",
    "ui.setTitle",
    "ui.setIcon",
    "ui.setBadge",
    "ui.resize",
    "ui.toast",
    "settings.register"
  ],
  "window": { "minWidth": 480, "minHeight": 320 },
  "features": [{ "code": "main", "cmds": ["hello"] }],
  "development": { "main": "http://127.0.0.1:5173/index.html" },
  "ui": {
    "chrome": "default",
    "themeAware": true,
    "background": "opaque",
    "preferredColorScheme": "auto"
  }
}
```

| 字段 | 必选 | 说明 |
|------|------|------|
| `id` | 是 | 全局唯一，反向域名 |
| `name` | 是 | 显示名 |
| `version` | 是 | semver |
| `main` | 是 | HTML 入口相对路径 |
| `permissions` | 否 | IPC 白名单，未声明的调用会被拒绝 |
| `development.main` | 否 | 开发态 URL（Vite/Webpack） |
| `ui` | 否 | UI 集成配置，见下节 |

## UI 集成标准

插件保留自有 UI（HTML/CSS/Canvas/WebGL 均可），壳子负责 chrome 高度、主题 Token 与背景透明。

### plugin.json `ui`

```jsonc
"ui": {
  "chrome": "default" | "minimal" | "none",
  // default: 标准插件条 48px；minimal: 细条 28px；none: 无条，内容全幅
  "themeAware": true,
  // true: 壳子注入 CSS 变量并推送主题变更
  "background": "transparent" | "opaque",
  // transparent: WebContents 透明底，透出壳子背景（Canvas/WebGL 场景）
  "preferredColorScheme": "light" | "dark" | "auto"
  // light/dark 强制该配色；auto 跟随壳子（含系统主题）
}
```

**缺省（整段或字段缺失）**：`chrome=default`，`themeAware=true`，`background=opaque`，`preferredColorScheme=auto`。

### 主题 Token

- **注入时机**：插件 `did-finish-load` 后 `executeJavaScript` 写入 `document.documentElement` 的 CSS 变量；壳子主题变更时向所有已打开的 `themeAware` 插件再次注入并推送 IPC。
- **协议 CSS**：`enest://plugin/{id}/__enest_theme.css` 动态生成，可选 `<link rel="stylesheet">` 引入。
- **Token 集**（与壳子一致）：`--bg` `--surface` `--surface-2` `--surface-3` `--border` `--border-strong` `--text` `--text-2` `--text-3` `--accent` `--ok` `--ok-soft` `--danger`；并设置 `data-theme="light|dark"` 与 `color-scheme`。
- **叠加顺序**：内置预设 → 活动主题包 → 用户 overrides。

### 运行时 API（主题）

```ts
// 读取当前 Token（按 preferredColorScheme 解析后的 light/dark）
const { mode, tokens } = await enest.theme.getTokens()

// 订阅主题变更；返回取消订阅函数
const off = enest.ui.onThemeChange(({ mode, tokens }) => {
  // 重绘 Canvas / 更新 WebGL uniform 等
})
```

也可用通用 `enest.on('theme-change', cb)` / `enest.off(...)`。

### Chrome 与布局

| chrome | 插件条高 | 说明 |
|--------|----------|------|
| `default` | 48px | 标准条：名称 + 协议 URL |
| `minimal` | 28px | 细条：仅名称 |
| `none` | 0 | 不渲染插件条；内容区从标题栏下方开始 |

主进程 `getPluginContentBounds(chromeBarHeight)` 按当前插件 chrome 扣除标题栏 + 插件条；多插件打开时各自使用自身 chrome 高度布局。

### 动态绘制（Canvas / WebGL）

- 壳子**不禁止**任何绘制技术；`background: transparent` 时请用 `clearRect` / `alpha: true` 的 WebGL 上下文，勿绘制不透明底色。
- 颜色请优先读 `--accent` / `--text` 等 Token 或 `theme.getTokens()`，避免写死与壳子冲突的色值。
- 示例：`plugins-samples/canvas-demo/`（`chrome=none` + 透明底 + 主题感知动画）。

## 运行时 API

preload 向插件页面注入 `window.enest`（别名 `window.zapi`）。

```ts
// UI（扁平别名与 enest.ui.* 命名空间等价）
await enest.ui.setTitle('我的工具')
await enest.setBadge(3) // 或 enest.ui.setBadge(3)

// 应用内 Toast：由壳子统一渲染（与 notify 系统通知分工）
// type: 'info' | 'success' | 'warn' | 'error'，默认 info
await enest.ui.toast({ message: '已保存', type: 'success' })

// 设置动态注册（壳子设置页「插件」分组）
await enest.settings.register({
  id: 'hello.prefs',
  title: 'Hello 工具',
  items: [{ key: 'name', type: 'text', label: '称呼', default: '朋友' }]
})

// 持久化存储（按插件 partition 隔离，落盘至 ~/eNest/data/plugin-storage/{id}.json）
await enest.storage.set('k', { any: true })
await enest.storage.get('k')

// 会话态存储：主进程内存，插件 Tab 关闭或应用退出即清空，不落盘
// 权限复用 storage.local（弱于持久化，无需单独声明）
await enest.storage.session.set('draft', { text: '...' })
await enest.storage.session.get('draft')

// 系统
await enest.clipboard.writeText('hi')
await enest.shell.openExternal('https://example.com')
await enest.notify({ title: '完成', body: 'ok' }) // 系统通知，可后台展示
```

### toast vs notify

| API | 渲染方 | 场景 |
|-----|--------|------|
| `ui.toast({ message, type? })` | 壳子全局 Toast 层 | 应用内轻提示，当前窗口可见时 |
| `notify({ title, body })` | 操作系统通知 | 系统级、可后台触发 |

权限与 API 对应关系：

| API | 权限 |
|-----|------|
| `clipboard.readText` | `clipboard.read` |
| `clipboard.writeText` | `clipboard.write` |
| `shell.openExternal` | `shell.openExternal` |
| `storage.*` / `storage.session.*` | `storage.local` |
| `notify` | `notify` |
| `ui.setTitle` | `ui.setTitle` |
| `ui.setIcon` | `ui.setIcon` |
| `ui.setBadge` | `ui.setBadge` |
| `ui.resize` | `ui.resize` |
| `ui.toast` | `ui.toast` |
| `settings.register` | `settings.register` |

## 隔离模型

- 每个插件独立 `session` partition：`persist:plugin-{id}`
- 自定义协议：`enest://plugin/{id}/...`，仅映射该插件根目录
- 关闭 Tab 时 `webContents.close()` 立即回收，并清空 `storage.session`
- 日常关闭 **不清除** partition localStorage / `storage.local`（用户数据保留）
- 卸载插件时应 `session.clearStorageData()` + 删除 `plugin-storage/{id}.json`（见 LIFECYCLE_REVIEW.md）

## 安装包

- 扩展名：`.enestplugin`（zip）或普通 `.zip`；也可直接拖入**插件文件夹**
- 包结构：`plugin.json` 必须位于 zip **根目录**，或**唯一一层子目录**内
- 安装路径：`{dataRoot}/plugins/{id}/{version}/`（默认 `~/eNest/plugins/...`）
- 安装入口：
  1. **拖拽**：将文件夹 / `.enestplugin` 拖到 eNest 窗口任意位置 → 遮罩提示「释放以安装插件」
  2. **IPC**：`shell:install-plugin(sourcePath)` 入队，主进程 `installQueue` 限流执行
- 并发：最多 **3** 个并行安装，其余按 FIFO 进入等待列表
- 进度事件（`shell:event`）：
  - `install-progress` `{ jobId, name, progress: 0–100, step? }`
  - `install-queue` `{ active: InstallJobInfo[], waiting: InstallJobInfo[] }`
  - `install-result` `{ jobId, name, ok, error? }` → 统一 Toast 反馈
- 日志：安装每一步 + 主进程 boot 写入 `{dataRoot}/logs/YYYY-MM-DD.log`

### 打包示例

```bash
# 文件夹安装（最简单）
cp -R my-plugin ~/Desktop/my-plugin
# 拖入 eNest 窗口即可

# 打成 .enestplugin
cd my-plugin && zip -r ../my-plugin.enestplugin .
```

## 生命周期（摘要）

完整分析见 [LIFECYCLE_REVIEW.md](./LIFECYCLE_REVIEW.md)。

- **打开** `openPlugin`：不存在则创建 View 并加载；已存在则激活（单例）
- **切换** `activatePlugin`：`setVisible` 显隐，不销毁
- **关闭** `closePlugin`：立即销毁 WebContents + 清空 session 存储
- 演进方向：`onEnter` / `onOut` 生命周期事件（当前未实现）
