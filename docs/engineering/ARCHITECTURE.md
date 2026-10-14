# eNest 当前技术架构

更新于 2026-10-13。通用插件运行在 Electron 44 的 WebContentsView 中，壳界面使用 React、TypeScript、zustand 和 GSAP。根目录 ARCHITECTURE.md 保留早期决策，当前插件开发契约以 [开发文档](../site/plugin/README.md) 和仓库生成的 schema/SDK 为准。

## 进程与视图

```text
Main
├── BaseWindow / Shell WebContentsView（主窗 React 界面）
├── Plugin WebContentsView × N（各插件独立 persist:plugin-{id}）
├── Quick BrowserWindow / Plugin WebContentsView（快捷面板）
├── orb rail WebContentsView（主窗内顶层导航）
└── 宿主服务：文件能力、存储、网络、SSH、数据库、计时、主题
```

所有 renderer 关闭 Node 集成、开启 contextIsolation 和 Chromium sandbox。preload 构建为自包含 `.cjs`，仅暴露 contextBridge API；插件不能自带可执行 preload。DSH 保留专属外部 Node runtime，它不属于通用页面沙箱的保证范围。

原生插件视图在 shell DOM 之上，返回首页/设置必须隐藏它；授权使用主进程原生对话框。orb rail 在插件挂载后重新置顶。主窗标题栏固定 36px，插件内容 bounds 由窗口实际尺寸和 chrome 高度计算；Quick 启动模式与主窗通过 API 明确切换，断点只调整空间布局。

## 模块与公共契约

| 区域 | 职责 |
| --- | --- |
| `src/main/plugin` | Registry、安装/卸载、Host、权限、协议、运行代次、活动租约、编译缓存 |
| `src/main/ipc` | 插件分发与 shell/Quick/orb 的可信窗口门禁 |
| `src/main/dev` | 独立开发注册、源码/服务器/dist 预览与覆盖配置 |
| `src/main/paths`、`db`、`settings` | 数据根、迁移、SQLite、缓冲 KV 与设置 |
| `src/main/window` | 窗口创建、原生层 bounds 与可见性 |
| `src/preload` | 壳、插件和辅助窗口的最小 API 桥 |
| `src/renderer` | React UI、布局、状态、主题、动效 |
| `src/shared` | 跨端类型、IPC 常量、标准路径和生成的 manifest schema |
| 独立插件仓库 | `plugins/<id>`、workspace kit、SDK、构建/验收工具、开发 skill |

跨目录使用 `@main`、`@preload`、`@renderer`、`@shared` 别名。公共 API 修改必须同步类型、preload、宿主分发、权限和资源回收；SDK 和文档由插件仓库脚本生成并提供无写入检查模式。

## 加载与安装

普通插件的源码根为 `plugins/<id>`，包含 plugin.json、package.json、index.html、src 和 public/assets。Vue、React 和原生 JS 共用这一标准。源码/发行格式、必填字段和资源约束见 [工程格式](../site/plugin/structure.md)。

发布根固定为 dist，其直接内容打成 `{id}@{version}.enestplugin`。安装过程在后台准备与解包，校验路径、schema、真实文件、包身份和市场摘要，重新校验暂存副本，再原子替换并发布 Registry。失败时回滚，更新使旧内容版本缓存失效。普通包拒绝源码、环境配置、依赖目录、符号链接和额外目录层。

开发注册不复制、不安装、不运行 npm。框架自行运行开发服务器；宿主只连接明确配置的 origin 与同源 HMR。静态源码只映射 index.html、src 和 public/assets；修改后手动重载。生产预览明确选 dist，不因服务器失败静默切换路径。

已安装版本的 icon、README 和截图走该版本的 `enest://plugin/{id}/assets/...`；未安装市场的媒体从最终 ZIP 提取。Markdown 不执行 HTML，资源路径和链接协议受限。

## 能力边界

插件 IPC 校验 WebContents 身份、主 frame、origin、插件 ID、当前运行代次。壳提供统一能力，插件自行实现业务。基础存储/UI/设置/主题/声明式入口/私有密钥保存直接可用；只有敏感能力先声明，再经 ask/allow/deny 决策；原生对话框串行执行，撤权关闭当前代次。浏览器敏感权限、下载、任意导航与直接外联默认拒绝，开发 origin 与宿主签发的连接桥按精确范围放行。

系统文件通过原生选择器签发的能力句柄访问，绑定插件、用途、真实路径和运行代次。裸路径仅展示。SQLite authorizer、DuckDB 外部访问锁定防止 SQL 绕过文件授权。文件读取、网络流、SSE、连接队列和待写存储都有预算。

Chromium 用户通过 HTML 文件选择器或拖放授予的 File 能力不等同于宿主 API 权限；Electron 的权限回调并不能统一拦截全部此类输入。官方插件已改用宿主 pick/read 接口。完整边界见 [权限说明](../site/plugin/permissions.md) 与 [安全验证](PLUGIN_SECURITY_VALIDATION.md)。

## 生命周期与数据

默认保持六个实例的软上限，后台三分钟休眠，按 LRU 回收；开发模式和活跃宿主任务有明确例外。切换、主窗隐藏/最小化、Quick 隐藏采用一致的可见性语义。休眠前发送检查点事件，销毁原生 renderer；再次进入重新加载并恢复业务状态。

关闭先摘除原生视图，再在有截止时间的保存流程后销毁。重载、崩溃、停用、卸载和替换撤销代次，释放监听、连接、文件句柄、活动租约和在途操作。存储写入失败保留已接收数据并报告错误。编译使用 Chromium/V8 缓存，不维护第二套编译器。

默认数据根 `~/.eNest`，显式配置优先。引导设置位于默认根 settings.json，设置与 KV 主体在 `{dataRoot}/data/enest.db`。安装包在 plugins，主题在 themes，session 使用各插件 partition。旧数据只在复制、哈希与数据库完整性检查成功后删除来源。

## 开发与验证

```sh
npm run typecheck
npm run build
ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginApp.smoke.test.mjs
```

主进程或 preload 修改后重启 dev；renderer 可用 HMR。原生验收使用临时数据根和独立 profile。跨平台构建配置不等于跨平台已实测；测试数字和边界见 [标准化交付报告](PLUGIN_STANDARDIZATION_REPORT.md)、[生命周期与性能](PLUGIN_SANDBOX_LIFECYCLE_VALIDATION.md)。
