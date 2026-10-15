# 氛围色、拖动性能与设置按钮验收

日期：2026-10-15。

## 原因与修改

氛围层原先仅用 soft-light 混合，低饱和与深色预设容易被背景动效吞没；页面和卡片又叠加较厚的底色。无动效时，卡片遮罩甚至随强度增大而变厚。

现在使用轻着色层与保留动效明暗纹理的颜色混合层，并通过独立的氛围变量给标题栏、首页卡片、设置面板、输入框和下拉框轻染色。Quick 和独立插件窗口的宿主区域共用同一套处理。文字与选中态继续使用主题语义色，强度 0 退出氛围染色；不改写插件自身不透明业务界面。

原强度滑块每次变化都会保存主题并广播刷新；刷新产生的新动效对象触发 WebGL 画布重建。同时 App 根组件订阅完整主题，导致整组主题模式与颜色 Token 编辑器重复渲染。

现在滑块以 1% 步进即时显示，按动画帧合并预览，结束手势时保存最终值；键盘、失焦、取消与卸载均完成提交，闲置 240ms 提供兜底。主题根组件和设置区域只订阅所需状态，效果选择器使用 memo。动效只在实际渲染参数变化时重建，颜色保存广播不会重建画布。已有异步写入队列与过期读取保护保留，旧保存回执不能覆盖正在预览的值。

“关闭动效”和“重播启动画面”移至同一操作行，具有常态背景、边框与焦点反馈。设置页目录/连通/更新等次要按钮、插件设置入口及账号辅助操作也补齐同类样式；开关、图标按钮与 chip/segmented 选中态保留各自语义。

## 验证

| 检查 | 结果 |
| --- | --- |
| 类型检查、生产构建、diff 格式检查 | 通过 |
| 主题状态、持久化和共享背景契约 | 31/31 通过 |
| 氛围、表面、组件生命周期与独立窗口 | 24 通过，1 项可选原生检查未启用而跳过 |
| 真实设置页浏览器验收 | 1/1 通过，覆盖浅深主题 × 有无动效 × 强度 0/50/100 共 12 个场景 |
| 按钮布局与状态 | 760/1200 宽度、浅深主题、常态/悬停/键盘焦点与关闭动效选中态通过 |
| 表面像素与文字对比 | 晨曦/深海可见色差；黑/白/红/绿/蓝最大强度下，抽样标题栏和主卡片正文/说明文字对比度均 ≥4.5:1 |

持久化测试夹具同时补齐了 Electron preload 现有依赖的 `process.isMainFrame`，不改变实际业务行为或校验断言。

## 同场景拖动对比

在完整设置页连续拖动三次，结束值依次为 90%、10%、80%。修复后的滑块精度从 5% 提升至 1%，因此输入事件更多。

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 滑块 input 事件 | 38 | 72 |
| 主题保存 / 广播 | 38 / 38 | 3 / 3 |
| 新建 WebGL 程序 | 38 | 0 |
| 画布是否保持原实例 | 否 | 是 |
| 主题模式区渲染次数 | 228 | 12 |
| 颜色微调区渲染次数 | 228 | 12 |

三次按住拖动阶段均为零持久化、零主题模式区/颜色微调区重渲染，松开各保存一次。上述渲染计数来自 Vite 开发态 React StrictMode，包含开发态重复渲染；预览控件自身仍随输入更新。

性能与页面检查使用隔离 Chrome、Apple M2 Metal 和浏览器 mock bridge。记录了 rAF 间隔，但不将它当成 Electron 原生输入延迟，也不据此声称所有硬件达到固定帧率。正式 Electron 实例与数据未操作。

## 证据

目录：`/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere`。

- [浅色动效与氛围](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/browser-final/light-tunnel-100.png)、[深色动效与氛围](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/browser-final/dark-tunnel-100.png)
- [修复前浅色同场景](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/browser-baseline/light-tunnel-100.png)、[性能与手势对比数据](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/browser-comparison.json)
- [主题与持久化测试](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/theme-persistence-tests.log)、[表面验证](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/surface/validation.log)、[浏览器验收日志](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/browser-final.log)
- [类型检查](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/typecheck.log)、[构建](/Users/haijun/.codex/visualizations/2026/10/15/01a13e20-d83b-77c2-a45f-044e19fbcd8f/enest-atmosphere/build.log)

本轮均为 renderer 与其测试修改，开发模式可通过 HMR 加载。未执行 commit 或 push。
