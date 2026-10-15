# 应用图标、开发名称与首页分类修复

日期：2026-10-15。已修改源码和本地插件构建产物，未提交或发布。

## 应用图标与名称

原 Dock PNG 使用放大的主体，且原图存在游离灰白短线。清除游离像素后，主体从旧 Dock 的 959 px 高缩至 824 px，缩小 14.1%，按原比例居中于 1024 × 1024 透明画布。打包 PNG、ICNS 与运行时 Dock 使用同一基准。

Windows ICO 重新生成 16/20/24/32/40/48/64/128/256 共 9 档。小尺寸使用 32 位 BGRA DIB，并逐像素校验 AND 透明遮罩；256 档使用 RGBA PNG。ICNS 经 iconutil 解包核验 10 档普通/Retina 表示。PNG 四角 alpha 均为 0。

`npm run dev`、`npm start`、`npm run dev:debug` 现在通过 `src/main/dev/devLauncher.mjs` 启动私有缓存中的 `eNest.app`。应用包名称、图标和开发 bundle ID 正确，保持 Electron 开发模式；不修改 node_modules 原件。macOS AppKit 实测 `NSRunningApplication.localizedName=eNest`。主进程同时设置应用名称，保留既有 userData 路径，Windows AppUserModelId 对齐 `com.enest.shell`。

启动器为 Vite/Electron 分配独立 POSIX 进程组，信号转发至整组并提供有界清理；真实 npm dev 的 SIGTERM/SIGHUP 检查均未遗留 Electron/helper。Windows 使用进程树终止分支，尚未实机验证。

## 插件图标

问题来自此前 23 个浅色线条图标统一加上深色底板，以及按 URL 包含插件 ID 再补黑底的 CSS；计算器原图也是黑底。本次将 24 个图标改为各自配色，保留图形并统一内边距；同步全部 35 个官方 SVG 快照。

旧安装包通过 `enest://` 图片响应按已知旧 SVG 内容 SHA256 精确匹配，返回新彩色图标，不覆盖用户文件。远程兼容限定官方 GitHub 默认路径及记录的旧版本。自定义图标、第三方图标、未来版本和动态 glyph 不受该兼容规则影响。

插件仓库的图标源、同步脚本、旧签名表和 `docs/PLUGIN_ICONS.md` 一并更新。24 个受影响插件已重新构建，源码与 dist 图标字节一致；尚未发布新插件包。

## 首页分类

插件列表按效率、开发、设计、媒体、其它分区，保留自定义分类。每区按实际列数默认显示两行：3 列 6 个、2 列 4 个、1 列 2 个。超过时显示“更多（剩余数量）”，各区独立展开/收起。未展示的卡片不挂载；缩窄窗口移除当前聚焦卡片时，焦点返回分类展开按钮。搜索、已安装筛选及分类筛选继续可用。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；保留既有静态/动态混合导入提示 |
| 图标兼容、市场元数据、插件文件、首页搜索回归 | 28/28 通过 |
| macOS 原生开发 bundle 身份 | 1/1 通过，原生名称 eNest，原 Electron 依赖未改 |
| 真实 npm dev 进程退出 | SIGTERM/SIGHUP 2/2 通过，无残留进程 |
| 原生旧图标兼容 | 8/8 个隔离安装包返回彩色 SVG，原包文件未改；首页与时间戳 Tab 图片加载成功 |
| 原生 classic/orb Tab 图标回归 | 1/1 通过，动态图标、恢复默认及关闭回收正常 |
| 36 个真实 manifest 的隔离浏览器页面 | 1440/900/390 宽度、两行/展开/收起、筛选、搜索/Escape、深浅色、中英文通过，无页面异常 |
| 插件仓库 manifest / 图标快照 | validate 通过，35 个快照一致 |
| 24 个插件构建及图标产物 | 通过，源码/产物字节一致 |
| 两仓库 `git diff --check` | 通过 |

证据保存在 [验证目录](icon-home-validation-2026-10-15/)：

- [应用图标三种底色预览](icon-home-validation-2026-10-15/app-icon-backgrounds.png)、[透明通道和格式指标](icon-home-validation-2026-10-15/icon-assets.json)
- [原生开发名称](icon-home-validation-2026-10-15/app-native-identity.tap)、[启动器退出](icon-home-validation-2026-10-15/launcher-lifecycle.json)
- [插件彩色图标表](icon-home-validation-2026-10-15/plugin-colors.png)
- [首页浅色](icon-home-validation-2026-10-15/home-light.png)、[开发分类](icon-home-validation-2026-10-15/home-development.png)、[深色](icon-home-validation-2026-10-15/home-dark.png)、[窄窗口](icon-home-validation-2026-10-15/home-narrow.png)、[浏览器记录](icon-home-validation-2026-10-15/browser-checks.json)
- [原生已安装旧插件页面](icon-home-validation-2026-10-15/native-installed-icons.png)、[旧包兼容记录](icon-home-validation-2026-10-15/native-icons.json)、[Tab 回归](icon-home-validation-2026-10-15/native-tab-regression.json)

浏览器使用真实源码组件和本地 manifest/SVG 的隔离 fixture；原生检查使用临时 profile 和测试插件包。没有修改用户安装状态、业务数据或设置。未执行全仓库全部测试，未进行 Windows 实机视觉验收，也未验证旧 Windows 安装的系统图标缓存。Windows 需使用新构建安装包获取新 ICO；macOS 开发模式需退出旧进程后重新运行 npm 命令。
