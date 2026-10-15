# eNest 三平台构建与安装包体积审计

> 后续已实施依赖迁移和打包修复，结果见 [实施验证](packaging-fix-2026-10-15.md)。本文数据保留为修改前的审计记录。

审计日期：2026-10-15（Asia/Shanghai）。源码基线：`814b737`。Electron 44.4.3、electron-builder 25.1.8、@electron/rebuild 3.6.1、node-gyp 11.5.0。审计阶段仅测量和独立试包，尚未修改业务代码、依赖声明或发布工作流；没有触发 CI、发布或提交。

单位统一为 MiB（1 MiB = 1,048,576 字节）。应用展开大小、依赖文件内容和安装包下载大小分开统计。

## 结论与职责归属

用户提出“壳只携带自己的依赖”符合 AGENTS.md 的职责边界。当前实现将数据库和中间件后端固定内置在壳中，导致所有用户下载全部驱动。驱动目前确实被调用，但应随对应插件分发、升级和回收；不能仅从 package.json 删除。

| 内容 | 应有归属 | 当前证据 |
|---|---|---|
| MySQL、PostgreSQL、DuckDB、Oracle、SQL Server、MongoDB、Redis、Cassandra、Neo4j、ClickHouse、TDengine 及相关解析库 | 数据库插件的后端及其依赖 | `src/main/database/additionalSqlAdapters.ts:11`、`:40`；`relationalRuntime.ts`、`documentAdapters.ts`、`httpAdapters.ts` |
| Kafka、RabbitMQ、MQTT 客户端与业务操作 | 中间件插件的后端及其依赖 | `src/main/middleware/drivers/` |
| React、React DOM、GSAP、zustand、react-colorful | 壳 UI 的构建依赖；代码已进入 renderer bundle，无需再复制完整 npm 包 | `electron.vite.config.ts` renderer；main/preload 无运行时引用 |
| adm-zip、ajv、electron-log、electron-updater、pinyin-pro | 壳的安装、校验、日志、更新、搜索能力 | 当前主进程引用与生产依赖闭包 |
| ws、ssh2、undici | 按真实共用能力逐项核对 | 本轮保守保留；ssh2 为 SSH/远程桌面隧道使用，外部 undici 直接引用主要在数据库 HTTP adapter |
| Electron、Node 内建 node:sqlite | 桌面运行时及壳自身持久化 | 不能作为插件驱动冗余删除 |

真实插件为 `com.enest.database`、`com.enest.middleware`。它们的 package.json 目前仅有插件前端及构建依赖，未包含数据库/中间件驱动；前端分别调用宿主 `db.*` 与 `enest.mw.workbench`。宿主的 `dbSessionManager.ts:118`、`mwSessionManager.ts:117` 启动固定的 utility 入口，隔离进程不等于依赖归插件管理。

迁移前必须建立通用插件后端运行契约：由插件声明后端入口及平台/架构资产，宿主负责校验、进程启动、能力与实例归属检查、取消、退出回收和异常恢复。业务协议和模型进入插件仓库。Node 原生模块还需明确 Electron ABI / N-API 与版本策略。

现有 `PluginInstaller.ts:419–424` 禁止普通包携带 node_modules，`PluginHost.ts:900–901` 设置 nodeIntegration=false、sandbox=true；仅 DSH 有专属 runtime 例外。因此不能直接移动依赖声明，也不能通过开启 renderer Node 集成完成迁移。进程隔离本身不是权限沙箱，后端能力约束需要单独设计。

## 驱动迁回插件的体积测算

以本次实际生成的 macOS ARM64 `app.asar` 及其 unpacked 文件统计依赖内容，按实际嵌套包位置遍历 dependencies/optionalDependencies/peerDependencies，计算完整保留闭包，再做差集。247 个生产包均已覆盖，无未归属文件或不可达包；避免直接相加驱动造成共享依赖重复计数。

| 场景 | 生产包数量 | 依赖文件内容 | 相对当前减少 |
|---|---:|---:|---:|
| 当前真实包 | 247 | 238.17 MiB | — |
| 数据库与中间件驱动迁出 | 45 | 19.10 MiB | 219.07 MiB |
| 再去掉 renderer 的重复 npm 副本 | 37 | 8.23 MiB | 229.94 MiB（96.5%） |
| 如果 SSH 后端也迁出 | 29 | 6.59 MiB | 231.58 MiB |

第三行仍保留 adm-zip、ajv、electron-log、electron-updater、pinyin-pro、ssh2、undici、ws 及其传递依赖。外部 undici 若最终确认无壳引用，还可减少约 1.68 MiB；没有计入首选方案。

