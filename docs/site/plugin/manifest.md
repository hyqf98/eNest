# plugin.json 契约

manifest 是插件身份、资源和能力的唯一声明。源码、发布构建、宿主安装器都校验同一契约；非法包会被拒绝，不猜测入口。

| 字段 | 约定 |
|---|---|
| id | 小写反向域名，源码目录名与其一致；不能使用宿主保留标识 enest.builtin |
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
| features | code、explain、cmds 声明启动指令 |
| contributes | settings、homeCards、railEntries、themePacks 等声明式扩展 |

资源路径不得包含绝对路径、URL、反斜杠、点段、隐藏段、百分号编码或查询片段。`logo`、任意 main 路径和单独 settings HTML 入口已移除；设置使用 contributes.settings 或插件内页面。

## 可选 Node 后端

带后端的插件声明 `"backend": { "entry": "backend/index.cjs" }`，在 `permissions` 中列出 `backend.node`，并设置 `"engines": { "enest": ">=0.2.0" }`。`main` 仍是浏览器页面 `index.html`。后端入口不是 preload，也不会通过页面资源协议暴露。用户授权后运行完整 Node.js 代码，不能按页面沙箱理解其权限边界。源码入口和依赖收集配置放在 `package.json.enestBackend`，协议与示例见[插件本机后端](backend.md)。

## 小窗、主窗和 UI

同一插件支持 `quick` 与 `shell` 两种容器，不定义两种包类型。`getLaunchMode()` 读取实际容器，`onModeChange()` 响应切换；宽度断点不能代替启动模式。

默认 `chrome:none`、`themeAware:true`、`background:opaque`、`preferredColorScheme:auto`。使用宿主主题 token、字体和动画档位。不同容器只调整布局和可见操作，不重复创建业务状态。

## 综合插件与主题插件

综合插件在一个入口内组合功能和贡献点，每个 feature.code 路由到对应功能。业务类型不需要壳逐项注册；只声明实际使用的敏感权限，所有订阅有对应取消函数。

主题插件也使用同一标准包和 index.html 预览页。固定主题通过 `contributes.themePacks` 声明；动态编辑主题通过基础能力 `enest.theme.register(pack)` 注册，无需权限弹窗。主题 source 由宿主绑定插件，停用或卸载会撤下主题贡献。不要直接修改壳设置文件或全局 CSS 文件。

完整字段形状由插件仓库 `docs/plugin-manifest.schema.json` 定义；实际 API 签名由[生成类型](api-types.md)定义，不手抄权限数量或类型副本。
