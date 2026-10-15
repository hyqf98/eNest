---
feature: quick-launcher
status: delivered
updated: 2026-10-14
---

# Quick Launcher

Quick 是独立于桌面主窗口的快捷启动面板。顶部搜索框沿用首页的搜索语言与主题，支持系统应用、已安装插件和壳子操作；底部可显示结果或承载内嵌插件（quick 容器）。

## 打开行为

插件不再有 manifest `form` 区分，由入口决定渲染容器，用户可为每个插件覆盖启动方式：

| 目标 | 行为 |
|------|------|
| 系统应用 | 通过系统打开扫描结果中的应用，成功后隐藏 Quick；失败保留窗口并提示 |
| 插件（缺省） | 从 Quick 打开 → 在输入条下方挂载插件的原生 WebContentsView（quick 容器） |
| `pluginLaunch[id].mode = 'shell'` | 从 Quick 打开也进主窗 Tab，主窗前置，Quick 收起 |
| ⌘/Ctrl+Enter | 强制固定主窗（显式 container 优先级最高），同一 WebContentsView 迁移，保留插件运行状态 |
| 从主窗打开（市场 / 圆轨 / Tab） | 恒为主窗 Tab（shell 容器），即使该插件之前在 Quick 打开 |
| 重新扫描应用 | 刷新应用索引，保留 Quick 供继续搜索 |

Quick 打开决策链：显式 container（⌘/Ctrl+Enter 强制主窗）> `settings.pluginLaunch[id].mode` > `'quick'`（跟随入口）。主窗入口恒为 shell；插件快捷键使用各条绑定自己的启动位置。未安装或禁用的插件不进入可执行搜索结果。

## 搜索

`src/main/launcher/commandIndex.ts` 聚合内置操作、安装插件指令、应用、剪贴板与插件注册的 Quick providers。

- 首次搜索等待初次应用扫描，避免刚打开时误报没有应用。
- 每次呼出、清空查询或从插件按 Esc 返回时，显示两行常用应用/插件；标准宽度 720px，8 列、16 项，默认总高度 248px。
- 搜索结果使用图标网格，按最佳搜索结果、最佳匹配、匹配推荐及动态搜索分组，保留主进程的组内相关性顺序。
- 输入条在常用、搜索和插件模式下保持统一的高度、字号与控件槽位。分类改变时不挤压输入框。
- 右侧始终显示 eNest 应用图标，点击收起 Quick 并打开主窗口插件市场；旁边的小按钮提供分类或插件迁移操作。底部不显示快捷键说明或技术字段，图标与名称采用紧凑间距。
- 字符串指令、名称及用户别名支持 NFKC、大小写归一、拼音全拼、拼音首字母和英文缩写；精确入口优先于前缀和连续包含。描述仅作为说明展示。
- `regex` 匹配当前输入，`over` 提供任意文本处理入口；匹配类型和原始文本通过插件 `onEnter` 传递。超过 32 字符跳过名称索引，内容匹配继续生效。
- 最近选过的相同搜索词优先展示该入口；偏好有界保存 100 项。静态插件索引仅随安装与别名 revision 失效。
- 名称索引先返回，内容匹配/图标与运行时 provider 并行补齐；旧查询响应不得覆盖新查询，补齐结果按稳定 id 保留当前选中项。
- 应用图标只为返回结果提取并缓存；macOS 优先读取应用包 ICNS 内的原生 PNG，旧格式再通过 NSWorkspace 获取；Windows 保留快捷方式图标，Linux 查询原彩色主题目录。失败短期缓存后可重试，避免永久保留通用占位图。
- 最近使用写入 `general.quickLauncher.recent`（最多 20 项），保留已设置的快捷键和开关。

`quickSearch(query, limit?, kind?, phase?)` 中 `kind` 可为 `app | plugin | action`，不传表示全部。最多返回 100 条，渲染层可选择更小的上限。

## 本地应用

