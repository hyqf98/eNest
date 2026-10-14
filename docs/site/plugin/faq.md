# FAQ

## 开发

**Q：必须用 React/Vue 吗？**
A：不必。任意静态 HTML 即可。main 固定为 index.html。开发期使用 development.main；显式预览 dist 时以 dist 为运行根。

**Q：`window.enest` 和 `window.zapi` 什么关系？**
A：同一对象的两个名字。`zapi` 是 `@deprecated` 历史别名（保留兼容，计划 v2 移除）——新代码直接用 `window.enest`。

**Q：能 `require('electron')` 或调 Node API 吗？**
A：不能。插件运行在隔离 View 中，只能走白名单 IPC（`enest.*`）。

**Q：改了 `plugin.json` 权限没生效？**
A：关闭该 Tab 重新打开；仅 HMR 不会重读清单。

**Q：`id` 能改吗？**
A：安装后尽量不要改。`id` 决定安装路径与 `persist:plugin-{id}`，改了等于新插件，旧数据仍在旧目录。

## 运行

**Q：为什么关掉 Tab 内存就下来了？切走的 Tab 呢？**
A：关 Tab 即 `webContents.close()`，无保活。切走的 Tab 先保活（仅 `setVisible(false)`），但后台空闲 3 分钟或存活插件超过 6 个会被 **休眠**（销毁渲染进程、保留逻辑 Tab 与 `storage.session` 快照，再次激活重建并恢复快照）。dev 白名单插件不休眠。

**Q：插件崩溃了怎么办？**
A：首次 crash 壳子自动重启（回到原容器，session 快照恢复）；连续第二次 crash 不再自动重启，Tab 显示崩溃态等用户手动重开。

**Q：多插件数据会串吗？**
A：不会。session partition 按插件隔离；存储 API 也落在各自数据目录。

**Q：插件能读其它插件或壳子 DOM 吗？**
A：不能跨 View 访问。协议仅映射自身根目录，并防路径穿越。

## 发布

**Q：怎么打包插件？**
A：规范扩展名为 `.enestplugin`（zip，内含 `plugin.json`），可直接拖入壳子安装。

**Q：要提交 node_modules 吗？**
A：不要。仓库提交源码、资源和依赖锁文件；发布包只放经校验的 dist 内容，不提交构建产物。

**Q：市场审核 / 权限展示？**
A：当前版本提供内置示例市场。**授权发生在运行时**：插件调用已声明且尚未授权的敏感能力时，壳子弹「本次允许 / 总是允许 / 拒绝」授权弹窗（60s 无响应按本次拒绝；拒绝会记住为 deny，可在 插件设置 → 权限管理 改回）。私有存储、UI、设置、主题等基础能力无需声明或授权；manifest 只列实际使用的敏感能力，见 [权限说明](permissions.md)。
