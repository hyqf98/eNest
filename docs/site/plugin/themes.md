# 主题包与动态设置标准

主题是完整外观包，不只是颜色预设。宿主只随包提供一套「eNest 默认主题」（`enest.builtin / default`，浅色与深色是同一个主题的两个模式），其余外观通过插件扩展。首次启动直接加载源码内置主题及其启动动画，首页在后台预热后进入，不再显示选主题或确认页面。后续启动恢复有效的主题选择；第三方主题仍可在设置 → 主题中安装后切换。

## 宿主与主题的边界

- 宿主提供主题选择、浅色/深色/跟随系统、恢复默认、持久化、资源导入、校验和跨窗口同步。
- 默认设置界面的设置 → 主题分为两张卡：上方「切换主题」列出全部已安装主题（内置与插件安装的主题同一列表，选中即切换，预览按当前模式渲染）；下方「主题参数」按当前主题的 `settings.groups[].fields` 动态渲染。切换主题后，参数卡片整体换成新主题支持的字段，不保留上一主题的控件。
- 主题通过 `settings.groups[].fields` 声明内容区域的外观设置。通用设置保留主窗全局导航偏好；宿主拥有会话、窗口几何、受控动作与安全入口，主题可通过 [chrome](chrome.md) 标准替换允许的导航呈现；顶部标签与悬浮圆轨按用户全局选择互斥显示。默认圆轨模式的设置并入末项，左下角头像入口仅默认经典模式显示。主题、字体、背景和动画参数仍在主题 Tab。分组建议收敛到 4–6 组，同类数值微调（圆角、间距、通知尺寸）放在同一组，宿主会把同组连续滑杆合并成一个紧凑调节块。
- 字段类型决定默认表单控件，`binding` 决定语义目标。宿主不按主题 ID 写 `if/switch`，也不将主题脚本或 CSS 选择器注入可信表单；需要不同设置 DOM 时使用可选的隔离 `settingsPage`。
- 字体导入属于 `font` 字段；图片/视频导入属于 `media` 字段。只有声明了字段才显示对应控件。
- 启动画面仍由同一主题 Profile 管理；默认主题恢复品牌背景、主题底色、自定义图片和透明度，不再读取另一套可写的通用外观设置。
- 设置只有一个宿主控制的容器。主题工作区通过 `openSettings` 请求进入；V2 主题可用 `settingsPage` 替换容器内的安全设置呈现，不能读取全量设置、替换原生安全入口或冒充全局导航。默认设置入口按宿主导航样式呈现：圆轨模式依次显示首页、插件会话与贡献入口、末尾头像设置按钮，不另显示左下角头像或设置按钮；头像与设置合并为同一入口。默认经典模式将同一头像设置入口放在左下角，不使用头像侧签隐藏样式。仅可信默认适配器可读取宿主缓存的登录头像，不加载远程 URL；未登录或图片不可用时显示人物占位或用户名首字。第三方 chrome 快照不包含账户资料。“设置”提示只在按钮悬停或键盘聚焦时显示。两种入口均为宿主原生视图，启动画面和原生模态期间隐藏。

主题包、首页贡献使用普通插件的开发、安装与发布流程。`main: "index.html"`、图标、README、截图等必需资产不变；不能以特殊 JSON 包绕过插件规范。

## 源码内置主题包

`src/shared/theme/defaultTheme/package.ts` 使用标准 `contributes.themePacks / homePages` 同时声明默认主题与配套 Workspace，并受公共 manifest 类型和 canonical schema 约束；`builtinThemes.ts` 只把该声明提供给注册表。内置包由宿主编译和加载，不在插件仓发布，也不从可写的 `themes/registry.json` 读取；该文件只保存第三方主题注册数据。随宿主编译的 UI 位于 `src/renderer/themes/default/`：Workspace 通过独立 `home.html` 和受限 `enestWorkspace` 运行，Quick 通过同一可切换提供者契约接入，设置呈现位于 `settings/` 并使用可信默认适配器。这个源码内置适配器不向第三方页面开放主壳 `shellApi`。内置包是安装包内的保底主题贡献，不是需要用户安装或授权的业务插件，也不需要改动现有业务插件。

