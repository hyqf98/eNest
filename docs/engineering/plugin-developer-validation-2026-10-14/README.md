# 插件启动与开发者操作验证

验证日期：2026-10-14。平台：macOS，实际 Electron 窗口，独立临时数据根与用户配置。

## 修复与原因

- SSH 的源码清单默认指向 `127.0.0.1:5173`，本机该端口实际运行 Nexus。开发入口现通过服务端 `/plugin.json` 校验插件身份；服务不存在或身份不符时使用该插件自身的有效 `dist`。重新加载也重新识别入口，并保留原源码目录。
- 插件加载时先隐藏原生 WebContentsView，让壳显示“正在启动”；页面及主题就绪后才显示原生内容。修正活动插件 ID 与渲染层 Tab ID 不一致的问题，使中间状态能实际展示。
- DevTools 被插件网络策略误挡。仅放行 Electron 原生 remote inspector 使用的内置 DevTools 资源；普通插件页面的请求仍受既有策略约束。
- 开发者页面删去预览方式、HMR 标记、调用跟踪和退出即杀操作；实际开发日志与控制台输出显示在日志区。“移出”只移除开发注册，保留源码、已安装包和插件数据。

## 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过。
- 以下定向回归：86 通过、1 跳过、0 失败。跳过项为原有的可选独立窗口原生烟测。

```bash
node --test src/main/dev/devPluginEntry.test.mjs src/main/dev/devPluginsStore.test.mjs src/main/plugin/PluginHost.test.mjs src/main/plugin/pluginSessionPolicy.test.mjs src/renderer/stores/shellStore.test.mjs src/renderer/detached-plugin.test.mjs
```

- 实际 Electron 烟测：1 通过、0 失败。

```bash
ENEST_DEVELOPER_SMOKE=1 node --test src/main/plugin/pluginDeveloper.smoke.test.mjs
```

该烟测从项目根运行，要求已构建壳与真实 SSH 插件。它使用真实 SSH 构建产物，验证工作台完成初始化、64 个按钮、存储桥接、开发日志、DevTools 前端实际加载；通过开发者 UI 移出后验证源码和已安装包仍存在，重开已安装 SSH 后存储哨兵值仍为 `keep-me`。

另用受控本地开发服务验证 `dist → 匹配身份的开发服务` 重新识别，以及加载期间原生视图隐藏、壳显示旋转指示和“正在启动”、加载后原生视图可见。

## 证据与边界

- [evidence.json](./evidence.json)：机器可读结果。
- [ssh-ready.png](./ssh-ready.png)：真实 SSH 工作台。
- [plugin-starting.png](./plugin-starting.png)：真实主窗口的加载中状态。

本次覆盖插件启动、开发工具和移出保留数据；未连接实际远端 SSH 服务器，未声称 Windows/Linux 原生验证。截图加载状态附近的通知来自烟测刚完成的开发注册操作。
