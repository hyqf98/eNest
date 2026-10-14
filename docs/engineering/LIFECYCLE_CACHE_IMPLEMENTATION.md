# 插件缓存与生命周期实现、验证记录

日期：2026-10-13。适用当前工作区实现；没有提交或推送。并行的 SSH/数据库工作台与插件接口任务也在修改同一工作区，本报告只将生命周期相关行为及本次实际运行的检查作为验收依据。

## 已实现的行为

`PluginHost` 统一管理 classic、orb、Quick 的逻辑 Tab 和运行实例。打开、关闭使用共享操作；关闭先同步摘除 Tab 与原生 View，再在同一个 1.5 秒期限内完成插件通知、资源释放和原生销毁。重复关闭等待原操作，关闭中重开等待旧代回收。`beforeunload` 不能阻止宿主关闭；如果期限内仍未确认 `destroyed`，保留 retiring 记录并阻止新代启动，避免旧视图成为无主资源。

占位、崩溃、休眠 Tab 都由主进程发布带 revision 的快照。renderer 只投影快照，并乐观移除用户关闭的 Tab。取消首次加载后的无条件刷新、300/400ms 假就绪计时；ready 来自真实加载状态。reload 创建新实例，期间显式关闭不会使旧请求复活。

三个身份分别承担不同职责：

| 身份 | 生命周期 | 用途 |
| --- | --- | --- |
| `buildRevision` | 安装包内容或开发刷新版本 | 描述符、资源缓存和检查点兼容性 |
| `generation` | 一次 WebContents 运行 | IPC、异步回调、连接、释放动作只能作用于所属实例 |
| `tabSessionId` | 从打开至显式关闭，跨休眠保留 | JSON 业务快照恢复；关闭后旧快照不适用于新 Tab |

`PluginRuntimeScope` 在资源创建前登记所有者、活动和释放函数，关闭时立即 abort；创建完成后再次检查 scope。SSH、跳板、SFTP、DB、HTTP 请求、provider、快捷键、权限请求、贴图、本地文件句柄和定时器均接入所属生命周期。独立释放函数全部启动，其中一个失败不会跳过其他资源。超时同时配合实际 stream/channel 销毁或 utility process 终止，不能只依赖 `Promise.race()`。

DB 驱动、SQL、结果转换和 CSV 处理放在每运行实例独立的 `utilityProcess`；主进程保留权限、凭据解析和文件选择。取消 250ms 未应答则请求终止该插件数据库服务，并等待真实 `exit`；仍不退出时对明确所属的子进程 PID 强制终止。退出未确认时保留 retiring 记录并阻止重建。所属连接必须重新连接，不自动重放写入。ZIP 解压和安装摘要计算通过 worker 执行，文件复制使用异步文件 API。安装与卸载共享每插件锁和宿主阻止打开机制，旧安装操作在文件替换前校验取消序列。

录屏关闭立即停止采集；宿主后台保存独立于普通实例的回收期限，最长 10 秒。隐藏录制窗口、区域选择窗口在失败、崩溃和超时路径均释放。退出等待普通实例、安装 worker 和录屏收尾，另有总退出期限。真实系统录屏与异常文件系统场景仍需三平台手工验收。

联合真实插件测试发现并修复了两个运行时问题：sandbox 辅助窗口需要独立 CommonJS preload，不能加载共享 ESM chunk；隐藏录制页从临时 `file:` 页面启动，避免 `data:` 页面没有 `mediaDevices`。临时页面加载后清理。`pluginApp.smoke` 对录屏、区域选择、贴图分别创建真实 sandbox 窗口检查桥接，也在 `.app` 内验证。并行插件任务已在 macOS 验证短录屏及截屏；长录制、系统授权变化、磁盘失败和其他平台仍需专项验收。

## 缓存依赖与失效

