# 首页、设置、通知与拖入安装验收

日期：2026-10-15

## 本轮完成范围

- 首页使用插件市场发布索引和本地实际插件 manifest，移除生产目录中的模拟补齐。展示作者、版本、标签、同版本包大小、真实推荐标记和目录数量；保留分类默认两行及更多/收起。优化推荐区域、卡片信息层次、刷新和离线空状态。仓库没有的下载量、评分和每插件更新时间不补造。
- 设置页普通按钮、输入框、自定义下拉统一为 36px，开关为 40×24px，整理代理、路径、字体和插件设置字段的对齐。自定义下拉支持键盘定位与 Portal 防裁切，颜色字段使用自绘色板；精简重复说明，保留重启、权限、冲突、文件限制和错误信息。
- 插件卡片卸载、详情卸载/更新、开发插件移出共四处确认框统一为主题化弹框，默认聚焦取消，支持 Esc、遮罩取消、键盘焦点循环和关闭后焦点归还；只有确认后才执行操作。
- 统一通知支持纯文本、HTML 白名单、Markdown、标题、级别、停留时间，以及居中/右下角位置。通过插件 `enest.ui.toast` 暴露，兼容旧调用。富文本安全处理、链接限制、计时暂停、关闭过渡、主题和动画档同步均已接入。
- 支持 `.zip` 与 `.enestplugin` 拖入安装。拖动时显示加号蒙版，松开后右上角显示实际安装阶段、进度、成功或失败。最多同时处理 3 项，等待任务可滚动查看；失败保留到手动关闭，成功短暂停留后退出。发布包仍需在根目录包含 `plugin.json`，与原有格式采用同一套安装校验。

安装蒙版、安装进度和通知均由宿主管理的原生视图承载，可显示在插件 `WebContentsView` 上方。安装结束后只保留右上角面板区域，空闲视图自动回收。插件编辑器的普通文件 drop 仍交给插件；安装路径只能来自隔离 preload 获取的可信拖入文件。

## 验证与证据

| 检查范围 | 结果 |
| --- | --- |
| 全仓 `npm run typecheck` | node + web 通过 |
| `npm run build` | 通过，含 native prebuild 与许可证产物步骤 |
| 安装浮层/拖入桥接/IPC/preload/通知协议定向回归 | 23/23 通过 |
| 市场映射、下载与搜索 | 26/26 通过 |
| 插件仓库市场资产 | 10/10 通过 |
| 自定义下拉真实浏览器交互 | 1/1 通过 |
| 四处确认入口的真实浏览器交互 | 1/1 通过，确认/取消/键盘/焦点/窄屏 |
| 通知真实浏览器交互与富文本安全 | 1/1 通过 |
| macOS Electron 通知原生验证 | 1/1 通过 |
| macOS Electron ZIP 原生拖入验证 | 1/1 通过 |
| SDK 类型及文档同步 | 154 个类型、17 篇文档通过 |
| 两个仓库 `git diff --check` | 通过 |

详细记录：

- [最终类型检查日志](ui-polish-validation-2026-10-15/typecheck.log)、[构建日志](ui-polish-validation-2026-10-15/build.log)、[23 项定向回归日志](ui-polish-validation-2026-10-15/focused-tests.log)。
- [首页布局与真实市场数据](market-realdata-validation-2026-10-15.md)：真实的 35 条本地发布索引快照，1440/900/390px，浅深主题、搜索、分类展开/收起、离线与空目录。
- [设置界面](settings-ui-validation-2026-10-15.md)：文末为本轮控件与对齐验收，附通用、主题、快捷键、开发者、代理、字体截图。
- [通知协议、原生层和富文本](notification-validation-2026-10-15.md)：主窗/Quick/独立窗归属、卡片区域、隐藏暂停、恢复计时、关闭回收及主题同步。
- [ZIP 原生验证 JSON](install-surface-validation-2026-10-15/evidence.json)：可信 CDP 文件拖拽、真实安装 worker 进度、ZIP/.enestplugin 安装、坏包报错、普通文件透传、空闲回收。
- [加号蒙版](install-surface-validation-2026-10-15/native-zip-target.png)、[安装进度](install-surface-validation-2026-10-15/native-zip-progress.png)、[安装完成](install-surface-validation-2026-10-15/native-zip-complete.png)、[错误结果](install-surface-validation-2026-10-15/native-zip-error.png)。

## 验证边界

原生测试均使用临时 `dataRoot`/`userData`，没有修改日常插件数据。文件拖拽通过 Chromium CDP 生成可信 File 事件，实际经过隔离 preload、主进程队列和生产安装 worker；未执行 Finder 鼠标拖动。不同系统对 `.enestplugin` 的 MIME 判断可能不同，空 MIME、通用二进制 MIME 的放行与安全分流另有 6 条隔离 preload 测试，不把它们算作系统 MIME 实测。

原生截图是各浮层 WebContents 的截图；其位于插件之上由真实 View 列表和顺序断言验证。通知 Quick fixture 为稳定检查层级关闭了失焦监听，没有覆盖通常的 Quick 失焦收起行为。

本轮未在 Windows/Linux 真机运行原生拖拽或弹层验收，也未发布远程插件索引。未执行 `git commit`/`push`。主进程和 preload 已变更，现有开发实例需要重启 `npm run dev`。

## 安装专项复现

```bash
npm run build
node --test src/preload/installDropBridge.test.mjs src/main/window/installSurface.test.mjs src/main/ipc/ipcSecurity.test.mjs src/preload/pluginEvents.test.mjs src/shared/notification.test.mjs
ENEST_INSTALL_SURFACE_SMOKE=1 ENEST_INSTALL_SURFACE_EVIDENCE="$PWD/docs/engineering/install-surface-validation-2026-10-15" node --test src/main/window/installSurface.native.test.mjs
```
