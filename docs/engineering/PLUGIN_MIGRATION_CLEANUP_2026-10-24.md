# 插件化迁移收尾：源码归属与产物卫生

日期：2026-10-24，宿主 0.2.3 / Electron 44.9.3。本文统一记录本次插件化范围、最终复审收尾及保留的验收来源；重复的中间报告已清理，不将不同构建的数字混写为最终成绩。

> 后续复审又修复了 Quick 状态策略、动态设置契约和死派发残留，详见文末「追加源码复审」。正文原有 17 项验证、180 模块清单、多插件性能与三个 ZIP 均保留原阶段身份，不是追加修改后的重测或重新打包数据。自由面板由另一位 AI 并行开发，本轮不修改其实现。

本次迁移将 DB/MW/SSH/DSH/RDP 的驱动、协议与工作台，AI 应用配置适配与 Codex Pets，LAN 分享业务，剪贴板历史与番茄状态/历史，以及选区、贴图、录制界面和 MediaRecorder 策略交给插件仓。壳保留标准、权限、安装/加载、生命周期、原生能力、通用文件/存储/密钥与窗口管理。默认主题的 Quick 搜索/排序、Settings、classic/orb chrome 和 Workspace 展示统一归 `themes/default/`，仍按产品约定源码内置，不迁入独立插件仓；第三方主题的注册与隔离能力保留。壳账户协议及有退场条件的旧数据转交兼容是明确边界，不宣称宿主只剩 OS 原语。

## 本轮已处理

| 复审问题 | 当前处理 |
| --- | --- |
| 通用保存接口写死数据库文件名 | 删除 `database.sqlite` 默认值；省略或空建议名使用原生默认行为。类型、255 字符、NUL 及 basename 的空值/`.`/`..` 校验在获取 UI 租约前完成；数据库文件名仍由数据库插件显式传入 |
| 贴图/选区/录音的旧协议 | 删除共享契约中 8 个无消费者的 IPC 常量；通用 `plugin:call/event` 不变。afterPack 实际读取 ASAR 内 JS/CJS/MJS/HTML，拒绝这些旧通道重新进入产物 |
| 默认主题真实实现散落公共目录 | 27 个实现/样式归 `themes/default/workspace/`、`themes/default/motion/` 及默认开屏；DEV 预览单列 `workspace/preview/`，没有新增兼容 facade。公共大样式表再拆出 26 个主题专属片段，真实共享片段仍留公共目录 |
| 预览仅在渲染分支关闭、动态入口仍被打包 | 给 `lazy(import(preview))` 声明本身加 DEV 编译期门禁，发布构建不再产生 MarketPage、homeSearch 或 mockShellApi 预览 chunk；afterPack 拒绝已知预览入口 chunk |
| 死主题编排/辅助代码 | 删除无消费者的 `ambientFlow`、`playModalIn/Out`、`ownPluginChild`；共用动画预算、通知/更新弹窗、Markdown、无障碍工具和跨窗口背景基础设施保留共享归属 |
| 失效旧宿主测试与孤立样例 | 删除 14 个指向已删除业务实现的测试文件，以及孤立 `fixtures/mockMarket.ts`；另静态整理 12 个混合测试/bench 的死业务片段，保留通用权限/生命周期场景。不执行或宣称修复通过历史套件 |
| 包内依赖测试附件 | 精准排除 `json-schema-traverse/spec/` 并加产物拒绝检查；不泛化裁剪所有依赖的 `spec/test` 路径，避免误删运行资源 |
| 无消费者的开发依赖 | 从 package 与离线同步的 lock 中移除 `@radix-ui/react-popover`、`tsx`；无新增工具安装，也未将此描述为同额发布包收益 |
| 旧注释和说明 | 清理 SSH/config.agent/lan.share/focus timer 的失效生产注释或日志文案；旧验收文档加历史标识，不伪造当前复现命令或重算旧通过数字 |

