# 全局背景动效接入与验收

日期：2026-10-14。

> 历史验收快照：本文保留当日行为、测试名称和结果；部分独立主题 store/测试此后已移除。现行背景设置归默认主题 Schema，架构与迁移见 [THEME_STANDARD.md](THEME_STANDARD.md)，后续验证见 [默认主题恢复记录](../TASK_STATES/eNest-default-theme-restoration-2026-10-19.md)。

设置入口：设置 → 主题 → 背景 → 背景动效。内置空间折叠、极光绸缎、引力光环、液态波纹、光域隧道；默认光域隧道。选择即时生效并持久化，支持关闭和重播启动画面。

## 行为

- 启动页、主窗口、Quick 与独立插件窗口使用同一个选择；五款启动 Logo 分别按部件组装，完成时恢复原始 SVG 几何。
- 背景动效与氛围色叠加，纯色、渐变及其强度编辑即时生效，保留当前动效和 GPU 上下文；关闭动效后氛围色独立显示，启动画面同步。图片/视频配置保留，在关闭动效后显示。
- 插件通过 `contributes.themePacks[].backgroundEffects` 或 `enest.theme.register` 提供预设变体或本插件视频。SDK 类型、两侧 manifest schema 与主题开发文档已同步。
- 插件背景被移除或禁用时回退光域隧道，保留原选择；插件恢复后可自动恢复背景。
- 低档程序背景仍缓慢移动：12 FPS、请求速度的 0.35 倍、最多 36 万像素且不监听指针。系统减少动态效果保持静态；低档视频使用海报，避免持续解码。隐藏、失焦、切换、卸载会停止或释放对应动画资源。高档 FPS 采样同样遵守可见性策略。
- 不透明插件业务页面继续由插件自身绘制；宿主背景可透过声明透明的插件内容显示。独立窗口 chrome 位于原生插件 View 下方，不改变内容 bounds。

## 初次接入验证（2026-10-14）

下列记录保留初次接入时的验证范围；同日追加的低档缓动和氛围色合成另见下节。

- `npm run typecheck`：node 与 web 完整通过。
- `npm run build`：通过；存在原有 mixed static/dynamic import 分包提示。
- `node eNest_plugin/scripts/generate-api-types.mjs --host-root . --check`：149 个公开类型一致。
- 共享目录解析、来源隔离、非法媒体路径、注册/持久化/禁用回收、主题保存竞态及 preload/mock/SQLite 往返的定向测试通过。
- 真实 Chrome WebGL 验证五款编译及不同画面、明暗主题、插件调色、隐藏/失焦停帧、当时的低档静帧、context 丢失回退和 GPU/监听器清理。低档随后改为缓慢运动，以下方追加验证为准。
- 真实 Chrome + React StrictMode 验证 canvas 重建及视频低档、失败、切换、卸载的资源释放。
- 真实 Chrome + GSAP 验证五款不同中间轨迹、最终原图像素/矩阵一致、重复组装与清理、取消后不回调、可见性暂停。
- 浏览器实际设置按钮验证五款选择及刷新保留、键盘选择、插件选项与回退、关闭动效、Quick 和重播；零页面异常。
- `ENEST_BACKGROUND_SMOKE=1 node --test src/main/window/backgroundEffects.smoke.test.mjs`：最终构建上通过。使用临时数据根、独立 userData、真实 preload/IPC、真实插件资源协议；验证五款主窗口/启动匹配、Quick 同步、动态插件来源绑定、视频加载、独立窗口同步、禁用回退、刷新后的启动与工作台一致、关闭移除。该 opt-in 测试需要 Electron 桌面环境与 ffmpeg。
- detached renderer 的更新测试 16 项通过；其原有独立原生窗口截图测试因未启用专用开关跳过。本次原生背景集成由上面的 background smoke 验证，不声称完成多系统原生合成画面验收。

专项组合运行（detached 视频异常测试追加前）为 67 通过、1 个上述 opt-in 测试跳过；追加后的 detached 文件已单独重新验证。未执行与本功能无关的全仓测试。

## 同日追加：氛围色合成与低档缓动

- `backgroundAtmosphere.test.mjs` 使用真实 Chrome、React 设置控件和 WebGL；故意让持久化请求保持未完成，点击晨曦/深海立即改变可见像素，当前动效仍为光域隧道，GPU 程序没有重建。氛围强度归零后截图与原始背景逐字节一致。
- `backgroundEffect.test.mjs` 的低档检查验证时间推进后像素变化、绘制预算不超过 36 万像素；系统减少动态效果另验静帧，二者不混同。
- `backgroundComponent.test.mjs` 验证氛围色更新不重建 canvas；`detached-plugin.test.mjs` 验证渐变、纯色与清空切换不重启 GPU，`useTheme.test.mjs` 与共享 helper 检查用户/主题包背景来源解析。
- 最新定向组合：主题/独立窗口/共享背景/颜色校验 38 通过、1 个 opt-in 原生窗口测试跳过；背景组件/WebGL 11 通过；氛围色真实控件 1 通过；窗口拖拽/FPS/持久化 30 通过。
- 最终合并构建上的 `ENEST_BACKGROUND_SMOKE=1 node --test src/main/window/backgroundEffects.smoke.test.mjs` 已重新通过（1/1）：主窗、Quick、独立窗口和启动预览同步渐变与纯色，关闭动效后仍显示同一氛围色；五款切换、插件预设/视频、禁用回退和刷新持久化同轮通过。使用隔离数据根与 userData，未更改用户设置。

## 视觉证据

截图在本次工作产物目录：

`/Users/haijun/.codex/visualizations/2026/10/14/01a13922-b1dd-7892-975d-50d41dd5f989/`

- `settings-effects-dark-final.png`：实际设置页，背景遮罩 42%、模糊 5px，卡片 88% 表面。
- `home-effect-dark-final.png`：主窗口背景。
- `startup-effect-dark-final.png`：完整品牌标志、标题和说明；截图使用减少动态效果的静态预览，运动轨迹另由 GSAP 测试验证。
- `background-settings-browser-qa.json`：浏览器交互验收结果。
- `enest-atmosphere-before.png`、`enest-atmosphere-dawn.png`、`enest-atmosphere-ocean.png`：真实设置控件切换前后，同一光域隧道叠加晨曦/深海的像素证据。

主进程与 preload 有改动，已有开发进程需重启后使用完整功能。未提交或推送 Git；未改用户现有持久化设置。
