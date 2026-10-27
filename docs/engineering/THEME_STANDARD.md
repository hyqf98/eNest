# 主题与工作区扩展标准

更新：2026-10-24。本文是宿主侧主题、Workspace 与隔离设置页面的现行标准；插件作者以[主题包规范](../site/plugin/themes.md)、[工作区协议](../site/plugin/home.md)和[设置与窗口边界](../site/plugin/settings-and-windows.md)为入口。旧五主题与业务插件批量适配计划已废弃，决策沿革见 [任务记录](../TASK_STATES/eNest-default-theme-restoration-2026-10-19.md)。

## 固定边界

- 安装包只保留一套 eNest 默认主题 `enest.builtin / default`，含浅色和深色；删除的旧主题不能重新出现在列表。
- 新安装直接加载源码内置主题与启动动画，不显示主题选择向导，也不维护首启完成标记。后续恢复有效的插件主题选择；主题仍可在设置中切换。启动恢复轻量 Tab 状态，但落地页始终为主题目录。
- 完整主题工作区接管目录、已安装和详情布局。宿主拥有会话、设置入口、窗口几何、受控动作和安全门禁的管理权；第三方可通过独立 chrome 标准替换会话导航呈现，通过 V2 `settingsPage` 替换安全设置呈现，不能隐藏可信控制与恢复入口。classic 顶部标签与 orb 左侧圆轨互斥，切换只改变导航呈现，不关闭或丢失会话；orb 模式保留窗口控制和标题栏拖拽区。
- 主题外观属性以 Schema 为权威。默认设置界面在主题 Tab 编辑；通用页不重复渲染字体、颜色、背景或动画。全局导航 `tabStyle/tabOpacity/tabAutoHide` 是例外：通用页写宿主默认 Profile，解析时不接受第三方主题覆盖，不写 `general.tabStyle` 或额外外观 store。主题参数展示时过滤这三个兼容绑定。默认主题 Tab 固定为两张卡：先「切换主题」，后「主题参数」；切换主题后参数卡整体替换，不残留上一主题控件。
- 字段 schema、持久化和校验永远由宿主拥有，不将第三方 HTML、CSS、JS 或 CSS 选择器注入可信设置 DOM。默认主题的通用表单消费字段 `presentation`、选项 `preview` 和 pack `palettes`；第三方需要不同 DOM 时使用受限 `settingsPage`，只消费宿主发布的简单字段描述符，不获得原始设置或可信页面权限。
- 原生权限确认、账户凭据、文件/网络路径、快捷键授权、调试工具和现有插件私有设置保留可信面板。它们不是可替换的主题代码。
- 通知支持安全语义样式扩展，不允许主题控制来源、内容、关闭、计时、位置或原生堆叠。
- 标题栏收起规则必须限定到 `header.titlebar`，不能隐藏 `.app` 根节点。背景透明度只作用于材质层，窗口按钮和文字保持不透明。原生插件/Home 内容始终保留 8px shell 唤出区；展开恢复 36px，DOM 网格与原生边界必须同步，主进程只接受当前主窗发出的请求并重排 current/preparing Home。
- 设置内容在标题栏下方的 stage 内滚动，不跨到标题栏背后，也不额外叠加 36px 页内留白。标题栏 0% 背景透出全局主题背景。设置卡片的磨砂只在独立伪元素层绘制，默认 20px 模糊配合半透明主题表面，不给整页或控件祖先叠加 backdrop-filter；保留深色、低动画档、减少透明度和高对比度降级。

## Quick 主题呈现边界

ThemePackV2 可声明 `quick: { version: 1, entry }`，未声明时保留源码内置默认 Quick。默认主题的界面、名称与拼音匹配、内容匹配、排序、最近使用权重、推荐、结果分组及其记录/保留/关键词学习/旧模型解释位于 `src/renderer/themes/default/quick/`；第三方主题通过同一 `enestQuick` 契约替换呈现和检索策略。宿主只提供安全目录、通用插件搜索来源、原生图标、启动校验及成功事实、输入与窗口生命周期和有界提供者私有 JSON 存储，不在主进程执行默认检索或历史策略。目录项的 `id` 是当次查询的不透明启动句柄，`stateKey` 是不可用于启动的稳定 HMAC 身份；主题提交携带 `catalogRevision/queryRevision` 的 `results` 来选择和排列目录，不能提交路径或启动载荷。目录不再带宿主计算的使用次数、上次使用时间或关键词偏好。未提交 `results` 的旧 V1 自绘页面兼容默认主题的检索策略和该默认主题自己的状态，首次有效提交后由第三方独占策略；切换提供者不共享历史。

