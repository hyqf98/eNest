# eNest 开发指南

## 环境

- Node.js ≥ 20
- npm ≥ 10

```bash
npm install
npm run dev
```

## 进程边界

```
Main (Node)          Preload              Renderer (React)
─────────────        ───────              ────────────────
PluginHost      ←→   shellPreload    ←→   shellStore / pages
Protocol             pluginPreload  ←→   window.enest (插件页)
SettingsStore
IPC handlers
```

- 渲染进程 **不得** 直接 `require('electron')`。
- 壳子 UI 只通过 `window.enestShell`（`src/renderer/services/shellApi.ts`）访问主进程。
- 插件页面只通过 `window.enest`。

跨目录导入用 `@main`、`@preload`、`@renderer`、`@shared`，同目录内可用 `./`。改公共 API 时按 [宿主开发](../site/plugin/host-development.md) 同步权限、生成 SDK 和销毁清理；所有 preload 为自包含 CJS，保持 sandbox 开启。

## 目录规范

按功能拆分，禁止把多职责塞进单文件：

| 目录 | 允许内容 |
|------|----------|
| `src/main/window` | 窗口创建与布局 |
| `src/main/plugin` | 宿主、清单、协议、权限 |
| `src/main/ipc` | 通道处理器 |
| `src/main/settings` | 持久化设置 |
| `src/renderer/pages` | 路由级页面 |
| `src/renderer/components` | 可复用 UI |
| `src/renderer/stores` | zustand |
| `src/renderer/gsap` | 动效 |
| `src/shared` | 仅类型与常量 |

## 新增 IPC

1. 在 `src/shared/types/ipc.ts` 增加通道常量。
2. 主进程 `src/main/ipc/*Handlers.ts` 注册；壳/Quick/orb 通道使用 `ipcSecurity` 的可信窗口包装器，插件通道验证主 frame、origin、身份和运行代次。
3. preload 暴露方法。
4. `shellApi.ts` 封装 + mock。

## 主题

- Token 定义在 `src/renderer/styles/tokens.css`。
- 默认浅色；设置页可切深色并改色值。
- 主进程 `SettingsStore` 持久化 `mode` 与 `overrides`。

## 调试插件

1. 设置 → 开发者，或左下角「开发者」。
2. 「加载本地目录」指向含 `plugin.json` 的文件夹。
3. `development.main` 可指向 Vite：`http://127.0.0.1:5173/index.html`。
4. 框架自行执行 `npm run dev` 并提供 HMR；宿主不启动 npm 或监听源文件。静态源码修改后手动重新加载，发布前明确选择 dist 预览。

支持 IP/端口和完整 URL 覆盖，配置只保存在开发注册记录，不改源码。加载后自动在壳内打开，不复制安装；细节见 [调试](../site/plugin/debug.md)。

## 命名

- 协议：`enest://`
- 包名：`enest`
- IPC 前缀：`shell:` / `plugin:`
