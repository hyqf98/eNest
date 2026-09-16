# eNest 插件化桌面壳子 — 架构定稿（决策记录）

> **完整实现架构请读：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**  
> 本文保留 v0.1 决策过程，供追溯。

> 版本：v0.1 · 状态：已确认  
> 产品名：**eNest** · 协议：`enest://` · 包前缀：`@enest/*`

---

## 1. 已锁定决策

| 项 | 决策 |
|----|------|
| 产品名 | eNest |
| 协议 | `enest://plugin/{id}/...` |
| 侧栏 | **无侧栏**。首页即市场；左下角浮动开发者 / 设置 |
| 市场数据 | 第一期本地 Mock + 可安装示例插件 |
| 主题 | 双主题 + **设置 → 主题** 全量 Token 动态调色 |
| Tab 关闭 | 立即销毁 `webContents` |
| 壳子 UI | React 18 + GSAP |
| 桌面运行时 | Electron 33+ · `BaseWindow` + `WebContentsView` |
| 打包 | electron-forge / builder，目标安装包 &lt; 90MB |

---

## 2. 进程与视图拓扑

```
BaseWindow (frameless)
├── ShellView          // React 壳子：标题栏 Tab、侧栏、市场、设置
└── PluginView × N     // WebContentsView，独立 session partition
                       // persist:plugin-{pluginId}
```

- 壳子默认会话：`enest-shell`
- 插件会话：`persist:plugin-{id}`（Cookie / localStorage / IndexedDB / 缓存隔离）
- 自定义协议在各 session 上注册，防跨插件读盘

---

## 3. 插件清单 `plugin.json`

```jsonc
{
  "id": "com.example.hello",
  "name": "Hello 工具",
  "version": "1.0.0",
  "description": "示例插件",
  "author": "dev",
  "logo": "logo.png",
  "main": "index.html",
  "preload": "preload.js",
  "settings": "settings.html",
  "engines": { "enest": ">=0.1.0" },
  "permissions": [
    "clipboard.read", "clipboard.write",
    "shell.openExternal", "storage.local",
    "notify", "ui.setTitle", "ui.setIcon",
    "ui.setBadge", "settings.register"
  ],
  "window": { "minWidth": 480, "minHeight": 320 },
  "features": [{ "code": "main", "cmds": ["hello"] }],
  "development": { "main": "http://127.0.0.1:5173/index.html" }
}
```

### 安装包

- 扩展名：`.enestplugin`（zip）
- 安装路径：`userData/plugins/{id}/{version}/`
- 安装时：schema 校验 → 权限列表落库 → 哈希校验

---

## 4. zapi（插件 API）

preload 注入 `window.enest`（别名 `zapi`）。主进程按 `permissions` 白名单放行 IPC。

| 域 | API |
|----|-----|
| ui | `setTitle` `setIcon` `setBadge` `resize` `onShow` `onHide` |
| settings | `register(section)` `get` `set` |
| storage | `get` `set` `remove` `clear`（按 plugin id） |
| clipboard | `readText` `writeText` |
| shell | `openExternal` |
| notify | `show({title,body})` |
| events | `on` `off` `emit` |

### 设置动态注册

```js
enest.settings.register({
  id: 'hello.prefs',
  title: 'Hello 工具',
  items: [
    { key: 'greetName', type: 'text', label: '称呼', default: '朋友' }
  ]
})
```

壳子设置页左侧出现「插件」分组下的「Hello 工具」，右侧面板渲染声明式控件；或插件提供 `settings.html` 则嵌入该页。

---

## 5. 多 Tab 与生命周期

| 事件 | 行为 |
|------|------|
| 打开插件 | 创建 `WebContentsView` + partition，加载 `enest://plugin/{id}/index.html` |
| 切换 Tab | `setVisible(true/false)`，激活项置顶 `setBounds(内容区)` |
| 关闭 Tab | `webContents.close()`，移除 View，卸载 IPC 监听 |
| 插件崩溃 | Tab 标记错误态，提供「重新加载」 |
| 窗口关闭 | 销毁全部 PluginView |

无 LRU 保活（本期）。

---

## 6. 安全

- `contextIsolation: true` · `nodeIntegration: false` · `sandbox: true`（插件 View）
- 预加载仅暴露白名单 IPC
- 协议 handler 解析路径后 `path.relative` 防 `..` 穿越
- 插件 HTML 注入 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`
- 开发模式放宽 CSP，允许 `localhost` HMR

---

## 7. 开发者控制台

1. 「加载本地目录」— 选含 `plugin.json` 的文件夹  
2. 热更新 — `development.main` URL 或 file watcher `reload`  
3. DevTools — detach 模式  
4. 日志 — console + IPC 聚合  
5. 权限模拟  
6. 导出 `.enestplugin`

入口：侧栏「开发者」+ 设置 → 开发者。

---

## 8. 视觉 Token（设置 → 主题 可调）

### 深色（默认）

| Token | 值 |
|-------|-----|
| `--bg` | `#0B0D12` |
| `--surface` | `#12151C` |
| `--surface-2` | `#181C26` |
| `--border` | `#1E2430` |
| `--text` | `#E8ECF4` |
| `--text-2` | `#8B93A7` |
| `--accent` | `#5B8CFF` |
| `--ok` | `#3DDC97` |
| `--danger` | `#FF5C7A` |
| `--radius-card` | `12px` |
| `--radius-btn` | `8px` |
| `--shadow` | `0 8px 32px rgba(0,0,0,.45)` |

