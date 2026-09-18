---
feature: core-plugins
status: delivered
updated: 2026-09-17
branch: main
commits: f48f9f0..HEAD
---

# 核心三插件：屏幕助手 / 粘贴板 / 翻译

## Report

**What was built** — eNest 宿主扩展 7 组插件权限（`screen.capture/record`、`pin.create`、`clipboard.readImage/writeImage/history`、`net.fetch`）并接入 `pluginHandlers` + `pluginPreload`。实现 desktopCapturer 截图、全屏区域选择遮罩、canvas 裁切 MediaRecorder 录屏（可选系统音频，失败降级）、置顶贴图窗、剪贴板历史轮询落盘（200 条、图片 blob 分文件）、受控 HTTPS fetch（手动重定向、逐跳 https 校验）。在 `eNest_plugin/plugins/` 交付三插件：屏幕助手、粘贴板、翻译（谷歌 `translate_a/single`）。本地安装优先 monorepo 路径；关闭插件 Tab 会回收其贴图窗。

**Verification** — `npm run typecheck` PASS；`npm run build` PASS（含 region/recorder/pin 三个新 preload）。eslint 未安装（PRE-EXISTING）。审查发现的 pin HTML 注入 / file 路径、录屏分片竞态、stop 挂起、net.fetch 重定向 SSRF、贴图窗归属等 critical/major 已修复并复验通过。

**Journey log** — 插件无 Node，敏感能力必须走宿主 API 而非插件内 getDisplayMedia；pin 窗口禁止拼接 HTML，载荷用 `executeJavaScript(JSON.stringify)` 注入；MediaRecorder 分片 IPC 必须串行 append 再 rename；`net.fetch` 不能只校验首 URL。

## [S1] Problem

eNest 缺少对标 uTools 的三件套内置工具：

1. **屏幕助手** — 矩形截图、矩形录屏（可选声音）、截图贴到屏幕
2. **粘贴板** — 查看剪贴板历史、图片回显、快速选中回写
3. **翻译** — 谷歌翻译引擎、自动检测语言、一键复制译文

当前插件 API 仅有 `clipboard.readText/writeText`，无法完成上述任一能力。必须先扩展宿主权限与 handler，再在 `eNest_plugin` 交付完整插件 UI。

## [S2] Design

### 2.1 分层

```
插件 UI (eNest_plugin/plugins/*)
    │  window.enest.*  (pluginPreload)
    ▼
plugin:call  →  pluginHandlers  (身份 + 权限 + 分发)
    │
    ├─ screenService   desktopCapturer / 区域遮罩 / 录制会话
    ├─ pinService      alwaysOnTop 贴图窗
    ├─ clipboardHistory 轮询 + 落盘 + 图片 blob
    └─ net.fetch       受控 HTTPS（翻译引擎）
```

插件本身无 Node、无任意文件系统；一切敏感能力经新权限键门禁。

### 2.2 新权限键

| 权限键 | 敏感度 | 覆盖 method |
|--------|--------|-------------|
| `screen.capture` | 高 | `screen.capture` · `screen.selectRegion` |
| `screen.record` | 高 | `screen.record.start/stop/cancel` |
| `pin.create` | 中 | `pin.open/close/list/closeAll` |
| `clipboard.readImage` | 高 | `clipboard.readImage` |
| `clipboard.writeImage` | 中 | `clipboard.writeImage` |
| `clipboard.history` | 高 | `clipboard.history.*` |
| `net.fetch` | 中 | `net.fetch` |

安装时在市场详情展示中文标签；**本轮不做**运行时二次确认弹窗（与现网静态权限模型一致）。

### 2.3 宿主 API 契约

#### screen

```ts
screen.capture(opts?: {
  displayId?: number
  bounds?: { x: number; y: number; width: number; height: number } // 设备像素
}): Promise<{ dataUrl: string; width: number; height: number }>

// 打开全屏冻结遮罩，用户拖矩形；Esc/取消 → null
screen.selectRegion(): Promise<{ x: number; y: number; width: number; height: number } | null>

screen.record.start(opts?: {
  bounds?: { x: number; y: number; width: number; height: number }
  withAudio?: boolean
  displayId?: number
}): Promise<{ sessionId: string }>

screen.record.stop(sessionId: string): Promise<{ path: string; size: number; durationMs: number }>
screen.record.cancel(sessionId: string): Promise<boolean>
```

- 截图：`desktopCapturer.getSources` → `nativeImage` → 可选 crop → PNG dataURL
- 区域遮罩：跨屏 `BrowserWindow`（无边框、全屏、置顶、透明），内置选择 UI
- 录制：隐藏 `BrowserWindow` + `getUserMedia`/`MediaRecorder`；产物写 `~/eNest/recordings/`
- macOS 系统音频依赖系统权限；`withAudio` 优先 loopback，失败回退麦克风，再失败无声并 toast 说明

#### pin

```ts
pin.open(payload: {
  dataUrl?: string
  path?: string
  x?: number
  y?: number
  width?: number
}): Promise<{ pinId: string }>

pin.close(pinId: string): Promise<boolean>
pin.closeAll(): Promise<number>
pin.list(): Promise<Array<{ pinId: string; title?: string }>>
```

- 独立无边框置顶 `BrowserWindow`，展示位图；可拖动、滚轮缩放、右键/按钮关闭
- 多贴图并存；插件卸载/应用退出时 `closeAll`

#### clipboard 扩展

