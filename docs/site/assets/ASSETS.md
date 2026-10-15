# 官网资源说明

更新日期：2026-10-14。站点仅引用本目录的静态文件，不依赖嵌套插件仓库或远程字体服务。

## 插件目录与图标

- `catalog.json`：当前 `eNest_plugin/plugins/*/plugin.json` 的离线快照。收录 34 个工具，排除 `com.example.hello` 与 `com.enest.theme-demo`。
- `plugins/{slug}.svg`：逐一复制相应插件 `public/assets/market/icon.svg`。保留官方插件标志，未重绘。
- 字段：`id`、`slug`、`name`、`description`、`category`、`icon`；已有官网截图时附 `screenshot`。名称、说明和分类来自 manifest，首页可另外使用简短展示文案。
- 分类数量：效率 12、开发 16、设计 2、媒体 2、其它 2。更新插件时同步 manifest 快照、图标和首页静态目录，不能只改计数。

## 复用的插件市场截图

下列截图来自对应插件 `public/assets/market/screenshots/01-main.png`。2026-10-14 逐张视觉核对，无加载失败、错误页或真实私密业务信息。以 RGB / WebP quality 90 / method 6 压缩，不修改界面内容或合成数据。

| 文件 | 尺寸 | 画面与数据 |
| --- | --- | --- |
| `screens/database.webp` | 1280 × 800 | 数据库真实工作台，隔离的订单库查询示例和 8 行结果 |
| `screens/clipboard.webp` | 1200 × 800 | 剪贴板工作台，仅含“让常用工具回到工作流里。”演示文本 |
| `screens/markdown.webp` | 1200 × 800 | Markdown 编辑与预览，默认欢迎示例笔记 |
| `screens/translate.webp` | 1200 × 800 | 翻译真实初始态，没有声称已完成翻译 |
| `screens/middleware.webp` | 1200 × 800 | 中间件真实未连接初始态，没有声称已建立业务连接 |
| `screens/net-kit.webp` | 1200 × 800 | 网络调试台 HTTP 真实初始态，无已发送请求或业务响应 |

以上六张插件 WebP 共约 138 KiB。这些文件用于对应插件的界面介绍；初始态截图不能证明联网、连接或调试请求已经成功。

## 本轮隔离采集的界面

以下资源来自当前真实宿主 renderer / 插件界面和隔离演示 fixture。采集服务是本轮临时工具 `/tmp/enest-site-preview-server.mjs`，提供 renderer 预览、插件静态资源及演示 API；它不属于静态站点运行依赖，也不随 GitHub Pages 发布。

| 文件 | 来源与画面 |
| --- | --- |
| `screens/shell.webp` | 真实宿主 renderer 的浅色插件市场，1280 × 720；插件名称、图标和介绍来自当前 manifest，安装状态由演示 fixture 提供 |
| `screens/shell-dark.webp` | 同一宿主 renderer 的深色插件市场，1280 × 720 |
| `screens/shell-ambient.webp` | 同一宿主 renderer 的氛围背景演示，1280 × 720；使用宿主已有背景效果 |
| `screens/workspace.webp` | 真实主工作台 renderer、标签栏与数据库插件界面组合，1280 × 720；标签和活动插件由隔离 fixture 提供 |
| `screens/quick.webp` | 真实 Quick renderer 的插件搜索结果，720 × 249；结果来自当前 manifest 的演示索引 |
| `screens/detached.webp` | 真实 `src/renderer/detached-plugin.html` 外框与数据库插件界面，1000 × 640 |
| `screens/ssh.webp` | 当前 SSH 插件界面，1280 × 720；连接、终端及远程内容来自插件测试 fixture |
| `screens/screen-assistant.webp` | 本轮重新采集的真实屏幕助手编辑器，1265 × 791；载入官网截图后，在实际插件 UI 中拖动绘制箭头与矩形框 |

上述 `screen-assistant.webp`、`quick.webp`、`workspace.webp` 的尺寸已通过 Pillow 读取实际文件核对。

屏幕助手素材源图为本轮官网截图 `/tmp/enest-site-captures/home-desktop-before.jpg`，通过隔离 fixture 载入当前真实插件。采集时在实际编辑器 UI 中完成两步操作：拖动画一条箭头，再拖动画一个矩形框，最后采集编辑器画面并转换为 WebP。它取代了最初的海岸插画示例；标注由插件交互生成，未在图片转换阶段合成。该过程验证了隔离环境中的两步标注交互，不代表系统级截图或录屏能力已完成原生验收。

采集复用的基础数据入口：`eNest_plugin/scripts/preview-fixture.mjs`、`eNest_plugin/scripts/tests/database-fixture.js` 与 `eNest_plugin/scripts/tests/ssh-fixture.js`。宿主 `enestShell`、`enestWindows` 的演示桥接由临时采集服务提供；数据库、SSH 和供应商数据均为演示状态，不读取个人连接配置或真实远程业务系统。

**验证边界：**浏览器预览使用 iframe 放置插件界面，替代原生 `WebContentsView`；截图没有验证 Electron 原生窗口层级、置顶、焦点、拖动、回收、快捷键注册或真实网络连接。真实 renderer 截图、隔离 fixture 操作和原生窗口端到端验收是三类不同证据，不能互相替代。

这些文件均转换为本地 WebP。复采时使用当前 renderer 和相应插件，重新建立上述隔离演示状态；先确认界面没有错误、遮挡或敏感数据，再导出、转换并替换。临时采集脚本不是永久构建工具，后续环境不能假设 `/tmp` 文件仍然存在。

## CC Switch 主展示调整

本轮尝试采集当前 CC Switch。其 `src/css/main.css` 的 `.page { display: flex; ... }` 覆盖页面元素的默认 `hidden` 表现，隔离浏览器预览出现多页同时显示；当前样式仅对 `.modal[hidden]` 做了显式隐藏。因此没有把这张异常界面发布为主展示，也没有在截图中通过隐藏 DOM 来掩盖问题。

首页开发场景的第四个预览改为 `screens/net-kit.webp`（网络调试台真实初始态）。`CC Switch` 的 manifest、名称和官方图标仍保留在 34 个工具目录中。官网改动不包含对此插件缺陷的修复；后续插件修复并重新采集、核验后可以恢复供应商切换预览。

## 本地字体

- `fonts/manrope-latin.woff2`：Manrope 拉丁字符可变字体，400–800，约 24 KiB。
- `fonts/noto-sans-sc-subset.woff2`：Noto Sans SC 中文按字符子集，400–800，当前约 170 KiB；覆盖页面文案和 34 个插件的名称、描述、分类。
- `fonts/fonts.css`：本地 `@font-face`，均设 `font-display: swap`。建议字体栈：`'Manrope', 'Noto Sans SC', system-ui, sans-serif`。
- 字体来源为 Google Fonts；下载 URL、版本和采集日期见 `fonts/sources.json`。`fonts/noto-sans-sc-characters.txt` 保存请求的完整字符集。
- 两种字体均遵循 SIL Open Font License 1.1，完整许可保存在相邻 `*-OFL.txt` 文件中。

更新中文文案时收集首页、下载页、脚本界面文案和插件目录中的非 ASCII 字符，合并去重后，用 Google Fonts CSS2 的 `Noto Sans SC:wght@400..800&text=<URL 编码字符集>` 下载新的 WOFF2 并替换本地文件及 `unicode-range`；同步字符集与来源记录。不必下载完整 CJK 字体。字体下载失败时保留系统字体回退。