- 布局恢复原插件市场、搜索、精选轮播、分类目录、已安装卡片、来源卡片展开详情和顶部 Tab 设置页；卡片与详情继续使用原 GSAP 动画。
- 颜色恢复中性灰 / 石墨表面和铜橙强调，浅色、深色、跟随系统以及各语义 Token 微调；透明边框保留 Alpha。
- 五种背景动效为 `fold / aurora / orbit / ripple / tunnel`，默认 `tunnel`；`none` 关闭。原八种渐变是白名单数据，不接受任意 CSS 字符串。
- `background.kind` 选择无、渐变、纯色、图片、视频；`palette` 默认是宿主内置的 `theme / dawn / mint / linen / peach / ocean / forest / ink`，主题也可在 pack 顶层用 `palettes` 追加自己的配色（见下文「自定义氛围配色」），`opacity` 为 0–1，`fit` 为 `cover / contain`。动效与氛围色叠加；图片 / 视频在关闭动效后显示。
- `fonts.latin / cjk` 使用中英双槽，单独修改一槽时保留另一槽的主题默认字体；英文预设不夹带中文兜底。支持字体导入、删除和 0.9–1.3 字号比例；宿主固定字号通过 `--appearance-font-scale` 跟随比例，Quick 使用根字号对应的 rem，均不缩放窗口几何；普通插件仍使用 13px 基准。
- `splash.type` 支持 `brand`（品牌）、`none`（主题底色）、`image`（自定义图片）及 `paper`（纸页描线）。`paper` 是宿主提供的声明式预设，使用当前主题的颜色和标题字体，播放纸页、索引彩条和铅笔描线动画；无需也不允许主题脚本接管启动门禁。其它预设继续沿用统一背景动效编排；关闭动效后，显式启动图片优先于静态氛围色。所有预设都在首页 ready 与路由 ACK 完成后才交接，尊重系统减少动态效果；设置页可重播预览，预览期间隐藏原生 Workspace 和全局导航浮层。

Quick 小窗使用同一 `appearance-changed` 权威快照，隐藏时仍接收更新，首次懒加载先订阅再水合；不能在显示/复开时把旧 `general.animationLevel` 再写入 DOM。配色、字体、背景和内部圆角跟随主题，Quick 外框与输入条几何以及主窗专属 Tab 样式不互相套用。

这些设置都进入同一主题 Profile；`general.fontFamily`、`general.splashBackground` 等旧键仅作为迁移输入，不重新成为另一套实时设置权威。旧本地媒体经宿主转换为受控资源句柄，Workspace 只读句柄，不读取绝对路径。清除字体会同时复位引用该字体的 Profile 项，保留其它主题数据与不可变迁移备份。

## 主题样式台与主题切换

安装主题只登记主题包。打开其普通插件 Tab 用于查看组件样式，关闭或重新打开该 Tab 都不切换已选主题，也不会销毁仍在使用的配套首页。固定首页 Tab 与普通样式台 Tab 的生命周期不同。样式台应从自己的主题包声明读取预览数据，宿主快照最多用于跟随浅色／深色模式；不要为预览调用激活接口后再切回来。

## Quick 自绘页面 V1

在 V2 主题包顶层声明：

```json
{ "quick": { "version": 1, "entry": "quick/launcher.html" } }
```

入口是包内相对 HTML，最长 240 字符，只接受安全 ASCII 路径，不含 URL、点段、反斜杠或 `backend/runtime/node_modules/src/test/tests` 目录。入口和依赖必须随插件构建发布。该声明只随用户显式选择的主题生效；省略声明、页面错误或 8 秒内未就绪时回退内置 Quick，不影响已选主题与业务插件会话。