第三方 Quick 的 `state.read()/state.write(value, expectedRevision)` 仅访问当前原生选中 `source + packId` 的私有 JSON；无手势要求，不访问其它主题、全量设置或旧模型。存储按 revision 做 CAS；只接受有界纯 JSON（深度≤20、节点≤10000，完整记录≤128KiB），禁止危险对象键。失效提供者 key 不能跨代次读写，卸载来源时删除其命名空间。默认主题通过可信控制器访问固定内置命名空间，首次写入前仅向该可信提供者转交完整旧 Quick 配置备份，由主题解释与转换旧身份；原备份不被删除。成功启动的 `opened` 回执只含 stable key/时间及受限查询，不在固定、返回、Tab 或失败动作上生成。

页面无同源权限，无普通插件／壳 API，当前主题包资源使用独立 `enest-quick` 协议；请求、子帧导航、重定向、下载和消息代次分别校验。执行类动作核对真实原生输入的一次性许可，而不信任主题提交的键盘或手势字段。超时或异常回退内置，不改用户主题选择。业务插件模式页面只占 64px 输入区；文件投递、插件输入代次和原生视图仍由宿主管理。粘贴图片/文件上下文由主进程按会话预算保管，`snapshot.input` 仅发布不透明 id 与不超过 64KB 的缩略图，主题经手势授权的 `paste`/`input-clear` 动作请求读取或移除；启动载荷由宿主直接组装进插件 `onEnter.input`，主题不经手字节、路径或启动数据。

普通主题样式台是可关闭的插件会话，关闭不释放同 ID 的 Home 视图或共享开发资源，也不改变活动主题。只有显式设置选择主题触发激活事务。详见插件作者[主题规范](../site/plugin/themes.md)。

## 设置主题呈现边界

默认设置页、专用组件和 CSS 已归入 `src/renderer/themes/default/settings/`，原组件路径仅保留兼容 facade。`SettingsSurfaceController` 负责选择当前提供者；源码内置主题使用可信默认适配器，第三方 V2 包可声明 `settingsPage: { version: 1, entry }`。没有声明时使用默认界面；第三方加载失败或 8 秒内未 ready 时显示恢复入口，可信「系统与安全设置」始终可达，不改用户当前主题选择。

第三方页面使用无同源权限的 `sandbox="allow-scripts"` iframe、当前包专属 `enest-settings` 协议和 `window.enestSettings`。API 只有 `ready/getState/onState/action`，快照只有安全外观、locale、分组与简单字段描述符、原生入口描述符。字段使用当前提供者的不透明句柄；`set` 不能提交设置键、插件 ID 或路径，`native` 只能选择宿主发布的分组。状态读取不需要伪造用户动作；写入和原生跳转必须绑定当前可见、聚焦页面的真实原生一次性输入，隐藏、换主题、代次变化、过期或合成事件不能恢复资格。

其它插件的字段默认不跨桥。只有已启用插件显式逐项声明 `shareWithThemes: true` 的简单 `switch/select/number/color` 类字段才进入描述符，显示 `confirmation: true`；每次跨插件写入经原生确认，并在确认后重校 owner、build、schema、当前值、可见性和活动代次。文本、密钥、路径、账号、授权表、开发管理及未公开插件值不发布；`page` 项仍是原生入口中的插件自绘路由，不转化成任意 URL。

媒体与字体导入、主题选择、账户、权限、系统/代理路径、原生快捷键、开发装载与性能采样继续走可信入口。页面不得创建弹窗、导航子框架、访问网络或借 Workspace 取得完整设置。HTML 和依赖必须进入标准构建发布链并验证安全路径、无符号链接与无源码泄漏。公开参数和示例见[设置与窗口边界](../site/plugin/settings-and-windows.md)。

## 代码责任表

