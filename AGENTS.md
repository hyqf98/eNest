# AGENTS.md — eNest 开发约定

eNest：Electron 插件化桌面壳子。改代码前先读本文；与 `ARCHITECTURE.md`、`docs/` 冲突时以更新的约定为准。

## 快速命令

```bash
npm run dev          # electron-vite dev
npm run typecheck    # tsc node + web（提交前必须通过）
npm run build        # electron-vite build
npm run lint         # eslint（若配置存在）
```

插件开发者 SDK 在插件仓 `eNest_plugin/packages/plugin-sdk`；打包图标只认 `build/icon.{icns,ico,png}`（electron-builder buildResources）。`assets/icons/` 仅存运行时图标（`enest-icon-256.png` 窗口 / `dock-runtime.png` Dock），经 extraResources 打进 Resources/icons。

主进程/preload 变更需重启 `npm run dev`；纯 renderer 可依赖 HMR。

## 目录与别名（强制）

**禁止**跨目录写 `../../../`。使用与 `electron.vite.config.ts`、`tsconfig.*.json` 一致的别名：

| 别名 | 路径 |
|------|------|
| `@main/*` | `src/main/*` |
| `@preload/*` | `src/preload/*` |
| `@renderer/*` | `src/renderer/*` |
| `@shared/*` | `src/shared/*` |

```ts
// ✅
import { pluginHost } from '@main/plugin/PluginHost'
import { useShellStore } from '@renderer/stores/shellStore'
import type { PluginTab } from '@shared/types/plugin'

// ❌ 不要
import { pluginHost } from '../plugin/PluginHost'
```

同一目录内相对导入（如 `./Button`）可以保留。跨目录请直接写 `@` 别名。

新增顶层目录时，必须同时改：`electron.vite.config.ts` 的 `sharedAlias`、`tsconfig.node.json`、`tsconfig.web.json`。

## 三端职责

| 区域 | 职责 | 不要放 |
|------|------|--------|
| `src/main` | 窗口、插件 WebContentsView、IPC、设置持久化、代理、更新 | UI / React |
| `src/preload` | `contextBridge` API 暴露 | 业务逻辑 |
| `src/renderer` | React UI、GSAP、样式 | Node/Electron 主进程 API |
| `src/shared` | 三方共用类型与常量（IPC 通道、PluginManifest…） | 运行时依赖 |

IPC 通道名只定义在 `@shared/types/ipc`，preload 与 main 共用。

跨端 DTO 在 `@shared/types/` 定义并复用；壳 API 的 preload、renderer 与 mock 不各写一份同名请求/响应接口。

## UI 组件层（2026-10 起基线）

- 主壳基础控件统一走 `@renderer/components/ui/`（Button/Input/Checkbox/Switch/Tooltip/Dialog/Segmented/Select/Slider）：行为来自 Radix UI，视觉沿用手写 CSS 类（`.btn/.switch/.segmented/.ui-select-*` 等，token 直读）。**新增基础控件优先扩展该层，不要在页面里再手写裸控件**。
- 该组件层是官方插件 `src/ui/`（`pk-*`）模板的**唯一上游**：壳组件升级时同步派生到插件仓（见 `eNest_plugin/docs/developer/react-migration-sop.md`）。
- 官方插件已全面 React 化（React 18 + Radix，与壳同栈、每插件独立打包）；插件规范保持框架无关，第三方插件可自由选型。

插件业务界面、算法、数据模型和协议处理放在插件仓库；壳只扩展可复用的原生能力。不要按插件业务功能增加专用权限或主进程处理器。基础/敏感分类统一使用 `@shared/pluginPermissionPolicy`：插件私有存储、UI、设置、主题、声明式入口、私有密钥保存和插件自身后台计时无需声明或额外权限授权。`fs.read` / `fs.write` 仅限用户经宿主原生选择器选定的文件或当前实例持有的文件句柄，选择目标即授权，不追加通用权限框；拖入路径仍由宿主确认目标，不能静默访问任意路径。网络、剪贴板、系统控制、AI 应用配置与资产等敏感能力继续声明并授权；计时到期的系统通知仍单独受 `notify` 控制。两类都校验实例归属、参数、配额和资源回收，基础能力不得接触宿主保留设置键。

## 状态与设置

- 全局 UI 状态：`@renderer/stores/shellStore`（zustand）
- 外观唯一权威：主进程 `appearanceService` → `ResolvedAppearance` → renderer `useAppearance`；字体/背景/动画/Tab/通知样式不再有独立可写 store。`useAnimationLevel` 只读取有效动画档。
- 通知：优先 `@renderer/services/notifyService`（`notify.info/success/...`）；`toastStore.push` 为兼容层。默认位置由设置 `general.notifyPosition`（中间弹框/右下角）决定，主进程 `showNotification` 对未显式指定 position 的通知在显示时读取
- 持久化：主进程 `settingsStore`（`{dataRoot}/data/enest.db`；`~/.eNest/settings.json` 仅存数据根引导信息）+ mock（localStorage）字段契约对齐；新设置写入 `general` 或独立段，勿只写 UI 本地 state

主题字段可在本地预览，但必须通过 `updateThemeProfile` 提交并以宿主持久化后的 revision 为准；失败恢复确认状态。主题工作区的设置只能经 `enestWorkspace` 描述符接口，不得读取全量 `shellApi.getSettings()`。

## Tab 与插件层（易踩坑）