页面运行在 `sandbox="allow-scripts"`、不含同源权限的隔离 iframe，通过宿主提前注入的 **`window.enestQuick`** 交互。没有普通插件 `enest`、`enestShell`、Node 或任意网络／文件访问能力。脚本、样式和资源使用本包相对路径；不能动态访问其它插件资源。主题能看到当次显示的搜索词、安全目录和插件搜索来源的显示文本，因此不要将此接口解释为不接触用户数据；宿主不公开应用路径、完整设置、原始历史列表、剪贴板载荷或原始启动请求。目录可以包含每项的 `lastUsedTs/useCount/preferred` 偏好元数据、别名、经过校验的内容匹配声明和宿主发布的图标字节。主题决定是否及如何使用它们，不应把这些数据发送到外部。

最小页面脚本（放入包内外部 JS 文件）：

```js
const api = window.enestQuick
const input = document.querySelector('input')
const results = document.querySelector('[data-results]')
const render = state => {
  if (document.activeElement !== input) input.value = state.query
  results.replaceChildren(...state.items.map(item => {
    const button = document.createElement('button')
    button.textContent = item.title
    button.ariaSelected = String(item.id === state.selectedId)
    button.onclick = () => api.action({ type: 'open', id: item.id })
    return button
  }))
  if (!state.plugin) api.action({ type: 'layout', columns: 3, height: Math.min(545, Math.max(248, document.body.scrollHeight)) })
}
input.addEventListener('input', event => {
  if (!event.isComposing) api.action({ type: 'query', query: input.value })
})
input.addEventListener('compositionend', () => api.action({ type: 'query', query: input.value }))
const offState = api.onState(render)
const offFocus = api.onFocus(({ selectAll }) => { input.focus(); if (selectAll) input.select() })
api.getState().then(render)
api.ready()
window.addEventListener('pagehide', () => { offState(); offFocus() }, { once: true })
```

`getState/onState` 提供 `QuickThemeSnapshot`，`onFocus` 请求输入框聚焦。`action` 支持 `query/composition/filter/results/select/open/expand/open-market/open-settings/refresh-apps/retry/hide/plugin-back/plugin-pin/plugin-focus/plugin-detach/layout/key`，完整参数以 SDK 的 `EnestQuickApi` 为准。结果 `id` 是当前目录有效的不透明句柄，不得持久化或用作应用路径；执行仍经过宿主校验。打开、隐藏、固定等动作需要当前真实鼠标或键盘输入，主题自行发送 `key` 不构成授权。`open-market` 打开桌面主窗插件市场，不在小窗加载市场。

上面的最小页面只替换呈现，兼容使用默认主题的检索策略。要接管检索，在 `state.catalog` 上执行自己的匹配、排序与分组，并提交当前版本的句柄投影：

```js
const chooseResults = state => api.action({
  type: 'results',
  catalogRevision: state.catalogRevision,
  queryRevision: state.queryRevision,
  items: state.catalog
    .filter(item => item.title.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()))
    .slice(0, 60)
    .map(item => ({ id: item.id, group: 'matches' })),
})
```

该示例是最小名称匹配，实际主题可实现拼音、内容表达式、最近权重或推荐；内容表达式应在可终止的 Worker 中执行，不能阻塞输入线程。仅在目录／查询版本变化时重新提交，不能每次快照都提交造成反馈循环。首次有效 `results` 后，兼容默认策略停止发布，后续目录与通用插件来源变化仍通过快照到达该主题。未知、重复、过期句柄及过期版本的投影会被拒绝，投影最多 100 项；主题不能通过改标题、组名或顺序改变对应的原生启动目标。`query`、筛选和插件模式切换会退役旧句柄，切换回默认主题不重造另一套查询状态。

原生宽度上限 720px、总高上限 545px，输入区 64px，业务插件内容区 480px；主题报告的 `layout` 列数限定 1–8，最终尺寸仍受屏幕工作区与宿主约束。业务插件模式中主题页面实际只占顶部 64px，不得替换业务插件 DOM。主题需保留输入法、光标与选区语义，输入法开始／结束使用 `composition` 同步，普通输入使用 `query` 同步。接管 `results` 后自行实现方向／Tab 选择并使用 `select`，Enter 可发送 `key` 或打开已选择句柄；旧呈现模式的方向／Tab 可委托 `key` 给默认策略。Esc、Cmd/Ctrl+K 和插件模式的 Cmd/Ctrl+Enter 由宿主保护。布局报告应仅在内容尺寸或列数变化时提交，避免状态更新反馈循环。

