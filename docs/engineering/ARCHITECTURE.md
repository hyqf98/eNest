# eNest 技术架构说明

> 版本：v0.2 · 对应代码状态：`src/` 工程实现  
> 产品：**eNest** 插件化桌面壳子 · 协议：`enest://` · 运行时：Electron 33+

---

## 1. 产品与技术决策

| 项 | 决策 |
|----|------|
| 产品名 / 包名 | eNest / `enest` |
| 桌面框架 | Electron 33+（`BaseWindow` + `WebContentsView`，不用已废弃 BrowserView） |
| 壳子 UI | React 18 + TypeScript + GSAP |
| 构建 | electron-vite（main / preload / renderer 三入口） |
| 状态 | zustand（渲染进程） |
| 布局 | **无侧栏**；首页即市场；左下角浮动「开发者 / 设置」 |
| 主题 | 默认浅色；设置页可切深色并实时改 Token |
| Tab 关闭 | 立即 `webContents.close()`，无 LRU 保活 |
| 市场数据 | 第一期本地 Mock + `plugins-samples` 示例包 |
| 数据根目录 | `~/eNest`（`plugins/` · `data/` · `themes/` · `settings.json`） |
| SQLite | **sql.js**（WASM 真 SQLite）写入 `~/eNest/data/enest.db`；避免 better-sqlite3 原生 ABI 在 Electron 下 SIGSEGV |
| 打包 | electron-builder，目标安装包 &lt; 90MB；`extraResources` 自 `assets/` 含 sql.wasm 与 icons |

---

## 2. 进程拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  Main Process (Node)                                        │
│  index.ts → createShellWindow · PluginHost · Protocol · IPC │
└───────────────┬─────────────────────────────┬───────────────┘
                │ IPC (invoke / send)         │
┌───────────────▼──────────────┐  ┌───────────▼────────────────┐
│  Shell Renderer              │  │  Plugin Renderer × N       │
│  React 壳子（全窗口）         │  │  WebContentsView           │
│  preload: shellPreload       │  │  session: persist:plugin-* │
│  window.enestShell           │  │  preload: pluginPreload    │
│                              │  │  window.enest / zapi       │
└──────────────────────────────┘  └────────────────────────────┘
```

### 窗口层级（关键）

1. **Shell WebContentsView** 铺满整个 `BaseWindow`：标题栏 + Tab + 市场/设置/开发者页面。
2. **Plugin WebContentsView** 叠在 Shell 之上，bounds 为：

   ```
   x = 0
   y = TITLEBAR_HEIGHT + PLUGIN_BAR_HEIGHT   // 48 + 48 = 96
   width  = windowWidth
   height = windowHeight - y
   ```

   这样原生插件页不会挡住标题栏和插件工具条。
3. 窗口 `resize` 时由 `pluginHost.layoutAll()` 重算所有插件 View。
4. 关 Tab：`webContents.close()`；关窗口：`destroyAll()`。

---

## 3. 目录与模块职责

```
src/
├── shared/                     # 跨进程契约（只放类型与常量）
│   ├── constants.ts            # 协议名、partition、标题栏高度、tabId 转换
│   └── types/
│       ├── plugin.ts           # Manifest / PluginSummary / Permission
│       └── ipc.ts              # IPC 通道名与事件负载类型
│
├── main/
│   ├── index.ts                # 启动入口：特权协议、窗口、IPC 注册
│   ├── window/
│   │   ├── createShellWindow.ts  # BaseWindow + ShellView + resize 联动
│   │   └── windowState.ts        # 内容区 / 插件区 bounds 计算
│   ├── plugin/
│   │   ├── PluginHost.ts       # 打开/激活/关闭/布局插件 View
│   │   ├── PluginRegistry.ts   # 市场 + 磁盘扫描 + 从 sample 安装
│   │   ├── mockMarket.ts       # 6 个 Mock 市场插件元数据
│   │   ├── PluginInstaller.ts  # 本地目录安装（zip 为 stub）
│   │   ├── PluginPermissions.ts# 权限白名单校验
│   │   └── pluginProtocol.ts   # enest:// 协议 + 路径穿越防护 + CSP
│   ├── settings/
│   │   ├── SettingsStore.ts    # userData/settings.json 持久化
│   │   └── PluginSettingsBridge.ts  # 插件动态设置分组
│   ├── ipc/
│   │   ├── channels.ts         # 通道 re-export
│   │   ├── shellHandlers.ts    # 壳子侧 invoke 处理器
│   │   └── pluginHandlers.ts   # plugin:call + 权限门禁
│   └── dev/DevConsole.ts       # 加载本地插件目录
│
├── preload/
│   ├── shellPreload.ts         # contextBridge → window.enestShell
│   └── pluginPreload.ts        # contextBridge → window.enest / zapi
│
└── renderer/
    ├── index.html / main.tsx / App.tsx
    ├── styles/                 # tokens / base / app（CSS 变量主题）
    ├── layout/                 # TitleBar · TabStrip · BottomBar · ShellLayout
    ├── pages/                  # Market · Settings · DevConsole · PluginHostChrome
    ├── components/             # 轮播、卡片、搜索、主题编辑器…
    ├── stores/shellStore.ts    # 视图 / Tab / 筛选状态
    ├── hooks/                  # useTheme · useShellEvents · useToast
    ├── gsap/marketMotion.ts    # Hero 入场、卡片 stagger、轮播位移
    └── services/
        ├── shellApi.ts         # ShellApi 封装 + 无 preload 时的 Mock 回退
        └── mockData.ts         # Mock 市场与本地存储读写
