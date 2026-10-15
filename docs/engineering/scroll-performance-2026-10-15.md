# 首页与设置页滚动优化验证

日期：2026-10-15。

此次减少滚动过程中的重复背景采样与下拉面板定位工作。继续使用原生纵向滚动，没有增加 wheel 拦截、平滑滚动代理或滚动时降低背景画质；用户的背景、主题、动画档设置保持原样。

## 已确认的问题与修改

- 动态背景启用时，首页 19 张已展示卡片和 5 个未选中分类按钮各有一层 `backdrop-filter: blur(10px)`。设置外观页整页已有背景模糊，内部 4 张设置卡片和 4 个按钮又重复模糊背景。移除这些内容表面的独立模糊，保留标题栏与设置整页的玻璃层；首页可用卡片的底色不透明度由 72% 调到 88%，禁用卡片保留原有区别。分类与分段控件的激活态规则未改。
- `useAnchoredPopover` 捕获全部滚动事件，包括浮层自己的选项滚动；每次都读取锚点矩形、面板高度并提交新的位置对象。现在忽略面板内部滚动，将其他滚动/resize 合并到一帧，位置未变时复用原状态。打开时仍同步定位，外层滚动继续跟随锚点。
- 检查了纵向页面、轮播和背景 canvas：页面没有持续的纵向滚动 React 更新，轮播已有离屏/失焦暂停，背景主题读取已缓存。因此没有增加新的监听、虚拟滚动或背景重建逻辑。

修改文件：`src/renderer/styles/app.css`、`src/renderer/styles/market.css`、`src/renderer/components/useAnchoredPopover.ts`。

## 页面前后测量

测量使用实际 App、`eNest_plugin/dist/registry.json` 的 35 条真实目录记录和本地发布媒体，仅安装标志及宿主连接为隔离测试状态。相同 Chromium 155.0.8059.79 / Apple M2 ANGLE Metal、1440 × 900 CSS 像素、DPR 2、浅色主题、中动画档、`tunnel` 背景，无 CPU 限速。

首页与设置外观页分别执行 3 轮，先完成全部 before，再修改并完成全部 after。每轮通过 CDP `Input.synthesizeScrollGesture` 发送向下 1800px、向上 1800px 的鼠标滚动，速度 650px/s，约 5.7 秒；没有用 JavaScript 逐帧写 `scrollTop` 模拟滚动。每轮开始前归零滚动位置。

下表均为各 3 轮的中位数。Task/Script 是 CDP `Performance` 累计值的差；Layerize/Paint/Raster/PrePaint 是 trace 同名完整事件的 `dur` 累加。它们是不同管线阶段的观测，不应相加为总耗时。

| 场景 | 指标 | 修改前 | 修改后 |
| --- | --- | ---: | ---: |
| 首页 | 主线程 TaskDuration | 525.4 ms | 390.1 ms |
| 首页 | Layerize 合成准备 | 178.7 ms | 20.7 ms |
| 首页 | ScriptDuration | 52.5 ms | 69.3 ms |
| 首页 | Paint | 11.9 ms | 15.8 ms |
| 首页 | RasterTask | 12.7 ms | 15.5 ms |
| 首页 | PrePaint | 22.8 ms | 33.2 ms |
| 首页 | rAF 调度频率 | 59.78 Hz | 59.62 Hz |
| 首页 | rAF 间隔 P95 | 16.7 ms | 16.7 ms |
| 设置外观页 | 主线程 TaskDuration | 251.4 ms | 220.9 ms |
| 设置外观页 | Layerize 合成准备 | 0.617 ms | 0.592 ms |
| 设置外观页 | ScriptDuration | 28.1 ms | 23.2 ms |
| 设置外观页 | Paint / RasterTask | 0 / 0 ms | 0 / 0 ms |
| 设置外观页 | PrePaint | 27.2 ms | 21.7 ms |
| 设置外观页 | rAF 调度频率 | 59.74 Hz | 59.87 Hz |
| 设置外观页 | rAF 间隔 P95 | 16.8 ms | 16.8 ms |

首页 Layerize 中位耗时减少 88.4%，TaskDuration 减少 25.7%；设置页 TaskDuration 减少 12.1%。但首页 Script、Paint、Raster、PrePaint 没有同步下降。三个轮次累计超过 25ms 的 rAF 间隔：首页 2 → 5，设置页 8 → 2。不能据此得出卡顿率或实际显示帧率稳定改善的结论。

测量期间同机仍有开发工具和其他浏览器功能验收活动，未隔离系统负载，顺序 A/B 也有缓存与热机差异。这里确认的是本机 headless 场景的合成准备工作减少；rAF 约 60Hz、P95 基本不变，不代表 Electron 桌面呈现帧率或跨平台体验承诺。LayerTree 在本环境没有返回可用层列表，摘要中的 `layers: 0` 不用于结论；上述模糊表面数量来自 DOM 的实际计算样式，且不包含一直隐藏的安装蒙版。

## 下拉面板行为验证

实际 Chromium wheel 输入让浮层内部滚动 840px，产生 12 次 scroll 事件：

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 锚点 `getBoundingClientRect` 调用 | 12 | 0 |
| React 提交 | 12 | 0 |
| 同一帧 20 次 resize 的锚点读取 | 20 | 1 |
| 坐标不变的 React 提交 | 1 | 0 |
| 外层滚动 40px 后面板跟随距离 | 40px | 40px |

该测试通过 Vite 测试加载器读取修改前 hook 的副本做对照，没有切换或覆盖生产文件。回归与既有控件键盘、禁用项、焦点恢复、颜色弹层边界测试合计 **2/2 通过**，无浏览器异常。首页和设置截图已目视检查，文字、控件与层次正常。

```bash
ENEST_SETTINGS_UI_SMOKE=1 node --test \
  src/renderer/components/useAnchoredPopover.browser.test.mjs \
  src/renderer/components/select.browser.test.mjs
node docs/engineering/scroll-performance-2026-10-15/profile.mjs current
```

最后一条命令对当前代码采集新结果，不覆盖本次 before/after 摘要；需本机安装 Chrome，且 4197 端口可用。它使用实际目录与发布资产，不适合缺少 `eNest_plugin/dist` 的干净 CI 环境。

## 证据

- [修改前摘要](scroll-performance-2026-10-15/before.json)、[修改后摘要](scroll-performance-2026-10-15/after.json)。
- [面板修改前](scroll-performance-2026-10-15/popover-before.json)、[面板修改后](scroll-performance-2026-10-15/popover-after.json)。
- [首页修改前](scroll-performance-2026-10-15/before-home.png)、[首页修改后](scroll-performance-2026-10-15/after-home.png)。
- [设置修改前](scroll-performance-2026-10-15/before-settings.png)、[设置修改后](scroll-performance-2026-10-15/after-settings.png)。
- [采样脚本](scroll-performance-2026-10-15/profile.mjs)。
- 四份原始 trace 共约 90.6 MB，保存在本机 `/tmp/enest-scroll-performance-2026-10-15/`，未放入仓库交付目录；该目录同时保存修改前 CSS 和 hook 副本，临时目录可能被系统清理。

生产改动及新增测试的 diff 格式检查通过。全量 typecheck/build 由主任务在所有并行修改稳定后统一执行，本报告不代替该结果。