## 设置自绘页面 V1

在 V2 主题包顶层声明：

```json
{ "settingsPage": { "version": 1, "entry": "settings/preferences.html" } }
```

入口使用与 Quick 相同的安全相对 HTML 路径规则，必须随构建包发布。它只在用户当前选择的主题中生效；省略声明时使用源码内置默认设置页，页面失败或 8 秒内未 ready 时保留重试与可信原生设置入口，不改变用户主题选择。默认页的布局、专用组件、CSS 在 `src/renderer/themes/default/settings/`，壳设置控制器只负责提供者选择、容器、原生层切换与安全边界。

页面运行在无同源权限的 `sandbox="allow-scripts"` iframe，包内资源经独立 `enest-settings` 协议读取；没有普通插件 `enest`、完整 `shellApi`、Node、网络、文件、弹窗或子框架。唯一公开桥 **`window.enestSettings`** 提供 `ready/getState/onState/action`。快照包含安全外观、locale、分组与 `switch/select/number/color` 字段描述符，以及可请求进入的 `nativeSections`；没有原始设置键、账户、授权表、开发配置、敏感路径或其它插件的私有值。

写入使用 `{type:'set',fieldId,value}`，只能提交当前快照给出的不透明字段句柄；进入原生页面使用 `{type:'native',section}`，section 必须来自快照。两种动作都要求当前活动、聚焦页面中的真实原生一次性操作，合成事件或加载时自动写回不能获取许可。宿主重校 schema、值、当前主题、字段可见性与页面代次；主题必须等待结果处理失败，不维护第二份持久化真值。

其它插件的字段默认不向主题公开。仅对显式声明 `shareWithThemes: true` 的简单通用字段提供显示描述符，跨插件写入每次经过原生确认，确认后再次校验构建、归属、schema、当前值和活动状态。媒体/字体导入、账号、权限、系统路径、开发管理和性能采样仍由可信原生界面处理；自绘页面不能遮挡宿主控制器的「系统与安全设置」入口。完整字段格式、生命周期与最小脚本见[插件自绘设置与窗口边界](settings-and-windows.md)。

## V2 契约

真实类型位于 SDK 的 `ThemePackV2`、`ThemeSettingsSchema`、`ThemeSettingsField`、`ThemeSettingBinding` 和 `ResolvedAppearance`。源码模板是宿主 `src/shared/theme/defaultTheme/package.ts` 中唯一的默认主题；复制结构时必须改为自己的来源和 ID，不能注册 `enest.builtin`。

| 字段 | 作用 |
| --- | --- |
| `schemaVersion: 2` | 完整外观协议版本 |
| `version` | 主题包修订号，正整数 |
| `id / name / description` | 稳定标识、展示名、说明 |
| `source` | 宿主按调用者/manifest 绑定，保留大小写 |
| `mode / tokens` | V1 兼容声明；V2 实际值以两套 `variants` 和宿主模式选择为准 |
| `variants.light / variants.dark` | 两种模式的颜色、字体、控件、背景、布局与动画 |
| `settings` | 动态表单 Schema，自定义参数及其合法范围 |
| `palettes` | 可选，本主题额外声明的氛围配色；id 不得覆盖宿主内置 |
| `home` | 可选配套首页引用；不声明时使用默认首页 |
| `quick` | 可选 `{ version: 1, entry: "quick/launcher.html" }`，在隔离沙箱内自绘 Quick 小窗口；省略或加载失败时使用内置界面 |
| `settingsPage` | 可选 `{ version: 1, entry: "settings/preferences.html" }`，在隔离沙箱内渲染安全设置描述符；原生安全入口不随主题替换 |

每个 variant 都包含：