| 层 | 预算或边界 | 依赖、失效与保留规则 |
| --- | --- | --- |
| V8 编译缓存 | Chromium 默认策略、默认 Code Cache 位置 | `enest` 同时开启 `standard`、`codeCache`；保持独立持久 partition。普通关闭保留；更新、覆盖安装、开发刷新与卸载定向清理 |
| 资产 LRU | 全局 32 MiB，单文件 512 KiB | 同文件并发读共享 Promise；root/build 失效版本在读取完成后再次校验，旧读取拒绝返回且不能回填 |
| 大文件、媒体 | 流式，支持 HEAD / Range | 不把整个视频加载进主进程；请求终止释放流。条件响应已实现，HTTP 缓存命中仍以 Electron 实测为准 |
| 插件描述符 | 已安装和开发插件集合 | 扫描合并并发操作，临时结果完成后一次发布；manifest 与 UI 声明克隆、冻结，installed revision 只在相关结果变化时递增 |
| Quick 静态命令 | installed revision + 启动别名 revision | 静态命令与检索文本复用；搜索词、最近使用、剪贴板和 provider 保持动态；普通设置和远程市场刷新不重建静态池 |
| 主题派生结果 | 最多 2 项 | mode、overrides、主题包 token 内容构成依赖 |
| DB catalog | 连接、database/schema，60s TTL | 连接关闭、显式刷新失效；晚返回结果校验连接身份。业务查询和写入不缓存 |
| SSH 补全 | 连接所属缓存，3s TTL，最多 128 项 | 断连清空，晚返回结果校验连接身份 |
| `storage.local` clean 缓存 | 全局 32 MiB，单插件 4 MiB | 单 key 惰性读取；仅淘汰可从 SQLite 重读的数据。dirty 数据独立保留，事务成功才解除标记 |
| session/checkpoint | 单插件 8 MiB，全局 64 MiB JSON 载荷 | JSON 校验、复制读取；新增超限报错，存量超限可读取和缩减。休眠释放驻留值，仍计入逻辑会话的全局预算 |

所有容量均是缓存或序列化载荷预算，不能解释为实际 JS 堆、GPU 或进程 RSS 上限。`session.getCacheSize()` 也不代表总内存。

## 休眠与插件接口

保留 3 分钟后台空闲与 6 个存活实例软上限。前台、Quick 当前挂载界面、受保护的连接/任务、开发态 HMR 实例不会被强制 LRU 休眠，因此有活动保护时可以超过 6。活动释放后重新安排休眠。没有消息恢复机制的任务界面不因达到软上限被销毁。

数据库成功打开后保留连接级 lease，即使没有查询也不会误休眠。关闭、取消和连接列表同步按实际连接状态释放；同 sessionKey 重连时更换 lease 身份，旧 close/list 返回不能解除新连接的保护。utility 退出前继续保留退役资源记录。

插件可登记自行管理的任务；宿主提供的 SSH、DB、网络和录屏等能力由宿主登记，插件无需重复登记：

```ts
const token = await enest.runtime.acquireActivity('导入项目')
try {
  await importProject()
} finally {
  await enest.runtime.releaseActivity(token)
}

const unsubscribe = enest.onBeforeSuspend(async () => {
  await enest.storage.session.set('editor', {
    documentId: currentDocumentId,
    draft: currentDraft,
    cursor: cursorPosition
  })
})
// 新 renderer 初始化时从 storage.session 读取明确保存的业务状态。
const editor = await enest.storage.session.get('editor')
```

异步保存回调必须返回 Promise。宿主等待所有保存回调成功，再检查活动、激活状态、运行身份与会话 revision，随后落盘。保存失败或期间重新激活取消本次休眠。同步回调后的 ACK 使用 `queueMicrotask`：隐藏 renderer 的 timer 节流曾把很短的等待放大到接近一秒。

session 只接受有限数字、字符串、布尔、null、普通对象与数组；拒绝循环、undefined、NaN、类实例和稀疏数组等 JSON 会丢失或修改的数据。快照记录格式版本、buildRevision、tabSessionId 和 stateRevision。只有成功保存后释放驻留值；显式关闭清除临时会话和快照，`storage.local` 持久数据保留。

本地存储写入继续使用 50ms 合并事务。事务失败保留 dirty 数据并记录 `lastFlushError`；后续写入、显式 flush 或关闭会重试，不把失败数据当作可淘汰缓存。进程崩溃或在持续磁盘故障下退出不能保证未落盘数据持久化。

