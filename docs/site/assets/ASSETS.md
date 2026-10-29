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

## 本次原生界面素材

`screens/native-*.webp` 采集于 2026-10-29 的 macOS 开发实例（宿主源码版本 `0.2.3`），不是早期浏览器预览素材。采集时临时停止原开发实例，同时使用独立的 `ENEST_TEST_USER_DATA` 与 `ENEST_TEST_DATA_ROOT`。演示目录仅复制本地已构建的计算器、JSON 工具、Markdown 编辑器与番茄钟插件，版本均为 `0.0.1`；没有复制用户数据库、插件记录或私人文件。

原生窗口通过 CUA 的可见界面操作并截图，保存为 WebP。Markdown 文档、JSON 和任务名称是为产品展示现场输入的公开演示内容；权限询问选择「暂不允许」，未读取真实剪贴板、建立连接、登录账号或上传文件。主窗口显示该隔离环境的四个已安装插件，不代表官网目录只有四个插件。

| 文件 | 原生画面与处理 |
| --- | --- |
| `screens/native-shell-light.webp` | 默认主题浅色插件市场，1200 × 800；关闭演示环境的背景动效 |
| `screens/native-shell-dark.webp` | 同一隔离主窗口的深色模式，1200 × 800 |
| `screens/native-quick-empty.webp` | Quick 全局搜索空输入状态，720 × 248；应用名称来自系统应用目录，不包含使用记录或文件内容 |
| `screens/native-quick-search.webp` | Quick 输入「番茄钟」后的真实搜索结果，720 × 171 |
| `screens/native-quick-plugin.webp` | 番茄钟的真实 Quick 布局，720 × 545；任务名称为公开演示文字 |
| `screens/native-markdown.webp` | Markdown 编辑器内输入的产品演示文档，1200 × 800；未保存为用户文件 |
| `screens/native-json.webp` | JSON 工具对公开示例执行格式化后的真实结果，1200 × 800 |
| `screens/native-panel-pomodoro.webp` | 自由面板内的番茄钟专用 `panel` 组件，240 × 240；从原生面板画面裁切，不重绘 UI |
| `screens/native-panel-calculator.webp` | 自由面板内计算器的真实兼容视图，752 × 674；演示计算 `25 * 4 + 15 = 115`，从原生面板裁切，不重绘 UI |

Quick 由设置页中真实的插件快捷键「立即启动」入口打开，再使用「返回全局搜索」采集搜索状态。截图证明所显示的原生界面状态，不代表系统快捷键、跨平台兼容性、权限、拖动手感、多屏恢复或全部插件已完成验收。自由面板网页场景是原生插件画面与生成壁纸的 HTML 组合演示，不是操作系统桌面截图，也不是无限画布或系统桌面小组件。

自由面板网页场景中的 Markdown 窗口复用 `screens/native-markdown.webp` 的主窗口实拍内容，仅在网页中通过 CSS 裁去顶部 36px 宿主栏；查看原图仍展示完整截图。这只是网页排列示意，不是 Markdown 原生 `panel` 截图。本次没有生成或交付 `native-panel-markdown.webp`，也没有用合成界面补足缺失的原生截图。

采集结束后已停止隔离实例，恢复不带上述隔离环境变量的普通开发实例，并删除临时 PNG、隔离用户数据和演示数据目录；仅保留列出的正式 WebP 资产。

## 生成的背景素材

两张背景使用内置 `image_gen` 生成，共两次调用、无修订。仅生成场景底图，不生成或修改软件窗口、文字、产品标志和插件图标。PNG 输出经 FFmpeg 编码为本地 WebP，均为 1586 × 992。它们是 AI 生成的装饰素材，不是实拍桌面或软件功能证据。

| 文件 | 作用 |
| --- | --- |
| `scenes/porcelain-light.webp` | 首屏瓷白空间与柔和光影；左侧和中央留出真实标题、窗口与轨道图标的位置 |
| `scenes/sage-desktop.webp` | 自由面板演示的浅鼠尾草色抽象壁纸；窗口由网页另行叠加 |

### 首屏背景生成提示词

> Use case: ads-marketing. Asset type: wide product-website background, no foreground product. Create an extremely refined, minimalist porcelain-white architectural light study for a plugin desktop app named eNest. Landscape approximately 16:10. Almost-white porcelain (#F5F7F4), extremely subtle pale sage undertones, a large soft elliptical pool of sunlight and one gently curved pale ceramic surface toward the lower right. Soft physically plausible ambient shadows, restrained spatial depth, no dramatic architecture. Leave the left half and central area airy and quiet for HTML typography and real software window compositing. Editorial product photography quality, matte materials, diffuse daylight. This is only a background plate. Absolutely no text, letters, logos, icons, software UI, screens, devices, furniture, people, or gradients in purple/blue. No visual noise or ornamental objects. The edges should blend toward near-white.

### 自由面板壁纸生成提示词

> Use case: ads-marketing. Asset type: calm desktop wallpaper to support real draggable application windows on a software product website. A beautifully restrained abstract landscape in porcelain white, silvery sage green and light cool gray. Wide landscape 16:10 composition. Broad soft ribbon-like rolling hills flowing diagonally across only the bottom third, subtle matte paper/ceramic surfaces and soft diffuse morning daylight, quiet expansive empty upper and central areas. Apple-quality desktop wallpaper restraint, no shiny plastic, high resolution and clean smooth contours, natural atmospheric depth. Palette predominantly pale sage #DDE7DC and near white #F5F7F4 with touches of muted forest green #9CB5A1. Full-bleed wallpaper image, no frame. Absolutely no people, furniture, objects, screens, devices, UI windows, icons, text, logos, watermarks, purple, blue neon, particles, or busy texture. This is a background only; real captured application windows will be layered by HTML later.

## 本地字体

- `fonts/manrope-latin.woff2`：Manrope 拉丁字符可变字体，400–800。
- `fonts/noto-sans-sc-subset.woff2`：Noto Sans SC 中文字符子集，400–800。它只覆盖采集时的字符集，不保证包含之后新增的全部文案。
- `fonts/fonts.css`：本地 `@font-face`，使用 `font-display: swap`；字体栈保留 `system-ui, sans-serif` 回退，新增字符可由系统字体显示。
- 字体来自 Google Fonts，原始下载地址与版本记录见 `fonts/sources.json`；原始中文子集列表保存在 `fonts/noto-sans-sc-characters.txt`。
- 两种字体均使用 SIL Open Font License 1.1，完整许可为 `fonts/manrope-OFL.txt` 与 `fonts/notosanssc-OFL.txt`。

文案维护不要求重新下载字体。确需更新子集时保留来源记录、字符集与完整许可，并保持无远程字体时的可读回退；不要为了官网文案安装新的字体处理工具。