```ts
const light = {
  tokens: { '--bg': '#f7f4ed', '--surface': '#fffdf8', '--text': '#302c25', '--accent': '#96613e' },
  fonts: { body: '"Avenir Next", "PingFang SC", sans-serif', heading: 'Georgia, "Songti SC", serif', mono: '"SF Mono", monospace', scale: 1 },
  components: { controlRadius: 8, cardRadius: 14, panelRadius: 18, borderWidth: 1 },
  background: { media: null, effect: 'none', texture: 'none', intensity: 0.3, speed: 0.5, direction: 30 },
  layout: { variant: 'studio', tabStyle: 'classic', tabOpacity: 1, tabAutoHide: false, density: 1, gap: 16, sidebarWidth: 280, contentWidth: 1040, columns: 3 },
  notifications: { layout: 'card', accent: 'stripe', radius: 14, borderWidth: 1, density: 1, shadow: 'soft' },
  animation: 'medium'
}
const dark = {
  ...light,
  tokens: { '--bg': '#1b1916', '--surface': '#25211c', '--text': '#f3ede5', '--accent': '#dfa674' }
}
```

`layout.variant` 是主题/首页消费的语义标记，不是宿主内置样式枚举。自定义标记不会自动生成新布局，也不会被强制映射成某个官方主题。需要不同 DOM 结构时，提供自己的首页页面及 CSS；普通业务插件则通过通用布局变量和自身的区域适配处理，不能期待主题任意改写其业务 DOM。

### 声明配置字段

```ts
const settings = {
  version: 2,
  groups: [{
    id: 'workspace', title: '工作区',
    fields: [
      { key: 'accent', label: '强调色', type: 'token', default: '#96613e', binding: { target: 'token', key: '--accent' } },
      { key: 'gap', label: '内容间距', type: 'slider', default: 16, min: 0, max: 32, step: 1, binding: { target: 'layout', key: 'gap' } },
      { key: 'tabs', label: '标签页样式', type: 'select', default: 'classic', options: [{ label: '顶部标签', value: 'classic' }, { label: '左侧圆轨', value: 'orb' }], binding: { target: 'layout', key: 'tabStyle' } },
      { key: 'bodyFont', label: '正文字体', type: 'font', default: light.fonts.body, binding: { target: 'font', key: 'body' } },
      { key: 'media', label: '背景媒体', type: 'media', default: null, binding: { target: 'background', key: 'media' } },
      { key: 'motion', label: '动画强度', type: 'select', default: 'medium', options: [{ label: '低', value: 'low' }, { label: '中', value: 'medium' }, { label: '高', value: 'high' }], binding: { target: 'animation', key: 'level' } }
    ]
  }]
}
const pack = {
  schemaVersion: 2, version: 1,
  id: 'studio', name: '工作室', source: enest.getPluginId(), mode: 'system', tokens: {},
  variants: { light, dark }, settings
}
await enest.theme.register(pack)
```

示例是插件页面脚本，不是可单独发布的 manifest。正式分发建议把等价 JSON 放入 `plugin.json.contributes.themePacks`，宿主安装扫描时即可发现，首次开屏无需先打开插件。运行时 `register` 适合编辑器生成/更新主题，不会自动激活它，也不能用来写宿主设置。

### 控件与绑定

| type | 用途 |
| --- | --- |
| `color` | 跨深浅模式共享的主题颜色参数 |
| `token` | 当前深浅模式的颜色微调，存入 `profile.colors[mode]` |
| `slider` | 有 `min/max/step` 的数字参数 |
| `switch` | 开关；`background.effect` 的开关启用/禁用 variant 自带的背景效果 |
| `select` | `options` 白名单选择，保留 string/number/boolean 类型；选项可带 `description`，选中后在字段下方显示该选项说明 |
| `font` | 字体栈选择及宿主字体导入 |
| `media` | 宿主选择并授权的图片/视频，`null` 使用主题材质 |