```

**规范**：一个文件一个职责；禁止把 IPC、UI、业务揉进单文件；新增能力先加 `shared` 契约再改两端。

---

## 4. IPC 契约

通道常量：`src/shared/types/ipc.ts` → `IpcChannels`。

| 通道 | 方向 | 说明 |
|------|------|------|
| `shell:get-plugins` | R→M | 市场 + 已安装列表 |
| `shell:open-plugin` | R→M | 安装（如需）并创建 WebContentsView |
| `shell:close-plugin` | R→M | 关 Tab 并销毁 View |
| `shell:activate-plugin` | R→M | 切换可见插件 |
| `shell:get-theme` / `set-theme` | R→M | 主题持久化 |
| `shell:load-dev-plugin` | R→M | 开发者加载本地目录 |
| `shell:reload-plugin` / `open-devtools` | R→M | 热重载 / DevTools |
| `shell:get-settings` / `set-settings` | R→M | 通用设置 |
| `window:minimize/maximize/close` | R→M | 无边框窗口控制 |
| `plugin:call` | P→M | 插件 API 统一入口（权限校验） |
| `shell:event` | M→R | plugins-changed / tab-closed / theme-changed… |

R = Shell Renderer，P = Plugin Renderer，M = Main。

约定：

- 壳子业务用 `ipcMain.handle` + `invoke`。
- 窗口控制用 `send`（无需返回值）。
- 主进程推送一律走 `shell:event`，preload `onEvent` 订阅。

---

## 5. 插件协议

详见 [PLUGIN_SPEC.md](PLUGIN_SPEC.md)。

要点：

- 清单 `plugin.json`：`id` / `main` / `permissions` / 可选 `development.main`。
- 运行时注入 `window.enest`（别名 `zapi`）。
- 存储与 Cookie 按 `persist:plugin-{id}` 隔离。
- 静态资源：`enest://plugin/{id}/...`，`path.resolve` + `relative` 防 `..` 穿越。
- 未声明权限的 `plugin:call` 直接失败。

---

## 6. 权限模型

| 权限键 | API |
|--------|-----|
| `clipboard.read` / `write` | clipboard.readText / writeText |
| `shell.openExternal` | 外部浏览器 |
| `storage.local` | storage.get/set/remove/clear |
| `notify` | 系统通知 |
| `ui.setTitle` / `setIcon` / `setBadge` / `resize` | Tab / 窗口 UI |
| `settings.register` | 向壳子设置页注入分组 |

校验位置：`src/main/ipc/pluginHandlers.ts` + `PluginPermissions.ts`。

---

## 7. 主题系统

1. CSS Token 定义在 `src/renderer/styles/tokens.css`（`data-theme="light|dark"`）。
2. 渲染进程 `useTheme` 写 `document.documentElement` 并调用 `shellApi.setTheme`。
3. 主进程 `SettingsStore` 持久化 `mode` + `overrides`。
4. 设置页 `ThemeTokenEditor` 可改颜色 Token，立即生效。

