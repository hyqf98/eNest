# 打包与插件依赖迁移验证

日期：2026-10-15。本文记录已实施结果；此前的 `packaging-audit-2026-10-15.md` 保留审计阶段基线与试验数据。

## 已完成的边界调整

壳的直接生产依赖只保留 `adm-zip`、`ajv`、`electron-log`、`electron-updater`、`pinyin-pro`、`ws`，分别用于安装解压、清单校验、日志、更新、搜索和通用 WebSocket 能力。React、React DOM、GSAP、zustand、react-colorful 已归入构建依赖，renderer 仍正常打包使用。

数据库驱动、SQL 与结果处理、中间件协议和 SSH/SFTP/隧道实现已迁入独立 `eNest_plugin` 仓库。数据库和中间件各自维护 backend；SSH 与远程桌面共享 `packages/ssh-backend` 源码，但各自生成完整运行包。宿主保留旧 API 的兼容分发、文件/密钥能力桥与进程生命周期管理，不提供壳内驱动兜底。

插件后端以自己的 `backend/index.cjs` 和 `backend/node_modules` 运行。manifest、构建、安装、预览服务器、权限与 SDK 已同步；浏览器资源协议不暴露 backend。入口绑定当前插件及运行代次，关闭/撤权限时清理。`backend.node` 需要用户明确授权，代表完整 Node 本机信任，不是操作系统沙箱。详见 [后端开发契约](../site/plugin/backend.md)。

数据库包包含 macOS ARM64/x64、Windows x64、Linux x64 的 DuckDB 原生库；版本及 SHA-512 来自 lockfile。普通下载预算统一为 256 MiB，解压预算仍为 2 GiB。依赖包合法的 `#` 文件名只在私有后端路径中允许，浏览器 URL 路径规则保持严格。

## CI 与打包

- electron-builder 固定 26.15.3，移除旧 node-gyp 覆盖，使用兼容的 rebuild 工具链；实际正常 rebuild 已通过。
- GitHub 使用 Node 24、四个原生架构任务，按 OS/架构/lockfile 缓存，上传已压缩安装包时不重复压缩。
- 保持 Linux Ubuntu 22.04 基线；修复 builder 26 的 desktop 配置形状。
- macOS 双架构更新元数据分别下载后校验、合并，校验版本、文件大小与 SHA-512；手动流程也执行组装校验。
- 保留中英文语言资源、运行时所需 Chromium 文件、Electron/Chromium 许可证及已打入 renderer 的库许可；删除 source map 和多余运行时图标。
- `afterPack` 会拒绝插件驱动重新混入壳。三个现有发布图标已从 ignore 中放行，确保干净 checkout 可打包。

## 实测体积

同一机器、Electron 44.4.3、macOS ARM64。MiB = 1,048,576 字节；应用目录统计普通文件，不重复计算符号链接。

| 项目 | 修改前 | 修改后 | 减少 |
| --- | ---: | ---: | ---: |
| `.app` | 534.843 MiB | 267.131 MiB | 50.05% |
| DMG | 187.744 MiB | 117.232 MiB | 37.56% |
| ZIP | 180.184 MiB | 115.583 MiB | 35.85% |
| 包内第三方依赖文件 | 238.165 MiB | 2.967 MiB | 98.75% |

新版另外补齐了旧 macOS 包缺失的约 19 MiB Chromium 许可文件；上述数字已包含它。剩余主要体积属于 Electron/Chromium。插件依赖随插件安装：数据库约 124.30 MiB、中间件约 2.14 MiB、SSH 约 1.88 MiB、远程桌面约 2.38 MiB（均为压缩包）。这些依赖从壳转移到对应插件，不代表安装所有插件后的总磁盘占用同比减少。

本地正常 `--dir` 首轮 25.77 秒，缓存后最终轮 5.78 秒；最终 DMG/ZIP 生成 35.19 秒。它们不是 GitHub runner 的耗时，未触发远端 CI，不能据此承诺线上加速比例。

## 验证记录

- `npm run typecheck`、`npm run build` 通过；两个仓库 `npm ci --dry-run --ignore-scripts` 验证 lockfile 一致。
- 宿主完整测试 622 项：598 通过、24 跳过、0 失败。两轮并发浏览器测试出现的 Logo 子用例失败，在独立重跑和最终单轮全量执行中均通过；没有修改动画生产代码。
- 打包配置/许可/元数据回归 9 项通过；插件仓库全量测试 353 通过、1 跳过，manifest 校验通过。
- `api:check` 校验 149 个公共类型，`docs:check` 校验 17 份开发指南，均通过。
- 四个插件实际 build、validateDistribution、pack 成功，生成新版 `.enestplugin`。
- 四个真实归档通过宿主解压/哈希 worker、暂存副本校验和安装发布，安装后的目录哈希与源 dist 一致；四平台 DuckDB 文件、旧壳拒绝及预期 ID/版本不匹配拒绝均通过，所有操作使用临时目录。
- 四个最终 ZIP 的 CRC 校验通过；DuckDB Mach-O/PE/ELF 架构与四平台声明匹配。构建脚本新增 7 项离线回归通过，覆盖锁文件依赖闭包、含空格/# 的路径、原生归档安全检查和后端资源隔离。
- 复制实际后端产物到工作区外临时目录，清除 NODE_PATH/NODE_OPTIONS；23 个运行模块全部从产物解析，无工作区依赖兜底。SQLite/DuckDB 查询、截断、取消通过，释放会话并关闭后租约和 utility diagnostics 归零；中间件四类驱动元数据 RPC 通过。
- 真实 macOS Electron utilityProcess + 临时 OpenSSH 验证 SSH/远程桌面各自独立后端：严格指纹、Ed25519、命令、SFTP 冲突与传输哈希、跨实例句柄拒绝、隧道、关闭后子进程归零。
- 最终 `.app` 的 Quick 原生冒烟 1/1 通过，覆盖搜索、窗口尺寸、Esc、复用/迁移及反复开关。

产物与详细 JSON/log 位于忽略目录 `release/packaging-fixed-2026-10-15/` 和 `release/packaging-audit-2026-10-15/`。原生/外部服务测试需显式启用，常规测试中的 skip 不等于通过；本次未验证 Windows/Linux 原生运行、macOS Intel 运行、全部远端数据库/消息服务、签名公证和线上 GitHub 构建。

## 版本与交付

壳版本准备为 **0.2.0**；数据库 **1.2.0**、中间件 **0.2.0**、SSH **1.2.0**、远程桌面 **1.1.0** 均要求壳 `>=0.2.0`。更新壳时应配套发布这四个新版插件；旧版插件不含后端，不能在精简后的壳里继续使用驱动能力。新增本机后端授权不会从旧的数据库/SSH 授权静默继承。

壳与插件是两个独立 Git 仓库，需要分别提交/发布。本次保留插件仓库原有图标、截图和 manifest 改动；未执行 commit、push 或发布。