| binding.target | 允许的 key |
| --- | --- |
| `token` | `--bg`、`--surface`、`--surface-2`、`--surface-3`、`--text`、`--text-2`、`--text-3`、`--accent`、`--ok`、`--danger`、`--border`、`--border-strong`、`--link` |
| `layout` | `density`、`gap`、`sidebarWidth`、`contentWidth`、`columns`、`tabStyle`、`tabOpacity`、`tabAutoHide` |
| `component` | `controlRadius`、`cardRadius`、`panelRadius`、`borderWidth` |
| `font` | `body`、`heading`、`mono`、`cjk`、`latin`、`scale` |
| `background` | `texture`、`intensity`、`speed`、`direction`、`effect`、`media`、`warmth`、`grain`、`scale`、`wash`、`kind`、`palette`、`color`、`opacity`、`fit` |
| `splash` | `type`、`media`、`opacity` |
| `animation` | `level` |
| `notification` | `layout`、`accent`、`radius`、`borderWidth`、`density`、`shadow` |

`layout.tabStyle / tabOpacity / tabAutoHide` 保留兼容声明，但主窗实际值以宿主默认 Profile 中用户保存的全局偏好为准，第三方主题不能覆盖。classic 显示顶部会话标签；orb 改用左侧悬浮圆轨并隐藏顶部会话标签，窗口控制与拖拽区仍保留。两种导航共享同一会话状态和全局设置入口，不同时显示两套会话导航。全局偏好只在通用设置中修改，主题参数不再提供第二套控制器。

同一 Schema 中字段 key 和语义目标不能重复。最多 12 组、总计 48 字段，每个 select 最多 12 项。`visibleWhen: { field, equals }` 只能引用已声明字段，不能使用表达式或循环依赖。`help` 提供字段说明。

默认表单中，参数卡片的渲染顺序就是分组和字段的声明顺序。全部为 `token` / `color` 的组渲染成色板网格；同一组内相邻的 `slider`（语义目标为 `layout`、`component`、`notification`）合并为一个紧凑调节块，因此把圆角、间距、通知尺寸这类微调排在一起即可获得两列布局，无需额外声明。默认主题的氛围配色与背景动效使用相同的四列网格、最多两行，卡片高 100px、静态预览高 60px，组间宽高对齐。其它卡片组根据选项数扩展列数，窄屏保留最小可读宽度并允许组内横向滚动，不把名称挤成多行。隔离设置页面可用自己的布局呈现已发布描述符，不因此扩大字段范围。

### 渲染提示与缩略图

默认通用表单的 DOM、控件行为、焦点顺序、无障碍标签、动效档位、即时预览、保存与回滚由源码内置默认主题实现，主题包可提供两类声明数据：想用哪种控件形态，以及每个选项想显示什么缩略图。这些提示不能夹带 HTML、CSS、脚本或 CSS 选择器。需要完全不同的设置布局时声明隔离 `settingsPage`，不能注入或篡改可信原生表单。

**字段级 `presentation`** 让主题表达控件形态偏好，未声明时由宿主推断：

| 值 | 适用条件 | 呈现 |
| --- | --- | --- |
| `segmented` | `select`，选项 1–5 个 | 横向分段按钮 |
| `cards` | `select`，选项至少 1 个 | 带缩略图的卡片网格 |
| `slider-cluster` | `slider`，且 binding 有数值语义范围 | 与相邻同类滑杆合并成一个紧凑调节块 |

值与字段类型或绑定不匹配时，注册阶段直接拒绝（`presentation does not fit this field`），不会出现声明了却渲染不出来的情况。

**选项级 `preview`** 决定卡片缩略图，两种互斥形态：

```ts
options: [
  { label: '晨雾', value: 'mist', preview: { kind: 'swatch', stops: ['#cfd8dc', '#eceff1'] } },
  { label: '丝绸', value: 'silk', preview: { kind: 'asset', src: 'assets/previews/silk.webp' } },
]
```

