# 插件自绘设置与窗口边界

业务设置的字段、布局、校验、工作流和依赖由插件拥有。壳子只提供私有设置存储、声明式入口、通用控件回退、原生容器与安全门禁；不为某个插件增加一套主进程设置处理器。

## 选择正确的设置入口

| 场景 | 使用方式 | UI 所有者 |
|---|---|---|
| 少量开关、颜色、数值 | `contributes.settings` 声明通用字段 | 默认主题按通用 schema 渲染，无插件专用分支 |
| 复杂配置、编辑器、连接管理、内核安装 | `type: "page"` 指向插件的 `features[].code` | 插件自己的主页面和路由 |
| 主题希望重排设置界面 | V2 主题包声明 `settingsPage` | 主题在隔离页面渲染宿主发布的安全描述符，原生入口始终保留 |
| 插件内部普通偏好 | `settings.get/set/onChange` | 插件自绘，同步私有设置 |
| 不适合声明字段的业务数据、草稿 | `storage.*` / `storage.session.*` | 插件自绘，受实例与存储配额约束 |
| 密钥 | `vault` 或经明确原生后端信任管理的私有存储 | 不把凭据放到公开 manifest/default 或日志 |

`page` 不是任意 URL、外部 iframe 或第二套 preload。它由宿主打开本插件已验证的入口，并通过 `onEnter` 交付 `code/payload`；页面仍使用本插件的隔离上下文。静态声明在安装后即可显示，不要求先启动插件。

例如，一个完整的设置入口片段：

```json
{
  "features": [
    { "code": "main", "explain": "工具主界面", "cmds": ["我的工具"] },
    { "code": "settings", "explain": "工具设置", "cmds": ["我的工具设置"] }
  ],
  "contributes": {
    "settings": [
      {
        "id": "preferences",
        "title": "工具设置",
        "items": [
          { "key": "followShellTheme", "type": "switch", "label": "跟随主题", "default": true },
          { "key": "management", "type": "page", "label": "打开高级设置", "entry": { "code": "settings" } }
        ]
      }
    ]
  }
}
```

插件启动时处理 `enest.getEnterCode()`，同时订阅 `enest.onEnter`，在 `code === 'settings'` 时切换到自己的设置路由。不要只在冷启动读取 URL，否则已打开实例再次收到设置入口时不会切页。`page` 项只是动作入口，不是可以写入值的设置字段。

DSH 使用同一机制：`contributes.settings` 的 `manage` 页面入口打开插件自己的管理中心，内核、Profiles、会话和备份都不由壳设置页面实现。

## 私有设置与授权边界

- `settings.register(section)` 可动态声明同样的分组，同一来源的同 ID 分组会替换原声明；静态 `contributes.settings` 优先用于安装后即需可见的入口。`schemaVersion` 只支持省略或字符串 `'1'`，不是数字 `1`，其它值拒绝并返回 `unsupported settings schema version`。
- `settings.get(key)` 只读调用插件自己的合法键。已持久化值优先，无值时读取声明默认值；`false`、`0` 不被替换。为兼容旧设置，合法的旧私有持久化键仍可读取；既无保存值也无声明默认值时返回 `undefined`。
- `settings.set(key, value)` 只写本插件已注册、非 `page` 的字段；未知键会拒绝。宿主等待真实持久化成功后才广播确认值，失败 reject，不发布成功态。插件应校验自己的业务值，等待保存成功后再显示成功状态，失败时保留或恢复最后确认值；它不同于 KV `storage.set` 的排队语义。
- `settings.onChange(({key,value}) => ...)` 同步壳通用控件与插件自绘页的写入。离开页面时取消订阅，不要增加永久轮询。
- `permissionGrants`、`__proto__`、`prototype`、`constructor` 是宿主保留键，不能注册、读取或写入。API 不接受另一个 `pluginId` 来跨插件读写。
- 普通插件没有 `shellApi.getSettings()` 或完整的 `window.enestShell`。不要为自绘设置暴露全量设置、权限表、账户令牌、历史窗口位置或其它插件配置。
- 设置可以绑定声明式后台事件，但不等于授予资源权限。例如 clipboard 插件的 `monitoring` 开关由 `background.eventSettings` 绑定到 `clipboard.changed`；必须同时持久授权 `clipboard.history` 才有原生订阅。历史容量、保留天数和排除应用仍由插件解释，壳不按这些业务字段执行历史策略。

```js
const api = window.enest
const apply = value => {
  document.documentElement.dataset.followTheme = String(value === true)
}
let receivedChange = false
const off = api.settings.onChange(({ key, value }) => {
  if (key !== 'followShellTheme') return
  receivedChange = true
  apply(value)
})
window.addEventListener('pagehide', off, { once: true })
const initial = await api.settings.get('followShellTheme')
if (!receivedChange) apply(initial ?? true)

async function saveFollowShellTheme(value) {
  await api.settings.set('followShellTheme', value)
}
```

