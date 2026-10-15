# 设置界面修复验收（2026-10-15）

## 完成内容

1. Quick 预设 A、预设 B、自定义组合键始终为同一行的三张卡片；自定义卡点击后展开录制与保存。保持原有冲突校验和录制恢复行为。
2. 插件快捷键按已安装插件自动分组显示图标、名称、启动和添加快捷键操作，不再用下拉框选择插件。启动位置使用分段按钮，保留同插件多绑定。详情入口只定位插件，不隐藏其他插件；已移除插件的遗留绑定仍可删除。
3. 所有插件统一移除设置页和安装详情里的权限长表，基础能力继续沿用后台策略，敏感能力的宿主授权与实例边界保留。已持久化的拒绝可通过详情里的“重新授权”改回下次询问，只有存在拒绝时显示该操作。
4. 插件数字与文字输入框、自定义下拉统一高度、主题、焦点和窄屏布局；无效数字恢复已保存值。原下拉已经是自定义 Select，数字输入框此前漏了样式。
5. 个人资料 GitHub 按钮仅在请求中禁用，主进程分别返回缺少 OAuth 应用、缺少授权服务或服务地址无效的提示。CI 构建步骤接收三个公开 ENEST_GITHUB_* Repository variables，配置方法见 [账号登录接入](account-login.md)。

用户已确认尚未创建 GitHub OAuth App；本次完成交互提示和构建接入，未完成真实 GitHub 账号授权。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| npm run typecheck（node + web） | 通过 |
| npm run build（含许可证产物步骤） | 通过 |
| 快捷键、录制、设置、mock、认证专项 | 59/59 通过 |
| PermissionService + pluginPermissionPolicy | 26/26 通过 |
| packaging tests | 9/9 通过 |
| 快捷键浏览器 smoke | 1/1 通过，1200/800px 三卡同排、无溢出 |
| macOS Electron 原生 smoke | 1/1 通过，录制、原生视图复用、窗口迁移、重启和卸载清理 |
| 插件设置浏览器隔离检查 | 字段编辑保存、非法值回退、浅深主题、640px 布局、授权恢复及失败重试通过 |
| git diff --check | 通过 |

快捷键浏览器与原生 smoke 已随界面更新选择器。原生个人资料实际点击确认按钮可用，缺配置时显示具体错误，pending 会话为空。系统真实物理按键未测试；Windows/Linux 原生行为本轮未验证。插件设置检查使用隔离 mock fixture，不等同于全部插件业务 E2E。

## 证据

证据目录：`/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings`

- [浏览器快捷键宽窗口](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/shortcuts-browser-wide.png) / [窄窗口编辑器](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/shortcuts-browser-narrow.png)
- [原生快捷键与行为结果](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/native-evidence.json) / [原生个人资料错误提示](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/native-profile-login-unconfigured.png)
- [插件设置浅色](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/plugin-settings-light.png) / [深色](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/plugin-settings-dark.png) / [自定义下拉](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/plugin-settings-dropdown.png)
- [插件授权恢复结果](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-settings/plugin-result.json)

浏览器与原生截图中的快捷键冲突提示来自验证场景，不代表初始页面错误。原生截图使用独立测试插件与临时数据目录；正式开发实例的数据未修改。

主进程认证提示与授权文案有变更，现有开发实例需重启 npm run dev 才能载入。未执行 git commit 或 push。

## 追加：设置控件与排版统一（2026-10-15）

本节补充本轮界面调整，不替代上方历史验收记录。新增 `src/renderer/styles/settings.css`，规则仅作用于设置页：普通按钮、文本/数字输入和自绘下拉统一为 36px；开关统一为 40×24px；字段列、代理、路径操作、主题卡和字体区域按共同网格对齐。页面不再显示重复功能介绍、立即生效说明、内部 Token 名称和装饰性动效文案；保留硬件加速重启提示、字体格式/5MB 限制、登录授权、快捷键冲突、保存错误、背景互斥以及下次启动生效等必要信息。