### 浅色

| Token | 值 |
|-------|-----|
| `--bg` | `#F4F6FA` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#EEF1F6` |
| `--border` | `#E2E8F0` |
| `--text` | `#0F172A` |
| `--text-2` | `#64748B` |
| `--accent` | `#3B6AE8` |

字体：`Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif`  
Mono：`JetBrains Mono, "SF Mono", monospace`

---

## 9. 布局（无侧栏）

```
┌──────────────────────────────────────────────┐
│  ● ● ●   [首页] [Hello] [剪贴板]     ─ □ ×   │  标题栏 + 多 Tab
├──────────────────────────────────────────────┤
│                                              │
│   ENEST EXTENSIONS                           │
│   发现下一件顺手的工具              [搜索…]   │
│   [浏览市场 | 已安装]   全部 效率 开发 设计    │
│                                              │
│   ┌──────── 精选大卡 ────────┐                │
│   │  图标区   │  名称/操作    │                │
│   └──────────────────────────┘                │
│   ┌───┐ ┌───┐ ┌───┐                          │
│   │卡 │ │卡 │ │卡 │   3 列网格                │
│   └───┘ └───┘ └───┘                          │
│                                              │
│  [</>] [⚙]                     ← 左下角浮动   │
└──────────────────────────────────────────────┘
```

- 首页即插件市场；顶部 Tab 打开插件
- 左下角：开发者 / 设置
- 设置页内：通用 · 主题 Token · 快捷键 · 开发者 · 插件动态分组

---

## 10. 工程目录（严格按功能拆分）

```
eNest/
├── package.json
├── electron.vite.config.ts
├── forge.config.ts
├── ARCHITECTURE.md
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── window/createShellWindow.ts
│   │   ├── window/windowState.ts
│   │   ├── plugin/PluginHost.ts
│   │   ├── plugin/PluginRegistry.ts
│   │   ├── plugin/PluginInstaller.ts
│   │   ├── plugin/PluginPermissions.ts
│   │   ├── plugin/pluginProtocol.ts
│   │   ├── settings/SettingsStore.ts
│   │   ├── settings/PluginSettingsBridge.ts
│   │   ├── ipc/channels.ts
│   │   ├── ipc/shellHandlers.ts
│   │   ├── ipc/pluginHandlers.ts
│   │   └── dev/DevConsole.ts
│   ├── preload/
│   │   ├── shellPreload.ts
│   │   └── pluginPreload.ts
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── styles/tokens.css
│   │   ├── styles/base.css
│   │   ├── styles/components.css
│   │   ├── layout/ShellLayout.tsx
│   │   ├── layout/TitleBar.tsx
│   │   ├── layout/TabBar.tsx
│   │   ├── layout/SideNav.tsx
│   │   ├── pages/MarketPage.tsx
│   │   ├── pages/InstalledPage.tsx
│   │   ├── pages/SettingsPage.tsx
│   │   ├── pages/DevConsolePage.tsx
│   │   ├── pages/PluginHostView.tsx
│   │   ├── components/*
│   │   ├── hooks/*
│   │   ├── stores/*
│   │   └── gsap/*
│   └── shared/
│       ├── types/plugin.ts
│       ├── types/ipc.ts
│       └── constants.ts
├── plugins-samples/hello/
└── resources/
```

当前仓库中的 `index.html` + `css/` + `js/` 为 **壳子 UI 高保真原型**（浏览器可预览），用于确认视觉与交互；正式实现迁入 Electron + React 工程。

---

## 11. 瘦身与跨平台

- 不引入 `@electron/remote`、原生模块
- `asar: true`，按平台单目标打包
- 前端 tree-shake，GSAP 按需
- 懒创建 PluginView，启动只挂 ShellView
- CI：mac / win / linux 三矩阵
- 目标安装包 &lt; 90MB

---

## 12. 里程碑

| 阶段 | 交付 |
|------|------|
| P0 | 壳子 UI 原型（本仓库 index.html）+ 架构文档 |
| P1 | Electron 骨架 + market/installed/settings 页面 |
| P2 | 插件运行时：清单、View 隔离、zapi 最小集 |
| P3 | 多 Tab 生命周期 + 标题联动 |
| P4 | 设置动态注册 |
| P5 | 开发者控制台 |
| P6 | 安装包 + Mock 市场安装流 |
| P7 | 瘦身打包与跨平台验收 |
