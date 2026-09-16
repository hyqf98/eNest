---
feature: quick-launcher
status: delivered
updated: 2026-09-16
branch: feat/quick-launcher
commits: a8cdb2b..HEAD
---

# Quick Launcher（ztools 式小窗启动器骨架）

## Report

**What was built** — eNest 增加独立于主壳子的快捷启动小窗（`?surface=quick` 的 `BaseWindow`）：全局热键默认 `Alt+Space`（多 accelerator 任一触发，失败回滚并 toast），设置页可录制/启用热键并重新扫描本地应用。命令面聚合内置操作、已安装插件 `features.cmds`（含别名检索）与三平台本地应用扫描（macOS `.app` / Windows 开始菜单 `.lnk` / Linux `.desktop`）。`plugin.json` 支持 `form: mini|panel`（缺省 panel）；骨架阶段 mini/panel 均打开主窗 Tab。`quick:open` 启动本地应用前必须命中扫描缓存白名单，阻断渲染层任意路径 `spawn`。

**Verification** — `npm run typecheck` PASS；`npm run build` PASS；`npm run e2e:smoke` PASS。运行时：`quickGetConfig` → `Alt+Space` enabled；扫描 72 个应用 complete；空查询返回 actions；`quickOpen` 注入 `/usr/bin/touch`、`open -a Calculator`、未知 `.app` 均被拒绝。

**Journey log** — 首轮 `ensureQuickWindow` 预创建与 Playwright `firstWindow` 抢占冲突，改为热键懒创建；`electron-updater` 具名导入在 ESM 下启动即挂（既有问题），改为 default 解构；审查指出 `quick:open` 路径未校验可 RCE、失败热键被持久化，已修（白名单 + 只持久化 `registered`）。

## [S1] Problem

eNest 目前只有主壳子大窗口（市场 + 多 Tab 插件）。用户需要：

1. 全局快捷键呼出一个独立小窗命令面板（Spotlight / ztools / uTools 形态）；
2. 在输入框中搜索并启动：本地已安装应用、已安装插件的 `features.cmds` 指令；
3. 插件可声明形态：小窗命令（`mini`）与主窗大插件（`panel`），两种都可从命令面触发；
4. 设置页可录制全局快捷键，处理 mac / Windows / Linux 冲突与权限。

本轮交付**骨架**：小窗 + 快捷键 + 应用扫描启动 + 插件 form 字段 + cmds 搜索。  
**不做**：内置计算器/翻译 mini 工具、小窗内嵌插件 WebContentsView、拼音搜索、剪贴板历史、双击修饰键。

## [S2] Design

### 2.1 产品分层

| 形态 | 宿主 | 触发 | 本轮行为 |
|------|------|------|----------|
| Quick Window | 独立 `BaseWindow`（无边框、置顶、居中） | 全局快捷键（默认 `Alt+Space`） | 完整实现 |
| panel 插件 | 主壳子 Tab（现有 PluginHost） | 命令面 Enter / 主窗市场 | 命令面列出并 `openPlugin` |
| mini 插件 | 未来小窗内嵌 View | 命令面 Enter | 本轮仍 `openPlugin` 到主窗（占位，manifest 已可声明 `form: "mini"`） |
| 本地应用 | OS 原生 | 命令面 Enter | 扫描 + 启动 |

### 2.2 窗口拓扑

```
BaseWindow 主壳子（现有）
└── Shell WebContentsView

BaseWindow Quick（新建，独立）
└── Quick WebContentsView   # ?surface=quick 仅渲染命令面板
```

Quick 窗口参数：