| 平台 | 扫描与启动 |
|------|------------|
| macOS | `/Applications`、`/System/Applications`、`~/Applications`，含 Utilities 与 Finder；支持 XML / 二进制 Info.plist；通过系统打开 `.app` |
| Windows | 用户和公共开始菜单 / 桌面；保留 `.lnk` 启动以保留快捷方式参数与工作目录 |
| Linux | XDG 应用目录的 `.desktop`；检索英文名与本地化名；按 Exec 参数启动 |

主进程只允许打开扫描缓存内的应用路径。启动失败不会写入最近使用；Linux 等待进程 spawn 成功，macOS 的 open 回退等待退出状态。

## 窗口与圆角

Quick 使用透明无框 `BaseWindow`，其内部共享一个原生圆角 `View`，统一裁切壳页面和插件 `WebContentsView`。外轮廓始终为 20px 圆角，输入条与内容连接处保持直边；插件区不能依赖壳页面 CSS 裁切。

宽度统一为 720px。默认呼出与返回首页时为两行常用项，总高度 248px；搜索随内容伸缩，最高 545px，超出部分内部滚动。进入插件后统一展开到 545px：输入区 64px、内容区 480px、底边 1px。插件声明及尺寸上报不改变插件态高度，仅屏幕工作区不足时缩小。

共享父 View 始终展示完整窗口，进入插件时不再从输入栏高度裁切展开。工作区变化时一次性适配原生窗口并重排插件；失焦隐藏保留窗口，重新呼出恢复两行高度。`BaseWindow` 关闭时显式销毁壳 WebContents。

主题、字体、主题包和动画设置沿用主壳子的持久化设置并接收即时更新。

## 插件布局与尺寸

壳子只分配插件内容区，插件控制自己内部的布局、滚动和搜索。禁止依赖固定 720px 宽度；桌面与 Quick 都应按实际 viewport 响应式渲染。

```jsonc
{
  "window": { "width": 760, "height": 400, "minWidth": 480, "minHeight": 240 },
  "permissions": []
}
```

- manifest 的 `window` 尺寸字段保留兼容，不改变 Quick 的固定外框；标准插件视口为 718 × 480px。主窗尺寸由用户控制。
- `enest.ui.resize({ width?, height? })`、`enest.ui.setHeight(height)`：基础能力，保留参数校验和成功返回，不改变 Quick 或主窗尺寸。
- 实际尺寸受当前屏幕工作区限制；超出内容由插件内部滚动。
- 尺寸不再由 `body.scrollHeight` 轮询撑大，避免百分比根布局反复增高。
- 固定到主窗或主窗缩放时无需重载，插件可通过 CSS 断点 / ResizeObserver 响应。

### 启动方式传递

壳子把启动方式同步给插件，插件据此在「小窗样式」与「桌面样式」两套入口样式间切换：

- URL query 追加 `?mode=quick|shell`（与既有 `?pid` / `?code` 并列），插件首个脚本可同步读取初始值。
- `onEnter` 载荷增加 `mode: 'quick' | 'shell'`。
- `enest.getLaunchMode()` 返回当前模式（URL 初始值 + 事件实时更新）；`enest.onModeChange(cb)` 订阅变更，同时经 `mode-change` 事件推送 `{ type: 'mode-change', mode }`。
- quick ↔ shell 容器迁移（⌘Enter 固定到主窗等）**不重载页面**；URL `?mode=` 只是初始值，运行时以 `getLaunchMode()` / `onModeChange` 为准。

## 插件快捷键与搜索偏好

设置 → 快捷键集中管理 Quick 呼出键与插件绑定。插件详情的快捷键入口跳转到此处并筛选当前插件；详情中的搜索启动方式与触发词仍保存为 `pluginLaunch[id].mode/aliases`。

`settings.pluginShortcuts` 是绑定列表，每条为 `{ id, pluginId, accelerator, mode: 'quick' | 'shell', enabled }`。同一插件可以绑定多组组合键，分别直接进入小窗口和主窗口。已有实例保留页面和任务并迁移到绑定位置；已分离的独立窗也按明确绑定收回。原生对话框阻止迁移时提示并保留现状。关闭绑定只暂停全局键，设置页仍可点击“立即启动”。

