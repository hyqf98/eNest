# 自由面板（小组件）— 工程说明

状态：功能开关默认关闭（设置 → 通用 → 自由面板）。开启后才创建窗口、注册快捷键、恢复布局。

## 1. 概念与边界

自由面板是一块由用户框选出来的置顶窗口，里面把**插件**当作小组件自由摆放：每个组件是插件自己的 `WebContentsView`，宿主负责排布、组件条、拖动/缩放与对齐辅助线。

已确认的设计决策：

| 决策 | 结果 |
|---|---|
| 面板结构 | 无标题栏、无工具栏、无添加虚槽。两层：chrome 底板视图 + 组件原生视图。操作靠右键菜单与组件条 `⋯` |
| 插件归属 | **移动语义**：同一 webContents 换父级（与「独立窗口」同构），不复制实例 |
| 组件形态 | 沿用 `?mode=shell`，插件零改动 |
| 外观 | 可见底板；不透明度与材质（无/毛玻璃/系统材质）在设置 → 外观「自由面板外观」卡调节（壳级 `general.panelAppearance`） |
| 开关 | `general.freePanel.enabled`，默认 false |
| 持久化 | 顶层 `panels` 段；重启后先建窗口显示占位，再按并发上限冷启动组件插件 |

## 2. 模块拓扑（严格单向依赖）

```
shared/types/panel.ts        纯类型 + 尺寸常量（无任何运行时依赖）
    ↑
main/panel/panelGeometry.ts  纯函数：clampRect / findFreeSlot / rectAtPointer /
                             computeSnap / applyDrag / fitWidgetsToPanel（零 Electron）
    ↑
main/panel/panelStore.ts     持久化：readPanels / 防抖写入 / readPanelAppearance / isFreePanelEnabled
    ↑
main/window/panelWindows.ts  原生窗口：BaseWindow + container View（圆角裁切）+ chrome 视图 +
                             材质 + layoutPanelChrome
                             （不 import PanelManager，事件经 PanelWindowHost 回调回流）
    ↑
main/panel/PanelManager.ts   编排：create/close、组件增删、组件与面板拖动 tick、吸附反馈、恢复队列
                             （不 import PluginHost，运行时能力经 PanelPluginHost 窄接口注入）
    ↑
main/ipc/panelHandlers.ts    IPC 校验与转发（功能开关前置守卫）
```

两个注入点（与 `bindDetachedWindowHost` 同范式，避免模块环）：

- `PluginHost` 启动时 `bindPanelPluginHost(...)`：提供 mountInPanel / unmountFromPanel / setPanelWidgetBounds / setPanelWidgetVisibility / closePanelPlugins / getPlacement / describePanelWidget / getPluginView
- `index.ts` 启动时 `registerPanelWindowHost()`：面板窗口的几何变化/关闭请求回流到 `PanelManager`

区域选择独立成 `main/panel/regionSelection.ts`（每显示器一个全屏 overlay，surface role = `'region'`），被 `PanelManager.createPanel` 与 `panelHotkey` 共用。多屏时任一屏取消会销毁全部 overlay；overlay **不监听 `blur`**（焦点在屏幕间切换会误取消）。

## 3. placement 接入（第四种）

`PluginPlacement` 新增 `{ kind: 'panel'; panelId }`。`PluginHost` 里必须同步的分支：

| 位置 | 语义 |
|---|---|
| `getContainerWindow` | panel → `getPanelWindow(panelId)` |
| `isPresented` | **panel 恒为面板可见**（窗口未销毁/可见/未最小化），因此面板组件不参与 `activeTabId` 判定、免疫 3 分钟空闲休眠与 LRU(6) 驱逐 |
| `hasPlacementInteraction` | panel 按 `panelId` 区分归属 |
| `activatePlugin` | panel 分支走 `activatePanelPlugin`：只 `setVisible` + enter，不抢主窗激活、不隐藏别的视图 |
| `layoutAll` | 跳过 panel（由 `PanelManager.layoutPanelWidgets` 驱动，避免两处排布打架） |
| `moveEntry` | `parent()`/bounds 含 panel；迁入面板即 `logicalTabs.delete`，面板不写 `windowSession`/`sessionTabs` |
| `createPlugin` | 挂载分支含 panel（真实矩形由 Manager 挂载后立即下发） |
| `detachView` | 父级查找含 panel |
| `closePlugin` | 非 preserveSession 关闭时 `forgetPlugin(pluginId)` 摘除幽灵组件 |
| `restoreTabs` | 跳过 placement=panel 的插件（布局走 `panels` 段独立恢复） |

