# 主题与工作区扩展标准

更新：2026-10-22。本文是宿主侧主题与 Workspace 的现行标准；插件作者以[主题包规范](../site/plugin/themes.md)和[工作区协议](../site/plugin/home.md)为入口。旧五主题与业务插件批量适配计划已废弃，决策沿革见 [任务记录](../TASK_STATES/eNest-default-theme-restoration-2026-10-19.md)。

## 固定边界

- 安装包只保留一套 eNest 默认主题 `enest.builtin / default`，含浅色和深色；删除的旧主题不能重新出现在列表。
- 新安装直接加载源码内置主题与启动动画，不显示主题选择向导，也不维护首启完成标记。后续恢复有效的插件主题选择；主题仍可在设置中切换。启动恢复轻量 Tab 状态，但落地页始终为主题目录。
- 完整主题工作区接管目录、已安装和详情布局。顶部会话 Tab、左下角设置按钮、窗口控制和设置页面始终由宿主拥有，不能由第三方页面替换或隐藏。classic 与 orb 都保留顶部会话，圆轨只是附加导航。
- 主题外观属性由 Schema 生成，在主题 Tab 编辑；通用页不重复渲染字体、颜色、背景或动画。全局导航 `tabStyle/tabOpacity/tabAutoHide` 是例外：通用页写宿主默认 Profile，解析时不接受第三方主题覆盖，不写 `general.tabStyle` 或额外外观 store。主题参数展示时过滤这三个兼容绑定。主题 Tab 固定为两张卡：先「切换主题」，后「主题参数」；切换主题后参数卡整体替换，不残留上一主题控件。
- 主题参数表单永远由宿主渲染，这是不变量。主题只能提供数据与声明：字段的 `presentation`（想用哪种控件形态）、选项的 `preview`（缩略图素材或两个安全色）、pack 的 `palettes`（额外氛围配色）。不引入主题提供的 HTML、CSS、JS 或 CSS 选择器，也不给主题一套独立的表单脚本或样式入口。差异化视觉靠素材与声明式提示实现，不靠注入样式。
- 原生权限确认、账户凭据、文件/网络路径、快捷键授权、调试工具和现有插件私有设置保留可信面板。它们不是可替换的主题代码。
- 通知支持安全语义样式扩展，不允许主题控制来源、内容、关闭、计时、位置或原生堆叠。
- 标题栏收起规则必须限定到 `header.titlebar`，不能隐藏 `.app` 根节点。背景透明度只作用于材质层，窗口按钮和文字保持不透明。原生插件/Home 内容始终保留 8px shell 唤出区；展开恢复 36px，DOM 网格与原生边界必须同步，主进程只接受当前主窗发出的请求并重排 current/preparing Home。
- 设置内容在标题栏下方的 stage 内滚动，不跨到标题栏背后，也不额外叠加 36px 页内留白。标题栏 0% 背景透出全局主题背景。设置卡片的磨砂只在独立伪元素层绘制，默认 20px 模糊配合半透明主题表面，不给整页或控件祖先叠加 backdrop-filter；保留深色、低动画档、减少透明度和高对比度降级。

## Quick 主题呈现边界

ThemePackV2 可声明 `quick: { version: 1, entry }`，未声明时保留内置 Quick。隔离页面只绘制小窗表面，通过 `enestQuick` 接收当次显示快照和受限动作，搜索、结果合并、启动、焦点、原生尺寸、业务视图仍由宿主掌握。页面无同源权限，无普通插件／壳 API，当前主题包资源使用独立 `enest-quick` 协议；请求、子帧导航、重定向、下载和消息代次分别校验。执行类动作核对真实原生输入的一次性许可，而不信任主题提交的键盘或手势字段。超时或异常回退内置，不改用户主题选择。业务插件模式页面只占 64px 输入区。

普通主题样式台是可关闭的插件会话，关闭不释放同 ID 的 Home 视图或共享开发资源，也不改变活动主题。只有显式设置选择主题触发激活事务。详见插件作者[主题规范](../site/plugin/themes.md)。

## 代码责任表

