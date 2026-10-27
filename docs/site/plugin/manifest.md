# plugin.json 契约

manifest 是插件身份、资源和能力的唯一声明。源码、发布构建、宿主安装器都校验同一契约；非法包会被拒绝，不猜测入口。

| 字段 | 约定 |
|---|---|
| id | 反向域名，保留 `com.github.eNest` 的大小写；源码目录名与末段一致；不能使用宿主保留标识 enest.builtin |
| name / description / version | 非空名称、功能描述、semver 版本 |
| category | 效率、开发、设计、媒体、其它 |
| main | 固定 index.html，相对于运行根 |
| icon | 固定 assets/market/icon.svg |
| market.readme | 固定 assets/market/README.md |
| market.screenshots | assets/market/screenshots 下的相对路径；发布 1–8 张 PNG/JPEG/WebP |
| market.tags / featured | 市场标签及推荐展示 |
| backend.entry | 可选；包内 backend/ 下的 .cjs/.mjs/.js 入口，需 backend.node；构建工具输出 backend/index.cjs |
| permissions | 需要用户授权的敏感能力；基础存储/UI/设置/主题等无需声明 |
| engines.enest | 支持 `*`、精确版本、`^x.y.z`、`>=x.y.z` |
| development.main | 仅源码开发使用的无凭据 HTTP(S) URL，发布时移除；优先级低于 package.json `enest.dev.url`，启动命令解析见[开发加载](debug.md) |
| window | 内容尺寸建议；宿主按可用屏幕区域限制，不是 CSS 固定尺寸 |
| ui | chrome、themeAware、background、preferredColorScheme |
| features | code、explain、cmds 声明启动指令；cmds 支持触发词、regex/over 文本内容与 img/files 粘贴上下文，见[触发词与内容指令](#触发词与内容指令) |
| contributes | settings、homeCards、railEntries、themePacks、homePages、openWith 等声明式扩展；homePages 仅在来源插件已安装、已启用且与当前 manifest 精确匹配时运行，见[完整首页](home.md) |

资源路径不得包含绝对路径、URL、反斜杠、点段、隐藏段、百分号编码或查询片段。`logo`、任意 main 路径和单独 settings HTML 入口已移除；设置使用 contributes.settings 或插件内页面。

`contributes.mcpTools` 声明可供本机 MCP 客户端调用的业务工具（每插件最多 128 项，处理器在普通插件页注册）；服务默认关闭，声明不授予额外权限。字段、JSON Schema 限制、注册流程及当前交付边界见 [MCP 工具贡献](mcp.md)。

## 触发词与内容指令

`features[].cmds` 是 Quick 小窗唯一的可检索入口声明，对标 uTools / zTools 的 `features`。每个 feature 有稳定 `code`（进入载荷 `code` 与之对应）、可选 `explain`（副标题），以及至少一条 `cmds`。`cmds` 混合三种形状：

- **字符串触发词**：每个字符串独立生成一条可搜结果，首个作为该 feature 的显示名，其余作为别名。检索经 NFKC、大小写归一后，命中全拼、拼音首字母与英文缩写（`fy` 搜「翻译」、`vsc` 搜「Visual Studio Code」）。插件名、插件 id 与用户在详情里自定义的触发词与字符串指令等权并入。
- **regex 文本内容**：`{ "type": "regex", "label": "...", "match": "/source/flags", "minLength": 1 }`。`match`（或兼容字段 `regex`，同时提供时 `match` 优先）必须是 `/source/flags` 字面量，最长 2048 字符，支持 JS flags `dgimsuvy`。安装时仅编译语法、绝不执行匹配；执行在隔离 Worker，单次有 180ms 预算。命中的原始输入文本作为 `payload` 交给 `onEnter`。
- **over 文本兜底**：`{ "type": "over", "label": "...", "minLength": 1, "maxLength": 10000, "exclude": "/^https?:/i" }`。接受任意满足长度边界、且未命中 `exclude` 的文本，归入「匹配推荐」组；适合翻译、全文搜索一类「把当前文本交给我」。
- **img 粘贴图片**：`{ "type": "img", "label": "压缩这张图片", "extensions": ["png", "jpeg"] }`。仅当 Quick 输入框带图片上下文时命中；`extensions` 是小写无点扩展名白名单（最多 16 项，缺省接受任意图片）。图片以 `onEnter` 的 `input.images[].dataUrl` 交付。
- **files 粘贴文件**：`{ "type": "files", "label": "批量处理文件", "extensions": ["txt", "md"], "minCount": 1, "maxCount": 20, "allowDirectory": false }`。仅当带文件上下文时命中；数量边界 `minCount`/`maxCount` 缺省 1/20，`allowDirectory` 决定是否把目录计入有效数量。文件以宿主签发的只读句柄在 `input.files[]` 交付。

```json
{
  "features": [
    {
      "code": "translate",
      "explain": "翻译文本",
      "cmds": [
        "翻译", "translate", "fy",
        { "type": "over", "label": "翻译这段文字", "minLength": 1, "maxLength": 10000 }
      ]
    },
    {
      "code": "compress",
      "explain": "压缩图片",
      "cmds": ["压缩", "image", { "type": "img", "label": "压缩这张图片" }]
    }
  ]
}
```

对象指令的字段由 schema 严格约束（`additionalProperties:false`）：未知 `type`、拼错字段、无效正则、越界数量或非法扩展名都会在安装时被拒。regex/over 与 img/files 互不混用字段。无论命中哪条 `cmds`，只要 Quick 输入框有文本，该文本也会随启动进入 `onEnter`（详见[双模式工具接口](dual-mode-tools.md#输入上下文)），插件据此把内容填入自己的工作区。新增或修改 `plugin.json` 后，需重新安装更新后的插件包、或开发插件刷新重载 manifest 才生效；改仓库源码不会更新已安装的旧包。

## 可选 Node 后端

带后端的插件声明 `"backend": { "entry": "backend/index.cjs" }`，在 `permissions` 中列出 `backend.node`，并设置 `"engines": { "enest": ">=0.2.0" }`。`main` 仍是浏览器页面 `index.html`。后端入口不是 preload，也不会通过页面资源协议暴露。用户授权后运行完整 Node.js 代码，不能按页面沙箱理解其权限边界。源码入口和依赖收集配置放在 `package.json.enestBackend`，协议与示例见[插件本机后端](backend.md)。

## 小窗、主窗和 UI

同一插件支持 `quick` 与 `shell` 两种展示模式，不定义两种包类型。`getLaunchMode()` 读取当前模式，`onModeChange()` 响应模式切换；独立窗口和[自由面板](panels.md)是挂载位置，不增加第三种模式。宽度断点不能代替启动模式，也不能假定每次移动 View 都触发模式变化。

默认 `chrome:none`、`themeAware:true`、`background:opaque`、`preferredColorScheme:auto`。使用宿主主题 token、字体和动画档位。不同容器只调整布局和可见操作，不重复创建业务状态。

## 打开方式（contributes.openWith）

插件可声明自己能处理的文件类型与 URL scheme，成为系统「打开方式」的候选。**纯声明**：插件是壳内视图而非独立 OS 应用，系统注册与「类型→插件」路由全部由壳统一负责，设置 → 通用 → 打开方式里集中管理，不新增任何插件权限。

```json
{
  "contributes": {
    "openWith": [
      {
        "id": "markdown-files",
        "extensions": ["md", "markdown"],
        "mimeTypes": ["text/markdown"],
        "schemes": ["enest-md"],
        "role": "Editor"
      }
    ]
  }
}
```

- `extensions` 小写无点扩展名；`mimeTypes` 主要供 Linux（xdg-mime）使用；`schemes` 小写不含 `://`，`enest`、`http`、`https`、`file`、`mailto` 为壳保留，跨插件重复先声明者得。
- 用户把某类型设为默认后，双击文件 / 点击链接会打开 eNest 并唤起对应插件：`onEnter` 收到 `code: 'open-file' | 'open-url'`，`payload` 为 `{ paths?, handles?, url? }`。**文件读取必须走 `localFiles.read({ handleId })`**（基础能力，无需授权），`handles` 是宿主签发的只读句柄，`paths` 仅作展示，不能绕开句柄自行访问。
- 平台能力边界：Linux 可通过 `xdg-mime` 程序化设默认，但当前支持的文件类型仍依赖壳安装包的 MIME 声明与宿主 `EXT_MIME` 映射；尚未实现插件安装后的任意扩展名/MIME 动态注册，新类型需要补齐映射与打包声明。Windows 写入 HKCU 候选、切换默认引导到系统设置；macOS 候选来自安装包声明（新类型需随壳发版），默认切换由用户在 Finder/系统设置完成。设置页对每行如实显示「系统默认 / 已注册候选 / 未注册」，不能把壳内路由选择等同于操作系统默认已修改。

## 综合插件与主题插件

综合插件在一个入口内组合功能和贡献点，每个 feature.code 路由到对应功能。业务类型不需要壳逐项注册；只声明实际使用的敏感权限，所有订阅有对应取消函数。

主题插件也使用同一标准包和 index.html 预览页。固定主题通过 `contributes.themePacks` 声明，支持 V1 包与 `schemaVersion: 2` 的完整外观包；动态编辑主题通过基础能力 `enest.theme.register(pack)` 注册，无需权限弹窗。主题 source 由宿主绑定插件，停用或卸载会撤下主题贡献。注册只增加可选项，不会自动激活主题或首页。V2 主题包可在顶层用 `palettes` 追加自己的氛围配色，id 不得覆盖宿主内置的 `theme / dawn / mint / linen / peach / ocean / forest / ink`，含 `url()` 之类的不安全画法在注册时即被拒绝。不要直接修改壳设置文件或全局 CSS 文件。

完整字段形状见[官方 manifest Schema](https://github.com/hyqf98/eNest_plugin/blob/main/docs/plugin-manifest.schema.json)；实际 API 签名由[生成类型](api-types.md)定义，不手抄权限数量或类型副本。