面板内插件**不产生 Tab、不写 windowSession**；关闭面板 = 逐插件走完整 `closePlugin` 链路（beforeClose 1500ms 宽限 → saveSessionSnapshot → disposeEntry）。

## 4. IPC 与安全

通道全部定义在 `@shared/types/ipc`：

- 面板 chrome（role `'panel'`，白名单 `panelChannels`）：`panel:get-state`、`panel:command`（统一命令入口）、`panel:drag-tick`
- 壳 renderer：`panel:pick-region`、`panel:create`、`panel:close`、`panel:list`
- 区域 overlay（role `'region'`，白名单 `regionChannels`）：`panel-region:confirm`、`panel-region:cancel`
- 主进程 → 页面推送：`panel:state`、`panel:drag`

⚠️ `ipcSecurity.assertSurfaceSender` 是「按 role 排除」的写法：新 role 若忘了加白名单分支会**落到全通**。新增任何 surface 都必须同时加 `xxxChannels` Set 并在该条件里加一行。

`panel:command` 的入参经 `normalizeCommand` 白名单校验（未知 action、超长 pluginId、非有限数一律拒绝），再交给 `PanelManager.handlePanelCommand`。`panels` 段与 `mainWindowState`/`sessionTabs` 一样在 `shell:set-settings` 被剥离，renderer 只能读。

## 5. 拖动链路与性能红线

**面板内组件拖动 = 主进程驱动**（与 `pluginWindowDrag` 同范式）：

1. chrome `pointerdown`（组件条/缩放手柄）→ 一次 `widget-drag-begin { pluginId, mode, edge, pointer }`
2. 主进程建 `DragSession`，`setTimeout(0)` 合并 tick：读 `screen.getCursorScreenPoint()` → `applyDrag` → `computeSnap` → `view.setBounds`
3. **只有矩形或辅助线集合变化**才向 chrome 推一次 `panel:drag-feedback`；chrome 用 `transform/width/height` 直接改 DOM（跟随框 + 1px 辅助线），React 零 setState
4. `pointerup` → `widget-drag-end` → 提交矩形、`persist(true)` 立即落盘

**整块面板的移动/缩放同样是主进程驱动**（`window-drag-begin` / `window-drag-end`）：

> 不要用 `-webkit-app-region: drag`。该区域的**右键不会触发 `contextmenu`**，而面板的「添加组件」入口正是空白处右键。空白层因此改为普通 `pointerdown` 启动窗口拖动，边缘 8px 手柄启动窗口缩放，两者与组件拖动共用同一套 tick 与看门狗。

拖动期间**必须隐藏本面板全部插件原生视图**：原生 view 在 OS 层截走指针，被拖组件经过其它组件时会让 chrome 丢失 `pointerup` 而卡死。隐藏由 `PanelManager.syncPanelVisibility` 单点管理（拖动 / 覆盖层两条路径共用），`PluginHost.panelSuppressed` 记录抑制集合并参与 `isPanelPlacementVisible` 判定，因此 `did-finish-load`、`activatePlugin` 等路径不会越过隐藏意图把视图放回。看门狗 30s 无 chrome 输入即安全收尾，避免视图永久隐藏。

红线（写进了模块头注释，改动时遵守）：

- 拖动中**不** `addChildView`/`removeChildView`/`raiseTransientViews`（仅 drag-begin 提一次 z）
- 拖动中**不**改 `alwaysOnTop`/`setVibrancy`/`setBackgroundMaterial`
- 渲染层**不**逐帧上报矩形（`panel:drag-tick` 只是保活/触发信号）
- 持久化防抖 400ms；窗口拖动期间 `onGeometryChanged` 直接返回，落定后统一提交一次