- `frame: false` · `resizable: false` · `skipTaskbar: true`
- `alwaysOnTop: true` · macOS `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
- 默认尺寸 720×420；显示时相对光标屏幕居中（上 1/3 偏上）
- **懒创建**：启动只注册热键；首次呼出时 `ensureQuickWindow()`
- 失焦自动 `hide()`（不销毁）；Esc 隐藏；Enter 执行后隐藏
- 预加载复用 `shellPreload`（同一 API 面）；URL `?surface=quick`

### 2.3 全局快捷键

设置持久化（`~/eNest/settings.json` → `general`）：

```ts
general.quickLauncher = {
  enabled: boolean          // 默认 true
  hotkeys: string[]         // Electron accelerator，默认平台相关
}
```

默认热键（可注册多个，任一触发 toggle）：

| 平台 | 默认 hotkeys |
|------|----------------|
| darwin | `Alt+Space`（即 Option+Space） |
| win32 | `Alt+Space`，再尝试 `Ctrl+Space` |
| linux | `Alt+Space`，再尝试 `Ctrl+Space` |

注册策略（`src/main/hotkey/quickHotkey.ts`）：

1. 先 `unregister` 旧集合；
2. 对每个目标 accelerator `globalShortcut.register`；`register()` 返回 `false` 记入 `failed`；
3. 至少一个成功即启用；全部失败 → `enabled` 保持但发送事件提示「快捷键被占用」；
4. 设置页修改后立即 re-register；失败回滚到上一成功集合并 `toast`。
5. **不引入** `uiohook-napi` 等原生监听（避免 macOS 辅助功能/输入监控权限与打包体积）。
6. macOS 注意：`Ctrl+Space` 常被输入法占用；Windows 上 `Alt+Space` 在前台窗口有系统菜单语义，全局注册仍可用，失败则靠第二快捷键。

### 2.4 快捷键录制（设置页）

- 组件 `HotkeyRecorder.tsx`：点击进入录制，监听 `keydown`，映射 `KeyboardEvent.code` → Electron accelerator；
- 修饰键：`Meta`→`Command`(mac)/`Super`(win/linux)、`Control`→`Control`、`Alt`→`Alt`、`Shift`→`Shift`；
- 至少一个非修饰键；拒绝单独修饰键；
- 保存走 `quick:set-hotkeys`，主进程应用并返回 `{ ok, hotkeys, failed, registered }`。

### 2.5 本地应用扫描

```
src/main/launcher/
  types.ts          # LocalApp / ApplicationScanResult
  appScanner.ts     # 平台分发 + 内存缓存
  macScanner.ts
  windowsScanner.ts
  linuxScanner.ts
  appLauncher.ts    # shell.openPath / open / xdg-open
```

扫描源（骨架，无原生模块）：

| 平台 | 源 |
|------|-----|
| macOS | `/Applications`、`/System/Applications`、`~/Applications` 下 `*.app`（一层 + 子目录有限下钻）；`Info.plist` 读 `CFBundleDisplayName` / `CFBundleName`；icon 走 `app.getFileIcon` 延迟填充 |
| Windows | 开始菜单 `*.lnk` + 桌面快捷方式（用户/公共）；`shell.readShortcutLink`；跳过卸载/帮助类名称 |
| Linux | `~/.local/share/applications`、`/usr/share/applications`、`/var/lib/snapd/desktop/applications` 的 `*.desktop`；解析 `Name`/`Exec`/`NoDisplay`/`Hidden`/`Terminal` |

- 启动后异步全量扫描一次，结果缓存；`quick:scan-apps` 可强制刷新；
- 启动：mac `open -a` / `shell.openPath`；win `shell.openPath` 或 `spawn` 目标；linux 解析 `Exec` 字段后 `spawn`（`%U`/`%F` 剥离）。

### 2.6 命令索引与搜索

`src/main/launcher/commandIndex.ts`：

```ts
type QuickCommand =
  | { kind: 'app'; id: string; title: string; subtitle: string; path: string; icon?: string }
  | { kind: 'plugin'; id: string; title: string; subtitle: string; pluginId: string; code?: string; form: 'mini' | 'panel' }
  | { kind: 'action'; id: string; title: string; subtitle: string; action: 'open-settings' | 'open-market' | 'refresh-apps' }
