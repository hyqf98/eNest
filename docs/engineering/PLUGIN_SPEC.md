# eNest 插件协议入口

当前协议的权威文档维护在 `docs/site/plugin/`，并同步到独立插件仓库的 `docs/developer/`。这里集中提供入口，避免再维护一份会漂移的 manifest/API 副本。

| 开发内容 | 文档 |
| --- | --- |
| 源码、固定加载路径、dist 与 .enestplugin | [工程与发布格式](../site/plugin/structure.md) |
| plugin.json、功能指令与组合贡献 | [Manifest](../site/plugin/manifest.md) |
| Vanilla、Vue、React、Vite | [入门](../site/plugin/getting-started.md)、[示例](../site/plugin/examples.md) |
| 源码注册、远程服务器、HMR、dist 预览 | [调试](../site/plugin/debug.md) |
| 所有 API 与类型 | [API 说明](../site/plugin/api.md)、[生成类型](../site/plugin/api-types.md) |
| 系统能力、原生授权、文件句柄和持久化 | [权限](../site/plugin/permissions.md) |
| Quick、主窗、容器响应式与主题 Token | [UI 标准](../site/plugin/ui-standard.md)、[双模式工具](../site/plugin/dual-mode-tools.md) |
| 主题预览、声明式/运行时注册、综合插件 | [主题与综合贡献](../site/plugin/themes.md) |
| 开启、隐藏、休眠、关闭、更新和卸载 | [生命周期](../site/plugin/lifecycle.md) |
| Electron 主进程、IPC、preload 与公共契约 | [宿主开发](../site/plugin/host-development.md) |

插件仓库 `docs/plugin-manifest.schema.json` 是 manifest schema 来源，生成到宿主 `src/shared/pluginManifest.schema.json`。SDK 位于插件仓库 `packages/plugin-sdk/index.d.ts`，可复用 kit 位于同仓库 packages；不依赖宿主被忽略的本地 scripts/packages。

发布插件使用最小权限集。普通包不包含外部 Node runtime；DSH 专属附加区单独保留，不属于通用页面沙箱保证。实际验证及限制见 [安全报告](PLUGIN_SECURITY_VALIDATION.md) 和 [生命周期报告](PLUGIN_SANDBOX_LIFECYCLE_VALIDATION.md)。