先订阅再读取，避免初始化期间的旧读取覆盖新通知。将 `saveFollowShellTheme` 绑定实际的用户保存动作，并捕获失败、保留最后确认值；成功值由 `onChange` 应用，不要在页面加载时自动反转持久化开关。

`enest.ui.openSettings()` 打开宿主设置并定位本插件分组；它不直接打开插件自绘页面。用户再点击 `page` 项，或插件在自己的 UI 中直接切换设置路由。敏感资源访问依然使用各自权限，提供设置页面不等于获得网络、系统控制或 `backend.node` 信任。

## 主题自绘设置页面 V1

默认设置界面及其控件、布局与样式位于宿主源码的 `src/renderer/themes/default/settings/`，随 eNest 默认主题编译。壳的设置控制器只负责选择提供者、进入与返回、原生内容层切换、协议和失败恢复；不是把默认主题布局作为第三方主题必须复刻的固定页面。默认主题的可信适配器保留原有完整设置行为，不代表第三方页面可以取得同等权限。

V2 主题包可在顶层声明以下入口，只有用户当前选择的主题生效：

```json
{ "settingsPage": { "version": 1, "entry": "settings/preferences.html" } }
```

入口是包内相对 HTML，最长 240 字符，使用安全 ASCII 路径，不含 URL、点段、反斜杠或 `backend/runtime/node_modules/src/test/tests` 目录。HTML 及其依赖必须进入构建与发布包；页面脚本放在包内外部 JS 文件中。源码开发时可先构建，再装载对应 `dist` 分发目录，不能让隔离页面直接执行 `src` 中的 TS/TSX。安装校验与发布脚本会检查声明的入口存在、无符号链接、无源码泄漏。

页面位于 `sandbox="allow-scripts"` 且无同源权限的 iframe，资源只来自当前主题包的独立 `enest-settings` 协议。没有普通插件 `enest`、`shellApi`、Node、任意网络、文件、弹窗或子框架能力。公开桥只有 **`window.enestSettings`**：

| 方法 | 作用 |
|---|---|
| `ready()` | 页面脚本与订阅已准备好；8 秒内未就绪显示故障恢复入口 |
| `getState()` | 读取安全的 `ThemeSettingsSnapshot`，不是原始设置对象 |
| `onState(listener)` | 订阅新快照，返回取消订阅函数 |
| `action({type:'set',fieldId,value})` | 使用当前发布的字段句柄请求写入，由宿主重校 schema、值、归属与可见性 |
| `action({type:'native',section})` | 请求进入 `nativeSections` 中的可信原生设置分组 |

快照包含 `version/revision/locale/appearance`、`groups[].fields` 与 `nativeSections`。字段只包含不透明 `id`、显示名、`switch/select/number/color` 控件语义、当前简单值和可选范围/选项。`id` 不是插件设置键，不得持久化、猜测或替换为路径；每次更新使用当前快照。主题自己的媒体、字体导入等不在这些描述符中，使用快照提供的原生入口。

最小页面脚本可以只呈现开关，未支持的控件保留原生入口；不要用 `innerHTML` 拼接描述符文本：

```js
const api = window.enestSettings
const root = document.querySelector('[data-settings]')
const status = document.querySelector('[role="status"]')
const render = state => {
  const rows = []
  for (const group of state.groups) for (const field of group.fields) {
    if (field.type !== 'switch') continue
    const row = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = field.value === true
    const save = document.createElement('button')
    save.type = 'button'
    save.textContent = '保存'
    save.onclick = async () => {
      const result = await api.action({ type: 'set', fieldId: field.id, value: input.checked })
      status.textContent = result.ok ? '已保存' : result.error || '保存失败'
    }
    row.append(input, document.createTextNode(field.label), save)
    rows.push(row)
  }
  for (const section of state.nativeSections) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = section.title
    button.onclick = () => api.action({ type: 'native', section: section.id })
    rows.push(button)
  }
  root.replaceChildren(...rows)
}
const off = api.onState(render)
api.getState().then(render)
api.ready()
window.addEventListener('pagehide', off, { once: true })
```

写入和进入原生分组都要求当前可见、聚焦页面中的真实原生鼠标或键盘操作，许可一次性消费；合成事件、页面加载即保存、延迟后台重放都不能代替用户操作。示例使用明确的「保存」点击，不在收到快照时写回值。等待 `action` 的 `{ok,error}`，失败时保留错误并以宿主后续快照为准，不显示假成功。

### 其它插件字段必须显式公开

`contributes.settings` 和动态 `settings.register` 中的字段默认私有。插件可对适合第三方主题展示的简单字段逐项声明 `shareWithThemes: true`：