DuckDB ARM64 本地库 `libduckdb.dylib` 单文件 117,008,720 字节（111.59 MiB）。`@tdengine/websocket` 还通过 dependencies 带入了约 18.97 MiB 的 TypeScript 编译器。这些都说明主要负担在业务后端及依赖树。

这些是迁移后的依赖内容测算，不是已完成迁移的可运行安装包，也不是 DMG/NSIS 的下载降幅。迁移不消除功能自身的依赖成本，而是由安装相关插件的用户承担。与下面的冗余清理方案存在重叠，不能直接相加。

## 保留功能的 macOS ARM64 实际试包

从同一份最新 out、同一份本机原生依赖构造 base/slim 两个独立 app，再分别以相同 builder 默认压缩生成 DMG 与 ZIP。无签名、无公证，输出在被 Git 忽略的 `release/packaging-audit-2026-10-15/`。

| 实际产物 | 当前配置基线 | 清理后 | 减少 |
|---|---:|---:|---:|
| `.app` 普通文件总大小（不重复计算符号链接） | 534.84 MiB | 423.73 MiB | 111.11 MiB，20.78% |
| DMG | 187.74 MiB | 161.81 MiB | 25.94 MiB，13.81% |
| ZIP | 180.18 MiB | 155.36 MiB | 24.82 MiB，13.78% |

清理内容：已进入 renderer 的 npm 包副本、依赖 sourcemap、TDengine 间接带入且运行时不调用的 TypeScript 编译器、当前 Oracle Thin 模式不使用的原生 build 目录、未使用的 512/1024 运行时图标，以及除英文/简中/繁中之外的 Electron 语言资源。没有删除数据库驱动业务功能。

重要测量限制：正常 builder 重编依赖会遇到下一节的工具链挂起。两组体积实验一致使用 `npmRebuild=false` 复用本机同架构依赖，随后验证实际产物。这仅用于隔离体积变量，**不是建议生产 CI 跳过重编**。base/slim 的目录打包本机耗时 11.26/8.08 秒，不可当作 GitHub Actions 性能收益。

验证：

- `npm run typecheck`、`npm run build` 成功；build 仍提示已有混合静态/动态 import 警告。
- 对实际 slim app 执行现有 Quick 原生窗口测试：1/1，通过重复 Esc、窗口/插件切换等流程，使用独立临时 profile/data root。
- 用 slim 包的 Electron 44.4.3 / Node 24.21.0 对其真实 app.asar 加载 23 个生产依赖：23/23；DuckDB 内存库执行 `SELECT 42` 成功，Oracle `thin=true`。
- 未连接远程数据库或消息服务；未验证 Oracle 真实连接、SSH 连接和所有认证分支。Windows/Linux 未生成完整 eNest 安装包，macOS x64 未验收。

## Electron 本体语言资源实测

读取并以官方 SHASUMS256 校验 Electron 44.4.3 的平台 ZIP，保留英文、简中、繁中：

| 平台 | 原语言资源 | 保留后 | 展开文件净减少 | 官方 ZIP 条目压缩数据净减少 |
|---|---:|---:|---:|---:|
| macOS ARM64 | 48.03 MiB | 1.67 MiB | 46.36 MiB | 11.81 MiB |
| Windows x64 | 48.30 MiB | 1.68 MiB | 46.62 MiB | 11.74 MiB |
| Linux x64 | 8.57 MiB | 0.30 MiB | 8.27 MiB | 2.45 MiB |

ZIP 条目统计不能等同最终 NSIS/AppImage/deb 降幅。macOS 用 `en/zh_CN/zh_TW`，Windows/Linux 用 `en-US/zh-CN/zh-TW`。删除其他语言后，相关 Chromium 原生文案会回退；ICU 保留，不能把 locale 资源裁剪理解为删除 Intl 功能。

**当前 builder 25.1.8 的 macOS electronLanguages 仅清顶层空 `.lproj`，真实资源在 Electron Framework 的 `Versions/A/Resources`。** 本次 slim 使用 afterPack 精确清理该路径，后续正式签名应在清理之后进行；也可升级 builder 后重新验证。仅添加 electronLanguages 不会在当前 macOS 配置上达到表中收益。

保留 ICU、FFmpeg、GPU/SwiftShader、V8 snapshots、resources.pak 和许可文件。默认 `compression: normal` 已合适；`maximum` 并非免费瘦身，会增加压缩工作，各目标需分别测试。

## GitHub Actions：先修挂起，再做加速

### 确定性工具链问题

`package.json:80–83` 强制旧 @electron/rebuild 使用 node-gyp 11.5.0。rebuild 3.6.1 的 worker 用 `promisify(nodeGyp.commands[command])` 等待 callback，但 node-gyp 11 的 command 已返回 Promise，忽略 callback，导致 worker 不退出。

