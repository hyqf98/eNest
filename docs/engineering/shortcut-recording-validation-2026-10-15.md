# 快捷键录制与本地路径验收（2026-10-15）

## 交互与注册

- Quick 自定义与插件快捷键共用录制输入框。点击或聚焦后开始录制，修饰键和完整组合键立即显示；松开主键、恢复宿主快捷键后才提交草稿。没有单独的录制按钮。
- 完成录制后自动检查冲突，显示占用者；检查期间与冲突未确认时禁止普通保存。旧检查结果不能授权新输入。
- 用户明确点击“确认覆盖并保存”后，可替换 eNest 的 Quick 或插件绑定。原插件绑定停用并保留，原 Quick 被替换时关闭。关闭状态的绑定可直接保存，启用时重新检查。
- 确认令牌限时、单次使用，并核对当前占用配置；占用变化或确认过期会要求重新确认。原生注册和双方持久化配置统一保存，失败回滚。系统、其他应用与插件运行时快捷键无法强制覆盖。
- 录制期间暂时停用 eNest 全局快捷键，并对当前窗口忽略 Electron 菜单快捷键，避免 Cmd+W、Cmd+Q 等菜单操作抢占录制。Esc、失焦、离开页面、进程退出和超时均回收录制状态、恢复菜单响应。慢 IPC 返回前也能实时预览按键。
- Windows/Linux 的 Win、Super、Command 等原生等价别名统一比较；Shift 符号按 Electron 的实际解析规则归一化，避免漏报冲突。
- Wayland 静默检查不试注册，避免仅编辑输入框就触发系统授权。保存后显示“等待系统确认”，收到实际快捷键回调后才显示已生效；Linux desktopName 与桌面文件标识已对齐。

## 本地路径

统一入口为 `src/main/paths/userPath.ts`，使用 Node 的 `path.posix`、`path.win32` 和 `os.homedir()`，没有增加路径框架依赖。

| 输入 | 解析规则 |
| --- | --- |
| `~`、`~/Plugins/demo` | 当前用户目录；Windows 同时支持 `~\Plugins\demo` |
| `.`、`./demo`、`../demo` | 按调用方显式提供的绝对 `baseDir` 解析 |
| `C:\Plugins\demo`、`\\server\share\demo` | Windows 盘符绝对路径与 UNC 共享路径 |
| `C:demo`、`~otheruser`、网址、SSH 目标 | 明确拒绝，避免产生意外的本地目录 |

已接入开发插件路径、数据根目录与打开本地路径入口。当前这些入口的相对路径基准沿用进程工作目录；新设置保存绝对路径。历史版本将 `~` 当作普通目录名时，若旧目录实际存在则保留旧目录引用，避免数据目录静默切换。打开路径通过主进程调用 `shell.openPath`，失败会回传实际错误。

该模块只解析本地路径，不代替 `realpath`、目录边界或文件句柄授权；未改变 SSH 远端路径与插件文件权限。

## 验证范围

本地环境：macOS arm64，Electron 44.4.3，Node 22.22.1。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`、`npm run build` | 通过；构建保留原有静态/动态导入分块警告 |
| 快捷键、录制、设置、路径与 IPC 专项 | 98/98 通过，包含菜单忽略状态的归属、续租、超时与释放 |
| 浏览器设置 smoke | 1/1 通过；按下与松开之间检查预览、自动检查冲突、显式覆盖、Quick/插件保存失败后保留草稿并显示真实错误 |
| macOS Electron 设置与插件生命周期 smoke | 1/1 通过；确认前原绑定保留、确认后原绑定停用，实例复用、迁移、重启与卸载清理正常 |
| macOS 独立原生快捷键注册 | 1/1 通过；真实 `globalShortcut` 注册、归属冲突、独立释放与全部清理 |
| macOS 最终构建菜单忽略检查 | 4 项断言通过；真实 IPC 开始、续租、旧令牌结束、有效令牌结束的调用序列为 `[true, false]`，未发送按键 |
| 打包配置专项 | 9/9 通过 |
| `git diff --check` | 通过 |

Windows/Linux 的等价键与路径分支已做逻辑测试，并添加 `.github/workflows/shortcut-platforms.yml` 的 macOS、Windows、Linux X11 原生注册矩阵。工作区未提交或推送，CI 尚未运行；本机也没有 Windows/Linux 桌面运行环境，因此不能宣称这两个平台的原生验收通过。Wayland 系统授权仍需在已安装应用的真实桌面测试。

浏览器使用隔离 mock，Electron 使用临时数据目录。测试没有发送真实系统按键，也没有修改正在运行的正式开发实例数据。原生注册通过不等同于所有操作系统保留组合键都可捕获。

主进程与 preload 已变更，需重启 `npm run dev` 后使用。

## 证据

证据目录：`/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording`。

- [原生冲突与确认按钮](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/native-shortcut-conflict-confirm.png)
- [浏览器完整布局](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/browser-settings-wide.png)、[保存失败反馈](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/browser-save-failure.png)
- [原生行为结果](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/native-evidence.json)、[原生注册日志](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/native-registry-macos.log)
- [原生菜单与录制恢复](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/native-menu-guard.json)
- [专项测试](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/targeted-tests.log)、[浏览器测试](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/browser-smoke.log)、[类型检查](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/typecheck.log)、[构建日志](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-shortcut-recording/build.log)

截图里的冲突来自专门的验证场景；浏览器 mock 的原生注册提示不代表 Electron 注册失败。