- `swatch` 的两个停靠色必须是安全画法，宿主渲染成 135° 线性渐变。
- `asset` 是本包 `assets/` 下的相对路径，扩展名限 `png / jpeg / jpg / gif / webp / svg`；宿主会改写成 `enest://plugin/<source>/assets/...` 再交给渲染层，主题不能直接填任意 URL。
- 同一选项同时声明 `swatch` 和 `asset` 会被拒绝（`cannot mix swatch and asset`）。
- 缩略图只对 `select` 字段有意义。`font` 字段永远渲染成下拉加字形预览，因此给字体选项声明 `preview` 会被拒绝（`preview is not rendered for font fields`），而不是静默丢弃。

未声明 `presentation` 时，宿主按以下顺序推断：字段声明 > 选项是否自带 `preview` > 类型与绑定推断（`font` 走字体选择；`layout / component / notification` 的滑杆合并；`background.effect` 与 `background.palette` 走卡片；其余 `select` 在 5 项以内走分段）。内置默认主题依赖这套推断，第三方主题无需了解规则也能获得合理呈现。

### 自定义氛围配色

`background.palette` 可以引用宿主内置的 8 套配色，也可以引用主题自己声明的新配色。声明写在 pack 顶层：

```ts
const pack = {
  // …
  palettes: [
    { id: 'studioGlow', name: '工作室暖光', css: 'radial-gradient(ellipse 80% 60% at 10% 0%, #d9b3a0 0%, transparent 62%), linear-gradient(160deg, #f6eee6, #e4cbb9)', swatch: 'linear-gradient(135deg,#d9b3a0,#f6eee6)' },
  ],
}
```

- `css` 是真正铺到背景上的画法，`swatch` 是设置页配色卡片的小样，省略时复用 `css`。声明过的配色即使字段没写 `preview`，也能在卡片上显示自己的小样，不会退化成占位符。
- 两者都只接受安全画法：长度 ≤1024，字符限字母数字与 `_#.,()% +-`，函数只能来自渐变、颜色空间与 `var/calc/min/max/clamp` 这组白名单。`url()`、`expression()`、尖括号、反斜杠和分号拼接一律拒绝。
- `id` 不能与内置的 `theme / dawn / mint / linen / peach / ocean / forest / ink` 重名，也不能在同一 pack 内重复。
- 只有声明过的 id 才能出现在 `variants[].background.palette`、字段默认值、`options` 和 profile 补丁中；未声明会被拒绝，避免存下一个渲染不出来的值。

数字的宿主边界：density 0.8–1.2，gap 0–32，sidebarWidth 220–440，contentWidth 640–1920，columns 1–6；font.scale 0.9–1.3；control/card/panel 圆角上限分别 24/32/40，borderWidth 0–6；强度、warmth、grain、wash 为 0–1，speed/背景 scale 为 0.25–2，direction 0–360。字段自己的范围必须在这些边界内。`tabStyle` 只接受 `classic / orb`；`tabOpacity` 为 0–1，只控制标题栏背景材质的不透明度，0 为完全透明，文字、图标和窗口按钮保持清晰；`tabAutoHide` 必须是布尔值，开启后整条标题栏收起到宿主保留的 8px 顶部唤出区，指针移入即恢复 36px 标题栏。插件和首页原生视图随之重排，但不得覆盖这 8px 热区。通用设置提供同一主题 Profile 的快捷入口：拖动仅本地预览，松开才提交，失败恢复宿主确认值，不写入另一份通用外观状态。`animation.level` 只接受 `low / medium / high`。默认工作区的内容宽度直接对应容器最大宽度，默认 1520px，与原页面一致，不加隐藏偏移。

背景材质名称和布局标记是描述数据，不是执行任意 shader、CSS 或脚本的入口。默认首页渲染默认材质及通用参数；自定义首页可在自己的隔离页面实现新的材质。保留的 V1 `backgroundEffects` 是兼容协议，不再对应一套独立的设置选项卡。

### 通知样式

每个 variant 可选 `notifications`，省略时由宿主补齐安全默认。`layout` 支持 `card / compact / banner`，`accent` 支持 `stripe / icon / none`，`shadow` 支持 `none / soft / raised`；圆角 0–24、描边 0–6、密度 0.8–1.2。通过 `binding: { target: 'notification', key: 'radius' }` 等声明动态设置。