| 层 | 路径 | 唯一职责 |
| --- | --- | --- |
| 主题契约 | `src/shared/types/appearance.ts` | ThemePackV2、Schema、Profile、ResolvedAppearance |
| 隔离呈现契约 | `src/shared/types/quickTheme.ts`、`themeSettings.ts` | Quick 安全目录与结果投影、设置描述符与受限动作 |
| 工作区契约 | `src/shared/types/workspace.ts`、`home.ts` | `catalog/detail` 路由、ACK、安全数据与受控动作；已安装由主题本地筛选 |
| 纯模型 | `src/shared/theme/appearance.ts` | 校验、迁移、字段补丁、解析、语义 CSS 变量；`presentation`/`preview`/`palettes` 的取值与兼容性规则 |
| 渲染提示 | `src/shared/theme/settingsPresentation.ts` | 把声明的 `presentation` 与选项 `preview` 解析成宿主控件形态，未声明时按语义推断 |
| 氛围配色库 | `src/shared/theme/defaultTheme/backgroundPalettes.ts` | 内置 8 套配色、pack 声明配色合并、安全画法白名单 |
| 源码内置主题包 | `src/shared/theme/defaultTheme/package.ts` | 编译内置 contributes.themePacks + homePages、完整外观和动态字段；注册表启动直接加载，磁盘只存第三方主题 |
| 持久化权威 | `src/main/theme/appearanceService.ts` | 原子切换、revision、失败回滚、广播 |
| 用户资源 | `src/main/theme/appearanceResources.ts` | 宿主选择器、受控副本、字体/媒体引用与导入归属检查 |
| 工作区生命周期 | `src/main/home/HomeSurfaceManager.ts` | 候选加载、ready、路由 ACK、可见性、故障隔离及销毁 |
| 安全数据 | `src/main/home/homeDataService.ts` | 公开目录/详情/搜索、受控动作和脱敏快照 |
| 桥接 | `src/preload/homePreload.ts`、`src/main/home/homeIpc.ts` | 角色/代次验证，`enestWorkspace` 与兼容别名 |
| 默认主题页面 | `src/renderer/themes/default/workspace/`、`quick/`、`motion/`、`src/renderer/homeClient.ts` | 市场、卡片、轮播、详情与 Quick 的布局、检索策略和动效；工作区通过受限 bridge 获取数据，DEV 市场预览单列 workspace/preview 且不进入发布构建 |
| 默认设置 UI | `src/renderer/themes/default/settings/` | 完整默认设置页与专用组件/CSS，通用 Schema 表单、草稿和错误态；旧组件路径只作 facade |
| 设置控制器与安全桥 | `src/renderer/components/SettingsSurfaceController.tsx`、`src/main/theme/themeSettingsSurface.ts` | 选中主题提供者、隔离入口、描述符/字段句柄、原生输入与确认、可信回退 |
| 原生全局导航 | `orbRailViews.ts`、`TitleBar.tsx`、`TabStrip.tsx` | 圆轨含末尾设置，经典含头像 dock，两模式互斥，共享会话与门禁 |
| 启动画面 | `Splash.tsx`、`themes/default/DefaultThemeSplash.tsx`、`PaperSplash.tsx`、`motion/splashMotion.ts` | 宿主保留门禁适配器，默认主题拥有实际开屏与语义预设呈现，保留 ready/ACK 交接和清理 |
| 壳/恢复 UI | `App.tsx`、`HomeRecovery.tsx`、`SettingsPage.tsx` | 默认启动动画交接、故障恢复与设置容器入口；没有首启选主题页 |
| 消费者 | `useAppearance.ts`、`appearanceDom.ts`、`resolveThemeCss.ts` | 应用同一外观结果，不重新计算胜出的主题 |

跨目录导入使用已有 `@main/@preload/@renderer/@shared` 别名。新增业务设置通过宿主插件设置桥声明，不直接写 Workspace UI。新增主题不要改宿主 `if (themeId)`，不要重新引入可写的 `useTheme/useFont/useBackgroundEffect` store。`splash.type: 'paper'` 是可复用的宿主纸页描线预设，所有主题均可声明；不执行主题脚本，不按插件 ID 分支。

默认主题的真实设置/Workspace/Quick/开屏专属样式也归 `themes/default/`；公共 `app.css`、`backgroundEffect.css`、`appearance.css` 仅作保序 import 入口。窗口几何与命中区、共享基础控件、Markdown、背景渲染及 detached 标准材质可保持共享。拆分必须保留级联顺序和 specificity，不把物理归属变化声称为懒加载或内存优化；本轮归属与保序证据见[迁移收尾记录](PLUGIN_MIGRATION_CLEANUP_2026-10-24.md)。

## 工作区状态与事务

`homePages` 是既有贡献入口，名称保留以兼容 manifest；新工作区仍由同一个独立 WebContentsView 承载，不复制另一套 SurfaceManager。

