# plugin.json 契约

manifest 是插件身份、资源和能力的唯一声明。源码、发布构建、宿主安装器都校验同一契约；非法包会被拒绝，不猜测入口。

| 字段 | 约定 |
|---|---|
| id | 反向域名，保留 `com.github.eNest` 的大小写；源码目录名与末段一致；不能使用宿主保留标识 enest.builtin |
| name / description / version | 非空名称、功能描述、semver 版本 |
| author / homepage | 可选；作者与项目主页，仅用于展示 |
| category | 效率、开发、设计、媒体、其它 |
| main | 固定 index.html，相对于运行根 |
| icon | 固定 assets/market/icon.svg；正方形 viewBox 的 SVG，不超过 64 KiB，不含位图、脚本、事件属性或外部引用 |
| market.readme | 固定 assets/market/README.md |
| market.screenshots | assets/market/screenshots 下的相对路径；发布 1–8 张 PNG/JPEG/WebP，每张固定 1200×800 |
| market.tags / featured | 市场标签及推荐展示 |
| backend.entry | 可选；包内 backend/ 下的 .cjs/.mjs/.js 入口，需 backend.node；构建工具输出 backend/index.cjs |
| background | 可选；声明式后台页 `{ entry: assets/*.html, events?, eventSettings? }`，在隐藏视图中按事件运行，见 [API 参考](api.md) 的 background 段 |
| activation | 可选；`indexSync`、`resident` 等声明式激活与常驻策略，见 [launch 段](api.md) |
| net | 可选；`allowInsecure: true` 时 `net.fetch` 允许明文 http://，缺省仅 https。`loginOrigins: string[]` 声明 `web.login` 登录窗口允许加载的站点（https origin，不含路径，最多 16 个）；声明了 `web.login` 权限的插件必须同时给出它 |
| permissions | 需要用户授权的敏感能力；基础存储/UI/设置/主题等无需声明 |
| engines.enest | 支持 `*`、精确版本、`^x.y.z`、`>=x.y.z` |
| development.main | 仅源码开发使用的无凭据 HTTP(S) URL，发布时移除；优先级低于 package.json `enest.dev.url`，启动命令解析见[开发加载](debug.md) |
| window | 内容尺寸建议；宿主按可用屏幕区域限制，不是 CSS 固定尺寸 |
| ui | chrome、themeAware、background、preferredColorScheme |
| views | 可选；已适配的 Quick、主窗布局和回退默认值，见[布局与 UI](#小窗主窗与-ui) |
| features | `code` 标识功能，`title` 是固定展示名，`explain` 是说明，`cmds` 提供名称别名及内容指令，见[触发词与内容指令](#触发词与内容指令) |
| contributes | settings、homeCards、railEntries、themePacks、homePages、openWith 等声明式扩展；homePages 仅在来源插件已安装、已启用且与当前 manifest 精确匹配时运行，见[完整首页](home.md) |

## 图标与截图规格

图标和截图是固定规格的素材，不是自由尺寸的图片。源码校验、发布构建与宿主安装器校验同一套规则，不合规的包在安装时被拒绝；首页精选、市场卡片、详情图库与缩略图都按下面的比例预留容器，不会为了适配某张图改变版式。

| 素材 | 规格 |
|---|---|
| 图标 | `assets/market/icon.svg`。SVG，`viewBox` 必须是正方形（`0 0 128 128`、`0 0 256 256` 等均可，数值不影响清晰度）；不超过 64 KiB；不得包含位图、`script`、`foreignObject`、事件属性、动画元素或任何外部引用，渐变等内部引用（`url(#id)`）可以使用 |
| 截图 | 每张像素尺寸固定 **1200×800（3:2）**，PNG、JPEG 或 WebP。比例相近的尺寸（1200×764、1280×800、1280×720）同样不合规；需要高分屏清晰度时在导出前按 1200×800 逻辑视口、2 倍像素拍摄，再等比缩放到 1200×800 |
| 数量与体积 | 1–8 张，首张为首页封面；单张不超过 16 MiB |


尺寸不合规格时，宿主只会按 `cover` 裁切铺满容器，不会拉伸变形；所以比例偏差越大，被裁掉的内容越多。首页精选卡在窄窗口下截图区比 3:2 更接近方形，左右边缘会被裁切一部分，重要内容不要贴边。

资源路径不得包含绝对路径、URL、反斜杠、点段、隐藏段、百分号编码或查询片段。`logo`、任意 main 路径和单独 settings HTML 入口已移除；设置使用 contributes.settings 或插件内页面。

`contributes.mcpTools` 声明可供本机 MCP 客户端调用的业务工具（每插件最多 128 项，处理器在普通插件页注册）；服务默认关闭，声明不授予额外权限。字段、JSON Schema 限制、注册流程及当前交付边界见 [MCP 工具贡献](mcp.md)。

## 触发词与内容指令

Quick 和首页从 `features[]` 读取静态功能。`code` 是执行和使用记录的稳定标识，改文案不需要改 `code`。每个有字符串触发词的功能建议声明 `title`：使用单行、非空、不含控制字符的人读名称，最多 128 个 Unicode 码点，例如「截图」「Base64 编解码」。`explain` 用于补充说明，不用它截取标题。

- **字符串触发词**：同一功能只有一条名称结果。`cmds` 填中文同义词、常用英文名和需要兼容的显式简称，例如 `title: "截图"`、`cmds: ["截图", "截屏", "screenshot", "jt"]`。搜 `jt`、`jietu`、`screenshot` 或 `截屏` 都显示「截图」，不会显示别名。插件名、插件 ID 和用户自定义触发词仍关联到主入口。
- **名称匹配**：默认主题在名称索引里从标题和别名生成全拼、拼音首字母和英文词首，不必逐条抄写。多音字和习惯简称可用显式别名补充；不同功能可以同名或共用缩写，不互相覆盖。带正文的显式前缀优先；普通名称查询按完整标题/别名、完整拼音/首字母、部分匹配分档，同档再用查询偏好排序。
- **regex 文本内容**：`{ "type": "regex", "label": "...", "match": "/source/flags", "minLength": 1 }`。`match`（或兼容字段 `regex`，同时提供时 `match` 优先）必须是 `/source/flags` 字面量，最长 2048 字符，支持 JS flags `dgimsuvy`。安装时仅编译语法、绝不执行匹配；执行在隔离 Worker，单次有 180ms 预算。命中的原始输入文本作为 `payload` 交给 `onEnter`。
- **over 文本兜底**：`{ "type": "over", "label": "...", "minLength": 1, "maxLength": 10000, "exclude": "/^https?:/i" }`。接受任意满足长度边界、且未命中 `exclude` 的文本，归入「匹配推荐」组；适合翻译、全文搜索一类「把当前文本交给我」。
- **img 粘贴图片**：`{ "type": "img", "label": "压缩这张图片", "extensions": ["png", "jpeg"] }`。仅当 Quick 输入框带图片上下文时命中；`extensions` 是小写无点扩展名白名单（最多 16 项，缺省接受任意图片）。图片以 `onEnter` 的 `input.images[].dataUrl` 交付。
- **files 粘贴文件**：`{ "type": "files", "label": "批量处理文件", "extensions": ["txt", "md"], "minCount": 1, "maxCount": 20, "allowDirectory": false }`。仅当带文件上下文时命中；数量边界 `minCount`/`maxCount` 缺省 1/20，`allowDirectory` 决定是否把目录计入有效数量。文件以宿主签发的只读句柄在 `input.files[]` 交付。

旧包不要求补 `title` 才能使用：在可以公开的触发词里，先取第一个含汉字的词，再取第一个不是 1–3 位小写字母简称的词，最后回退插件名。没有 `features` 时仍按插件名启动。内容指令保留自己的 `label`；给纯内容入口或 `cmds: []` 的内部激活入口写 `title` 不会额外生成名称结果。只有显式声明 `activation` 的功能可以使用空 `cmds`。发布带 `title` 的包前，应先更新宿主、SDK 和 Schema，并在 `engines.enest` 声明实际支持的最低版本；旧 Schema 不接受这个新字段。

```json
{
  "features": [
    {
      "code": "translate",
      "title": "翻译",
      "explain": "翻译文本",
      "cmds": [
        "翻译", "translate", "fy",
        { "type": "over", "label": "翻译这段文字", "minLength": 1, "maxLength": 10000 }
      ]
    },
    {
      "code": "compress",
      "title": "图片压缩",
      "explain": "压缩图片",
      "cmds": ["压缩", "image", { "type": "img", "label": "压缩这张图片" }]
    }
  ]
}
```

对象指令的字段由 schema 严格约束（`additionalProperties:false`）：未知 `type`、拼错字段、无效正则、越界数量或非法扩展名都会在安装时被拒。regex/over 与 img/files 互不混用字段。无论命中哪条 `cmds`，只要 Quick 输入框有文本，该文本也会随启动进入 `onEnter`（详见[多布局工具接口](dual-mode-tools.md#输入上下文)），插件据此把内容填入自己的工作区。新增或修改 `plugin.json` 后，需重新安装更新后的插件包、或开发插件刷新重载 manifest 才生效；改仓库源码不会更新已安装的旧包。

文本功能可在同一 feature 增加 `"input": { "type": "text", "trigger": "prefix" }`。默认主题将“精确别名 + 空白 + 非空正文”作为携带参数的功能命中，宿主再次核验后交付 `input.text` 与 `input.query: { raw, trigger }`；命中时旧字符串 payload 同样使用正文。`trigger: "none"` 表示保留全文；只有别名而无正文时不剥离文本。没有声明 input、但同一功能已有不含 exclude 的 over 对象时兼容前缀行为；其它功能不自动启用。此字段不会重写持久目录或实时 provider 的私有 payload。示例、长度边界与排序见[文本触发词与启动参数](themes.md#文本触发词与启动参数)。

## 可选 Node 后端

带后端的插件声明 `"backend": { "entry": "backend/index.cjs" }`，在 `permissions` 中列出 `backend.node`，并设置 `"engines": { "enest": ">=0.0.1" }`。`main` 仍是浏览器页面 `index.html`。后端入口不是 preload，也不会通过页面资源协议暴露。用户授权后运行完整 Node.js 代码，不能按页面沙箱理解其权限边界。源码入口和依赖收集配置放在 `package.json.enestBackend`，协议与示例见[插件本机后端](backend.md)。开发态后端只从产物目录（`enest.output`，缺省 `dist`）解析；首次打开或重载时入口缺失，宿主按 `package.json` 的构建命令自动构建一次，构建失败不阻止页面打开。

## 小窗、主窗与 UI

宿主布局只有 `quick`（紧凑工具）和 `shell`（完整工作台）。独立窗口是挂载位置，不是布局。`getLaunchMode()` 读取当前布局，`onModeChange()` 只在布局改变时触发。

用可选的 `views` 段声明插件适配了哪些布局、未适配入口回落到哪个默认视图：

```json
{
  "views": {
    "layouts": ["quick", "shell"],
    "default": "shell"
  }
}
```

- `layouts`：已适配的布局集合，缺省 `["quick", "shell"]`。
- `default`：必须属于 `layouts`；缺省优先 `shell`。只声明 `shell` 的插件从 Quick 启动时会打开主窗。

Quick、快捷键和 Workspace 通过统一启动器解析目标：未适配请求的布局才回退到 `views.default`。普通 Quick 再次打开已独立的窗口时原地聚焦；显式目标可以移动原实例，不重新建立业务状态。

已安装旧包若同时声明了 `panel` 和普通布局，宿主只读取其 Quick/主窗入口；只含旧 `panel` 的包必须更新。新源码和发布清单不要声明该布局。

默认 `chrome:none`、`themeAware:true`、`background:opaque`、`preferredColorScheme:auto`。使用宿主主题 token、字体和动画档位。不同布局只调整呈现，不重复创建业务状态。

## 打开方式（contributes.openWith）

声明插件能处理的文件类型和 URL scheme，即可在设置 → 通用 → 默认打开方式中出现，无需插件先运行。也可以用 [`enest.openWith.register`](api.md#openwithregistercontribution--openwithunregisterid) 动态登记其他类型。插件不需要额外权限，不能替用户指定默认插件或系统默认应用。

```json
{
  "contributes": {
    "openWith": [
      {
        "id": "markdown-files",
        "label": "Markdown 文档",
        "extensions": ["md", "markdown"],
        "mimeTypes": ["text/markdown"],
        "schemes": ["enest-md"],
        "role": "Editor"
      }
    ]
  }
}
```

- 每项需要非空 `extensions` 或 `schemes`；仅给 MIME 不能建立文件路由。扩展名用小写字母数字、无点；协议名用 2–64 个小写字母、数字、`+.-`，以字母开头且不含 `:`。系统及宿主保留协议不可用（包括 `enest`、`http`、`https`、`file`、`mailto`、`tel` 和 `ms-` / `x-apple.` 前缀）。同一扩展名可有多个插件；同一协议只有一个来源，清单声明优先于运行时登记。
- 一项可以登记多个扩展名。`label`（可选，1–40 字符）是这条声明在设置页「可注册的打开方式」里的显示名；缺省时显示为扩展名列表。用户在宿主设置 → 通用 → 默认打开方式里按**声明项**逐条开关：关闭后这条声明声明的类型不再由该插件处理（候选列表、保存校验、双击打开同步生效），已设好的默认会保留，重新开启即恢复；插件不需要为此编写设置项或调用 `unregister`。设置页录入文件类型时可用逗号或空格一次填多个，候选插件是能处理全部这些类型的插件。
- 用户把某类型设为默认后，双击文件 / 点击链接会打开 eNest 并唤起对应插件：`onEnter` 收到 `code: 'open-file' | 'open-url'`，`payload` 为 `{ paths?, handles?, url? }`。**文件读取必须走 `localFiles.read({ handleId })`**（基础能力，无需授权），`handles` 是宿主签发的只读句柄，`paths` 仅作展示，不能绕开句柄自行访问。
- 文件参数按当前系统的本地路径规则处理，Windows 支持盘符绝对路径与完整 UNC 共享路径（包括由 `file://server/share/...` 转换的路径）；不接受设备命名空间、盘符相对路径或把 URL 当成本地文件名。
- 平台能力边界：Windows 登记当前用户的候选，不覆盖受保护的系统默认选择；需要时由用户进入「默认应用」确认。macOS 只对当前安装包声明的类型请求切换，可在 Finder 用「显示简介 → 打开方式 → 全部更改」设置文件。Linux 需要已安装并声明相应 MIME 或协议的 `.desktop` 入口及相应 XDG 工具；插件运行时声明不能修改已签名的安装包或替系统创造 MIME 类型。开发版也可以选择壳内插件，但不写入操作系统关联。
- macOS 运行时读取**当前应用包**的 `Info.plist` 与 bundle ID，并通过 AppKit `NSWorkspace` 和 `UTType` 查询扩展名对应的 UTI、默认处理程序及候选列表，不用源码里的打包快照或 `LSHandlers` 偏好替代系统事实。系统接口或查询结果不可用时显示状态未知；仅有插件声明、内部路由已保存、系统变更请求已提交，都不代表系统候选或默认已生效。URL scheme 也必须先在当前安装包声明，变更后重新查询确认。

## 综合插件与主题插件

综合插件在一个入口内组合功能和贡献点，每个 feature.code 路由到对应功能。业务类型不需要壳逐项注册；只声明实际使用的敏感权限，所有订阅有对应取消函数。

主题插件也使用同一标准包和 index.html 预览页。固定主题通过 `contributes.themePacks` 声明，支持 V1 包与 `schemaVersion: 2` 的完整外观包；动态编辑主题通过基础能力 `enest.theme.register(pack)` 注册，无需权限弹窗。主题 source 由宿主绑定插件，停用或卸载会撤下主题贡献。注册只增加可选项，不会自动激活主题或首页。V2 主题包可在顶层用 `palettes` 追加自己的氛围配色，id 不得覆盖宿主内置的 `theme / dawn / mint / linen / peach / ocean / forest / ink`，含 `url()` 之类的不安全画法在注册时即被拒绝。不要直接修改壳设置文件或全局 CSS 文件。

完整字段形状见[官方 manifest Schema](https://github.com/hyqf98/eNest_plugin/blob/main/docs/plugin-manifest.schema.json)；实际 API 签名由[生成类型](api-types.md)定义，不手抄权限数量或类型副本。
