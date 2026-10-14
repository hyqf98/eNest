# 插件沙箱与生命周期验证（2026-10-13）

本轮修复 Tab 切换的闲时计时顺序、主窗隐藏/最小化的后台状态，并将所有窗口 preload 改为自包含 CommonJS、启用 sandbox。仍保留 3 分钟后台回收与 6 个实例软上限；宿主任务与开发态保护不变。主窗隐藏保留选中 Tab，恢复时重新激活或按业务检查点唤醒。

插件 session 默认拒绝浏览器设备/媒体/位置/通知权限及直接下载。页面只可请求本插件静态资源、明确配置的开发 origin/HMR，以及经宿主服务动态登记且可撤销的 loopback endpoint。宿主 API 的网络/文件权限仍独立检查，进程沙箱不代替这些权限。DSH 子进程不被描述为独立操作系统沙箱。

`enest.storage.get/set`（现为无需声明或弹窗的 `storage.local` 基础能力）的待提交内容按 UTF-8 key/value 与 tombstone 元数据计费，上限 8 MiB/插件、64 MiB/全局；key 新写入上限 1024 UTF-8 字节。失败事务保留已接受的数据；超额新写入原子拒绝，缩减/删除仍可释放预算，持久化恢复后重试。clean 缓存仍为 4 MiB/插件、32 MiB/全局。以上是载荷预算，不是进程 RSS 上限。

## 隔离原生测量

- 基线：[plugin-native-baseline-2026-10-13.json](plugin-native-baseline-2026-10-13.json)
- 改后：[plugin-native-sandbox-2026-10-13.json](plugin-native-sandbox-2026-10-13.json)

两次均使用全新临时 profile、隐藏 BaseWindow、真实 WebContentsView 与生产插件 preload，业务服务使用隔离 fixture；未读取用户插件/设置/连接。改后移除内联 fixture 脚本以符合生产 CSP，并断言 renderer 没有 require/process、sandbox=true；未获授权的本地测试 HTTP 服务请求被阻止，服务器收到 0 次请求。

| 指标 | 基线 | 改后 |
| --- | --- | --- |
| 50 轮同步摘除 P95 | 1.754 ms | 1.102 ms |
| 50 轮原生 destroyed P95 | 7.522 ms | 13.643 ms |
| 50 轮打开 P95（含创建） | 689.069 ms | 598.398 ms |
| 创建 / 回收 WebContents | 90 / 90 | 90 / 90 |
| 1 / 6 / 10 / 20 逻辑 Tab 驻留 | 1 / 6 / 6 / 6 | 1 / 6 / 6 / 6 |

测试期间有并行构建，且 fixture 脚本加载方式发生改变；这些数字不是受控 A/B 加速结论。原始基线 main/preload bundle 已被旧脚本的 finally 清理，只保留哈希，无法严格重放原测量。原报告 destroyed P95 增加约 81%，超过 20% 回归阈值，但受环境和夹具差异影响，不能据此判定真实退化或通过验收。**受控前后对比尚未完成**，不能用后续更好的当前版数字替代。每轮报告包含 bundle SHA256、原生销毁事件和应用自身进程采样。

## 自动回归

Host 新增两插件切换后假时钟推进 3 分钟回收、隐藏主窗/休眠/恢复及隐藏期间加载的回归。存储新增磁盘失败下单插件/全局 dirty 预算、超额原子拒绝、缩减和提交恢复检查。浏览器策略检查文件/其他插件/任意网络拒绝、精确开发 origin、endpoint owner/撤销与浏览器权限拒绝。

```sh
node --test src/main/plugin/PluginHost.test.mjs src/main/plugin/pluginSessionPolicy.test.mjs src/main/db/pluginStorage.test.mjs
node src/main/plugin/PluginHost.native-bench.mjs --output /tmp/enest-native-sandbox.json
npm run build
ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginApp.smoke.test.mjs
```


## 构建产物应用冒烟

2026-10-13 在 macOS 使用真实构建产物与临时数据目录运行 `ENEST_APP_SMOKE=1` 通过。shell sandbox=true；录屏、区域选择、固定图片三个辅助 preload 均在 sandbox 下成功加载 bridge。两轮共六个真实插件实例关闭后，原生视图、活动租约、内存 session 均归零；正常插件 8–11 ms 收到 destroyed，故意不响应 beforeClose 的插件在 1206–1208 ms 被截止销毁。旧实例尚未完成的原生权限对话框，在关闭重开后允许也不能向新实例创建后台计时器。最新结果见 [plugin-native-app-smoke-2026-10-13.json](plugin-native-app-smoke-2026-10-13.json)，权限竞态夹具已明确选择“本次允许”。

DB/SSH 前端本地文件操作使用句柄：数据库选择和新建、CSV 导入、私钥及 SFTP 上下行。保存配置中的旧路径只用于显示提示；句柄只在当前 renderer 生命周期复用，插件重启后重新选择授权，不自动恢复原始路径访问。对应 `eNest_plugin/scripts/tests/local-file-capabilities.test.mjs` 覆盖原始路径不出站、旧句柄重新授权、取消以及上传/下载参数。