默认主题按工程约定源码内置，不迁入独立插件仓。宿主继续拥有权限、加载/安装、标准协议、私有文件/存储/密钥、原生能力、窗口与生命周期。这里的收尾完成不意味着删除通用能力，也不意味着每个包含插件名称的源码字符串都应该删除。

## 样式归属与级联

`app.css`、`backgroundEffect.css`、`appearance.css` 保留原加载位置，改为有序 import 入口。51 个按职责命名的片段中，26 个归默认主题，25 个是共享基础设施：资料、设置字段与预览、Quick 热键/材质、开发者与控制台、路径/代理、详情透视与开屏皮肤不再由公共样式表定义；窗口命中区、共享控件、Markdown、故障恢复、背景渲染与 detached 外观仍共享。`semanticAppearance.css` 的四条混合 `:is()` 标准材质/字体适配规则保持完整，避免拆分后改变 specificity。

新增 fixture 用真实 PostCSS 展开 import，检查解析、循环、重复导入以及 selector/declaration/条件的顺序指纹。当前固定记录为 app 449 条、background 21 条、appearance 45 条；background/appearance 的拆分前后指纹相同。app 的独立拆分前哈希未留存，证据仅证明有序 AST 提取重组与当前展开结果一致，并固定当前回归基线，不将其描述为独立的旧/新哈希对照。物理拆分不等于 CSS 懒加载或已测得的内存下降。

## 退休材料与仍有价值的场景

退休的旧测试为 agentConfigService、pinService、lanShareService、focusTimerService、clipboardHistory.races、dbLifecycle、dbUtility.smoke、mwBackendLifecycle、sshBackendClient、sshUtility.smoke、quickPatternMatching、pluginBackend.artifact.smoke、workbenchApp.smoke、screenService。前述 14 个测试、孤立 mockMarket 与 ownPluginChild 合计 16 个文件、125,351 字节源内容；这些大部分本来不在发布闭包中，不能将该数字当成安装包减少量。

已转向插件仓源码的 `sshLocalOpenSsh.test.mjs` 保留。db/mw/ssh 等权限名也仍有插件通过通用授权接口使用，不因驱动迁出就删除权限标准。

旧 workbenchApp 测试整体依赖已退役宿主 API，删除后仍须保留两项验收需求：真实 SQLite 未提交事务通过活动租约阻止 LRU，以及使用当前插件 UI/API 在 Quick 与主窗口间迁移时保留 Monaco 模型、SQL 结果和 SSH 终端。通用生命周期 harness 不等价于这两项业务端到端验收；本轮不宣称它们通过。

## 明确保留的边界

- 两个固定来源旧数据导入适配器保留原始备份、来源校验、所有者绑定和幂等标记，职责及退场条件见[旧插件数据导入兼容边界](LEGACY_PLUGIN_DATA_IMPORTS.md)。它们不实现当前剪贴板历史或番茄业务，不能为清除名称而破坏升级。
- 源码内置默认主题及壳账户协议是已有产品边界；通用基础控件、动画档位、Markdown、共享背景引擎不是某个官方业务插件的实现。
- `mockData`、开发预览图标和浏览器适配器只服务开发预览，源码仍保留。发布构建的 DEV 门禁与已知 chunk 拒绝检查不等于对所有未来业务的自动完整证明。

只读 TypeScript AST 审计覆盖主入口与安装 worker 的 167 个本地模块、10 个 preload 入口的 17 个模块，合计 180 个唯一模块，未发现失联/计算式导入、旧业务目录、测试或 fixture 进入该闭包。[闭包清单](performance-2026-10-24/cleanup-final/source-boundary-audit.json)记录每个文件的 SHA-256；最终构建后的[完整性核对](performance-2026-10-24/cleanup-final/final-build-integrity.json)确认这 180 个模块没有漂移。它是生产 main/preload 的字面导入审计，不是对所有动态插件行为或所有平台的完整证明。

## 本轮新增验证