- 插件内容是 **原生 `WebContentsView`**，叠在 shell 渲染层**之上**。渲染层 UI **不能**盖住插件区。
- **classic**：Tab 在标题栏；**orb**：左侧圆轨 = 主窗口内顶层 WebContentsView（`@main/window/orbRailViews`，rail 收起窄条 hover 展开 + 左下角 dock 设置钮），真实 DOM 鼠标事件，插件视图挂载后必须 `raiseOrbRailViews()` 保持置顶，插件内容全宽，禁止左侧白条通道。
- 目录/已安装/详情属于主题 Workspace，导航走 `navigateWorkspace` 和 ACK。设置入口仍隐藏 Workspace 并走 `set-view: settings`；`SettingsSurfaceController` 选择当前主题的隔离 `settingsPage`，未提供或故障时使用源码内置默认主题设置。默认实现位于 `themes/default/settings/`。主题仅获白名单描述符和 opaque field ID；插件字段须 `shareWithThemes: true`，修改另一插件偏好逐次原生确认；账号、权限、开发者、路径和媒体选择仍由可信原生界面负责。Workspace 不提供设置路由，不存在「受保护设置」恢复机制；不能只靠 DOM z-index。
- 标题栏高度与 `TITLEBAR_HEIGHT`（`@shared/constants`）及 CSS `--titlebar-h` 必须一致（当前 36）。

## 动画

- 所有 GSAP 时长/缓动走 `@renderer/gsap/marketMotion` 的 `d()` / `dy()` / `ease()`（尊重 `data-anim` 低/中/高）。
- CSS 动效用 `:root[data-anim="low|medium|high"]` 覆盖，勿写死与档位无关的大位移。
- 轮播 hover 上移：容器需 `padding` 裁切缓冲 + 负 `margin`，避免 `overflow: hidden` 切顶边。

## 主题与背景

- 只保留一套内置 eNest 默认主题 `enest.builtin / default`（浅/深为两模式），保持原页面、动效和外观设置。源码内置包声明集中在 `@shared/theme/defaultTheme/package`，使用标准 `contributes.themePacks / homePages`；UI 与启动动画位于 `@renderer/themes/default/`。内置包随壳编译，不放入插件仓，不经过插件安装或磁盘注册表加载；第三方主题插件能力保留。完整规范见 `docs/engineering/THEME_STANDARD.md` 与 `docs/site/plugin/themes.md`、`home.md`。
- 默认目录/详情及其样式、轮播、图库和 DEV 预览归 `themes/default/workspace/`，专属开屏/卡片/Tab 编排归 `themes/default/motion/`；不要将真实主题实现放回公共 `components/`。基础控件、Markdown、安全表面控制器、动画档位工具和跨窗口背景引擎仍是共享设施。
- 新主题使用 `ThemePackV2` + schema；所有外观字段在主题 Tab 内动态渲染，禁止按主题 ID 写页面分支。`layout.variant` 是可扩展语义标记，不是内置枚举。
- `enest.theme.register()` 只登记，不能自动切换；外观只经 `appearance-changed` 快照同步。通知外观走受限 `notifications` 字段，内容/来源/关闭/计时由宿主拥有。
- 首页贡献复用 `HomeSurfaceManager`，专用 `enestWorkspace`（`enestHome` 别名）没有普通插件 `enest` 或完整 `shellApi`。新提供者声明 `catalog/detail` 两路由，已安装是提供者本地目录筛选，不向宿主发送 `installed` 路由；渲染后 ACK。设置入口用 `openSettings` 动作请求宿主切换原生设置视图。
- 默认 Quick 的搜索、拼音、规则、排序、最近/推荐均在 `themes/default/quick/`；主进程仅提供可验证目录、provider 传输和原生启动。第三方 Quick 使用 `enestQuick` 安全目录/结果投影，不接受磁盘启动路径或任意启动 payload。
- 启动直接加载源码内置主题（已选第三方主题则恢复有效选择），隐藏预热与默认启动动画并行，ready/路由 ACK/提交后复用同一首页。没有首启主题选择页、确认标记或正常「准备首页」页；故障恢复保留，隐藏预热不能解除恢复锁。原生 orb 可见性由 `App` 的启动/开屏预览门禁统一控制，`ShellLayout` 不另设门禁。
- 背景 `has-bg-media` 时：内容区可加毛玻璃，但 **不要**用同选择器覆盖 `.chip.active` / `.segmented button.active`。

## 插件仓库 `eNest_plugin/`

- 剪贴板历史模型/去重/保留/迁移解释在 clipboard 插件的沙箱后台；壳只提供声明式事件后台、私有文档/blob、有界资源和原生剪贴板事件。无授权、禁用或停止资源后不得自动唤醒。
- 选区/贴图/录制界面和 MediaRecorder 策略在插件仓 `packages/native-surfaces`；壳只提供 `screen.capture/displays`、`auxiliary` 和私有 `files.stream`。辅助页仅有 `enestAux`，不能获得完整 `enest`；录屏必须真实原生手势及系统许可。

- monorepo：`plugins/<短名>/plugin.json`；id = `com.github.eNest.<短名>`，目录名 === id 末段
- 资产命名：`{短名}@{version}.enestplugin`
- 索引：CI 生成 `registry.json`（列表 + 分类 + asset.url/sha256）
- 分类枚举：效率 / 开发 / 设计 / 媒体 / 其它  
- Schema：`eNest_plugin/docs/*.schema.json`；说明见该目录 `README.md`

## 代理

设置 `general.proxy` → 主进程 `proxyService`（`session.setProxy` + `HTTP(S)_PROXY`）。改网络相关逻辑时保持与 proxy 兼容。

## 提交前

1. `npm run typecheck` 通过  
2. 新文件使用 `@` 别名导入  
3. 不要提交 `out/`、本地 `dist/` 插件包  
4. 用户未明确要求时不要 `git commit` / `push`