```json
{
  "key": "compactCards",
  "type": "switch",
  "label": "紧凑卡片",
  "default": false,
  "shareWithThemes": true
}
```

该标记只公开合法的 `switch/select/number/color` 类简单字段；`page`、密钥、路径、账号、授权和开发者管理不借此公开。公开后的当前值与显示信息可被用户选中的主题读取，因此不能把敏感信息放入公开字段。主题得到的字段仍只有会话句柄，没有跨插件 `settings.get/set(pluginId, ...)` 能力。

官方插件也逐字段 opt-in，不按控件类型批量公开。历史容量与保留期限可能触发数据删除；自动剪贴板替换、截图后贴图、自动写文件、网络请求、系统通知及远程输入控制也有副作用，这些字段继续私有。普通显示格式、布局与颜色可单独公开；manifest 与运行时 `settings.register` 重注册必须保留同一显式标记，不能由默认值袋或主题推断公开权限。

其它插件字段的描述符带 `confirmation: true`，每次修改都弹出宿主原生确认，说明目标插件、字段与新值。确认后宿主再次校验字段仍公开、目标仍启用、构建/schema/值/可见性未变、页面仍是原活动代次；取消、隐藏、换主题或失效句柄都拒绝写入。主题不能省略确认或把一个确认复用于批量写入。插件未 opt-in 的字段继续只在其自身页面或可信原生回退中显示。

主题没有声明 `settingsPage` 时直接使用默认设置界面；第三方页面故障时保留重试与「系统与安全设置」入口，用户始终可以进入可信原生界面并返回。Workspace 的 `openSettings` 仍只是进入同一个宿主设置容器，不增加设置路由，也不把全量设置桥接给 Workspace。

## 布局模式与原生位置

插件公开标准是 `window.enest` 的 `ui` 与模式事件，不存在可任意创建和控制原生窗口的 `enest.window` API。

| 公开 API | 语义 |
|---|---|
| `getLaunchMode()` / `onModeChange(cb)` | 当前 `quick` / `shell` / `panel` 布局；仅实际布局变化才推送，不从 URL 或窗口大小推断当前位置 |
| `ui.openInShell()` | 将本插件现有 View 固定到主窗口，不新建实例、不重载文档或重放业务请求 |
| `ui.focus()` / `ui.focusSearch()` | 聚焦当前插件，或返回 Quick 的全局搜索 |
| `ui.dismissQuick()` | 仅当前 Quick 挂载者可收起小窗；不等同销毁插件，没有 `quick.hide()` |
| `ui.setInputContext(...)` | 声明编辑器、终端、弹层或工作台焦点，避免宿主快捷键抢占 |
| `quickInput.configure/release` | 当前实例受限接管顶部输入，隐藏、迁移、返回和销毁时释放 |
| `ui.resize(...)` / `ui.setHeight(...)` | 兼容尺寸建议，校验正有限数；成功不意味着改变 Quick 或用户窗口的尺寸 |

Quick、桌面与组件布局共用页面状态、会话、编辑器 model。使用 `ResizeObserver` 和实际内容区尺寸适配，长内容在插件内部滚动；需要更多空间时提供 `ui.openInShell()` 按钮，宿主将原 View 移到主窗，再按 `views` 选择 shell 或默认布局。不要根据某个固定宽度反推模式。

独立插件窗口是宿主的挂载位置，不是另一种 `PluginLaunchMode`；拖出时保留原布局。拖出、收回、窗口最小化/最大化、置顶和几何历史由可信原生标题栏控制；插件页面不获得宿主内部 `PluginWindowsApi`。这样可保证同一个 View、generation、runtime scope 在迁移中保持归属，权限对话框跟随实际容器。下节的包内辅助页是另一种受限资源，不是任意控制主窗口或独立插件容器的接口。

自由面板是宿主挂载位置；只有 `views.layouts` 包含 panel 的插件才可加入，并使用其专门的 panel 布局；未声明的插件不出现在组件选择器，也不能拖入。插件保留普通 `enest` API，不获得 `enestPanel`。组件的移动、缩放、拖动预览、对齐线、显示器恢复和布局持久化由宿主处理；用户直接拖动边缘移动、拖动四角缩放，无需切换编辑模式。插件只适配实际内容区并自绘内容，见[自由面板](panels.md)。切换挂载位置不一定改变 `PluginLaunchMode`，不能依赖每次迁移都收到 `onModeChange`。

启动请求只有 quick/shell 目标（`PluginLaunchTarget`）；`views.default` 仅在请求布局未适配时使用，不覆盖已适配请求。Quick、快捷键与 Workspace 打开经统一启动器按最终布局选择位置：quick 进入 Quick，其余进入主窗；请求未适配且最终回退 panel 时，才在主窗显示 panel，不自动创建自由面板。Workspace 目录、详情和首页搜索显式请求 shell；宿主主窗普通打开（`ShellOpenPlugin`）则是另一条路径，回退 quick 布局也留在主窗。