串行显式选择 3 个本轮新增 fixture 文件，**17/17 通过，0 失败/跳过**，实际文件路径、17 项名称、执行范围及原 TAP 的 bytes/SHA-256 已折叠保留在[交付验证记录](performance-2026-10-24/cleanup-final/delivery-status.json)。覆盖真实 localFiles 模块的保存建议名、句柄归属、取消/迟到响应与租约释放，实际共享 IPC 契约、21 个移动 TS/TSX 模块转译和导入解析，DEV 编译门禁，以及真实 builder 依赖过滤与 clean/stale ASAR 检查。它们不是跨平台原生对话框或全部插件业务端到端测试。

宿主 typecheck 与 build 均 exit0；构建目录经打包守卫复查无旧 IPC 和已知预览 chunk，保留 60 包许可证。[交付验证记录](performance-2026-10-24/cleanup-final/delivery-status.json)保留命令、既有退出结果、原日志 bytes/SHA-256、15 个静态/动态混合导入 warning 模块，以及生成/检查 161 个公共类型、同步/检查 21 篇开发指南的输出摘要。原重复日志已清理，混合导入模块未被宣称为已拆分懒加载。未执行历史测试套件，也不把本轮重复运行累加成更多检查。

最新隔离原生运行的测量后 CUA 验证见[原生观察](performance-2026-10-24/cleanup-final/native-gui-observation.json)：实际默认首页 32 插件、轮播/卡片、计算器详情的截图与 Markdown、真实插件打开、设置、classic/orb 往返和分类筛选均实际呈现；资料未登录卡片与开发者导入/日志面板的迁移样式也经截图检查。同一个计算器 PID 2934 跨导航切换保留。原生保存对话框、授权后剪贴板/录屏、账户与外部连接不在此 GUI 收尾范围；没有新 Settings 导出录制，不将旧导出改名复用。中间 GUI 观察记录已清理，不用于替代这次最终构建的观察。

## 最终多插件占用与清理

最终运行标签为 `cleanup-css-final-44.9.3`，使用真实 main 源码、最终 renderer/preload 和实际安装器，32 个已构建插件全部安装在隔离数据目录；敏感声明全部拒绝。样本插件为 calculator、cron、regex、password-kit、timestamp、todos、sketchbook、sticky-notes，不包含实际外部数据库/SSH/录屏工作负载。主进程没有替换成服务 stub；但这仍不是最终 ZIP 启动验收。

| 阶段 | 平均唯一 PID phys_footprint（MiB） | 平均 CPU（单核 100%） |
| --- | ---: | ---: |
| 32 个已安装，未开插件 | 394.98 | 1.30% |
| 6 个逻辑插件 / 6 个常驻 | 614.60 | 5.46% |
| 8 个逻辑插件 / 6 个常驻 / 2 个休眠 | 616.48 | 18.35% |
| 关闭 8 个插件 | 427.96 | 1.66% |
| 单插件再次打开 | 440.47 | 7.01% |
| 单插件再次关闭 | 428.57 | 1.01% |

[原始 JSON](performance-2026-10-24/round-023/native-real-app-performance-cleanup-css-final-44.9.3.json)、[脱敏日志](performance-2026-10-24/round-023/native-real-app-performance-cleanup-css-final-44.9.3.txt)及[独立复算](performance-2026-10-24/cleanup-final/native-evidence-validation.json)相互对应：24 个样本、196 条进程记录，PID 去重、创建/启动身份、所有权代次、内存行求和、CPU 差分与 6 条 console 阶段摘要一致。2740 项算术/一致性对照零差异，不是额外 2740 个测试。每阶段仅 4 个内存点、3 个有效 CPU 区间，约 6 秒采样窗口，提前稳定等待 1100ms；内存缓存年龄为 0–893ms，并非每点同步读取 OS。首次 CPU 无前值，不填零伪装有效区间。

