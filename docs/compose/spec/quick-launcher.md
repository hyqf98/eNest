---
feature: quick-launcher
status: delivered
updated: 2026-10-13
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

Quick 打开决策链：显式 container（⌘/Ctrl+Enter 强制主窗）> `settings.pluginLaunch[id].mode` > `'quick'`（跟随入口）。主窗入口恒为 shell，`mode` 仅影响 Quick 打开与热键启动。未安装或禁用的插件不进入可执行搜索结果。

## 搜索

`src/main/launcher/commandIndex.ts` 聚合内置操作、安装插件指令、应用、剪贴板与插件注册的 Quick providers。

- 首次搜索等待初次应用扫描，避免刚打开时误报没有应用。
- 每次呼出默认只有 72px 搜索条。非空关键词才请求并显示结果，清空或仅输入空格会收回面板。
- 结果按常用软件（有使用记录）、其它软件、插件、系统操作分组，无结果的分组隐藏；上下键与 Enter 遵循分组后的可见顺序。
- 右侧分类默认隐藏，由搜索框内的开关展开；搜索框同步收短，低 / 中 / 高档都有过渡。单独展开或选择分类不会显示空查询面板。
- 类别过滤（应用 / 插件 / 操作）发生在排序截断前；默认搜索全部类型。
- 首页和 Quick 使用 `@shared/search` 统一 NFKC、大小写、前后及连续空白。多词可分别命中名字、描述和 id。
- 插件 `features[].cmds` 支持精确、前缀与模糊命中；本地应用同时检索系统显示名和应用包别名。
- 应用图标只为返回结果提取并缓存；macOS 通过 NSWorkspace 合批获取真实应用图标。
- 最近使用写入 `general.quickLauncher.recent`（最多 20 项），保留已设置的快捷键和开关。

`quickSearch(query, limit?, kind?)` 中 `kind` 可为 `app | plugin | action`，不传表示全部。最多返回 100 条，渲染层可选择更小的上限。

## 本地应用

| 平台 | 扫描与启动 |
|------|------------|
| macOS | `/Applications`、`/System/Applications`、`~/Applications`，含 Utilities 与 Finder；支持 XML / 二进制 Info.plist；通过系统打开 `.app` |
| Windows | 用户和公共开始菜单 / 桌面；保留 `.lnk` 启动以保留快捷方式参数与工作目录 |
| Linux | XDG 应用目录的 `.desktop`；检索英文名与本地化名；按 Exec 参数启动 |

主进程只允许打开扫描缓存内的应用路径。启动失败不会写入最近使用；Linux 等待进程 spawn 成功，macOS 的 open 回退等待退出状态。

## 窗口与圆角

Quick 使用透明无框 `BrowserWindow` 直接承载搜索页面，不再为搜索页额外挂载带有不透明底色的 `WebContentsView`。HTML 在加载时标记 Quick 表面，让页面画布从首帧起透明；只有搜索及结果容器绘制主题底色，因此圆角外露出的是桌面。窗口保留系统阴影。

默认 72px 搜索条只有一层胶囊轮廓（36px 圆角），输入区域不再叠加底板、内边框或焦点光圈；分类按钮在同一胶囊内展开。结果或插件内容展开后统一使用 20px 圆角。内嵌插件仍使用独立原生 `WebContentsView`，需要对自身裁切，不能依赖父页面的 CSS。

窗口相对当前光标所在屏幕定位，宽高受显示器工作区限制。原生窗口尺寸变更后立刻布局插件区域，渲染层按低 / 中 / 高动画设置提供显隐、选择和交互反馈。

主题、字体、主题包和动画设置沿用主壳子的持久化设置并接收即时更新。

## 插件布局与尺寸

壳子只分配插件内容区，插件控制自己内部的布局、滚动、搜索和用户尺寸偏好。禁止依赖固定 720px 宽度；桌面与 Quick 都应按实际 viewport 响应式渲染。

```jsonc
{
  "window": { "width": 760, "height": 400, "minWidth": 480, "minHeight": 240 },
  "permissions": ["ui.resize"]
}
```

- `width` / `height`：Quick 内嵌时的内容区初始尺寸建议；`minWidth` / `minHeight`：下限建议。主窗尺寸由用户控制。
- `enest.ui.resize({ width?, height? })`、`enest.ui.setHeight(height)`：Quick 即时调整，主窗只记录建议，不强制改变用户的窗口。
- 实际尺寸同时受壳子上限与当前屏幕工作区限制；超出内容由插件内部滚动。
- 尺寸不再由 `body.scrollHeight` 轮询撑大，避免百分比根布局反复增高。
- 固定到主窗或主窗缩放时无需重载，插件可通过 CSS 断点 / ResizeObserver 响应。

