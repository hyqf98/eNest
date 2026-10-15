# 精选插件与左下角入口交互优化

日期：2026-10-15。

## 本轮行为

- 精选卡片横移采用平缓的起步和收尾；左侧文案与侧边预览的透明度跟随实际滑动位置，预览先淡出、完整文案随后淡入，消除双标题和双图标重影。保留鼠标拖动、触屏、键盘、首尾循环与减少动态效果设置。
- 窗口仍可见时，失去焦点继续自动轮播；失焦清除残留悬停、键盘焦点和拖动状态。页面隐藏、精选区域离屏、详情或截图预览打开时仍暂停，回来后恢复。
- 图片控制条改为 6px 小圆点、28px 点击范围，支持方向键、Home/End。新图加载和解码完成后交叉淡入，等待期间保留上一张。真实卡片与循环镜像共享选中的截图，离场和回环不会重置为第一张。
- 精选卡片左侧图标、名称、作者、说明和留白共用打开动作：已安装且启用时直接打开，否则进入详情；标题按钮提供键盘入口。拖动不触发打开，截图和圆点不冒泡触发插件操作。
- 左下角头像与设置图标在悬停、聚焦、设置页激活时平滑切换，低档保留轻量反馈。头像更换先解码再淡入，快速更新取最新状态；减少动态效果时仅淡化。

生产修改均在 renderer；没有修改市场数据、主进程、preload 或用户配置。开发模式可通过 HMR 更新。

## 验证

`npm run typecheck`、`npm run build`（含 postbuild 许可证收集）和 `git diff --check` 均通过。构建保留已有的静态/动态导入混用提示。

| 检查 | 结果 |
| --- | --- |
| 实际 App 综合浏览器交互 | 1/1 通过：点击、键盘、拖动防误开、禁用插件详情、首尾循环、减少动态效果、多图选择共享和预览 |
| 隔离 Electron 原生失焦 | 1/1 通过：主窗口 `hasFocus=false`、`hidden=false`，实际等待约 6.8 秒后索引 0→1，自动播放继续 |
| 图片圆点与加载状态 | 1/1 通过：真实三张截图、延迟加载保留旧帧、交叉淡化、失败跳过、快速切图、键盘和事件隔离 |
| 左下角入口 | 1/1 通过、15 项检查，覆盖三档、快速反向、头像异步切换、退出清理、减少动态效果和 DOM 命中 |
| 轮播逐帧回归 | 4/4 通过（含父测试）：226 帧未发现同一卡片两套文案同时可读；反向点击前后位移 0px，首尾循环、拖动和离屏恢复通过 |

```bash
ENEST_FEATURED_UI=1 ENEST_FEATURED_NATIVE=1 node --test src/renderer/components/FeaturedCarousel.browser.test.mjs
ENEST_PRODUCT_VISUAL_TEST=1 node --test src/renderer/components/ProductVisual.browser.test.mjs
ENEST_ORB_DOCK_UI=1 node --test src/renderer/orb-overlay.browser.test.mjs
ENEST_CAROUSEL_MOTION=1 node --test src/renderer/components/useProductCarousel.browser.test.mjs
```

综合测试采用实际 App 和本地发布仓库的 35 条目录快照。该快照每个插件只有一张截图；多图测试读取当前插件仓库 `com.enest.clipboard/plugin.json` 中声明的三张真实图片。宿主调用、安装标志及账号状态均为隔离测试数据。

原生失焦测试使用 Electron 44.4.3 / macOS，临时用户目录，焦点移到第二个原生窗口，主窗口保持可见；关闭了 Playwright 默认的持续聚焦模拟，未通过派发假的 blur 事件代替。未做 Windows/Linux 原生验证，也不将浏览器逐帧轨迹解释为跨平台 FPS 改善。左下角入口本轮验证范围是 renderer，未重复原生 WebContentsView 穿透测试。

## 证据

- [综合交互结果](featured-polish-2026-10-15/featured-ui.json)、[原生失焦结果](featured-polish-2026-10-15/native-focus.json)。
- [精选卡片与圆点](featured-polish-2026-10-15/featured-home.png)、[失焦后自动切换](featured-polish-2026-10-15/native-blurred-autoplay.png)。
- [图库逐帧与检查结果](featured-polish-2026-10-15/gallery-checks.json)、[浅色圆点](featured-polish-2026-10-15/dots-light.png)、[深色圆点](featured-polish-2026-10-15/dots-dark.png)。
- [左下角图标过渡报告](orb-dock-validation-2026-10-15.md)。
- [轮播逐帧验证记录](featured-motion-2026-10-15/README.md)、[过渡中途截图](featured-motion-2026-10-15/mid-transition.png)。

未提交或推送代码。