| 层 | 路径 | 唯一职责 |
| --- | --- | --- |
| 主题契约 | `src/shared/types/appearance.ts` | ThemePackV2、Schema、Profile、ResolvedAppearance |
| 工作区契约 | `src/shared/types/workspace.ts`、`home.ts` | 三种内容路由、ACK、安全数据与受控动作 |
| 纯模型 | `src/shared/theme/appearance.ts` | 校验、迁移、字段补丁、解析、语义 CSS 变量；`presentation`/`preview`/`palettes` 的取值与兼容性规则 |
| 渲染提示 | `src/shared/theme/settingsPresentation.ts` | 把声明的 `presentation` 与选项 `preview` 解析成宿主控件形态，未声明时按语义推断 |
| 氛围配色库 | `src/shared/theme/defaultTheme/backgroundPalettes.ts` | 内置 8 套配色、pack 声明配色合并、安全画法白名单 |
| 源码内置主题包 | `src/shared/theme/defaultTheme/package.ts` | 编译内置 contributes.themePacks + homePages、完整外观和动态字段；注册表启动直接加载，磁盘只存第三方主题 |
| 持久化权威 | `src/main/theme/appearanceService.ts` | 原子切换、revision、失败回滚、广播 |
| 用户资源 | `src/main/theme/appearanceResources.ts` | 宿主选择器、受控副本、字体/媒体引用与导入归属检查 |
| 工作区生命周期 | `src/main/home/HomeSurfaceManager.ts` | 候选加载、ready、路由 ACK、可见性、故障隔离及销毁 |
| 安全数据 | `src/main/home/homeDataService.ts` | 公开目录/详情/搜索、受控动作和脱敏快照 |
| 桥接 | `src/preload/homePreload.ts`、`src/main/home/homeIpc.ts` | 角色/代次验证，`enestWorkspace` 与兼容别名 |
| 默认主题页面 | `src/renderer/themes/default/`、`src/renderer/homeClient.ts` | 市场、卡片、轮播和详情布局与动效，通过受限 bridge 获取数据 |
| 原生设置 UI | `SettingsPage.tsx`、`AppearanceSettingsSection.tsx`、`ThemeSettingsFields.tsx` | 唯一设置页面，按主题 Schema 生成外观字段，提交宿主 Profile |
| 原生全局导航 | `orbRailViews.ts`、`TitleBar.tsx`、`TabStrip.tsx` | 设置 dock 独立于圆轨，顶部会话保留，统一门禁及层级 |
| 启动画面 | `Splash.tsx`、`PaperSplash.tsx`、`splashMotion.ts` | 按 splash 语义预设渲染，保留 ready/ACK 交接和清理 |
| 壳/恢复 UI | `App.tsx`、`HomeRecovery.tsx`、`SettingsPage.tsx` | 默认启动动画交接、故障恢复、可信宿主设置；没有首启选主题页 |
| 消费者 | `useAppearance.ts`、`appearanceDom.ts`、`resolveThemeCss.ts` | 应用同一外观结果，不重新计算胜出的主题 |

跨目录导入使用已有 `@main/@preload/@renderer/@shared` 别名。新增业务设置通过宿主插件设置桥声明，不直接写 Workspace UI。新增主题不要改宿主 `if (themeId)`，不要重新引入可写的 `useTheme/useFont/useBackgroundEffect` store。`splash.type: 'paper'` 是可复用的宿主纸页描线预设，所有主题均可声明；不执行主题脚本，不按插件 ID 分支。

## 工作区状态与事务

`homePages` 是既有贡献入口，名称保留以兼容 manifest；新工作区仍由同一个独立 WebContentsView 承载，不复制另一套 SurfaceManager。

```text
发现 manifest → 绑定 source → 激活主题候选
  → 解析并加载隔离入口 → ready(workspaceVersion=1, routes)
  → navigate(当前 route, requestId, generation) → 页面数据与 DOM 就绪 → ACK
  → 持久化主题/profile → 提交候选 → 销毁旧实例

加载/ACK/持久化失败 → 保留或恢复已确认状态 → 隐藏失效原生层 → 可信恢复
```

三个内容页面为 `catalog`、`installed`、`detail(pluginId)`。页面内导航必须经宿主动作，以便换主题后恢复正确页面。设置入口统一使用 `openSettings`，由宿主隐藏 Workspace 并切到原生设置视图，不是第四个工作区路由。不能用 URL 代替受控路由，不能提交 arbitrary method/channel。

`ready` 只证明脚本初始化完成；ACK 才证明当前路由已渲染。宿主只接受匹配 requestId/generation 的 ACK。更新普通外观参数复用当前实例；提供者替换后撤销 IPC 信任、协议会话、监听与短期句柄。隐藏/显示具有活动代次，隐藏前发出的设置操作不会在重新显示后自动恢复权限。

## 启动与缓存

- 设置和主题注册表在主进程启动时加载，之后读取内存；`appearanceService` 保留按内容和深浅模式划分的解析缓存。一次快照请求只读取一次输入，复用本次注册表列表，最后一次 clone 后深冻结；不是把授权资源或完整设置另存到客户端缓存。
- Home IPC 注册后直接隐藏预热同一个工作区，与壳配置读取、内置启动动画及轻量会话恢复并行，不依赖首次确认。内置声明始终来自编译包，首次启动不读取插件仓主题文件；有有效第三方主题时仍恢复其配套工作区。
- 进入首页必须等候加载、`ready`、首个目录路由 ACK、事务提交和开屏退出。慢加载时保留已经完成的 Logo，不另显示「准备首页」页；低动画档和减少动态效果同样遵守就绪门禁。
- 正式显示直接复用预热实例，合并并发初始化，不重载一次首页。主题失败时等待配套默认主题回退，失败不可用时才显示可信重试入口。自动预热不得解除安全设置的恢复锁。
- 原生全局导航投影由 `App` 的启动/开屏预览门禁统一启停。设置 dock 与 orb 圆轨可见性解耦；classic 也显示 dock。开屏、预览、原生模态和壳卸载显式隐藏相关浮层，不能只暂停同步。会话/独立窗外壳后台恢复，不阻塞已就绪的首页；初次外观水合合并在途读取，会话恢复复用已读取的 ID，后续外观事件仍读取最新 revision。
- 工作区必须能够在隐藏状态完成初始化和路由 ACK；不能等待 `visibility=true` 才声明就绪。可见性只控制后台动效和交互权限。不得通过共享持久分区、跨 generation 快照或提前 ACK 换取启动速度。