```ts
clipboard.readImage(): Promise<{ dataUrl: string; width: number; height: number } | null>
clipboard.writeImage(dataUrl: string): Promise<boolean>

clipboard.history.list(opts?: { limit?: number }): Promise<ClipboardHistoryEntry[]>
clipboard.history.get(id: string): Promise<ClipboardHistoryEntry | null> // 含完整 text/dataUrl
clipboard.history.remove(id: string): Promise<boolean>
clipboard.history.clear(): Promise<boolean>
clipboard.history.togglePin(id: string): Promise<ClipboardHistoryEntry>
```

`ClipboardHistoryEntry`：

```ts
{
  id: string
  type: 'text' | 'image'
  preview: string        // text 截断或图片尺寸摘要
  text?: string          // type=text 时
  hasImage?: boolean     // type=image
  width?: number
  height?: number
  ts: number
  pinned: boolean
  bytes?: number
}
```

- 主进程 500ms 轮询 `clipboard` 文本/图片指纹；变化则入史
- 上限 200 条（pinned 不淘汰）；图片 blob 写 `~/eNest/data/clipboard-blobs/{id}.png`
- meta 写 `~/eNest/data/clipboard-history.json`
- 回写：text → `writeText`；image → `writeImage`

#### net

```ts
net.fetch(req: {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<{ status: number; headers: Record<string, string>; body: string }>
```

- 仅 `https://`；body 上限 2MB；timeout 默认 15s
- 供谷歌翻译等引擎使用（插件页 CORS 不可用）

### 2.4 谷歌翻译

插件侧请求：

```
GET https://translate.googleapis.com/translate_a/single
  ?client=gtx&sl={auto|src}&tl={tgt}&dt=t&q={text}
```

解析嵌套数组 → 译文；`sl=auto` 时从响应读检测语言。目标语言可配置（zh/en/ja…），历史写 `storage.local`。

### 2.5 三插件清单

| id | 名称 | 目录 | category | form | 核心权限 |
|----|------|------|----------|------|----------|
| `com.enest.screen-assistant` | 屏幕助手 | `eNest_plugin/plugins/com.enest.screen-assistant` | 媒体 | panel | screen.* · pin.create · clipboard.writeImage · storage.local · ui.* |
| `com.enest.clipboard` | 粘贴板 | `eNest_plugin/plugins/com.enest.clipboard` | 效率 | panel | clipboard.* · storage.local · ui.* |
| `com.enest.translate` | 翻译 | `eNest_plugin/plugins/com.enest.translate` | 效率 | mini | net.fetch · clipboard.read/write · storage.local · ui.* |

### 2.6 本地安装路径

`PluginRegistry.installFromSample` / `ensureInstalled` 解析顺序：

1. `eNest_plugin/plugins/{id}/`（完整 monorepo 源）
2. `plugins-samples/{shortNameOf(id)}/`（历史占位）

避免 sample 占位页抢先命中：clipboard/translate 的 `plugins-samples` 占位将同步替换为与 monorepo 一致的实现，或仅保留 monorepo 路径。**采用：优先 monorepo，占位目录删除以免旧 UI 抢占。**

### 2.7 权限文案

`PluginDetailModal.PERMISSION_LABELS` 增加新键中文说明；`docs/site/plugin/permissions.md` 同步全表。

### 2.8 错误与边界

- 未声明权限 → 现有 `permission denied: <perm>`
- 无显示器 / capturer 失败 → `screen capture failed: ...`
- 用户取消区域选择 → `null`（不是 throw）
- 录制进行中再次 start → `recording already in progress`
- `net.fetch` 非 https → `only https urls allowed`
- 剪贴板历史损坏 → 空列表并重建文件

## [S3] Out of Scope

- 运行时权限确认弹窗 / 权限降级 UI
- 翻译多引擎切换（DeepL/百度）、离线包
- 录屏系统音频在无驱动 macOS 上的完美采集
- 剪贴板云同步、加密库
- Quick 小窗内嵌上述插件（form: mini 的 translate 仍进主窗 Tab）

## Tasks

- [x] T1: 扩展 PluginPermission 类型、METHOD_PERMISSION、preload API 与权限文案 — acceptance: typecheck 通过；新 method 可在 handler 映射到权限（covers: S2.2）
- [x] T2: 实现 screen.capture / selectRegion / record 服务并挂到 pluginHandlers — acceptance: 无权限调用被拒；有权限可截全屏/区域并得到 dataUrl（covers: S2.3）
- [x] T3: 实现 pin 窗口服务 — acceptance: pin.open 创建置顶贴图窗，close/closeAll 生效（covers: S2.3）
- [x] T4: 实现 clipboard 图像读写 + 历史轮询落盘 — acceptance: 复制文本/图片后 history.list 可见；get 返回可回写内容（covers: S2.3）
- [x] T5: 实现 net.fetch（https 限制 + 体积/超时）— acceptance: 非 https 被拒；可请求 translate.googleapis.com（covers: S2.3）
- [x] T6: PluginRegistry 样本路径优先 eNest_plugin/plugins/{id} — acceptance: installFromSample 可从 monorepo 安装（covers: S2.6）
- [x] T7: 交付屏幕助手插件 UI — acceptance: 矩形截图、可选音频录屏、贴图三流程可操作（covers: S2.5）
- [x] T8: 交付粘贴板插件 UI — acceptance: 历史列表、图片回显、点击/按钮回写剪贴板（covers: S2.5）
- [x] T9: 交付翻译插件 UI（谷歌引擎）— acceptance: 输入文本得到译文，可复制/写回剪贴板（covers: S2.4; depends: T5）
- [x] T10: 文档 permissions.md 与 mock 市场元数据对齐 — acceptance: 权限全表含新键；市场卡片描述真实（covers: S2.2; S2.7）
