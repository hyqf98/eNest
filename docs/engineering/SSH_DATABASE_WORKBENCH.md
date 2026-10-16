# SSH 与数据库双入口工作台

更新：2026-10-13。本文记录本轮实现、接口边界和验证范围；历史方案见 `docs/compose/spec/ssh-db-plugins.md`。未提交、推送或发布。

## 入口、布局和状态

`com.github.eNest.ssh` 与 `com.github.eNest.database` 各保留一个插件。Quick 与桌面使用同一个 `WebContentsView`，按 `getLaunchMode()` 和 `onModeChange(mode)` 选择界面；窗口宽度仅控制当前界面的响应式布局。Quick 默认 720×420，最小建议 480×240，尺寸不包含壳的顶部输入条。

| 位置 | SSH | 数据库 |
| --- | --- | --- |
| Quick 首页 | 搜索连接、最近/收藏、继续已有会话 | 搜索数据源、最近/收藏、继续控制台 |
| Quick 主体 | 单终端；文件/资源/端口/进程切换页面 | 紧凑 Monaco、只读结果；展开结果占据主体 |
| Quick 顶部 | 服务器切换、快捷命令、桌面继续 | 数据源/库、运行/停止、桌面继续 |
| 桌面左侧 | 连接与分组 | 数据源与对象 |
| 桌面中央 | 终端标签、分屏、远程编辑与文件管理 | 查询文档、对象结构、资源页 |
| 桌面右侧/底部 | 文件列表、资源操作、传输任务 | 可调整的结果区与状态/消息 |
| 插件设置页 | 终端、历史、快捷键、监控、可信主机 | 编辑器、查询、快捷键、结果布局 |
| 壳设置 | 注册跳转到插件设置的页面入口，保留跟随主题开关 | 同左 |

`ui.openInShell()` 只能迁移调用插件自身，复用现有容器迁移。迁移不重复连接、执行或复制草稿。Monaco model、撤销栈和选区保留；SSH 已打开终端继续存活。Quick 数据库控制台使用独立只读 `sessionKey`，不会借用其他桌面控制台的事务；迁移后继续使用该控制台。

桌面读写控制台迁入 Quick 时保留文档、结果和待提交单元格修改，但阻止执行，并提供“桌面继续”和“新建独立快捷查询”。原草稿不会被复制或覆盖。已加载结果可就地分页、筛选；需要请求服务器的新页面必须使用独立 Quick 控制台。展开结果时才显示紧凑筛选栏和分页控件，避免挤占默认编辑区。

## 公共宿主契约

- `ui.setInputContext(workbench | terminal | editor | overlay)` 指定快捷键归属。编辑器和终端的控制键、Esc 与中文输入不被 Quick 的全局快捷键抢走；明确按钮可返回壳搜索。
- `ui.focus()` / `ui.focusSearch()` 管理编辑区和壳搜索焦点。`onModeChange` 回调参数是模式字符串。
- `localFiles.pick/fromDrop/list/reveal/prepareDrag/startDrag/endDrag` 使用按插件隔离的本地句柄；选择范围不能被路径或符号链接绕过。
- 原生文件选择与拖拽以当前容器为父窗口，活动期间暂停 Quick 失焦隐藏。插件关闭后迟到的选择结果不能授予新实例文件访问能力。
- 原生拖出使用已准备的本地文件。远程文件必须先下载；不把 SFTP 路径伪装成本地文件。
- `activityRegistry` 与插件 `RuntimeScope` 共同保护 SSH 会话、传输、隧道、数据库请求和事务，阻止自动休眠/LRU 销毁。显式关闭仍清理资源。
- 已连接的普通数据库会话也持有活动租约，实际断开或 utility 退出后释放；同名重连不受旧关闭响应影响。
- 设置 `type: 'page'` 支持 `entry: { code, payload? }`。运行时注册设置只替换本插件的设置贡献，不删除其他菜单或贡献。

实现入口：`src/main/plugin/localFiles.ts`、`activityRegistry.ts`、`quickInputPolicy.ts`、`src/preload/pluginPreload.ts`、`src/main/ipc/pluginHandlers.ts`。

## SSH 实现边界

连接、信任、文件、传输、隧道和系统采集分别位于 `src/main/ssh/`；`sshWorkbench.ts` 是权限分派入口，未知动作不放行。UI 位于 `eNest_plugin/plugins/ssh/`，公共命令/选择/对话框来自 `eNest_plugin/shared/`。