```text
发现 manifest → 绑定 source → 激活主题候选
  → 解析并加载隔离入口 → ready(workspaceVersion=1, routes)
  → navigate(当前 route, requestId, generation) → 页面数据与 DOM 就绪 → ACK
  → 持久化主题/profile → 提交候选 → 销毁旧实例

加载/ACK/持久化失败 → 保留或恢复已确认状态 → 隐藏失效原生层 → 可信恢复
```

两个宿主内容路由为 `catalog`、`detail(pluginId)`。目录是单一表面：市场/已安装切换、分类筛选、搜索范围与滚动位置属于提供者视图状态，不得声明为路由，也不得为此调用 `navigate`；提供者自行持久化这类偏好。会改变宿主可见状态或需跨崩溃/换主题恢复的导航（目录、详情）必须经宿主动作。设置入口统一使用 `openSettings`，由宿主隐藏 Workspace 并切到原生设置视图，不是第三个工作区路由。不能用 URL 代替受控路由，不能提交 arbitrary method/channel。

`ready` 只证明脚本初始化完成；ACK 才证明当前路由已渲染。宿主只接受匹配 requestId/generation 的 ACK。同一已显示实例内部导航保留原生画面，不在等待 ACK 时先隐藏；可见性与操作资格分离，导航启动递增活动代次，导航期间拒绝管理动作，迟到或过期确认不能恢复操作资格。初次呈现及不同提供者候选仍须隐藏等待加载和 ACK，失败仍进入可信恢复。

原生 Home 底色在创建及外观同步时取当前主题的实色背景，不使用 Chromium 默认白色。确认弹层保持透明画布，订阅就绪只发送状态；renderer 在 Portal 内容和主题提交后回传弹层 ID/外观 revision，宿主验证一致才显示并允许响应。共享等待屏障兼容隐藏视图暂停 rAF，不放宽权限或用任意延时替代就绪。

更新普通外观参数复用当前实例；提供者替换后撤销 IPC 信任、协议会话、监听与短期句柄。隐藏/显示具有活动代次，隐藏前发出的设置操作不会在重新显示后自动恢复权限。

## 启动与缓存

- 设置和主题注册表在主进程启动时加载，之后读取内存；`appearanceService` 保留按内容和深浅模式划分的解析缓存。一次快照请求只读取一次输入，复用本次注册表列表，最后一次 clone 后深冻结；不是把授权资源或完整设置另存到客户端缓存。
- Home IPC 注册后直接隐藏预热同一个工作区，与壳配置读取、内置启动动画及轻量会话恢复并行，不依赖首次确认。内置声明始终来自编译包，首次启动不读取插件仓主题文件；有有效第三方主题时仍恢复其配套工作区。
- 进入首页必须等候加载、`ready`、首个目录路由 ACK、事务提交和开屏退出。慢加载时保留已经完成的 Logo，不另显示「准备首页」页；低动画档和减少动态效果同样遵守就绪门禁。
- 正式显示直接复用预热实例，合并并发初始化，不重载一次首页。主题失败时等待配套默认主题回退，失败不可用时才显示可信重试入口。自动预热不得解除安全设置的恢复锁。
- 原生全局导航投影由 `App` 的启动/开屏预览门禁统一启停，classic 与 orb 互斥显示原生导航。默认 orb 圆轨固定首页为首项，插件会话及贡献入口居中，头像与设置合并为同一个末项；不另显示左下角头像或 dock，也不为其预留圆轨高度。默认 classic 将同一个头像设置入口放在左下角，无头像侧签、收起动画或透明折叠命中区。仅可信默认适配器可只读宿主缓存头像，未登录或图片失败使用人物占位或用户名首字；第三方 chrome 快照不包含账户资料。开屏、预览、原生模态和壳卸载显式隐藏导航，不能只暂停同步。会话/独立窗外壳后台恢复，不阻塞已就绪的首页；初次外观水合合并在途读取，会话恢复复用已读取的 ID，后续外观事件仍读取最新 revision。
- 工作区必须能够在隐藏状态完成初始化和路由 ACK；不能等待 `visibility=true` 才声明就绪。可见性只控制后台动效和交互权限。不得通过共享持久分区、跨 generation 快照或提前 ACK 换取启动速度。

## 设置归属与写入