已有面板组件或独立窗口从普通 Quick 搜索（未指定显式目标）或 `ShellOpenPlugin` 打开时原地聚焦；Workspace 打开、显式设置入口、快捷键目标与迁移动作可以移动现有实例。固定/拖入等迁移遵守指定位置，不因布局回退改换目标。不要为实现“展开”关闭当前组件再新建一个插件。完整入口决策见[UI 集成标准](ui-standard.md#三种布局与挂载位置)。

插件自绘弹层必须放在自己的文档内。原生 `WebContentsView` 在壳 renderer 之上，不能依靠壳 CSS `z-index` 盖住插件。

## 沙箱后台与包内辅助页

eNest 将业务后台、选区/录制/贴图与原生容器分开。各文档不能互换桥对象：

| 文档 | 可用桥 | 所有者与限制 |
|---|---|---|
| 普通插件主页面 | `enest` | 当前插件前台，可经授权调用原生能力、自己的后台与辅助页 |
| manifest 声明的 `background.entry` | `enestBackground` | 本插件沙箱后台，只注册事件/RPC/搜索处理器并访问私有文档/blob、插件设置和限定迁移源；无 Node、完整前台 API 或任意网络 |
| `auxiliary.open` 打开的包内 `assets/*.html` | `enestAux` | 只有一次性上下文、收发消息和关闭；不能读设置、剪贴板或文件，不获得父页完整 API |
| 当前主题 `settingsPage` | `enestSettings` | 白名单简单字段与可信原生入口，不获得任何上述插件桥 |

宿主提供 `auxiliary.open/send/close/list`，校验包内入口、owner、main frame、代次、窗口和消息预算。普通辅助窗口是基础 UI 能力；非捕获的 `alwaysOnTop:true` 需兼容权限 `pin.create`。带 `capture` 的辅助页需 `screen.record`、系统许可和真实原生点击，只能获取当前指定显示器的一次捕获，不允许自报 source ID、合成激活或额外媒体权限。插件不能使用辅助页操作其它插件或宿主的原生窗口。

选区、贴图内容、缩放和 MediaRecorder 流程由插件仓 `@enest/native-surfaces` 提供，并随使用它的插件构建。`createNativeSurfaces(window.enest)` 返回本地 facade，才具有 `surfaces.screen.selectRegion/record` 与 `surfaces.pin`；原生 `window.enest.screen` 只有 `capture/displays`，没有宿主 `pin`。官方辅助页放在 `assets/vendor/native-surfaces/`，不能依赖壳中的固定业务页面。

录制数据先经 `enestAux.post` 交给拥有者，再用主页面的 `files.stream.open/write/finish/abort` 有序写入私有输出；辅助页没有文件 API，任何一层都不接受任意保存路径。每块需确认、队列有界，`finish` 成功后才显示保存成功。完成文件的 ID 由 `storage.files.get/list/remove/export` 管理，导出仍须原生保存确认；业务不再需要原件时应显式删除，不能只删业务索引。正常关闭只提供有界收尾期，撤权、禁用、崩溃或强制销毁会回收辅助窗口、捕获轨和未完成输出。提交后回执失败可能已经留下完成文件，应按[存储标准](storage.md)核对；已有完成文件不会因撤权自动删除，卸载按插件私有目录清理。

clipboard 的 `history.*` 则是该插件注册的 `background.call` 方法，不是 `enest.clipboard.history`。持续观察需要持久授权及启用的事件开关；关闭前台不等于关闭已授权后台，手动停止、禁用或撤权才按各自生命周期释放。没有敏感授权时，后台不得因设置刷新或 Quick 查询被唤醒采集。完整签名和权限语义见 [API 参考](api.md) 与[权限说明](permissions.md)。

## 必须留在宿主的权威与原生操作

持久化、主题 Profile、参数校验、权限授予/撤销、原生容器及资源回收是宿主职责。语言、关闭行为和通知位置可经宿主白名单描述符呈现；数据根、代理与网络路径、硬件加速、更新、账户凭据、授权管理、原生快捷键冲突处理、开发装载与性能采样仍通过可信原生入口。主题外观按主题 schema 提交到宿主持久化权威；第三方主题不能读取全量设置、账号、授权表、开发配置、私有插件值或敏感本地路径。

默认主题设置页的插件区按注册分组泛型渲染，不包含 DSH、数据库或 SSH 的专用业务表单。继续开发时，复杂业务设置应新增插件 `page` 路由，而不是向壳的设置控制器或默认主题添加插件 ID 分支。保留通用字段回退不等于把插件业务放回壳内。

详见 [API 参考](api.md)、[UI 集成标准](ui-standard.md)、[多布局工具接口](dual-mode-tools.md) 与 [原生后端](backend.md)。