## 当前版本静默测量（非前后对比）

[plugin-native-final-current-quiet-2026-10-13.json](plugin-native-final-current-quiet-2026-10-13.json) 在 Tab 展示状态改动完成、其他代理暂停构建、打包和浏览器测试后运行；测量早于后续基础能力分类、密钥库和主题来源收口，不将其描述为这些改动后的重新测量。仍有外部系统负载，未控制系统全部进程。使用隐藏窗口、真实沙箱 renderer 与生产 preload，每 renderer 申请 8 MiB、包含 canvas/rAF 和 100ms 计时器，业务服务使用夹具。之前的 [plugin-native-current-quiet-2026-10-13.json](plugin-native-current-quiet-2026-10-13.json) 保留为历史记录。

| 项目 | 当前观测 |
| --- | --- |
| 新 profile 首个插件创建并完成加载 | 320.122 ms（单次，非整个壳冷启动） |
| 30 次已加载 Tab 宿主激活 P95 | 0.238 ms |
| 30 次激活并完成 renderer 往返 P95 | 0.802 ms（未测可见帧） |
| 50 轮新建插件打开 P95 | 113.886 ms |
| 50 轮同步摘除 / native destroyed P95 | 0.380 / 1.824 ms |
| 1 / 6 / 10 / 20 逻辑 Tab 驻留 | 1 / 6 / 6 / 6 |
| 创建 / 回收 WebContents | 93 / 93，最终孤儿 0 |
| 3 个后台 renderer 的 CPU 采样 | 0.029%、0.040%、0.065% |
| 显式休眠后 renderer 数量 | 0 |
| 显式休眠后 CPU 采样 | 0.046%、0.147%、0.078% |
| 后台 / 休眠后应用进程 working-set 合计末次值 | 588.4 / 292.8 MiB |

CPU 来自 Electron app metrics，每组仅 3 次、间隔 1 秒；working-set 合计包含共享页，不能作为独占 RSS。休眠调用生产 suspend/checkpoint/destroy 路径，本次基准未等待真实 3 分钟；真实 180 秒调度另有下文证据。初始与最终应用进程数为 1→3（GPU/utility 启动），renderer 为 0→0；内存不会回到冷启动初值。上述短程检查不能证明长期无泄漏。

每次创建插件均设置 title/glyph/badge，1/6/10/20 Tab 每批关闭后、50 轮中的每 10 轮以及最终状态都检查 `tabPresentations`，结果全部为 0；最终 opening/closing/hibernated/logicalTabs/retiring 也为 0。无响应和同步阻塞 beforeClose 的插件分别在 1202.639/1203.375 ms 销毁，beforeunload veto 夹具在 0.971 ms 销毁。

基准脚本新增 `--keep-bundle`，可保留本次 main/preload/fixture 并删除临时 profile，位置记录在报告 `retainedBundle` 字段。历史受控 A/B 缺口保持未完成，不因当前结果更好而替换。

## 源码、HMR 与响应式原生验证

[plugin-native-dev-layout-2026-10-13.json](plugin-native-dev-layout-2026-10-13.json) 使用仓库外临时标准项目（根目录 plugin.json、package.json、index.html，src/ 与 public/assets/market/）。测试点击实际设置页开发者区“加载源码目录”按钮，原生目录对话框使用 stub 返回夹具路径（不是人工操作系统选择）；`pickerCalls: 1`，未单独调用 openPlugin 即自动打开（`autoOpenedWithoutSeparateOpenCall: true`）。源码注册后不复制到已安装目录；真实 Vite server 更新 JS 后同一个 WebContents 和页面生命周期完成 HMR（模块运行次数 1→2）。renderer sandbox=true、无 require/process。

真实主窗口分别调整到 900×600、1200×800、1920×1080，以及 900×600 下 21px 基础字号压力场景。首页与设置主容器未横向溢出，标题栏保持 36px；已查看窄屏首页与放大字号设置截图。21px 为直接 token 压力测试，设置界面的最大字号比例仍为 130%。此检查覆盖外层结构，完整插件功能和所有字体排版仍需逐项 UI 测试。

## 文件授权前端回归

四个文本导入插件（验证器、片段、待办、便签）使用 localFiles.pick/read；4/4 浏览器回归覆盖取消、拒绝、授权成功、字节数上限参数和数据保留。数据库选择/新建、CSV、私钥、SFTP 的句柄接口另有 2/2 合约与数据库 10 项 UI 验证。官方插件已迁移原生文件 input；Electron restricted-directory 事件仅限制 Chromium 特定目录，并不能普遍拦截任意第三方 HTML file input/drop。文档不把这个钩子描述成所有浏览器文件选择的授权总闸。

## 尚未完成的运行验收

