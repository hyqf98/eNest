# eNest

插件化桌面壳子（Electron 33+ · React · GSAP · TypeScript）。

## 快速开始

```bash
npm install
npm run dev
```

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式 |
| `npm run build` | 编译到 `out/` |
| `npm run typecheck` | TS 检查 |
| `npm run e2e:smoke` | Playwright 驱动 Electron 冒烟 |
| `npm run dev:debug` | 开发 + CDP 9222 |
| `npm run pack:dir` | 本地未安装包目录（`release/`） |
| `npm run dist` | 当前平台完整安装包 |
| `npm run dist:win` / `dist:mac` / `dist:linux` | 分平台打包 |

## 打包与 CI

- 配置：根目录 [`electron-builder.yml`](electron-builder.yml)（electron-builder 自动发现）
- **Windows**：NSIS 多步安装向导，可选择安装目录；桌面 / 开始菜单快捷方式；中英安装界面
- **静态资源**：`assets/sql`、`assets/icons` → `Resources/`（已本地 `pack:dir` 验证）
- **GitHub Actions**：[`.github/workflows/build.yml`](.github/workflows/build.yml)
  - 矩阵：`macos-latest` · `windows-latest` · `ubuntu-latest`
  - 触发：推送 `v*` 标签或手动 `workflow_dispatch`
  - 产物上传 Artifact；打 tag 时创建**已发布** Release（含 `latest*.yml` + blockmap）
  - 未配置签名时设 `CSC_IDENTITY_AUTO_DISCOVERY=false`

## 自动更新

- 驱动：`electron-updater` + GitHub Releases（`publish.provider: github`）
- 入口：**设置 → 通用 → 软件更新 → 检查更新**
- 流程：检查 → 发现新版本自动下载 → 安装并重启
- 源：`hyqf98/eNest` 最新 Release；需存在 `latest.yml`（Win）/ `latest-mac.yml` / `latest-linux.yml`
- 限制：macOS 自动安装需代码签名；未签名时可检查下载，安装步骤可能被 Gatekeeper 拦截

## 文档

| 文档 | 内容 |
|------|------|
| [docs/engineering/ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md) | **完整技术架构** |
| [docs/engineering/PLUGIN_SPEC.md](docs/engineering/PLUGIN_SPEC.md) | 插件协议与 zapi |
| [docs/engineering/DEVELOPMENT.md](docs/engineering/DEVELOPMENT.md) | 目录规范与开发流程 |
| [docs/engineering/AUTOMATION.md](docs/engineering/AUTOMATION.md) | 自动化 / MCP |
| [docs/site/](docs/site/) | **官网 + 插件开发静态站**（GitHub Pages） |
| [docs/README.md](docs/README.md) | docs 目录划分说明 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 早期定稿（决策记录） |

## 目录速览

```
src/main      主进程（窗口 / 插件宿主 / 协议 / IPC / 设置）
src/preload   shell 与插件预加载桥
src/renderer  React 壳子 UI
src/shared    跨进程类型与常量
assets/       静态资源（应用图标、sql.js wasm）
plugins-samples/  示例插件
scripts/      e2e 等脚本
```

## 架构一页图

```
BaseWindow
├── Shell WebContentsView     # React：标题栏 Tab + 市场/设置/开发者
└── Plugin WebContentsView×N  # 独立 session partition，关 Tab 即销毁
```

- 协议：`enest://plugin/{id}/...`
- 隔离：`persist:plugin-{id}`
- 插件 API：`window.enest`（`zapi`）
- 壳子 API：`window.enestShell`
