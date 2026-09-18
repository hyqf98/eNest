# FAQ

## 开发

**Q：必须用 React/Vue 吗？**
A：不必。任意静态 HTML 即可。框架产物把 `main` 指向 `dist/index.html`，开发期用 `development.main`。

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
A：规范扩展名为 `.enestplugin`（zip，内含 `plugin.json`）。当前 zip 安装为 stub，发布链路完善前请用目录分发 + 开发者加载。

**Q：要提交 node_modules 吗？**
A：不要。只提交编译后的静态文件。

**Q：市场审核 / 权限展示？**
A：路线图项。现阶段本地 Mock 市场；生产请主动最小权限。

## 文档站

**Q：为何用 Docsify？**
A：零构建、单 `index.html` + Markdown，与 `docs/site` 静态托管（GitHub Pages）匹配。选型说明见仓库 `docs/evaluation-docs.md`。

**Q：CDN 挂了怎么办？**
A：可将 `docsify.min.js` / 主题 CSS 放到 `vendor/` 并改 `index.html` 引用（文件内有注释说明）。
