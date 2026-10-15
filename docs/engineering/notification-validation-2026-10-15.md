# 统一通知验收 · 2026-10-15

通知现已使用统一协议和卡片：默认右下角，可选居中，兼容旧的顶部位置、`message` / `type` 字段及宿主 `html` 别名。支持标题、正文、纯文本 / HTML / Markdown、级别与停留时间。Electron 下由宿主创建卡片大小的原生 `WebContentsView`，确保在主窗、Quick 和独立插件窗中位于插件内容之上；浏览器预览复用同一卡片。

## 行为和安全边界

- 标题最多 120 字符、正文最多 16000 字符。纯文本默认 4200ms，富文本默认 6500ms，正文超过 500 字符默认保持显示。可显式设置 0 或 1500–60000ms。
- 每个来源最多 10 条 / 10 秒，每窗最多 8 条；右下角同时 3 条，居中和顶部各 1 条。悬停、焦点进入、宿主隐藏 / 最小化时暂停计时。
- HTML 在 inert template 中解析，再按白名单重建。脚本、内联事件、样式、图片、iframe、SVG、表单等不会进入卡片。Markdown 不支持原始 HTML 或图片。
- 链接仅允许无凭据的 HTTP(S) / mailto，并由宿主专用 IPC 打开。通知视图没有设置、插件管理或 `enestShell` bridge。
- 插件通知来源由宿主填写；实例关闭时回收所属通知。原生视图只覆盖卡片区域，不抢焦点；支持关闭按钮、卡片内 Esc 和 reduced-motion。
- 手动切换主题、主题包或动画档，会同步刷新已显示的通知。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（node + web） |
| notification / ipcSecurity / pluginEvents 定向测试 | 14 / 14 通过 |
| Chromium 通知组件验收 | 1 / 1 通过 |
| macOS Electron 通知原生验收 | 1 / 1 通过，最终运行约 10.5 秒 |
| 插件 SDK 类型生成及同步检查 | 154 个 public types、17 篇 guides 通过 |

浏览器验收覆盖恶意 HTML / Markdown、无图片追踪请求、悬停暂停、焦点内 Esc、队列上限、390px 窄屏和 reduced-motion。浅色 / 深色截图已检查。

原生验收通过真实插件 bridge 调用通知，分别覆盖主窗 HTML 居中、Quick Markdown 右下角、独立窗纯文本居中；验证原生容器归属、View 层级、卡片尺寸、危险节点清除、最小 bridge、原插件输入值保留，以及手动关闭和自动销毁。最终卡片区域分别为 476×147、410×171、476×119px。

补充原生断言覆盖：已显示通知随手动主题 / 动画档刷新；1500ms 通知在隐藏宿主 1900ms 后仍保留，显示后按剩余时间关闭；插件返回主窗后，关闭实例会清理其持久通知。

证据：[原生状态 JSON](notification-validation-2026-10-15/evidence.json)、[主窗通知](notification-validation-2026-10-15/enest-native-notification-shell.png)、[Quick 通知](notification-validation-2026-10-15/enest-native-notification-quick.png)、[独立窗通知](notification-validation-2026-10-15/enest-native-notification-detached.png)、[浅色](notification-validation-2026-10-15/enest-notification-light.png)、[深色](notification-validation-2026-10-15/enest-notification-dark.png)。

## 复现

```bash
npm run build
node --test src/shared/notification.test.mjs src/main/ipc/ipcSecurity.test.mjs src/preload/pluginEvents.test.mjs
ENEST_NOTIFICATION_UI=1 node --test src/renderer/components/NotificationHost.test.mjs
ENEST_NOTIFICATION_SMOKE=1 node --test src/main/window/notificationOverlay.smoke.test.mjs
```

浏览器测试默认使用 macOS Google Chrome，可通过 `ENEST_CHROME_PATH` 指定二进制。原生脚本使用临时 dataRoot / userData，完成后删除；不会修改日常插件状态。

验证边界：本次原生测试运行于 macOS，未在 Windows / Linux 真机验收。为避免其他桌面焦点变化影响视图层级检查，隔离的 Quick fixture 移除了 blur 监听，未覆盖通常的 Quick 失焦收起行为。原生截图为通知 WebContents 单独截取，不是操作系统合成窗口截图；通知高于插件的结论来自真实原生 View 列表与层级断言。

API 示例与限制见 [插件 API 文档](../site/plugin/api.md) 的 `ui.toast` 小节。