```

- 插件条目：已安装插件的 `features[].cmds`（字符串字面量指令）+ 无 feature 时用插件名作为默认指令；
- `form` 来自 manifest，缺省 `panel`；
- 搜索：大小写不敏感；`title` 前缀 > 包含 > `subtitle` 包含；空查询显示推荐（最近/内置 action）；
- 打开插件：调用现有 `pluginHost`/`shell:open-plugin` 等价主进程逻辑，并 focus 主窗。

### 2.7 插件 manifest 扩展

```jsonc
{
  "form": "mini" | "panel",   // 可选，缺省 panel
  "features": [
    { "code": "main", "explain": "…", "cmds": ["翻译", "fy"] }
  ]
}
```

- `panel`：主窗 Tab（现状）。
- `mini`：本轮命令面仍打开主窗；类型与索引已就绪，后续可在 Quick 窗内嵌 View。

### 2.8 IPC 契约

新增通道（`IpcChannels`）：

| 通道 | 方向 | 说明 |
|------|------|------|
| `quick:toggle` | R→M | 显示/隐藏 Quick 窗（快捷键主入口） |
| `quick:hide` | R→M | 主动隐藏 |
| `quick:search` | R→M | `{ query }` → `{ items: QuickCommand[] }` |
| `quick:open` | R→M | `{ kind, id, pluginId?, code?, path? }` 执行 |
| `quick:scan-apps` | R→M | `{ force?: boolean }` → `{ apps, complete, errors }` |
| `quick:get-config` | R→M | `{ enabled, hotkeys, platform }` |
| `quick:set-hotkeys` | R→M | `{ enabled?, hotkeys }` → 应用结果 |

`shell:event` 增加：`{ type: 'quick-hotkey-failed'; failed: string[]; registered: string[] }`  
`{ type: 'quick-config-changed'; enabled: boolean; hotkeys: string[] }`

### 2.9 渲染（Quick UI）

- 路由：`App.tsx` 检测 `?surface=quick`，渲染 `QuickLauncherApp`（不走 Splash/市场）。
- 布局：顶部搜索框 + 结果列表；无边框拖拽区（`-webkit-app-region: drag` 仅顶 12px）。
- 样式复用 `tokens.css` 主题；圆角、阴影由窗口提供。
- 键盘：`↑↓` 选择、`Enter` 打开、`Esc` 隐藏、`⌘/Ctrl+Enter` 在主窗打开 panel 插件。

### 2.10 设置页

「设置 → 快捷启动」：

- 启用开关；
- 快捷键列表 + 录制/删除；
- 本地应用扫描「重新扫描」按钮 + 计数；
- 说明：mini/panel 形态与冲突提示。

### 2.11 样本插件

- `plugins-samples/translate`、`json` 增加 `"form": "mini"` 与 `features.cmds`（仅元数据，便于命令面命中）；
- 不改插件运行时逻辑。

### 2.12 错误行为

- 快捷键全失败：设置页红字 + toast；主窗仍可通过设置操作。
- 应用扫描失败：返回 `errors`，UI 显示部分结果。
- 插件未安装：搜索不出现；打开时主进程再校验。
- Quick 窗首次显示前未加载完成：`show()` 等 `did-finish-load`。

## [S3] Out of Scope

- 内置计算器 / 翻译 / JSON 等内核小工具；
- Quick 窗内嵌插件 `WebContentsView`（mini 宿主）；
- 拼音 / 首字母搜索；使用频次排序持久化；
- 剪贴板历史、划词、超级面板、双击修饰键、悬浮球；
- 原生模块应用扫描（Windows MUI/lnk 原生、mac accessibility）；
- 多显示器高级定位策略（骨架：光标所在屏居中）。

## Tasks

- [x] T1: shared 契约 — form 字段、Quick 类型、IPC 通道与事件 — acceptance: `npm run typecheck` 通过且类型可被 main/renderer 引用（covers: S2.3, S2.5–S2.8）
- [x] T2: 主进程 Quick 窗口 + 全局快捷键 — acceptance: 启动后可注册默认热键；toggle 显示/隐藏；失败有事件（covers: S2.2, S2.3; depends: T1）
- [x] T3: 应用扫描与启动 — acceptance: 当前平台 `quick:scan-apps` 返回非空列表（本机有应用时）；`quick:open` kind=app 能启动（covers: S2.5; depends: T1）
- [x] T4: 命令索引与搜索 IPC — acceptance: `quick:search` 能返回插件指令与应用；空 query 返回 action 推荐（covers: S2.6; depends: T1, T3）
- [x] T5: preload + Quick 渲染 UI — acceptance: `?surface=quick` 打开命令面板；键盘导航与 Esc/Enter 行为正确（covers: S2.9; depends: T2, T4）
- [x] T6: 设置页快捷键录制与扫描刷新 — acceptance: 可录制新热键并生效；重新扫描按钮工作（covers: S2.4, S2.10; depends: T2, T3）
- [x] T7: 样本插件 form/cmds 元数据 — acceptance: translate/json 声明 mini 且 cmds 可被搜索命中（covers: S2.7, S2.11; depends: T4）
- [x] T8: 验证 typecheck + 冒烟 — acceptance: `npm run typecheck` 与可行的 e2e/smoke 通过（covers: S2; depends: T1–T7）
