# eNest

eNest 是一个插件化桌面壳：把常用工具放进同一个工作台，通过 Quick 呼出、主窗标签、独立窗口或自由面板使用。宿主提供通用原生能力与隔离运行环境，插件实现具体业务，主题控制页面呈现。

宿主技术栈为 Electron、React、TypeScript 和 GSAP；插件前端保持框架无关，可选的 Node 后端需要显式完整本机信任。依赖版本与 Node.js 要求以 `package.json`、`package-lock.json` 为准。

## 软件边界

- **插件业务**：编辑器、剪贴板历史、数据库/SSH/中间件驱动、计时策略等由插件拥有，不作为壳内专属服务。
- **原生宿主**：安装更新、窗口与生命周期、权限、快捷键、文件句柄、私有存储、系统集成和 MCP 协议桥。
- **主题呈现**：首页、目录、详情、Quick、开屏、外观参数和受限设置页。唯一源码内置默认主题随壳编译，第三方主题通过标准贡献点扩展。
- **动态设置**：插件既可向宿主注册字段，也可提供自己的设置页；主题不能越过原生账号、权限、路径和安全确认边界。
- **数据隔离**：插件前台使用统一 `enest.storage` 与授权能力；普通路径字符串不构成前台文件访问授权。默认数据根为 `~/.eNest`，用户可配置自己的数据根。

## 开发入口

先阅读 [AGENTS.md](AGENTS.md)。使用满足 `package.json.engines` 的 Node.js，并按锁文件安装依赖：

```bash
npm ci
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动桌面开发环境 |
| `npm run dev:debug` | 开发并开放本机 CDP 调试端口 9331 |
| `npm run typecheck` | 检查 main/preload 和 renderer 类型 |
| `npm run audit:source` | 静态检查源码、测试夹具与插件职责边界，不执行用例 |
| `npm run build` | 生成主进程、preload、页面和许可证产物到 `out/` |
| `npm run audit:source -- --build-output` | 检查构建产物中的夹具标记和 preload 依赖 |
| `npm run pack:dir` | 生成本机未安装包目录 |
| `npm run dist` | 生成当前平台发行包 |

主进程/preload 修改后重启开发进程；renderer 可使用 HMR。测试仅在用户明确要求时运行，入口与隔离要求见 [tests/README.md](tests/README.md)。

## 官方文档

| 入口 | 内容 |
| --- | --- |
| [产品官网](docs/site/index.html) / [下载说明](docs/site/download.html) | 软件功能与真实发行入口 |
| [插件开发概览](docs/site/plugin/README.md) | 官方 API 文档导航 |
| [工程格式](docs/site/plugin/structure.md) / [清单](docs/site/plugin/manifest.md) | 插件源码、构建与发行格式 |
| [API](docs/site/plugin/api.md) / [存储](docs/site/plugin/storage.md) | 公共能力、可靠提交与私有图片/文件资源 |
| [主题](docs/site/plugin/themes.md) / [设置与窗口](docs/site/plugin/settings-and-windows.md) | 呈现扩展与安全控制边界 |
| [权限](docs/site/plugin/permissions.md) / [生命周期](docs/site/plugin/lifecycle.md) | 授权、实例状态与资源回收 |
| [MCP](docs/site/plugin/mcp.md) | 插件工具贡献、非交互调用和当前可用范围 |
| [AGENTS.md](AGENTS.md) | 宿主开发标准、命名、验证和文档维护规则 |

文档只维护当前产品说明和官方开发契约，不再另外保存开发过程报告。网站发布方式见 [网站维护说明](docs/site/README.md)。

## 仓库结构

```text
src/main          原生宿主与通用服务
src/preload       最小安全桥
src/renderer      壳控制器、共享 UI 与默认主题
src/shared        跨端契约、常量和纯模型
tests             用例、夹具与 DEV 浏览器预览
docs/site         产品官网与官方插件 API
tools             构建发布工具与发布者辅助示例
native            原生剪贴板与平台辅助能力
assets/icons      运行时图标
build             打包图标和系统关联声明
eNest_plugin      独立插件仓库，不纳入宿主 Git
```

## 构建与发行

构建配置在 `electron-builder.yml`；GitHub Actions 使用原生 macOS arm64/x64、Windows x64、Ubuntu 22.04 x64 任务。只有 `v*` 标签发布 Release，手动构建不会自动成为公开发行版。安装包与支持平台以实际 [GitHub Releases](https://github.com/hyqf98/eNest/releases) 为准，仓库版本号不等于已发布版本。

自动更新使用 `electron-updater` 和发行索引：用户检查更新后选择下载，完成后安装并重启。签名、平台安装器和更新元数据是发行要求，本地构建通过不代表各平台启动、安装和更新都已验收。工具细节见 [发布工具说明](tools/packaging/README.md)。

账号接入的发布者示例在 [tools/auth](tools/auth/README.md)，服务端密钥不得进入桌面包。MCP 当前默认关闭，源码接口与最终用户管理界面的交付范围见其官方指南。