### 启动方式传递

壳子把启动方式同步给插件，插件据此在「小窗样式」与「桌面样式」两套入口样式间切换：

- URL query 追加 `?mode=quick|shell`（与既有 `?pid` / `?code` 并列），插件首个脚本可同步读取初始值。
- `onEnter` 载荷增加 `mode: 'quick' | 'shell'`。
- `enest.getLaunchMode()` 返回当前模式（URL 初始值 + 事件实时更新）；`enest.onModeChange(cb)` 订阅变更，同时经 `mode-change` 事件推送 `{ type: 'mode-change', mode }`。
- quick ↔ shell 容器迁移（⌘Enter 固定到主窗等）**不重载页面**；URL `?mode=` 只是初始值，运行时以 `getLaunchMode()` / `onModeChange` 为准。

## 每插件快捷启动（热键 / 触发词 / 冲突接管）

用户可为每个插件配置启动方式覆盖项与快捷启动入口，持久化在 `settings.pluginLaunch[pluginId]`：

```jsonc
{
  "mode": "quick",        // 'quick' | 'shell'，仅影响 Quick 打开与热键启动；缺省 = 跟随入口
  "hotkey": "Alt+T",      // 全局启动热键：按下按该插件启动方式唤起（缺省 quick）
  "aliases": ["待办", "todo"] // 自定义触发词，并入 Quick 搜索索引，与 manifest features[].cmds 等权
}
```

设置 UI 在插件详情弹窗「快捷启动」区。

热键冲突检测走 `shell:probe-launch-hotkey`，返回归属：

- `status`: `'free' | 'system' | 'eNest-quick' | 'plugin-launch' | 'plugin-runtime'`（附 `ownerPluginId` / `ownerLabel` / `hint` / `takeoverable`）。
- 归属链：其它插件启动键 → Quick 当前生效键 → 插件运行时热键（`hotkey.register`）→ 系统。
- 插件启动键 / 插件运行时键冲突可「接管」：经用户确认后顶掉对方；Quick 当前生效键不可接管，引导用户去 Quick 设置改键。
- 保存走 `shell:set-plugin-launch`（带 takeover 标志）。

更多示例见 [插件 UI 标准](../../site/plugin/ui-standard.md)。独立插件仓库的 manifest schema 同步支持这些字段。

## 键盘与焦点

- `↑↓` 跨分组选择，`Enter` 打开，输入法组合期间不误触发打开；空输入不会打开隐藏的旧结果。
- 搜索态 `Esc` 依次清空搜索词、收起分类按钮、取消分类、隐藏 Quick；插件态 `Esc` 返回搜索条。
- `⌘K` / `Ctrl+K` 聚焦顶部搜索框，在原生插件内容获得焦点时也有效。
- `⌘Enter` / `Ctrl+Enter` 将 Quick 内嵌的插件固定到主窗（显式 shell 容器）。
- 插件获得焦点时，由主进程拦截退出与固定快捷键。
- 顶部输入新关键词退出嵌入态并搜索全局；插件内搜索由插件页面自己实现。
- 失焦隐藏而不销毁窗口，再呼出重置为空搜索条；插件内容不自动展开，再次显式打开时可复用保留的页面状态。

## 全局快捷键

持久化在 `general.quickLauncher`：`enabled`、候选 `hotkeys`、唯一 `activeHotkey`。设置页可录制、探测占用并选择生效键。运行时只注册一枚选中快捷键，失败尝试候选并返回真实注册结果；界面不能把失败注册显示为成功。

## 验证

- `node --test src/main/launcher/quickSearch.test.mjs`：初次扫描、统一检索、分类、最近使用与失败行为。
- `npm run typecheck`：主进程 / preload / renderer 的共享契约。
- `npm run build`：应用构建。
- Quick 透明边缘需用真实 Electron 窗口核验：浅色、深色、结果展开与清空后，圆角外的像素 alpha 应为 0，主体应可见。仅 CSS 预览或 `setBorderRadius` 调用成功不能证明原生底板已透明。
- 圆角、原生插件嵌入、跨宿主迁移和快捷键焦点需在真实 Electron 验证。