14 项原生运行检查通过，退出码 0；9 个被测插件 WebContents 均销毁，关闭、重关及退出时插件运行资源、后台、utility、辅助窗口、文件流为 0，测量关闭后回到原 6 个宿主 PID。测量时资产缓存基线与关闭后均为 613,852B，GUI 浏览后退出缓存为 668,778B；有界缓存未全部清空，不能说最终缓存恢复基线。退出快照仍有两个宿主 WebContents，不能据此宣称全部宿主实例逐一验收退出。[独立清理补充](performance-2026-10-24/cleanup-final/final-cleanup-state.json)确认本轮精确临时目录已不存在，16 个已观测性能/UI PID 在检查时均不再存在；不覆盖未观测 OS 子进程。

日志保留 7 个事件：3 条离线 registry、1 条空 registry 回退、1 条 sandbox extension、1 条测量后 GUI 期 GPU mailbox、1 条退出时 `home:get-config` 拒绝。没有捕获 renderer 退出或未预期原生失败，但不能称 stderr/GPU 无错误。以上是本机一次短时观察，不是长期泄漏、FPS、统计显著节省或各平台负载结论；关闭后的平均占用也不等于初始均值，不将代码搬目录直接解释为 RAM 已下降。设置监控的[实际原生导出](performance-2026-10-24/round-023/settings-native-ui-44.9.3.json)及[UI/console 复算](performance-2026-10-24/round-023/evidence-validation-44.9.3.json)仍保留较早 `final-patch-44.9.3` 身份，并连同其原始 JSON/日志保留；本次只新增最终设置实际呈现观察，不把旧导出标成新构建验收。

## 最终打包

串行使用 Electron 44.9.3 / electron-builder 26.15.3 生成三个诊断 ZIP，并逐一重算 manifest、原生架构/语言/许可证、ASAR 卫生与哈希。完整记录见[包体比较](performance-2026-10-24/cleanup-final/shell-package-comparison.json)。

| 目标 | 最终 ZIP（字节） | 对上一轮同版本 ZIP | 最终 app.asar（字节） |
| --- | ---: | ---: | ---: |
| macOS arm64 | 121,592,807 | -12,064 | 4,992,252 |
| macOS x64 | 125,417,633 | -12,064 | 4,992,252 |
| Windows x64 | 144,038,344 | -12,814 | 4,992,252 |

本次 ASAR 相比 round-023 的 5,031,333B 再少 39,081B（0.78%）；main 从 1,089,232B 到 1,089,129B，plugin preload 从 19,447B 到 19,074B。对更早的 0.2.2 / Electron 44.4.3，ASAR 共减少 22.38%，但完整 macOS arm64 ZIP 仍多 234,423B、Windows ZIP 多 41,430B；main/preload 也仍比旧版稍大。版本/运行时同时变化，不是纯代码 A/B，不能宣称完整安装包减少 22.38%。

三个 ASAR 均无已知预览入口 chunk、被裁剪 spec 或已迁出的业务 driver Node 包，直接生产依赖保持 5 个。默认主题及其编译后的拼音搜索仍随壳发布；pinyin-pro 不作为独立 Node 运行包存在，不等于删除其编译字节。macOS 输出在 `release/migration-20261024-cleanup-final-mac/`，Windows 在 `release/migration-20261024-cleanup-final-windows/`，最新包留本地、不进入源码提交。三个目标的原始 manifest 已逐字节复制保留：[macOS arm64](performance-2026-10-24/cleanup-final/release-manifest-darwin-arm64.json)、[macOS x64](performance-2026-10-24/cleanup-final/release-manifest-darwin-x64.json)、[Windows x64](performance-2026-10-24/cleanup-final/release-manifest-win32-x64.json)，包含真实字节、SHA-256 与原生静态来源。Windows 使用 `signExecutable=false`，保留产品/版本/图标资源；[PE 复核](performance-2026-10-24/cleanup-final/windows-pe-resources.json)确认 eNest 0.2.3 与 build/icon.ico 相符。

这些是未签名 ZIP，不是 DMG/NSIS 安装器或已发布更新。macOS 未 Developer ID 签名/公证，Windows 未签名；三个 manifest 的 `runtimeValidated` 均为 false，未在 Windows/macOS x64 原生桌面或解包后的最终程序中运行。当前实测仅覆盖本机 arm64 的真实源码壳和最终 renderer/preload。