既有 Select 增加方向键、Home/End、输入定位、Enter/Space 确认、Esc 取消、Tab 关闭、禁用项跳过与焦点恢复。Select 和颜色面板通过 Portal 固定在视口，靠近底部时向上展开，并在滚动、尺寸变化时重新定位。背景和插件设置的原生颜色选择已替换为现有自绘色板。设置区域扫描已无 `<select>` 或 `input type="color"`；文本输入继续保留语义 input。

### 本轮验证

- `npx tsc --noEmit -p tsconfig.web.json`：通过。
- `ENEST_SETTINGS_UI_SMOKE=1 node --test src/renderer/components/select.browser.test.mjs`：1/1 通过。验证键盘选择、禁用项、取消不提交、焦点恢复、Portal 防裁切、底部翻转、自绘颜色 hex 修改。
- 独立浏览器 mock：通用、主题、快捷键、开发者页面截图与按钮尺寸检查通过，主要动作均为 36px。
- 900px 浏览器窗口：HTTP 代理为 184px/88px 两列，控件均高 36px，容器 `scrollWidth=clientWidth=280`；设置页无横向溢出。字体预设、上传按钮、滑杆布局已目视检查。
- 本节记录的是隔离浏览器 UI/控件验证，不是 Windows/Linux 原生窗口或完整插件业务 E2E。完整构建及其他代理负责范围由主验收汇总。

### 本轮截图

- [通用](settings-ui-validation-2026-10-15/general.png)
- [主题](settings-ui-validation-2026-10-15/appearance.png)
- [快捷键](settings-ui-validation-2026-10-15/shortcuts.png)
- [开发者](settings-ui-validation-2026-10-15/developer.png)
- [900px 代理行](settings-ui-validation-2026-10-15/proxy.png)
- [900px 字体区域](settings-ui-validation-2026-10-15/font.png)

截图来自各页可见区域；主题和通用长页未以一张图片覆盖全部内容。开发者图的 tab 高亮捕获处于切换过渡，但内容与操作按钮已经切换，不能将该截图单独视为 tab 状态验证。

## 追加：共享操作确认弹窗（2026-10-15）

开发插件移出、首页卡片卸载、插件详情卸载和更新四处 `window.confirm` 已替换为共享异步 `confirmAction` 与 `ConfirmDialog`。弹窗使用现有主题 Token、按钮样式和 GSAP 动画档位；卸载使用危险操作色。仅挂载于壳的首页/设置视图，未扩展插件确认 API 或主进程能力。

默认焦点为取消；Esc 和遮罩点击取消；Tab / Shift+Tab 在按钮间循环，关闭后归还触发按钮焦点。HTML dialog 的模态层使背景不可交互，Esc 在捕获阶段拦截以保留下层详情弹窗。已有请求时，新请求返回取消而不叠加，防止同一次确认执行多个操作；切换视图或卸载宿主时取消等待中的请求。

- `npx tsc --noEmit -p tsconfig.web.json`：通过。
- `ENEST_CONFIRM_UI=1 node --test src/renderer/components/ConfirmDialog.browser.test.mjs`：1/1 通过，真实 Chromium 操作上述四个 React 入口；业务桥接使用隔离 mock，无真实卸载/更新。
- 覆盖取消与确认、Enter 默认取消、初始焦点、Tab 循环、背景焦点隔离、焦点归还、Esc 保留下层详情、遮罩取消、重复请求拒绝、宿主卸载取消、390px 无横向溢出。未调用原生 `window.confirm`。
- 截图为隔离组件 fixture：已目视检查弹窗浅色、深色及窄屏；完整壳窗口由总验收报告记录。

证据：[浅色卸载](settings-ui-validation-2026-10-15/confirm-uninstall-light.png)、[深色更新](settings-ui-validation-2026-10-15/confirm-update-dark.png)、[窄屏移出](settings-ui-validation-2026-10-15/confirm-remove-narrow.png)、[结构化结果](settings-ui-validation-2026-10-15/confirm-result.json)。