- 旧 `pluginLaunch[id].hotkey` 在设置加载时迁移一次，沿用旧 mode，缺省 quick；同次删除旧字段。搜索偏好与插件数据保留。
- 专用接口为 `shell:get-plugin-shortcuts`、`shell:save-plugin-shortcut`、`shell:remove-plugin-shortcut`、`shell:probe-plugin-shortcut`、`shell:launch-plugin-shortcut`。普通设置写入不能修改绑定或原生注册。
- 冲突返回 `free | system | quick | shortcut | runtime | invalid` 与占用方，要求换键；不提供接管。等价修饰键统一规范化。
- 运行状态为已生效、已关闭、插件禁用／缺失、冲突、录制期间暂停；单独经 `plugin-shortcuts-changed` 推送，不持久化。注册失败保留原配置和旧键。
- 插件绑定与 Quick 呼出键在确认原生注册后同步提交设置；写盘失败回滚。若旧键已被外部应用占用而无法恢复，撤销未保存的新键并显示冲突，不能报告保存成功。
- 录制通过 `shell:begin-shortcut-capture` / `shell:end-shortcut-capture` 持有主壳文档的临时令牌，暂停本应用三类热键。主键释放后恢复，Esc、失焦、销毁与 30 秒超时都清理。
- 禁用插件保留配置并释放键，启用或重新安装时差量验证；卸载成功删除关联绑定。插件关闭或休眠不释放用户启动键。
- 绑定注册不预加载插件、不轮询；启动服务合并连按、遵从最后位置意图，复用原 WebContentsView。直接小窗启动等待文档就绪并捕获原外部粘贴目标，不先重置搜索列表。

## 键盘与焦点

- `←→` 逐项、`↑↓` 按网格行保留列选择，`Tab` / `Shift+Tab` 跨分组循环，`Enter` 打开。输入法组合及文本选区保留编辑行为。
- 搜索态 `Esc` 依次清空搜索词、收起分类按钮、取消分类、隐藏 Quick；插件态 `Esc` 返回两行常用网格。
- `⌘K` / `Ctrl+K` 聚焦顶部搜索框，在原生插件内容获得焦点时也有效。
- `⌘Enter` / `Ctrl+Enter` 将 Quick 内嵌的插件固定到主窗（显式 shell 容器）。
- 插件获得焦点时，由主进程拦截退出与固定快捷键。
- 顶部输入新关键词退出嵌入态并搜索全局；插件内搜索由插件页面自己实现。
- 失焦隐藏而不销毁窗口，再呼出重置为两行常用项；插件内容不自动展开，再次显式打开时可复用保留的页面状态。

## 全局快捷键

持久化在 `general.quickLauncher`：`enabled`、候选 `hotkeys`、唯一 `activeHotkey`。运行时只注册一枚选中快捷键。用户改键失败时保留旧键与旧配置，启动初始化可尝试既有候选；界面单独展示实际注册结果。Quick 呼出键开关不影响插件绑定。所有全局键要求 eNest 仍在运行，主窗口隐藏到托盘后继续可用。

## 验证

- `node --test src/main/launcher/quickSearch.test.mjs`：初次扫描、统一检索、分类、最近使用与失败行为。
- `npm run typecheck`：主进程 / preload / renderer 的共享契约。
- `npm run build`：应用构建。
- Quick 透明边缘需用真实 Electron 窗口核验：浅色、深色、结果展开与清空后，圆角外的像素 alpha 应为 0，主体应可见。仅 CSS 预览或 `setBorderRadius` 调用成功不能证明原生底板已透明。
- 圆角、原生插件嵌入、跨宿主迁移和快捷键焦点需在真实 Electron 验证。
- 本次统一快捷键设置的实际平台、测试结果、性能口径和未覆盖项见 [插件快捷键验收报告](../../engineering/plugin-shortcuts-validation.md)。