## Linux 与剩余验收条件

Linux 尚未生成包，不能用 macOS Mach-O helper 冒充 Linux ELF。[原生输入预检](performance-2026-10-24/cleanup-final/linux-native-preflight.json)确认缺 Linux x64 helper、非 glibc 共享库闭包、许可证与 `linux-dependencies.json`，要求 glibc≤2.35。实时只读查询确认本机已有运行中的 Docker 和支持 amd64 的 builder，但没有可直接复用的合规镜像；缓存的 arm64 Bookworm 镜像 glibc 2.36 不符合基线。

可执行的下一步是在隔离 Ubuntu 22.04 amd64 容器内准备与 CI 一致的 Node 24 和原生开发依赖，再构建、验真与打 Linux 包，不给 macOS 安装工具、不使用业务服务器、不改变发布基线。该下载/容器内依赖安装已向用户询问，尚未获得明确确认，因此本轮没有启动新容器或安装依赖。现成 CI 配置或本次获准的代码提交都不等于 Linux 构建已完成。真实 X11/Wayland 桌面权限、焦点与回贴仍须独立原生验收。

结论：本轮发现的源码归属、死实现、旧 IPC 与产物卫生项已清理并通过限定范围验证；保留兼容转交和通用能力是明确边界。Linux 构建环境许可、签名/安装器、跨平台原生桌面及前述两项 workbench 业务端到端场景仍是未完成项，不用其他验证数字替代。

## 证据收口与代码交付

用户随后明确授权提交、推送代码，并清理不必要的记录。现保留 19 个最小证据文件：最终原始测量/脱敏日志、Settings 实际导出及其较早来源、两份复算、包比较基线、最终构建/源码/GUI/清理记录与三个原始 manifest。旧 10-23 证据、五份中间报告、重复 TAP/构建/打包日志及中间 GUI 记录已删除；本次实际删除 122 个文件、5,121,565 字节。两个原生日志仅将扩展名由 `.log` 改为 `.txt`，内容、bytes 和 SHA-256 未变；原始 JSON 与已引用内容未重写，源目录日期不代表被重新运行。

TAP 与构建/类型/契约日志在删除前折叠到[交付验证记录](performance-2026-10-24/cleanup-final/delivery-status.json)，保留原摘要和范围，不把记录整理伪装为重新执行。打包后仅恢复已有 `js-yaml 4.3.2` 的直接开发依赖声明并离线同步 lock，没有安装依赖；运行时直接依赖仍为 5 个，原 ASAR 已包含传递的 js-yaml，原包与构建指纹保持原身份。该声明修复后的 typecheck 及 21 篇开发指南同步/检查均另行 exit0，不代表重打包。

验证结束时的未提交标记是带时间戳的历史快照，不是当前授权状态；本次提交/推送由交付流程执行，以实际结果为准，不在本报告预先宣称已推送成功。最新本地 ZIP/解包目录不入源码库，三个 manifest 和真实包 hash 随证据保留。

## 追加源码复审：Quick 状态与公开契约

上一轮并非已经没有源码残留。继续追踪真实调用链后，本轮确认并完成以下修复：

