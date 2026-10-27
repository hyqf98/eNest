# 官网资源说明

产品页只使用本目录内的静态图像与字体，不在运行时读取嵌套插件仓库，也不请求远程字体。资源随站点发布；插件开发文档的 Docsify 依赖另见 `../plugin/index.html`。

## 插件目录与图标

- `catalog.json` 是仓库根目录下 `eNest_plugin/plugins/*/plugin.json` 的展示快照，当前收录 **34 个插件**：效率 11、开发 15、设计 4、媒体 2、其它 2。主题插件「素描本」计入目录，源码内置默认主题不计入。
- 每项包含 `id`、`slug`、`name`、`description`、`category`、`icon`。名称、说明和分类来自 manifest；首页可采用更简短的展示说明，但不能改变能力边界。
- `plugins/{slug}.svg` 复制自对应插件 `public/assets/market/icon.svg`，保持原始图标，不重新绘制。图标快照与当前 manifest 目录一一对应。
- 更新目录时同时更新 JSON、首页静态卡片和图标。首页计数包含工具与主题，因此统一称为「插件」，不使用旧的工具数量推断当前目录。
- 目录是源码项目的展示，不是发行附件清单；安装版本与可用性以插件市场和实际发布资料为准。

## 产品标志与许可

`icons/enest-icon-256.png` 是 eNest 产品标志的站点副本，来源为宿主仓库的 `assets/icons/enest-icon-256.png`。产品与官方插件图标保留其来源标识；涉及第三方产品的名称与标志仍归各自权利人。

宿主源代码许可见仓库根目录 `LICENSE`（Apache License 2.0）。不要将宿主许可自动套用于第三方标志或供应商资源；需要再分发时核对相应来源的许可。字体使用单独的 OFL 许可，见下节。

## 既有界面截图

`screens/` 保存既有版本的实际界面展示素材，含演示数据。它们不是当前版本的逐功能截图，也不随源码更新自动改变。

以下图片由相应官方插件的市场截图转换为 WebP，原始素材位于该插件的 `public/assets/market/screenshots/`：

| 文件 | 展示内容 |
| --- | --- |
| `screens/database.webp` | 数据库工作台与演示查询结果 |
| `screens/clipboard.webp` | 剪贴板工作台与演示文本 |
| `screens/markdown.webp` | 早期 Markdown 笔记编辑与预览；当前插件为 Markdown 编辑器，界面已有变化 |
| `screens/translate.webp` | 翻译初始界面，不代表已完成联网翻译 |
| `screens/middleware.webp` | 中间件未连接界面，不代表已建立远程连接 |
| `screens/net-kit.webp` | 网络调试台初始界面，不代表已发送请求或收到业务响应 |

以下图片来自宿主 renderer 与官方插件 UI 的隔离演示环境；安装状态、连接信息和业务内容为演示数据：

| 文件 | 展示内容与来源 |
| --- | --- |
| `screens/shell.webp` | 宿主浅色插件市场界面 |
| `screens/shell-dark.webp` | 同一宿主的深色插件市场界面 |
| `screens/shell-ambient.webp` | 同一宿主的背景氛围演示 |
| `screens/workspace.webp` | 主工作台标签栏与数据库插件界面的组合展示 |
| `screens/quick.webp` | 默认 Quick 的插件搜索结果示例 |
| `screens/detached.webp` | 独立窗口外框与数据库插件界面的组合展示 |
| `screens/ssh.webp` | SSH 插件界面，连接、终端和远程内容均为演示状态 |
| `screens/screen-assistant.webp` | 屏幕助手编辑器，载入官网画面后在插件内绘制箭头与矩形标注 |

这些素材保留原有界面内容，压缩为 WebP 后本地发布；没有为更新产品文案而制作新的截图。屏幕助手中的标注来自编辑器操作，不是在图片转换时合成。

**展示边界：**隔离浏览器环境用嵌入页面展示插件，不等同于 Electron 原生 `WebContentsView`。截图不能证明系统级截图或录屏、窗口层级、置顶、焦点、拖动、多屏恢复、快捷键、权限、MCP 客户端互通或真实远程连接已通过验收。首次加载或演示数据画面也不能证明联网能力已经成功。

替换素材时应使用对应版本的实际界面，确认没有错误、遮挡和敏感数据，再导出到 `screens/`；同时更新页面尺寸、替代文本和本文件的来源说明。没有相应截图时采用文字说明，不借用其他界面冒充功能截图。

## 本地字体

- `fonts/manrope-latin.woff2`：Manrope 拉丁字符可变字体，400–800。
- `fonts/noto-sans-sc-subset.woff2`：Noto Sans SC 中文字符子集，400–800。它只覆盖采集时的字符集，不保证包含之后新增的全部文案。
- `fonts/fonts.css`：本地 `@font-face`，使用 `font-display: swap`；字体栈保留 `system-ui, sans-serif` 回退，新增字符可由系统字体显示。
- 字体来自 Google Fonts，原始下载地址与版本记录见 `fonts/sources.json`；原始中文子集列表保存在 `fonts/noto-sans-sc-characters.txt`。
- 两种字体均使用 SIL Open Font License 1.1，完整许可为 `fonts/manrope-OFL.txt` 与 `fonts/notosanssc-OFL.txt`。

文案维护不要求重新下载字体。确需更新子集时保留来源记录、字符集与完整许可，并保持无远程字体时的可读回退；不要为了官网文案安装新的字体处理工具。
