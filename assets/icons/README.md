# eNest 应用图标

`enest.svg` 是唯一几何源。运行 `node scripts/packaging/generate-app-icons.mjs` 从同一底板和标识导出两种配色；生成需要 macOS 自带的 `sips`、`iconutil` 和已有的 FFmpeg，正常开发、打包不需要重复生成。

| 使用场景 | 资源与选择规则 |
| --- | --- |
| macOS 默认分发与开发包 | `build/icon.icns`，固定为图一的墨绿版。Finder、Dock 和 Cmd-Tab 使用应用 bundle 身份；打开 Quick 不切换图标。普通 ICNS 没有系统外观变体，`light/icon.icns` 是独立可用的浅色版，不会自动选中。 |
| macOS 26+ 原生自适应分发 | `eNest.icon` 的根填充提供不透明墨绿底色，`Assets/` 只含透明的标识，不再叠第二层圆角底板。系统根据图标外观（默认或深色）选套；着色、透明效果和系统装饰仍由用户设置/macOS 决定。 |
| Windows | `build/icon.ico` 用于 EXE、快捷方式及安装器。主窗、Quick、独立窗和托盘按 Windows **系统**配色选择该 ICO 或 `light/icon.ico`，含 16–256px 多分辨率帧。固定项可能显示缓存的 EXE/快捷方式图标。 |
| Linux | `.desktop` 启动器使用 `build/icon.png` 导出的安装图标。窗口与托盘按桌面报告的配色选择普通/`light/` 目录下的 `enest-icon-256.png`；Wayland 合成器可能只看 `.desktop` 标识。 |

发布原生自适应 macOS 版：先完成正常构建，在已有完整 Xcode 26+ 的 Mac 上运行 `npx --no-install electron-builder --mac --config.mac.icon=assets/icons/eNest.icon --publish never`（其余发布参数按既有流程）。锁定的 builder 会调用 `actool`，在签名前写入 `CFBundleIconName=Icon`、`Contents/Resources/Assets.car` 和兼容旧系统的 `icon.icns`。同一发布的两个架构须使用同一选项。只装 Command Line Tools 的机器使用默认 ICNS 配置即可，不要设置不存在的 `CFBundleIconName`。

系统文件图标、正在运行的 Dock 项和第三方窗口切换器不是同一个 API；第三方还可能显示窗口缩略图或自己的缓存。不要为覆盖这些外部来源改变窗口激活、最小化或托盘行为。