| 残留或缺口 | 本轮完成 |
| --- | --- |
| 最近使用与关键词偏好仍由宿主记录 | 从 `SettingsStore` 删除 `recordQuickUse`，从 `quickHandlers` 删除 `touchRecent`，从 `commandIndex` 删除 `withPreferences`、20 项保留常量和历史输入；Home 目录也不再读取或投影该模型。公共 DTO 删除旧历史条目及 `lastUsedTs/useCount/preferred` 字段 |
| 默认模型缺少独立持久化流程 | `themes/default/quick/usagePolicy.ts`、`usageState.ts`、`useQuickUsage.ts` 拥有最近 20 项、计数、查询归一化、32 字符上限、100 项偏好、旧模型解释和排序投影。旧 Quick 配置只向可信内置提供者首次转交，不删除原备份；新文档只保存 opaque 身份，不保存应用路径 |
| 第三方 Quick 不能实现自己的持久模型 | 新增 `enestQuick.state.read/write`，宿主仅提供按原生 `source + packId` 绑定的有界纯 JSON/CAS 存储、HMAC 稳定身份和真实启动成功回执。完整记录≤128KiB、深度≤20、节点≤10000；不共享默认模型，不接受 stable key 作为启动授权 |
| 异步/卸载代次边界 | 控制器只转交实际成功事实，不把失败、固定、返回或 Tab 当作新打开；主题更换后不把迟到回执交给替代提供者。首次导入与后续写入冲突有界重读合并。卸载从等待安装锁之前就暂停来源并退役 grant，关闭清理后的异步窗口不能重建已删状态；异步配置还使用 retirement epoch 防暂停/恢复 ABA |
| 动态设置的公开类型不完整 | `pluginPreload.settings.register` 复用 `SettingsSectionContribution`，SDK 正式包含 `schemaVersion` 和逐项 `shareWithThemes`，不再依靠手写简化 DTO 或调用方强制转换 |
| 通用保存接口保留死重复实现 | 删除 `pluginHandlers` 中被工具路由提前返回遮蔽的 `shell.saveTextFile` 分支、辅助函数/导入及重复权限项。两个保存方法仍经唯一的 `savePluginFile` 原语，保留原生选择器、生命周期与授权边界 |

还修复了新增回执快照中的空引用：默认主题没有第三方配置时，不能用两个可选链结果相等来判定回执存在。新用例实际执行该表达式的默认空状态、更换提供者和相同提供者三个分支。默认主题仍按产品约定源码内置；这不是把策略移回宿主标准层，也不是将内置主题当作待安装业务插件。

### 本轮验证与限制

串行显式运行 **6 个本轮新增 fixture，69/69 通过，0 失败/跳过**，没有运行历史套件。覆盖真实转译的状态存储类、Quick IPC 回调、Quick/Settings 桥、主题策略/状态会话、控制器真实表达式与保存派发链，并补齐卸载暂停和失败路径。它们使用隔离内存依赖，不等价于新 GUI、真实外部连接或跨平台原生验收。

生产 `npm run build` exit0，保留 60 包许可证；构建仍有静态/动态混合导入警告，不声称这些模块已懒加载。当前输出的 67 个 JS/CJS/MJS/HTML 逐一经过发布守卫；`queryPreferences` 模型仅出现在 `DefaultQuickSurface` chunk，main 没有旧历史策略标记，字面导入中没有已迁出的数据库/SSH/编辑器驱动。发布守卫新增原生 main 策略回流拒绝检查，不把字符串守卫等同于所有未来业务的完整证明。165 个公共类型、21 篇开发指南同步/检查通过，两仓 diff 卫生检查通过。

本轮 renderer `tsc --noEmit -p tsconfig.web.json` exit0；完整 `npm run typecheck` 最近一次仍 exit2，11 条诊断全部属于并行自由面板：`PanelManager` 的高度常量、`regionSelection` 的 Session/事件类型，以及 `SettingsStore.mergeDefaults` 尚未合入 `panels`。本轮不修改、回退或声称修复这些并行实现；因此不能宣称整仓类型验收通过。

实际命令、fixture 路径/计数、日志哈希、错误列表和构建观察折叠保存在[交付验证记录的追加段](performance-2026-10-24/cleanup-final/delivery-status.json) `postAuditMigration`。本轮临时日志折叠后删除，未创建截图/原生配置，未安装工具，未提交/推送或把自由面板改动混入提交。没有重跑多插件性能、Settings 录制或三端 ZIP，不把正文旧指标重新标为本轮结果。

本轮确认的迁移残留已完成修复，独立 native/renderer 复核未再发现同类有实证的遗留；宿主保留的是标准、安全门禁、有界资源、原生能力、加载与生命周期，以及此前明确的账户/兼容边界。此结论不替代自由面板的整仓收口、Linux 构建、签名和真实跨平台验收。