通知仍由可信原生 overlay 绘制，主题只控制这些经验证的样式值和语义颜色。它不能注入通知 HTML/CSS/JS，隐藏来源/关闭按钮，改变内容、位置、权限或计时策略。外观切换更新当前卡片变量，不重新创建卡片或重置剩余时间。位置是通用行为设置，不属于通知样式。

## 持久化、同步和迁移

主题身份始终是 `(source, id)`，不能只按短 ID 读写。每个主题的 profile 独立保存 values、分模式 colors 和 quarantined；Schema 升级后不合法/已删除字段进入隔离区，不直接应用，也不删除用户原值。注册与激活分离，停用或卸载来源后，主题与首页成对回退到默认主题，原 profile 保留。

主进程 `appearanceService` 是唯一外观权威：先校验和持久化，再广播 `appearance-changed`。renderer 不维护另一套字体/背景设置 store。各页面根据单调 `revision` 接收快照；主题切换不应重建编辑器、清空草稿、断开连接。系统减少动态效果和 FPS 限制只改变 effective 动画强度，不改写保存值。

过渡版 `warm`、已移除的内置主题和旧 `legacy-custom` 选择统一迁至 `default`。旧版本颜色、背景动效、氛围/媒体、双字体、字号、动画档、Tab 和开屏设置迁入默认 Profile 生效；旧 Profile、quarantine 和迁移备份保留，不重新展示旧主题。V1 注册/读取 API 为兼容保留；新主题必须使用 V2 才会出现在主题选择和动态设置中。

普通插件消费外观：

```ts
let revision = -1
const apply = appearance => {
  if (appearance.revision < revision) return
  revision = appearance.revision
  // 更新 token、布局与编辑器配色；不重建业务实例。
}
const off = enest.theme.onAppearanceChange(apply)
apply(await enest.theme.getAppearance())
addEventListener('pagehide', off, { once: true })
```

官方 PluginKit 的 `useAppearanceLayout` 接收同一快照，保留合法自定义 layout 标记。无需把新主题 ID 加进 PluginKit 的白名单。

## 配套首页与资源安全

在 `contributes.homePages` 声明完整工作区，再在 pack 中使用 `home: { source: 插件ID, id: 首页ID, variant: 声明的变体 }`。不提供 home 时，仍可使用默认工作区的目录、已安装和详情。自定义页面只收到 `enestWorkspace`（兼容别名 `enestHome`），不拥有 `enest`、`shellApi` 或设置入口；进入设置用 `openSettings` 动作请求宿主切换原生设置视图。宿主路由只有 `catalog/detail`，已安装是主题本地筛选；握手、ACK、描述符、可见性、崩溃回退及多入口构建见[主题工作区](home.md)。

资源只接受受控宿主导入或当前插件包内资产。不允许远程 URL、任意文件路径、跨插件私有资源、路径穿越或宿主 DOM 注入。主题可实现普通设置容器，不接管关闭窗口、原生权限确认、敏感系统设置和恢复入口。每来源最多 8 个主题包，禁用/卸载按 source 回收。

## 扩展验收

1. manifest 校验、SDK 类型和生成文档一致；首次扫描即可发现声明式主题。
2. 无配置的新安装直接加载源码内置主题和启动动画，首页 ready/路由 ACK 完成后进入；没有首启选卡或完成标记。设置中仍可切换已安装主题，失败保留已确认外观。
3. 主题 Tab 自动显示 Schema 字段，通用 Tab 无外观编辑器；保存/重启/恢复默认只影响当前 profile。
4. 浅深色、系统模式、字体/媒体/布局/Tab 样式同步主窗、Quick、独立窗、Orb 和主题感知插件。
5. 自定义首页完成 ready 握手；禁用/卸载/崩溃可回到默认首页，无原生层遮挡设置/选择页。
6. 隐藏停帧、减少动态效果、资源释放与业务草稿保留通过真实应用测试。
