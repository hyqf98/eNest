# AGENTS.md — eNest 开发约定

eNest：Electron 插件化桌面壳子。改代码前先读本文；与 `ARCHITECTURE.md`、`docs/` 冲突时以更新的约定为准。

## 快速命令

```bash
npm run dev          # electron-vite dev
npm run typecheck    # tsc node + web（提交前必须通过）
npm run build        # electron-vite build
npm run lint         # eslint（若配置存在）
node scripts/rewrite-imports.mjs   # 相对路径 → @ 别名（可重复执行）
```

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

同一目录内相对导入（如 `./Button`）可以保留。发现历史相对路径时跑：

```bash
node scripts/rewrite-imports.mjs
```

新增顶层目录时，必须同时改：`electron.vite.config.ts` 的 `sharedAlias`、`tsconfig.node.json`、`tsconfig.web.json`。

## 三端职责

| 区域 | 职责 | 不要放 |
|------|------|--------|
| `src/main` | 窗口、插件 WebContentsView、IPC、设置持久化、代理、更新 | UI / React |
| `src/preload` | `contextBridge` API 暴露 | 业务逻辑 |
| `src/renderer` | React UI、GSAP、样式 | Node/Electron 主进程 API |
| `src/shared` | 三方共用类型与常量（IPC 通道、PluginManifest…） | 运行时依赖 |

IPC 通道名只定义在 `@shared/types/ipc`，preload 与 main 共用。

## 状态与设置

- 全局 UI 状态：`@renderer/stores/shellStore`（zustand）
- 主题 / 字体 / 动画档：`@renderer/hooks/useTheme`、`useFont`、`useAnimationLevel`
- 通知：优先 `@renderer/services/notifyService`（`notify.info/success/...`）；`toastStore.push` 为兼容层，默认顶部
- 持久化：主进程 `settingsStore`（`~/eNest/settings.json`）+ mock（localStorage）字段契约对齐；新设置写入 `general` 或独立段，勿只写 UI 本地 state

设置变更若需即时生效，先 `set` store / DOM，再异步 `shellApi.setSettings`。

## Tab 与插件层（易踩坑）

- 插件内容是 **原生 `WebContentsView`**，叠在 shell 渲染层**之上**。渲染层 UI **不能**盖住插件区。
- **classic**：Tab 在标题栏；**orb**：首页/设置用左侧 `FloatingTabRail`；**插件页 orb 用顶栏圆球**（`TitleBar` 内 `TitleBarOrbs`），插件内容全宽，禁止左侧白条通道。
- 回首页/设置必须 `shellApi.hidePlugins()`，否则原生层挡住壳子。
- 标题栏高度与 `TITLEBAR_HEIGHT`（`@shared/constants`）及 CSS `--titlebar-h` 必须一致（当前 36）。

## 动画

- 所有 GSAP 时长/缓动走 `@renderer/gsap/marketMotion` 的 `d()` / `dy()` / `ease()`（尊重 `data-anim` 低/中/高）。
- CSS 动效用 `:root[data-anim="low|medium|high"]` 覆盖，勿写死与档位无关的大位移。
- 轮播 hover 上移：容器需 `padding` 裁切缓冲 + 负 `margin`，避免 `overflow: hidden` 切顶边。

## 主题与背景

- Token 名以 `@shared` / `tokens.css` 为准；插件经 `themeAware` 注入，主题包 `enest.theme.register(ThemePack)` → `theme-packs-changed` → `refreshPacks`。
- 背景 `has-bg-media` 时：内容区可加毛玻璃，但 **不要**用同选择器覆盖 `.chip.active` / `.segmented button.active`。

## 插件仓库 `eNest_plugin/`

- monorepo：`plugins/<id>/plugin.json`；目录名 === `id`
- 资产命名：`{id}@{version}.enestplugin`
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