快照不保存 DOM、任意 JS 堆、GPU 资源、数据库事务或网络连接。Node `cachedData`、启动 snapshot、`.heapsnapshot` 都不能替代 WebContents 回收。

## 动画与窗口

Orb 使用按 Tab 身份复用的 DOM 节点，减少原生视图层级重排；长 Tab 列表可滚动，stagger 有界，动画尊重现有低/中/高档位。GSAP 与 rAF/定时器在卸载时清理；被不透明插件遮挡的装饰 canvas/video 暂停。移除 Quick/Orb 的无条件禁用后台节流，保留 GPU 加速。原生插件区域仍由 WebContentsView 承载，不依赖 renderer 遮罩盖住它。

Quick 的输入栏、全局搜索结果和插件现在共享同一原生外轮廓：`BaseWindow → View → shell/plugin WebContentsView`。插件顶部为直角，内容从输入栏末端 72px 开始，只有整张卡片有 20px 外圆角。`View.setBackgroundBlur(0)` 建立无模糊的合成层，确保子视图受到圆角裁切。窗口仅一次设到目标尺寸；展开期间只调整父 View 高度，shell/plugin 视口保持目标尺寸。返回、隐藏、关闭与迁移会取消未完成的展开。BaseWindow 不自动拥有 WebContents，因此窗口关闭显式关闭 shell WebContents；插件仍由 PluginHost 回收。

未采用 `View.setBounds(..., { animate })`：Electron 44.4.3 的原生 bounds 动画使用矩形 clip rect，圆角路径不能随中间高度连续更新，普通 setBounds 也不能可靠中止残留动画。当前用可取消的父 View 裁切，同时遵守动画档位及系统 reduced motion。macOS 原生夹具确认真实点击、app-region 拖动、途中圆角、取消及显式关闭回收；Linux/Windows 视觉行为仍需对应系统验证。

追加 Quick 回归（2026-10-13）：`ENEST_QUICK_SMOKE=1 node --test src/main/window/quickWindow.smoke.test.mjs` 通过。生产 preload + 隔离 profile 下验证全局结果/插件接缝均为 72px、输入接管事件投递、输入栏/原生工作台 Esc、16 个自动重复按键、3 轮展开中退出、Quick→shell→Quick 复用同一 WebContents，以及关闭 Quick 后 shell WebContents 销毁、插件退为 background。相关 Host/Input/恢复竞争测试 29/29 通过，renderer typecheck 通过。当前主进程/preload/renderer 定向构建通过；工作区同时进行的 middleware 驱动文件和 `MwTestResult` 导出尚未齐备，因此最后的全量构建/typecheck 不能记为通过。定向构建使用临时配置排除 mwUtility，未修改正式构建配置；不代表中间件已验证。

## 测量结果

### 原生 Host 与生产 preload

环境：macOS arm64、Apple M2、Electron 44.4.3、Chromium 152、Node 24.21。最终测试使用全新临时 profile、真实隐藏 BaseWindow/WebContentsView 与生产 `pluginPreload`；registry、存储及业务服务为隔离 fixture。每个 fixture 分配 8 MiB，运行 canvas/rAF 与定时器。数据见 [最终原生测试](plugin-native-benchmark-2026-10-13.json) 和 [隐藏 timer 对照](plugin-native-benchmark-timer-control-2026-10-13.json)。timer 对照使用简化 preload 和 10ms 定时 ACK，用来复现隐藏页节流机制，不是旧版生产 preload 的直接前后比较。

| 指标 | 本机测量 |
| --- | --- |
| 1 / 6 / 10 / 20 个逻辑 Tab 的稳定存活数 | 1 / 6 / 6 / 6 |
| 50 轮打开关闭，同步摘除中位 / P95 / 最大 | 0.391 / 0.714 / 1.222 ms |
| 原生 destroyed 中位 / P95 / 最大 | 1.838 / 6.602 / 173.175 ms |
| 不回复 ACK / JS 阻塞后销毁 | 1202.414 / 1202.464 ms |
| 累计原生 WebContents | 90 个创建，90 个回收，最终孤儿为 0 |
| 隐藏 timer ACK 对照，销毁中位 / P95 | 839.635 / 880.695 ms |

