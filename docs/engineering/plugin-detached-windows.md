# 插件独立窗口与拖动收回

插件可以从 classic Tab、Orb 插件项和 Quick 标题握柄拖出。独立窗口的图标及名称是插件拖动握柄，标题空白区域仍由系统移窗。拖回可见主窗口的 Tab 条 / Orb 轨道或 Quick 接收区域即可收回；独立窗也提供两个收回按钮。普通启动入口再次打开独立插件时聚焦现有窗口。

独立窗的“收回主窗口”“收回小窗口”使用图标，悬浮显示功能说明。置顶按钮切换原生 `alwaysOnTop`，按钮状态与提示随原生窗口状态同步；每个窗口独立设置并在重启后恢复。

## 窗口与实例

`PluginLaunchMode` 仍为 `shell | quick`；`PluginPlacement` 表达 `shell | quick | detached(windowId)`。拖出只改变挂载位置，跨布局收回才发送 `mode-change`。`PluginHost` 在目标窗口准备完成后迁移原 `WebContentsView`，保留 `wcId`、generation、runtime scope、tabSessionId 和页面状态。摘挂失败恢复来源；异步准备期间再次校验实例、位置版本、关闭状态及拖动令牌。

独立窗是无父窗口的顶层 `BaseWindow`。Windows 使用普通任务栏 / Alt+Tab 窗口语义，macOS 属于同一个 eNest 应用。每窗只有轻量标题栏和一个插件 View，Quick 布局额外保留独立输入栏。输入状态按插件与 generation 隔离，Esc 清空并返回插件内容。插件 `resize/setHeight` 的兼容行为不变，独立窗口尺寸由用户调整。

`detachedPluginWindows.ts` 管理窗口，`pluginWindowDrag.ts` 管理单个拖动会话，`pluginWindowHandlers.ts` 校验可信 sender。独立窗使用专用受限 preload；插件不能获得窗口管理接口。文件选择及权限模态框跟随所属窗口，并持有迁移互斥令牌，普通后台任务不阻止移动。

## 拖动与性能约束

- 按下捕获指针，8 DIP 后开始；离开完整来源 Tab 区域使用 16 DIP 迟滞。
- renderer 按 rAF 合并更新，主进程以屏幕 DIP 采样鼠标。非聚焦、鼠标穿透的原生预览窗位于插件 View 上方；每次最多截图一次，先显示图标 / 字形与名称。
- 跟手期间不迁移插件、不调整插件大小、不保存会话、不广播完整 Tab 列表。排序只预览 `transform`，释放时提交一次；长列表边缘自动滚动。
- Quick 在按下至释放期间持有交互保护，Orb 在拖动期间保持展开。动画使用现有 `marketMotion` 并尊重动画档位及减少动态效果。
- 放入 eNest 非接收区域取消；释放到所有 eNest 窗口外创建独立窗，原本独立的插件移动现有窗口。Escape、失去捕获、来源隐藏 / 销毁 / renderer 崩溃会清理会话。
- 收回目标须可见且未最小化；以 eNest 窗口的置顶、焦点、显示顺序处理相互遮挡。跨显示器约束使用 DIP 与工作区，支持负坐标及显示器拔出。

没有系统级鼠标钩子，也不以系统移窗事件推断松手。独立标题栏进程和一次性预览均显式关闭 WebContents，不通过 PID 杀进程。多个独立窗共用显示器与主题监听，避免每窗重复订阅。

## 关闭、休眠与会话

独立窗关闭沿用立即退场、限时清理；收回销毁空标题窗不会关闭插件。可见独立插件不会因失焦休眠，隐藏 / 最小化后沿用任务保护及空闲回收。主窗口隐藏不影响独立窗，退出统一清理全部实例、窗口和拖动资源。

`PluginWindowSession` 是会话唯一写入方；renderer 的设置更新不能覆盖会话和主窗历史字段。参与过主窗口或独立窗的未关闭插件保留，普通 Quick 临时插件不增加恢复项。`sessionTabs[].detached` 可选保存布局模式、正常窗口 DIP 坐标和尺寸、最大化 / 最小化及置顶状态；主窗口几何保存在 `general.mainWindowState`。旧版没有 detached 字段的会话继续恢复为主窗 Tab。损坏的历史字段会丢弃，拔屏后窗口约束在现有显示器工作区内。

重启时主窗 Tab 仅登记逻辑占位，独立窗恢复原位置与布局的轻量外壳（最多两窗并行创建标题栏）。包括上次激活的插件，所有恢复项都不创建插件 WebContents / runtime scope。“点击打开插件”或普通插件启动入口才加载对应内容；启动展示、聚焦、最小化还原、移动、缩放、置顶均不触发惰性插件加载。独立 Quick 的输入栏在内容就绪后启用；等待加载时不引入全局搜索列表。

未加载的独立窗可以直接关闭并从历史删除，收回主窗口仍保持惰性 Tab，收回 Quick 则视作明确打开。运行中的收回继续复用现有 View；收回后清除 detached 历史。窗口移动合并历史更新，退出清理前读取最后几何并冻结恢复列表，防止关闭、最小化或异步清理覆盖历史。恢复任务与关闭、卸载、退出竞争时取消，重复恢复请求复用任务。

## 验证方式

```bash
npm run typecheck
npm run build
ENEST_DETACHED_SMOKE=1 node --test src/main/window/detachedPluginWindows.smoke.test.mjs
ENEST_QUICK_SMOKE=1 node --test src/main/window/quickWindow.smoke.test.mjs
```

单元回归覆盖 Host 迁移回滚 / 竞争、原生窗口销毁、可信 sender、拖动取消、会话顺序、输入隔离及异步输入状态。独立窗 smoke 使用新建临时用户数据目录和测试插件，覆盖 20 次往返、输入 / wcId / generation 保持、多窗口输入、隐藏 / 最小化、1/6/10/20 逻辑插件、资源归零及实际退出后恢复。正常 LRU 仍生效，逻辑插件数不等于同时存活的 renderer 数。

自动 smoke 的窗口迁移通过宿主命令触发，不能证明物理鼠标捕获或 60 FPS。为避免其它桌面操作影响隔离测试，它只移除了测试进程 Quick 的 blur 隐藏监听；真实 blur 行为需要另行检查。截图分别捕获标题栏和插件 WebContents，不是系统合成窗口截图。冷独立窗创建、命令往返耗时与热跟手延迟必须分开解释。

最初拖动实现的验证记录在 `plugin-detached-windows-validation.md`；图标、置顶与历史惰性恢复的最新结果在 `plugin-window-history-validation.md`。Windows / macOS 混合 DPI、真实多屏拖动、指针至预览 P95 ≤32 ms 和松手至可交互 P95 ≤150 ms 必须经相应硬件测量，不以单元测试或命令计时代替。