- 连接支持密码、私钥、Agent、交互认证、跳板链、可信指纹和 OpenSSH 配置导入；导入的配置不执行本地 `ProxyCommand`。测试与保存使用同一参数采集，包含 Agent 路径、跳板、代理和密钥口令。
- 每个连接可配置 HTTP CONNECT 或 SOCKS5 代理，认证密码存入 vault。有跳板时代理仅作用于第一跳，不读取壳 HTTP 代理或改变其他连接；握手支持分包、合包、取消和超时。HTTP 支持 Basic，SOCKS5 支持用户名密码且不静默降级；不包含 HTTPS 代理、PAC、Digest/NTLM 或 UDP/BIND。
- 终端支持多会话、横纵分屏、标签重排/固定/改名、搜索、历史与快捷片段。标签与分屏布局持久化，重启恢复为断开标签，明确连接后才建立会话。临时 Bash/Zsh 集成使用 OSC 标记区分提示符、命令执行和当前目录，不修改用户启动文件；TUI/密码输入保留原生终端行为。
- 文件列表支持 Ctrl/Cmd 多选、Shift 范围选中、保留选集的右键菜单、拖入上传、批量改名、权限/属性、隐藏项、远程编辑与内容冲突检测。桌面提供本地/远端双栏；Quick 采用单页切换。
- 传输使用任务 ID、真实流取消、失败重试和进度；跨服务器复制直接串接两端 SFTP 流。续传验证源文件状态与已传前缀，避免把不匹配的内容拼接成成功文件。
- Linux/macOS/Windows 采集器分别处理资源、进程、端口与停止语义；停止进程复验 PID 与启动标识，避免终止被复用的 PID。服务、Docker 与隧道操作按目标平台和工具可用性返回结果。

三平台采集实现不等于三平台远端真机验收。Windows/macOS 服务权限、路径、shell 配置和本机拖拽体验仍须在对应环境复核。

OpenSSH Include/Match/ProxyCommand 与自动导入端口转发目前会报告未支持。自动重连退避、重启后恢复传输任务尚未实现；续传断点仅保留于当前运行时。跨服务器复制保留源文件，不提供跨服务器移动或续传。完整 SSH 边界见 [SSH 工作台说明](../../eNest_plugin/plugins/ssh/SSH_WORKBENCH.md)。

## 数据库 Provider 与准确能力

主进程 `dbSessionManager.ts` 负责权限、凭据、原生选择器与活动占用；每个插件运行代际拥有独立 Electron utility 进程，驱动、查询、CSV 和结果转换在其中运行。SQLite 另使用工作线程。取消失去响应的驱动时会回收所属 utility，界面明确要求重新连接；不会仅设置一个取消布尔值后宣称执行已停止。

utility 退役保留进程归属直到真实 `exit`。在 `spawn` 前关闭时补发终止信号；未确认退出前阻止重建同插件的数据库 utility。关闭清理不把 `kill()` 返回成功当作进程已经退出。

驱动注册返回 `family/language/transport/capabilities`。能力状态区分 `available`、`unsupported`、`permission-denied`、`not-configured`、`error`，界面按能力开启操作。新适配器优先实现统一连接、执行、元数据、取消和结果接口，再添加专属浏览操作。

| 驱动类别 | 注册项 |
| --- | --- |
| 关系型与嵌入式 | MySQL、MariaDB、PostgreSQL、SQLite、SQL Server、DuckDB、Oracle |
| 时序与分析 | TimescaleDB、TDengine、InfluxDB 1/2/3、ClickHouse |
| 文档/键值/搜索/图 | MongoDB、Redis、Elasticsearch、OpenSearch、Neo4j |
| 协议兼容/分布式 | TiDB、OceanBase MySQL 模式、CockroachDB、YugabyteDB YSQL、QuestDB、Doris、StarRocks、Cassandra、ScyllaDB |

共 27 个注册入口。InfluxDB 分别使用 InfluxQL、Flux、SQL 接口；协议兼容产品提供明确兼容说明，不宣称拥有原引擎全部管理能力。未实测产品不列为已验收。逐驱动范围见 [数据库验证矩阵](database-driver-validation-2026-10-13.md)。

- MySQL/PostgreSQL 事务固定在所属连接，元数据、查询取消与 Quick 控制台隔离。Quick 最多读取 200 行；行数和字节预算在消费结果时应用。
- 离线 Monaco 按需加载；方言补全使用数据库元数据、别名、CTE、派生表和 JOIN 关系。格式化和函数提示使用本地资源；这不等同于完整 DataGrip 语义分析器。
- 结果编辑采用参数化变更集及乐观条件；数据库不支持的事务/可编辑结果不开放按钮。
- `table.page` 提供服务端分页、筛选与排序；普通查询的本地分页明确区别于服务器分页。导出只包含已加载范围。
- `table.design.preview/apply` 提供新建表、增字段、改字段名、删字段、增/删索引。宿主从结构化输入生成 DDL；预览后明确执行，不接收客户端伪造的预览 SQL。当前设计器支持 MySQL/PostgreSQL/SQLite 家族中明确启用的能力。
- MongoDB 使用 EJSON 保存 BSON 类型；Redis 使用 SCAN 游标、TYPE、TTL 和按类型浏览；TDengine 区分超级表/子表和标签。文档结果可展开类型树或查看原文。
- 资源中心区分 eNest 客户端连接池与服务器会话、查询、锁、指标和后台任务；缺失值不当成零，数据库统计不推断为主机 CPU/内存。
- 数据比较通过左右弹窗呈现，支持最大化、键匹配、列映射、严格/文本/数值/JSON 规则、差异导航与导出。大整数/十进制比较避免浮点转换；重复键标为不明确。显示每侧范围和截断标记，两个查询是独立快照。比较没有修复脚本或同步入口。

