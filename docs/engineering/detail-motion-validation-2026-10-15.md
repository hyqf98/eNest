# 插件详情展开 / 缩回动画验收

日期：2026-10-15。最终浏览器验收 **1 / 1 通过，覆盖 11 组场景，零页面运行错误**，运行约 25.6 秒。

## 数据与方法

使用实际 `App`、市场卡片、精选轮播、搜索结果、`PluginDetailModal` 和截图预览组件。目录来自本地 `eNest_plugin/dist/registry.json` 的 35 条真实发布快照，经宿主 `parseRemoteMarket` / `remoteToSummary` 映射；截图、图标及 README 使用本地发布媒体。快照生成时间为 `2026-10-13T14:07:25.796Z`；安装标记与宿主调用采用隔离测试状态。

测试通过真实按钮点击、键盘和鼠标滚轮驱动界面。每个 rAF 记录弹窗与来源节点的实际边界、计算后 transform / opacity、动画阶段、页面 scrollTop 和视口大小，不冻结 GSAP 或 CSS，也不以几何公式单测替代界面验证。

## 通过的场景

| 场景 | 验证内容 |
| --- | --- |
| 网格入口，中档 | 从点击卡片附近展开，收起时回到该卡片；背景真实 wheel 不滚动，关闭后恢复位置并可继续滚动 |
| 详情交互 | README 正文可独立 wheel 滚动；首次焦点进入关闭按钮，Tab / Shift+Tab 循环；关闭后焦点回到真实触发按钮 |
| 嵌套截图预览 | Esc 只关闭上层大图预览，详情保持打开 |
| 精选入口，中档 | 从当前真实产品 slide 展开并缩回来源 |
| 搜索入口，中档 | 从实际搜索结果行展开并缩回；关闭后保留查询文字 |
| 快速关闭 | 开场期间 Esc 可中断，最终不残留遮罩 |
| 开场中 resize | 弹窗收敛到当前视口内 |
| 退场中 resize | 正常销毁遮罩并恢复滚动样式 |
| 高档 | 仍使用真实来源几何，拍摄开场 / 退场中途图 |
| 低档 / reduced-motion | 低档实际位移不超过约 6px、缩放保持轻微；reduced-motion 所有采样帧均为 identity transform |
| 来源丢失或离开视口 | 保持当前位置淡出，不飞向旧坐标；覆盖真实 DOM 移除和来源移动到视口外 |

机器结果包含 11 组独立记录；上表将部分组按交互语义合并。中途截图前后记录仍分别处于 `opening` / `closing`，确保图片来自真实过渡阶段。已目视检查最终网格开场、退场及搜索开场图片；图标与文字在几何变化早期淡出，避免短时非等比压缩。

## 证据

- [逐帧结果与截图前后状态](detail-motion-validation-2026-10-15/detail-motion-checks.json)
- [网格开场中途](detail-motion-validation-2026-10-15/opening-mid.png)
- [网格退场中途](detail-motion-validation-2026-10-15/closing-mid.png)
- [搜索开场中途](detail-motion-validation-2026-10-15/search-opening-mid.png)
- [网格展开完成](detail-motion-validation-2026-10-15/grid-open.png)
- [搜索展开完成](detail-motion-validation-2026-10-15/search-open.png)
- [缩放窗口后](detail-motion-validation-2026-10-15/resized-open.png)

## 复现

```bash
ENEST_DETAIL_MOTION_TEST=1 \
ENEST_DETAIL_ARTIFACT_DIR=docs/engineering/detail-motion-validation-2026-10-15 \
node --test src/renderer/components/PluginDetailMotion.browser.test.mjs
```

可通过 `ENEST_CHROME_EXECUTABLE` 指定 Chromium 二进制。共享 fixture 为 `src/renderer/components/marketBrowserFixture.test.fixture.mjs`；包含 `.test.` 标记，避免许可证收集器将测试依赖算作生产 renderer 依赖。

本次环境是 macOS 上的 headless Chrome 155.0.8059.79，主视口 1440×1000，并检查 900×760 与 1000×800 的窗口变化。这里验证浏览器组件交互及实际动效轨迹，不代表 Windows / Linux 原生验收，也不据 rAF 采样声称桌面 FPS 或系统触控板手感提升。滚动性能的独立 A/B 数据与限制见 [滚动性能报告](scroll-performance-2026-10-15.md)。

## 集成检查

- `npm run typecheck`：主进程与 renderer 全量通过。
- `npm run build`：最终代码完整构建通过，包含 postbuild 许可证收集；保留 8 个 UI 运行时包的许可说明。构建仍有已有的静态/动态导入混用提示。
- `ENEST_CONFIRM_UI=1 node --test src/renderer/components/ConfirmDialog.browser.test.mjs`：1/1 通过，确认取消更新/卸载不会误关底层详情。
- 设置控件与下拉滚动回归：2/2 通过，详见滚动性能报告。
- `git diff --check`：通过。未提交或推送代码。

本轮修改限于 renderer 与测试/验证资料，开发模式可通过 HMR 更新。前后测量使用相同真实市场快照，未改写用户的插件数据或偏好设置。
