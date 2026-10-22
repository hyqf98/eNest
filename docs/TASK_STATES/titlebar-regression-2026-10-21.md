# 标题栏隐藏、透明度和设置白屏回归

## 原因与修复

- `.app` 与标题栏共用 `titlebar-autohide`，宽泛的收起选择器把整个应用设为透明并禁止鼠标事件。根容器改用 `data-titlebar-state`，收起 CSS 只匹配 `header.titlebar`；stage 明确放在网格第二行。
- 原生插件视图之前可扩展到 y=0，遮住 shell 的 DOM 热区。现在最多让出 28px，保留 8px 顶部唤出区；展开恢复 36px。IPC 校验当前主窗口身份、有限数字与当前主题自动隐藏开关，同步刷新插件和 current/preparing Home 的 bounds。窗口销毁复位。
- `has-bg-media`、氛围背景原先直接覆盖标题栏底色，透明度还作用于整行内容。现在所有背景通过 `--titlebar-paint` 在 `::before` 材质层绘制，仅该层消费 `--appearance-tab-opacity`。范围为 0–1，文字、图标与窗口按钮保持不透明。
- 通用页按当前主题 Schema 的 layout binding 查实际字段 key；滑杆拖动只做 CSS 草稿预览，commit 才串行保存。保存失败、卸载或主题变化恢复宿主确认值。
- 恢复浏览器 mock 被误改的 `setPluginInset`，保留独立的 `setPluginTopInset`。

## 本轮验证

- `npm run typecheck`：通过。
- `npm run build`：通过，仍有构建器关于静态/动态 import 混用的提示。
- 受影响回归集：211 项，208 通过，3 项既有原生 gate 跳过，0 失败。范围为 renderer/layout、标题栏设置、外观 store、shared/theme、main/theme、main/home、main/ipc 和新增 titlebarBounds 单元测试，不代表全仓测试。
- `ENEST_TITLEBAR_NATIVE=1 node --test --test-concurrency=1 src/main/window/titlebarBounds.native.test.mjs`：1 项通过。启动真实 Electron BaseWindow/WebContentsView，执行生产窗口边界函数，验证 y 为 36/8/8/36/36，独立 profile 自动清理。该测试不模拟鼠标交互。
- SDK 211 个公共类型及 18 篇开发者文档生成/只读同步检查通过。
- 内置浏览器以真实鼠标操作验证：开启自动隐藏后设置页仍可操作；鼠标进入顶部展开、离开收起；背景为 0% 时 header 与 app opacity 为 1，材质层 opacity 为 0；展开 stage y=36、收起 stage y=8；classic/orb 切换控件显隐正确；重载后设置保留。
- 独立数据目录的 Electron 完整应用已打开并观察到设置页与隐藏状态正常。但桌面自动化的部分鼠标/键盘操作未产生可确认的效果，因此不把原生完整鼠标交互记为验收通过。

## 交付边界

主进程、preload 与 renderer 均有改动，必须由完整重启后的应用加载；单纯 HMR 不能替换原生布局逻辑。本轮未提交或推送代码，未改用户真实设置数据。