每 10 轮采样均无残留 renderer 或孤儿视图；应用自身进程的 working set 从约 274.4 MiB 到 234.5 MiB，没有观察到逐轮抬升。这不是长期无泄漏证明，也不是完整产品从鼠标点击至屏幕退场的 P95/FPS。主进程同步摘除达标不能直接宣布端到端退场 P95 ≤100ms 已验收。

### V8 编译缓存

[实测记录](plugin-code-cache-2026-10-13.json)：8000 个函数、452891 字节 JS。每次销毁旧 WebContents，再用新的 WebContents 加载；之后重启 Electron，复用同一隔离 profile。

关闭 codeCache 的 4 次加载没有生成编译缓存；开启后的 4 次加载生成两个脚本缓存条目，分别为 1529200 和 250 字节；重启后的 2 次加载仍可见缓存。10 次结果校验全部正确。开启组首次含窗口创建的 load 为 401.354ms，第 3/4 次为 123.786/129.816ms；脚本内计时 19.4ms 到 1.9ms。重启后首次 load 为 275.932ms，脚本内计时 2.4ms。

该实验确认自定义协议会生成并保留编译缓存；没有采集 V8 compile trace 或内部 cache-hit 计数，因此不能把差值归因于纯编译时间，也不承诺固定提速比例。协议 HTTP 条件请求行为单独记录，不能仅凭 Cache-Control 响应头推断命中。

### 实际构建与重型任务

`pluginApp.smoke.test.mjs` 启动真实 `out/main` 和全部生产 preload，使用临时 userData/dataRoot，安装 3 个合法 fixture，其中一个永不完成 beforeClose。最终两轮打开耗时 610/451ms，关闭 API 确认 39/25ms，诊断观察完成 1252/1287ms；原生 destroyed 为普通插件 24/29ms、13/18ms，无响应插件 1211/1220ms。断言逻辑 Tab、opening/closing/retiring、运行资源、插件 WebContents 与驻留 session 均归零，且没有 preload/未捕获异常/IPC 错误。可选通知权限等待期间关闭后，旧调用不能为新代启动持久计时器的回归也通过。这些值来自构建烟测，受同时运行的检查影响，不替代上节的专门压测。

DB 真实 utility 烟测在 SQLite 执行十亿级递归查询；补齐连接保护后的最终运行，空闲已连接会话有 1 个 lease，主进程 10ms heartbeat 继续执行（观测到 16 次）；取消后 274ms 返回，确认 `exit` 后 utility 所有权记录为空、活动 lease 为 0。普通结果 3 行上限和 truncated 标记正确。此项验证进程隔离与实际退出，不代表所有外部 DB 驱动的吞吐量测试。

macOS arm64 未签名目录包也已完成真实启动烟测。为隔离并行工作区，将构建输入和依赖复制至独立临时目录，以 electron-builder 25.1.8、`npmRebuild=false` 打包。生产 `.app` 加载实际 asar/preload 后，主进程记录普通插件 destroyed 为 16/18ms、29/34ms；永不回复 ACK 的插件为 1206/1215ms。两轮关闭 API 确认 15/29ms，诊断轮询观察完成为 1403/1230ms，最终资源均归零。三个辅助窗口的 sandbox 均保持开启，CommonJS preload 桥接全部可用。

此前未记录原生事件的一轮包烟测，诊断轮询曾在 2938ms 才观察到清理完成。因此报告保留观察延迟与原生销毁时间两种口径，不能把测试程序返回时间直接解释为 renderer 存活时间，也不据此宣布所有负载下的 2 秒目标达标。可复核目录包保存在 `release/lifecycle-validation-2026-10-13-arm64/eNest.app`（忽略的构建产物，无签名/公证）。Windows/Linux 安装包和真实用户插件仍需各平台验收。

最终包移除临时 staging 中遗留的三个未使用 ESM 辅助 preload 后，重新打包并逐字节核对全部 20 个构建输出文件；运行代码与已测 CJS 版本一致。`app.asar` SHA256：`ca5c7f913fd4bd10e72df590faac72f0f299d636ee0269faf92cb5999cc7f28d`。并行任务之后的源码变更不自动包含在这个验证包中。