**覆盖层（右键菜单 / 组件选择器）**：同样会隐藏全部组件视图（`overlay-open` / `overlay-close`），否则原生视图会盖住菜单导致点不到。错误/休眠态的组件没有原生视图，其重试按钮用 `pointer-events: auto` 覆盖 `.panel-widget-body` 的 `none`。

**跨窗口拖入**：Tab / 独立窗口 → 面板，走现有 `pluginWindowDrag`。面板 chrome 经 `PluginDragTargets` 注册一个覆盖内容区的 drop target（`kind:'panel'` + `panelId`），作用是让 `broadcast` 把拖拽反馈推给面板做落点高亮；命中判定本身由 `hitAt` 按「命中的窗口是不是面板窗口」直接完成（`getPanelIdForWindow` + `getPanelSurfaceBounds`），命中后 `endPluginWindowDrag` 调 `PanelManager.dropPluginIntoPanel(panelId, pluginId, localPoint)`。

**组件移出面板（v1 方式）**：组件拖动被 clamp 在面板内容区内，不支持「拖出边界变独立窗口」；移出面板的入口是双击组件条（移回主窗 Tab）、组件条 `⋯` 菜单（移回主窗 / 移除组件）与右键菜单。若后续要做拖出即 detach，需要在 `dragTick` 里检测指针离开面板并转入 `detachPlugin`，届时再更新本节。

## 6. 对齐辅助线

`computeSnap(candidate, others, panelSize, { threshold=6, movable })`：

- 候选线：其它组件的边与中心 + 面板四边与两条中心线
- move：三条边都可吸附；resize：只有被拖的边参与
- 同时最多一横一竖两条线；输出 `{ rect, guides[] }`，`guides` 带 `from/to` 可视区间（chrome 画 1px 实线，颜色 `--accent`）
- 落位算法：`findFreeSlot` 按 8px 网格行扫描第一个空位；拖入用 `rectAtPointer`（以指针为中心 + 吸附）

## 7. 恢复与开关

启动（`index.ts`，仅当 `freePanel.enabled`）：

1. `restorePanels()` 读 `panels` 段 → `resolveRestoreBounds`（显示器丢失回落主屏居中）→ **先建窗口+chrome 显示占位**
2. 组件进 `restoreQueue`，**2 并发 worker** 冷启动（照 detached 恢复节流），chrome 显示「加载中」状态条
3. 失败保留记录（status=error），可重试；不静默删用户布局

开关切换（`shell:set-settings` 检测 `generalPatch.freePanel` → `syncFreePanelSetting`）：

- 开启：注册快捷键 + `restorePanels()`
- 关闭：注销快捷键 + `closeAllPanels(true)` —— 释放全部插件运行时但**保留** `panels` 记录

## 8. 材质映射

| material | macOS | Windows | 其他 |
|---|---|---|---|
| none | 无 vibrancy | `none` | 无（CSS 纯色底板） |
| blur | `under-window` | `acrylic` | CSS 底板兜底 |
| system | `hud` | `mica` | CSS 底板兜底 |

CSS 的 `backdrop-filter` 只作为非 macOS/Windows 的降级；macOS/Windows 用原生窗口材质（Electron 原生模糊才能采样桌面背景）。

## 9. 常量

`@shared/types/panel`：组件条 26px、组件内缩 4px（也是缩放手柄热区）、组件最小 200×140、默认 360×280、面板最小 320×240、24 组件/面板、8 面板、吸附阈值 6 DIP、网格 8 DIP。

## 10. 验证清单（需 GUI 实测，AI 不自动跑）

1. 开关：通用页开启 → 快捷键/按钮框选 → 面板出现
2. 右键添加组件 → 选择器列表正确（已安装、启用、不在别的面板）
3. Tab 拖入面板、独立窗口拖入面板、拖出面板变独立窗口、双击组件条移回主窗
4. 组件拖动/缩放：对齐辅助线出现、吸附跟手；拖动时插件内容实时跟随（无黑块/撕裂）
5. 材质卡：三档材质 + 不透明度实时生效；重开后保持
6. 重启：面板位置与组件布局恢复；组件逐个出加载态再变内容
7. 静置 >3 分钟：面板组件不空白（休眠免疫）
8. 关面板 / 关开关：插件运行时释放（进程/内存回落），布局保留（关开关场景）