设置只有一个宿主控制的容器，`SettingsPage` 为通用控制器入口，默认呈现由 `DefaultSettingsPage` 提供；选中第三方 `settingsPage` 时使用独立沙箱。Workspace 桥不暴露全量设置或设置读写方法。Schema、范围、显示条件与持久化仍是宿主权威，呈现层按写入结果维护草稿和失败状态，不复制持久化权威。

- 外观字段通过 `updateThemeProfile` 提交字段级补丁，以宿主确认后的 revision 为准。不同主题 Profile 分离，不用整袋旧快照覆盖新字段。
- 全局导航偏好保存在宿主默认 Profile，主题切换只改变语义外观，不改变设置入口和顶部会话的归属。
- 文件和字体由宿主原生选择器导入，发布受控资源句柄；Workspace 不获得绝对路径、自定义字体文件名、凭据或插件私有值。
- `openSettings` 动作及原生账号 dock 都切换到同一设置视图，隐藏底下的 Home/插件原生内容。进入与返回仍由宿主管理。
- 默认设置页分类含动态插件项，超出一行时提供「更多」原地展开并换行展示，支持收起；不能只裁掉超出项或用被内容裁切的浮层代替全部入口。展开/收起只影响导航呈现，不丢失当前选中项。第三方页面保留宿主控制器的系统与安全入口。
- 浏览器 mock 的 MarketPage 是本地预览兼容代码，不是生产工作区旁路；mock API 仅在无原生 bridge 的浏览器预览中按需加载，生产原生方法缺失时拒绝，不静默切换 mock。

## 通知扩展

`ThemeNotificationStyle` 限定 layout、accent、radius、borderWidth、density、shadow；具体枚举和范围以共享校验器、canonical schema 为准。默认 `NotificationHost` 与原生 overlay 使用这些变量。身份、来源、sanitizer、关闭、悬停暂停和剩余时间不随主题变化重置。需要新增样式时同时修改契约、校验、解析、CSS、schema 及生命周期测试，不开放任意 HTML/CSS 作为捷径。

新增 `presentation` 形态或 `preview` 种类时，同样要在一处改全：`src/shared/types/appearance.ts` 的类型、`src/shared/theme/appearance.ts` 的白名单与兼容规则、`src/shared/theme/settingsPresentation.ts` 的解析、`src/renderer/themes/default/settings/ThemeSettingsFields.tsx` / `ThemeSettingChoices.tsx` 的渲染、两份 `pluginManifest.schema.json`、以及对应测试。若要发布到隔离设置页面，还须同时维护 `themeSettings.ts` 与 `themeSettingsSurface.ts` 的安全描述符投影，不因表单支持某类型就自动公开它。任何一环漏改都会让声明通过校验但渲染不出来，或渲染出来但无法保存。

## 兼容与清理规则

过渡版 `warm`、旧四套内置主题和 `legacy-custom` 激活项迁到 `default`；原版所有外观设置恢复到默认 Profile，旧 profile/quarantine/迁移备份不删除。V1 theme API 保留兼容读写入口，新选择器只接受 V2。`layout.variant` 可以是第三方合法语义标记，PluginKit 不硬编码官方主题 ID；第三方自己实现布局消费。

独立主题/字体/背景可写 stores 不恢复。原背景引擎、开屏品牌/图片、GSAP 动画和原页面样式归入源码内置默认主题，设置由同一 Schema 验证，不维护旧固定编辑器的第二份状态。删除代码前检查消费者；主壳恢复适配器、默认主题纯 UI 和有调用者的共享控件属于不同职责，不按文件名相似度合并。

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

第一组覆盖真实应用的直接启动、`catalog/detail` 路由与本地已安装筛选、Schema 字段持久化和重启；相关验收脚本必须跟随当前协议维护，未运行不能称为通过。第二组使用受控贡献夹具验证真实隔离会话、替换/崩溃恢复、原生弹层焦点和回收。它们都不适配或启动现有业务插件；不要把 fixture 通过描述为全量插件验收。

新增主题至少验证：声明发现、浅深模式、Schema字段持久化/重置/升级隔离、切换前后的目录/本地已安装筛选/详情、过期 ACK 拒绝、故障后恢复入口、敏感信息不跨桥、隐藏停帧、通知持续计时及资源释放。原生验收使用临时数据目录，不能用真实用户配置作破坏性测试。

单默认主题和标准契约验证不等于现有业务插件或第三方主题已经兼容。已执行结果与未验证范围只记录在任务状态文件中，不把历史通过数当作当前改动的验收。
