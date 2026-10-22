# 默认主题参数适配与 Quick 两行搜索

## 参数核对与修复

静态追踪默认主题 45 个字段的 Schema → Profile → ResolvedAppearance → 实际消费者：

- 13 个颜色 Token 走共用语义变量；字体导入/删除和资源由宿主提供。
- density/gap/contentWidth/columns 由默认 Workspace 消费；Tab 风格、自动隐藏与背景不透明度由主壳处理。
- 控件/卡片/面板圆角与描边走 appearance 变量；通知六项样式走独立通知渲染与 CSS。
- 背景 kind/palette/color/media/opacity/fit 解析为实际媒体/氛围；共享动效与图片/视频互斥保持不变。媒体填充说明明确不影响氛围与动效。
- 修复 font.scale 只改根字号、固定 px 文字不变化的缺口。增加 `--appearance-font-scale`，主壳/设置/Workspace/详情/通知显式像素字号按14px基线消费一次；Quick 使用 rem，不额外重复乘比例，不缩放窗口几何。
- 默认主题为 Latin/CJK 提供独立默认栈，修改一槽时保留另一槽的默认；移除英文 Georgia 预设中会遮蔽中文选项的 Songti SC。
- 关闭共享背景动效后，显式启动图片优先于静态氛围背景；共享动效仍有最高优先级。字体槽位本地预览同步组合正式字体栈。

此核对为源码事实，不等同真实窗口逐项验收。未声明的 sidebarWidth/texture/warmth 等常量不算本次主题参数适配范围。主窗布局、Tab/启动画面等语义不应套用到 Quick 原生几何或任意业务插件 DOM。

## 两行主题选项

- 氛围配色和背景动效统一四列、最多两行，预览60px、卡片100px；名称与选择标记在同一基线，缺省/关闭卡片也保持高度。
- 窄屏保留96px最小卡宽并允许组内横向滚动，不把选项挤成不齐的多行。预览为静态SVG/图片，不额外启动动效或WebGL。

## Quick 主题同步

- 已有 `appearanceService → broadcast → Quick sink → useAppearanceSync → applyAppearanceToDom` 链路保留，隐藏窗口仍接收快照，首次懒加载先订阅后水合。
- 删除 Quick 原生 load/show/reopen/docking 时从旧 `general.animationLevel` 执行脚本覆盖 `data-anim` 的分支，只保留主题快照作为权威。
- Quick 内部圆角/边宽/文字大小使用共享主题变量；20px原生外轮廓与64px输入条保持宿主几何契约。主题感知插件保持13px内容基线及自身深浅偏好。

## Quick 搜索折叠

- 非空查询默认显示当前响应式Grid的两行匹配项，8/6/4列均按实际CSS轨道计算，跨分组累计行数。
- 有溢出时显示“更多 N”，展开全部已匹配结果，可再“收起”；查询或类别改变时重置，异步补图/provider增量不打断同查询展开状态。
- DOM与键盘共用visibleItems，隐藏结果不能被Arrow/Enter误激活；更多按钮可键盘访问，窗口高度随折叠/展开重新测量，屏幕高度上限仍由主进程兜底。
- 空查询常用项和原生插件模式保持原语义。

## 检查边界

执行 TypeScript 检查、生产构建与SDK/文档同步检查；按用户偏好未运行测试命令、GUI或真实窗口验收。相关回归测试源码同步更新，但不称为已通过。未安装新依赖、未提交或推送。