- 原始代码与当前代码的受控 A/B 性能对比，以及可见帧 FPS/输入到显示延迟。
- Windows/Linux 的原生窗口、沙箱、文件权限与长期稳定性。
- 真实远程数据库、消息中间件服务器与 DSH 原生服务运行；远程/Linux SSH 多跳和 agent 流程。本机隔离 OpenSSH/SFTP 已单独通过，见 [plugin-local-openssh-2026-10-13.json](plugin-local-openssh-2026-10-13.json)，不将其视为远程或跨平台覆盖。
- 数小时/数日常驻与操作系统低内存压力。


## 真实三分钟闲时与唤醒

另行运行 [plugin-native-real-idle-2026-10-13.json](plugin-native-real-idle-2026-10-13.json)，未修改 180 秒常量、未替换时钟。先打开 A/B，再激活 A 并写入尚未提交的业务草稿 42，随后切到 B。A 的原生 destroyed 发生于切换后 **180032 ms**，B 保持原 WebContents 3 和 active 状态。A 的 onBeforeSuspend 将草稿保存到 session；重新激活 A 创建 WebContents 4（原 2）并恢复草稿 42。关闭后 runtime、活动和 resident session 均归零。

## 启动会话竞态修复

原生全插件测试发现，Splash 期间由外部入口打开/关闭插件时，400ms session 写回可能先于 hydrateSessionTabs；恢复阶段会把刚关闭的临时 Tab 误当成上次会话恢复。现在启动恢复前只缓存当前投影，读取并恢复保存的会话后才允许 debounce/pagehide 写回。新增 early-open→close→hydrate 的回归，防止关闭的临时插件复活；最终 shellStore 共 6/6 通过，包含后续图标/角标状态回归。


## 35 个官方包最终原生验收

[official-plugin-native-smoke-2026-10-13.json](official-plugin-native-smoke-2026-10-13.json) 读取最终 35 个真实 dist，复制到独立临时安装目录，使用生产 shell 与 sandbox preload 启动。macOS 全部 **35/35** 通过：sandbox=true、无 require/process、API bridge 可用、非空 UI、无资源错误/坏图片、无 Uncaught（含 Promise rejection）、无 CSP 无效 source 警告或阻断。每次关闭后 runtime、活动租约、resident session 和对应原生 WebContents 均归零。

此前原生记录暴露多份 manifest 缺 ui.setTitle、diff 缺 storage.local，以及 Chromium 不支持 bracketed IPv6 CSP source。补齐 manifest、删除无效 CSP source 后重跑得出以上结果；不会把旧的宽松筛选结果当作最终验收。宿主动态 endpoint 使用 127.0.0.1/localhost，IPv6 字面量开发服务器/HMR 未单独验证。

主题插件真实执行 theme.register；getTheme 列表含两个声明包和运行时 ink-green，source 绑定主题插件。禁用插件后三个包全部撤销。fixture 允许 storage/settings/ui/vault/theme，拒绝 OS/network 能力；ccswitch 有一条已捕获的 config.agent.read 拒绝日志，其余无 console 日志。该检查覆盖启动与清理，不代替需要外部服务的业务流程测试。

源码/HMR 原生用例另已覆盖显式 dist 预览（真实 Vite build 产物，注册 rootPath 为源码下 dist，不安装复制），关闭开发服务器时报告 ERR_CONNECTION_REFUSED 并释放失败 renderer，重启同 IP/端口后再次打开成功，随后在同一 renderer 完成 HMR。相关信息已进入开发/布局证据 JSON。


最终 Quick 原生回归通过：两行首页、搜索边缘与原生插件区衔接、打开/退出/Escape 连按、关闭后的空白搜索恢复；保存 7 张原生合成截图，索引见 [plugin-native-quick-smoke-2026-10-13.json](plugin-native-quick-smoke-2026-10-13.json)。Tab 展示状态改动前，生命周期/策略/存储/中间件/会话投影组合单元测试 38/38 通过；改动后 Host 与 shellStore 针对性测试 27/27 通过（新增 2 项），typecheck 与最终 electron-vite build 通过。

## Tab 图标、标题与角标

Host 的 `plugin-tabs` 快照现在携带插件包图标与 title/glyph/badge 覆盖状态，classic 标题栏和原生 orb rail 都消费同一份状态。`ui.setTitle/Icon/Badge` 经宿主身份、当前实例与参数检查后更新快照，作为基础能力无需声明或弹窗；标题最多 120 个 Unicode 码点，图标仅接受最多 2 个码点的文本字形（不接受 URL/路径），角标接受 0..999999 整数或最多 8 个码点的字符串。空值恢复默认标题/包图标或清除角标。覆盖状态在休眠和 Quick/主窗口迁移后保留，最终关闭时清理。

[plugin-native-tab-icons-2026-10-13.json](plugin-native-tab-icons-2026-10-13.json) 使用真实 sandbox 插件、生产 preload 和宿主 UI 检查 classic/orb：默认 SVG 成功加载（naturalWidth/Height 为 64）、动态标题/字形/角标即时更新、非法 URL/路径/超长值被拒绝且不污染快照、空值恢复默认、关闭重开清除覆盖状态。测试检查真实 DOM 图片加载与显示层，不包含截图或可见帧延迟测量。最终 runtime、活动租约与 session 归零。