在临时目录执行真实 API 与真实 worker，未改 node_modules：直接 await clean 约 5 ms；经 promisify 超过 1.5 秒无返回；真实 worker 同样超时，出现 DEP0174。本次正常打包两次停在 `preparing moduleName=bufferutil`，分别等待约 95/126 秒后主动终止。

应协同升级 builder/rebuild/node-gyp 并更新锁文件，移除不兼容的单项覆盖。registry 本次查询显示 builder 26.15.3 使用 rebuild ^4.0.4；rebuild 4.2.1 要求 Node >=22.12.0，内部使用 node-gyp ^12.2.0。CI 当前 Node 20 也低于已锁定 @electron/get 5.1.0 的 >=22.12.0 要求。建议统一到满足依赖要求的 Node 24 LTS/至少 22.12，再做三平台原生打包与加载验证。

### 获取到的远端耗时

10/15 run `38672314342`、SHA `814b737e` 的 jobs 快照：

| 阶段 | macOS | Windows | Linux |
|---|---:|---:|---:|
| npm ci | 27 秒 | 157 秒 | 31 秒 |
| typecheck | 11 秒 | 12 秒 | 13 秒 |
| build | 7 秒 | 5 秒 | 11 秒 |
| package（取消前） | 32 分 28 秒 | 30 分 | 32 分 43 秒 |

该 run 及前一次 run 在后续查询时已不可见，日志接口返回 404；本次未操作取消/删除。工具链挂起是本地确定性复现，与 CI 现象吻合，但无法再从该次 CI 的完整日志确认停点。

[9/18 成功 run](https://github.com/hyqf98/eNest/actions/runs/35325643024) 总耗时 3 分 14 秒，package 为 mac 107/Windows 44/Linux 100 秒。它使用 Electron 36.9.5 与旧依赖，不能作为当前版本的承诺。当前 GitHub Releases 列表为空，历史 artifacts 过期，安装包对比因此采用本地新试包。

### 后续优化顺序

1. 修复上述挂起，三端保存原生重编与打包分阶段日志，才有可比较的当前基线。Windows npm ci 的 157 秒最值得用 `--foreground-scripts --timing` 细分。
2. macOS x64/ARM64 各用对应架构 runner 和显式 arch。当前同一 host 的 npm ci 只装对应 DuckDB optional 二进制，builder 重编不会补装另一架构包，存在 x64 包缺 binding 的风险。拆分还需汇总两架构 `latest-mac.yml`，不能让现有 `merge-multiple:true` 覆盖同名更新元数据；保留自动更新所需 ZIP。
3. `upload-artifact` 设置 `compression-level: 0`，避免对已压缩安装器再压缩。旧成功记录整个上传仅 mac 21/Windows 4/Linux 7 秒，这项最多节省这些阶段的一部分。
4. 缓存 Electron、electron-builder 工具、Electron headers，按 OS/架构/版本隔离。npm cache 已存在。旧记录 Electron 下载 0.36–1.12 秒，工具各约 0.19–0.37 秒；缓存可改善波动，但不能解释或解决 30 分钟挂起。
5. typecheck 可在一个矩阵条目执行，减少约 24 秒重复计算量；不宜新增串行前置 job 而拖长墙钟时间。当前三系统已经并行，build 没有明显重复调用。Linux apt 本次 13 秒，优化优先级较低。

不能给出已经实现的 CI 百分比提速：本轮没有修改/触发线上工作流。不要使用 `--omit=optional` 全局跳过依赖来提速，DuckDB 平台包和构建工具架构包也在其中。

附项：build 图标目录被 .gitignore 排除且当前 Git 没有跟踪 build/icon.*；正式 CI 还需核查图标生成或注入方式，避免默认图标。

## 可复查证据

本机证据根目录：`release/packaging-audit-2026-10-15/`（被 Git 忽略，含较大的独立试包）。

- `size-comparison.json`：实际 app、asar、unpacked、DMG、ZIP 精确字节数。
- `slim.config.cjs`：仅供实验的清理配置。
- `packaged-dependency-smoke.{cjs,json}`：真实 slim 产物依赖加载与本地查询。
- `slim-smoke/`：Quick 原生验收 JSON 与截图。
- `dependencies/enest-asar-closures.cjs`、`dependencies/actual-asar-closures.json`：实际产物依赖闭包及迁移测算。
- `electron-core.json`：三平台官方 Electron 包、SHA256 与语言资源统计。
- `ci/`：远端耗时证据、工具链挂起复现脚本及结果。

建议实施顺序：先修打包工具链阻塞，再建立通用插件后端契约并迁移数据库/中间件业务，最后完成冗余清理、四架构构建矩阵与更新元数据验收。业务迁移和当前可清理项的收益分别跟踪。