---

## 8. 前端页面流

| 视图 | 组件 | 说明 |
|------|------|------|
| 首页市场 | `MarketPage` | Hero 打字机、搜索、分类、浏览/已安装、精选轮播、卡片网格 |
| 插件 Tab | Shell 透明内容区 + 原生 PluginView | 仅保留标题栏与插件条；主体由 WebContentsView 绘制 |
| 设置 | `SettingsPage` | 通用 / 主题 / 快捷键 / 开发者 + 插件动态分组 |
| 开发者 | `DevConsolePage` | 本地目录、热重载、DevTools、日志 |

动效集中在 `gsap/marketMotion.ts`，避免散落在业务组件。

---

## 9. 数据流示例：打开插件

```
用户点击卡片
  → shellStore.openPlugin(id)
  → shellApi.openPlugin(id)                    # preload invoke
  → shellHandlers: registry.installFromSample  # 若未安装
  → pluginHost.openPlugin
       · session.fromPartition
       · 注册 per-session enest://
       · new WebContentsView + load
       · setBounds(content) / setVisible
  → send shell:event plugins-changed
  → 渲染进程刷新列表 + 增加 Tab
```

关闭 Tab：`closePlugin` → `webContents.close()` → 移除 View → `tab-closed`。

---

## 10. 构建与产物

| 命令 | 产物 |
|------|------|
| `npm run dev` | electron-vite 开发（HMR renderer） |
| `npm run build` | `out/main` · `out/preload/*.mjs` · `out/renderer` |
| `npm run typecheck` | tsc node + web |
| `npm run e2e:smoke` | Playwright 驱动 Electron 冒烟 |
| `npm run pack:dir` | electron-builder 目录包 |

注意：

- `package.json` `"type": "module"` → preload 产出为 **`.mjs`**，主进程 `resolvePreload` 需改写扩展名。
- ESM preload **不能** 开 `sandbox: true`（当前 `sandbox: false`）。
- 预加载路径基于 `app.getAppPath()`，不要用 `__dirname`。

---

## 11. 安全清单

- [x] 壳子：`contextIsolation: true`，`nodeIntegration: false`
- [x] 插件：独立 session + 白名单 IPC
- [x] 协议：路径穿越防护
- [x] 插件 HTML 注入 CSP（生产）
- [ ] zip 安装签名校验（后续）
- [ ] 权限运行时二次确认 UI（后续）

---

## 12. 自动化

见 [AUTOMATION.md](AUTOMATION.md)。

- 项目内：`playwright-core` + `scripts/e2e-smoke.mjs`
- CDP：`ENEST_REMOTE_DEBUG=9222` 或 `npm run dev:debug`
- MiMo Desktop：设置 → MCP 添加 `@playwright/mcp`，可选 `--cdp-endpoint`

---

## 13. 已知限制 / 路线图

| 项 | 状态 |
|----|------|
| Mock 市场 / sample 安装 | 已实现 |
| 多 Tab 隔离与销毁 | 已实现 |
| 主题 Token 动态调色 | 已实现 |
| 开发者目录加载 | 已实现 |
| 数据目录 `~/eNest` + 迁移 | 已实现 |
| SQLite（sql.js WASM） | 已实现，文件 `data/enest.db` |
| i18n 中英切换 | 已实现 |
| 插件详情弹窗 + README | 已实现 |
| 主题：浅/深/系统 + 背景图/视频 | 已实现 |
| 硬件加速开关 | 已实现（需重启） |
| `.enestplugin` zip 安装 | stub，待实现 |
| 全局指令搜索（features） | 未接线 |
| 插件崩溃恢复 UI | 部分（事件通道已有） |
| 自动更新 / 签名 | 未开始 |

---

## 14. 静态资源布局

| 路径 | 用途 |
|------|------|
| `assets/icons/` | 应用图标 256/512/1024 |
| `assets/sql/sql-wasm.wasm` | sql.js 引擎（dev + 打包 extraResources） |
| `src/` | **唯一**业务实现 |

视觉与样式以 `src/renderer/styles` 为准。

---

## 15. 相关文档

- [README](../../README.md)
- [插件协议](PLUGIN_SPEC.md)
- [开发指南](DEVELOPMENT.md)
- [自动化与 MCP](AUTOMATION.md)