最终源码检查：`npm run typecheck`、`npm run build` 与 `git diff --check` 均通过。全量 MJS 回归 136 项通过、0 失败、5 项按环境变量跳过；跳过的是应用原生烟测、DB utility 原生烟测、13 个真实插件包、真实工作台和 OpenSSH 集成。前两项由本任务按上述命令单独通过；其余真实插件/服务测试由并行插件任务负责，不并入本报告的本任务测试计数。

## 复跑与平台验收

```sh
npm run typecheck
npm run build
node --test src/main/**/*.test.mjs src/renderer/stores/*.test.mjs
ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginApp.smoke.test.mjs
ENEST_ELECTRON_SMOKE=1 node --test src/main/database/dbUtility.smoke.test.mjs
ENEST_APP_SMOKE=1 ENEST_APP_SMOKE_EXECUTABLE="$PWD/release/lifecycle-validation-2026-10-13-arm64/eNest.app/Contents/MacOS/eNest" node --test src/main/plugin/pluginApp.smoke.test.mjs
node src/main/plugin/PluginHost.native-bench.mjs --output /tmp/enest-native-benchmark.json
node src/main/plugin/pluginCodeCache.native-bench.mjs --output /tmp/enest-code-cache.json
```

测试使用隔离临时目录，不复用用户实际插件、凭据或业务数据。Windows PowerShell 设置环境变量的语法不同；这些平台的原生测试需要在各自机器运行。修改 main/preload 后需要重启 `npm run dev`。

诊断入口为 `enestShell.getPluginDiagnostics()`，包含逻辑/运行状态、generation 与 WC/OS pid 映射、资源/活动数量、资产缓存 hit/miss/shared/stale/eviction、描述符/命令/主题缓存的命中及重建、session 载荷/驻留字节、本地 clean 缓存/dirty 数/写入错误、DB utility 的 running/retiring 状态，以及 `app.getAppMetrics()` 的本应用进程信息。只返回元数据，不返回凭据或业务载荷；读诊断不会触发缓存重建。

| 验收场景 | macOS 本次 | Windows / Linux X11 / Wayland |
| --- | --- | --- |
| 类型、构建、并发/取消/存储预算回归 | 自动检查，见最终结果 | 可复跑，尚无本机结果 |
| 真实 Host、生产 preload、50 次关闭及缓存跨重启 | 已测隔离 fixture | 待原生实测 |
| 完整构建产物启动与资源归零 | 已测隔离 fixture | 待原生实测 |
| 安装包、签名、升级与 utility/native 文件定位 | arm64 未签名目录包启动通过；签名、公证、升级和外部 DB native 驱动待发布验收 | 待发布产物验收 |
| 真实重型插件长时间运行、断网与数据库驱动失败 | 已覆盖取消回归，长期场景待测 | 待测 |
| 系统录屏权限、关闭即停、10s 收尾及损坏磁盘 | 自动故障路径回归；联合任务验证短录屏，长录制/授权变化/真实磁盘失败待测 | 待测，Wayland 另含 portal |
| classic/orb/Quick 点击退场 P95、掉帧、缩放与多屏 | Orb DOM/原生层检查；完整可见帧测试待测 | 待测 |

历史 [PERF_REPORT.md](PERF_REPORT.md) 的 2026-09-17 数据使用开发态、真实数据目录和全机 Electron RSS，其口径与本次隔离的应用进程采样不同，不能作直接前后对照。

## 设计依据

- [Electron 44 自定义 scheme：standard 与 codeCache](https://github.com/electron/electron/blob/v44.4.3/docs/api/structures/custom-scheme.md)
- [V8 Code caching for JavaScript developers](https://v8.dev/blog/code-caching-for-devs)
- [rustc 查询与增量计算](https://rustc-dev-guide.rust-lang.org/query.html)
- [LLVM 分析缓存与失效](https://llvm.org/docs/NewPassManager.html)
- [Rust 所有权](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)

这里借鉴的是计算复用、精确失效和资源作用域。TypeScript 的运行时登记与回归检查不能提供 Rust 的编译期所有权保证。
