# 插件开发概览

eNest 是插件化桌面壳，采用 **清单 + Web 入口 + 受控 API**。业务功能由插件实现，主题控制可替换的呈现，宿主负责原生容器、安全、生命周期与持久化。

## 插件是什么

一个插件包含本地目录里的 **Web 应用** 与 **plugin.json 清单**，还可携带声明并授权的 **Node 后端**。
壳子负责安装、隔离运行、Tab 管理与 API 白名单；插件只关心自己的 UI 与业务。

## 运行时模型

| 层 | 说明 |
|----|------|
| Shell | 可信标题栏、Tab、权限确认、直接启动与原生设置/故障恢复；没有首启主题向导 |
| Theme Workspace | 隔离 WebContentsView：插件目录、已安装和详情；默认包随壳源码编译，其它布局可由主题插件实现 |
| Node Backend（可选） | 插件包内 backend 入口；获得 backend.node 完整本机信任后，在 utilityProcess 中运行 |
| Plugin View | 独立 `WebContentsView`，partition = `persist:plugin-{id}` |
| 协议 | `enest://plugin/{id}/...`，仅映射许可的页面与公开资源，不暴露 backend |
| API | `window.enest`（zapi 为 deprecated 别名），IPC 权限门禁 |

## 与 uTools 的差异

- eNest 面向**桌面多窗口工作台**：顶部多 Tab，不是全局呼出搜索框为主。
- 插件页面默认**进程 / 会话隔离**；Node 后端是显式信任的独立进程，不是操作系统沙箱。关闭实例按生命周期回收页面与后端资源。
- 市场支持远端 registry 与最终包资源；开发检出优先预览本地 dist，未构建时可读取源码的公开市场资源。图标、截图与 README 经宿主受控槽位提供，卡片显示安装包大小而非下载量。

## 文档结构

| 章节 | 内容 |
|------|------|
| [快速开始](getting-started.md) | 环境、最小插件、在壳子中加载 |
| [目录结构](structure.md) | 插件目录约定与必备文件 |
| [plugin.json](manifest.md) | 清单字段与完整示例 |
| [enest API](api.md) | 完整方法参考：UI / 主题 / 设置 / 存储 / 剪贴板 / 通知 / 生命周期 |
| [数据存储与私有资源](storage.md) | KV 提交回执、统一图片资源、完成文件生命周期、旧数据兼容与安全边界 |
| [插件本机后端](backend.md) | 通用 backend.call、utility 协议、依赖打包与完整 Node 信任边界 |
| [MCP 工具贡献](mcp.md) | 声明与处理器、协议调用、权限、取消和当前交付边界 |
| [自绘设置与窗口边界](settings-and-windows.md) | 私有设置、page 入口、Quick / 桌面适配与宿主保留能力 |
| [TypeScript 类型](api-types.md) | `window.enest` 接口声明与使用建议 |
| [UI 集成标准](ui-standard.md) | chrome / 主题变量 / 透明底 / Canvas |
| [主题 Chrome](chrome.md) | classic / rail / dock 自绘入口、隔离快照与宿主动作边界 |
| [主题工作区](home.md) | 目录与详情路由、ACK、隔离桥接及公开资源协议 |
| [权限说明](permissions.md) | 权限键与 API 对照表 |
| [调试与热更新](debug.md) | 开发者控制台、Vite HMR、DevTools |
| [生命周期](lifecycle.md) | 页面代次、关闭保存、窗口迁移与后台资源责任 |
| [自由面板](panels.md) | 桌面组件适配、布局记忆、拖动与多屏边界 |
| [后台步骤计划](deadline-tasks.md) | 无需页面保活的插件私有步骤调度 |
| [错误码](errors.md) | 常见错误字符串、失败语义与排查 |
| [示例插件](examples.md) | 可复制的完整示例 + 仓库样例 |
| [FAQ](faq.md) | 高频问题 |

?> 建议顺序：**快速开始 → plugin.json → enest API → 生命周期 → 示例**。实际示例见[官方插件源码](https://github.com/hyqf98/eNest_plugin/tree/main/plugins)；从 [主题与综合插件](themes.md) 或 [宿主开发](host-development.md) 进入专项。

## 契约与兼容

本目录对应 eNest 0.0.1 的插件契约；版本号不代表安装包已公开发行。手写指南解释能力边界和用法，[TypeScript 类型](api-types.md)从真实 preload/shared 契约生成；生成类型中存在某个接口，不代表普通插件、主题、后台和辅助页都获得同一桥。manifest、权限分类与生成类型应随宿主版本配套使用。

新 API 应在调用前检查能力，并对不支持的宿主给出明确升级提示；不能通过任意文件路径、放宽沙箱或假成功回退。版本范围只表示包声明的兼容要求，不替代实际能力检测与目标平台验证。文档中的平台限制和未提供的管理入口也属于接口边界，尤其见[MCP 工具贡献](mcp.md)。

## 下一步

[快速开始 →](getting-started.md)