## 设置归属与写入

设置只有原生 `SettingsPage`，Workspace 桥不暴露全量设置或设置读写方法。主题只声明字段、范围、显示条件与渲染提示；宿主负责控件、草稿、持久化和失败回滚。

- 外观字段通过 `updateThemeProfile` 提交字段级补丁，以宿主确认后的 revision 为准。不同主题 Profile 分离，不用整袋旧快照覆盖新字段。
- 全局导航偏好保存在宿主默认 Profile，主题切换只改变语义外观，不改变设置入口和顶部会话的归属。
- 文件和字体由宿主原生选择器导入，发布受控资源句柄；Workspace 不获得绝对路径、自定义字体文件名、凭据或插件私有值。
- `openSettings` 动作及原生设置 dock 都切换到同一设置视图，隐藏底下的 Home/插件原生内容。进入与返回仍由宿主管理。
- 浏览器 mock 的 MarketPage 是本地预览兼容代码，不是生产工作区旁路；SettingsPage 则是生产唯一设置 UI。

## 通知扩展

`ThemeNotificationStyle` 限定 layout、accent、radius、borderWidth、density、shadow；具体枚举和范围以共享校验器、canonical schema 为准。默认 `NotificationHost` 与原生 overlay 使用这些变量。身份、来源、sanitizer、关闭、悬停暂停和剩余时间不随主题变化重置。需要新增样式时同时修改契约、校验、解析、CSS、schema 及生命周期测试，不开放任意 HTML/CSS 作为捷径。

新增 `presentation` 形态或 `preview` 种类时，同样要在一处改全：`src/shared/types/appearance.ts` 的类型、`src/shared/theme/appearance.ts` 的白名单与兼容规则、`src/shared/theme/settingsPresentation.ts` 的解析、`src/renderer/components/ThemeSettingsFields.tsx` / `ThemeSettingChoices.tsx` 的渲染、两份 `pluginManifest.schema.json`、以及对应测试。任何一环漏改都会让声明通过校验但渲染不出来，或渲染出来但无法保存。

## 兼容与清理规则

过渡版 `warm`、旧四套内置主题和 `legacy-custom` 激活项迁到 `default`；原版所有外观设置恢复到默认 Profile，旧 profile/quarantine/迁移备份不删除。V1 theme API 保留兼容读写入口，新选择器只接受 V2。`layout.variant` 可以是第三方合法语义标记，PluginKit 不硬编码官方主题 ID；第三方自己实现布局消费。

独立主题/字体/背景可写 stores 不恢复。原背景引擎、开屏品牌/图片、GSAP 动画和原页面样式归入默认插件，设置由同一 Schema 渲染，不维护旧固定编辑器的第二份状态。删除代码前检查消费者；主壳恢复适配器、默认主题纯 UI 和有调用者的共享控件属于不同职责，不按文件名相似度合并。

## 扩展入口与校验

插件作者从 [主题包规范](../site/plugin/themes.md) 和 [工作区协议](../site/plugin/home.md) 开始。SDK 类型从真实源码生成，不手改 `index.d.ts`：

```bash
node eNest_plugin/scripts/generate-api-types.mjs --host-root .
node eNest_plugin/scripts/generate-api-types.mjs --host-root . --check
node eNest_plugin/scripts/sync-developer-docs.mjs --host-root .
node eNest_plugin/scripts/sync-developer-docs.mjs --host-root . --check
npm run typecheck
npm run build
```

原生测试必须在 build 之后串行运行，使用机器上已有 Electron，不安装额外工具：

```bash
ENEST_APPEARANCE_NATIVE=1 node --test --test-concurrency=1 src/main/home/appearanceSurfaces.native.test.mjs
ENEST_HOME_SURFACE_NATIVE=1 node --test --test-concurrency=1 src/main/home/homeSurface.native.test.mjs
```

第一组覆盖真实应用的直接启动与三路由、Schema 字段持久化和重启；相关验收脚本必须跟随当前协议维护，未运行不能称为通过。第二组使用受控贡献夹具验证真实隔离会话、替换/崩溃恢复、原生弹层焦点和回收。它们都不适配或启动现有业务插件；不要把 fixture 通过描述为全量插件验收。

新增主题至少验证：声明发现、浅深模式、Schema字段持久化/重置/升级隔离、切换前后三路由、过期 ACK 拒绝、故障后恢复入口、敏感信息不跨桥、隐藏停帧、通知持续计时及资源释放。原生验收使用临时数据目录，不能用真实用户配置作破坏性测试。

单默认主题和标准契约验证不等于现有业务插件或第三方主题已经兼容。已执行结果与未验证范围只记录在任务状态文件中，不把历史通过数当作当前改动的验收。