严格只读隔离依赖引擎原生能力或受限命令 API；不具备相应保证的引擎禁用 Quick 执行/只读对比并解释原因，不能用词法过滤冒充完整的只读权限。SQL Server 精确 decimal/money 结果要求按错误提示 CAST 为文本，避免静默浮点损失。

## 构建与复现

宿主：

```sh
npm run typecheck
npm run build
node --test src/main/plugin/workbenchHost.test.mjs src/main/settings/pluginSettings.test.mjs src/main/database/tableOperations.test.mjs src/main/database/compare.test.mjs
node --test src/main/database/dbLifecycle.test.mjs src/main/ssh/sshLifecycle.test.mjs src/main/ssh/sshWorkbench.test.mjs
ENEST_ELECTRON_SMOKE=1 node --test src/main/database/dbUtility.smoke.test.mjs
ENEST_WORKBENCH_SMOKE=1 node --test src/main/plugin/workbenchApp.smoke.test.mjs
```

数据库真实连接测试位于 `dbRelational.integration.test.ts` / `dbDocument.integration.test.ts`，使用 `ENEST_DB_INTEGRATION` 选择驱动和 `ENEST_DB_HOST/PORT/USER/PASSWORD/DATABASE` 指定临时测试数据库；InfluxDB 另提供 `ENEST_DB_ORG/BUCKET`。用本地 `tsx --tsconfig tsconfig.node.json --test` 执行，勿向真实业务库运行这些会创建/删除测试对象的测试。SSH 真机测试使用 `ENEST_TEST_SSH_PORT` 及同前缀的 HOST/USER/PASSWORD，并仅写测试临时目录。

插件仓库：

```sh
cd eNest_plugin
npm run validate
npm test
npm run build -- com.github.eNest.ssh com.github.eNest.database
DB_UI_PORT=4179 npm run test:ui -- scripts/tests/database.ui.js --output=test-results-db
node scripts/pack-plugin.mjs com.github.eNest.ssh
node scripts/pack-plugin.mjs com.github.eNest.database
```

Monaco 与 worker 从 `assets/vendor/monaco/` 加载，`@workbench` 经 Vite 打入本地入口，无运行时 CDN/importmap。生产 CSP 不为编辑器放开 inline script 或 eval。插件打包从构建后的 staging 目录生成，源码不依赖相邻插件目录。

运行 `workbenchApp.smoke.test.mjs` 前须先构建宿主并完成上述两个插件打包；测试将 `.enestplugin` 解压到临时正式安装目录，使用隔离的应用数据，不读取用户业务连接。设置 `ENEST_TEST_SSH_PORT` 和同前缀测试凭据才能启用真实 SSH 分支。

## 验证记录

本轮验证使用独立本地容器和临时数据。浏览器模拟 host 的测试用于验证界面契约，不能替代真实 Electron、SSH 或数据库集成。

- MySQL 8.4 / PostgreSQL 17：固定连接事务与回滚、跨控制台隔离、原子变更回滚、FK/索引/DDL、字段补全、服务端分页筛选、200 行上限、取消长查询后复用连接、大整数精度。
- MongoDB 8 / Redis 8 / InfluxDB 2.7：实际读写、对象/类型元数据、BSON/Redis/Flux 大整数保真、可用引擎的 Quick 拒写。
- TDengine 官方 WebSocket：超级表/子表/标签、大整数、结果限量、实际取消后关闭及重新连接、最后连接关闭后 SDK 全局连接池退出。
- Linux OpenSSH：密码/私钥/隔离 Agent、两级跳板、HTTP CONNECT/SOCKS5 代理的真实直连及首跳路由、资源/进程/端口、PID 复用保护、文件编辑冲突、8 MiB 双向中断续传及断线重连续传、跨会话流式复制、本地隧道、Bash OSC 与当前目录补全。
- SQLite / DuckDB：本地驱动与精度、事务/结果限制测试；Electron utility 测试另验证主进程仍能处理事件及真正的后台退出。
- UI：480×240、720×420、Quick/桌面 Monaco model/undo/选区保留、独立 Quick 控制台、设置页面、结构设计、服务端页、比较和文档树。最终新增回归验证了已加载 1000 行按 50 行分页、1500 行表的服务器分页与每页 200 行上限、筛选与清除、桌面控制台迁入 Quick 禁止误执行且仍可取消在途查询；SSH 标签重载和测试/保存配置一致性也已通过。
- 主机文件测试：句柄隔离、符号链接边界、picker 父窗口、原生拖拽准备、活动占用、关闭后迟到回调和键盘/IME 归属。
- 正式安装结构的实际 Electron 工作台测试：直接解压本轮两个 `.enestplugin` 包，使用真实 preload 和生产 CSP；UI 新建 SQLite 连接并成功保存、真实查询保留 int64、Quick/桌面双向迁移保留 WebContents/model/结果/会话、实际 SSH 终端迁移、两个插件独立设置入口、超过六个已安装视图触发 LRU 时保护 SSH 与数据库事务。显式关闭后资源与 utility 均为零。最终通过用时约 22.5 秒；此前一次完成全部功能断言但超过 90 秒总预算，测试预算已调整为 180 秒，此项用于正确性验证而非性能基准。
- 原生测试发现并修复了模拟宿主未覆盖的连接保存问题：插件持久化省略可选对象字段中的 undefined，非法 JSON 拒绝保存；表单等待持久化成功才提示成功，失败保留输入。UI mock 现执行同等严格 JSON 检查。

宿主最终 `npm run build` 通过；本轮稳定快照的 typecheck 曾通过，但当前完整 `npm run typecheck` 被同目录并行开发的 middleware 模块阻挡。此前缺少的四个 driver 文件已补齐；最新检查剩 `mwService.ts:12` 导入的 `MwTestResult` 尚未由 `@shared/types/mw-workbench` 导出。未删除、排除或伪造这些其他任务的文件来取得通过，因此当前工作区不能宣称完整类型检查通过。

宿主 Quick 后续迁为 `BaseWindow` + 壳 `WebContentsView` 后，额外使用其最新构建重跑上述正式插件包安装测试，约 7.1 秒通过：SQLite 查询、双向迁移、两个设置入口、事务 LRU 和关闭清理正常。此轮未启用 SSH 服务端分支；真实 SSH 会话的证据来自前一轮已记录测试。

宿主公共接口/设置/表操作/比较的 13 项回归通过；数据库生命周期 13 项回归通过；SSH 28 项宿主测试与 2 项状态测试通过。数据库插件原有 7 项 UI 回归、40 项单元测试（另 1 项 opt-in 跳过）通过，最后 Quick 修改另跑 3 项相关 UI 回归通过。原生 utility 另验证空闲连接租约为 1、取消约 269 ms、实际退出后租约和 utility 为零。SSH 的 keyboard-interactive 协议与界面有模拟测试，真实 OTP 服务器尚未验收。

并行宿主生命周期任务完成 macOS arm64 未签名 `.app` 的真实打包烟测，使用 `app.asar` 与真实 preload，在两轮关闭后确认实例、WebContents、活动和 session 内存均为零；报告见 [生命周期实现与验证](LIFECYCLE_CACHE_IMPLEMENTATION.md)。未做远端 Windows/macOS 真机、未验收所有兼容驱动，也不能将本机 macOS 打包等同三平台完整发布验证。

## 本地交付包

以下文件仅为本地验证产物，未提交或发布；宿主主进程/preload 已变更，使用前需重新构建并重启 eNest。

| 插件 | 包 | 大小 | SHA256 |
| --- | --- | --- | --- |
| SSH | `eNest_plugin/dist/com.github.eNest.ssh@1.1.1.enestplugin` | 1,765,556 bytes | `1d52c1a954839a09fe18ceccfa1bcedb9d3c07aa166a3a1d87d3c2dc0ab3a38a` |
| 数据库 | `eNest_plugin/dist/com.github.eNest.database@1.1.1.enestplugin` | 1,764,540 bytes | `506589afe6fe0c2000871e9b6c87f4797dcc7740c8a5824e79ac6d052db980ee` |

## 参考交互

- [Tabby](https://github.com/Eugeny/tabby)：连接管理、分屏、会话与快捷键。
- [electerm](https://github.com/electerm/electerm)：终端联动文件、远程编辑、快捷命令、跳板与隧道。
- [WindTerm](https://github.com/kingToolbox/WindTerm)：SFTP 文件操作、本地文件与传输工作流。
- [DataGrip query consoles](https://www.jetbrains.com/help/datagrip/query-consoles.html)：数据源/控制台会话归属与编辑器结果区。
- [DataGrip compare data](https://www.jetbrains.com/help/datagrip/compare-data.html)：双侧差异视图和范围提示。本实现只读，不包含数据同步。

界面遵循 taste-skills 的既有设计系统适配与重设计规则：沿用壳 token、克制工具栏、可见焦点、小窗减少常驻区域，完整配置放在插件自己的页面。
