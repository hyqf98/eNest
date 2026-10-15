# 插件开发概览

> 参考 uTools 插件模型：**清单 + Web 入口 + 受控 API**。eNest 用 Electron 原生多 View 实现隔离与多 Tab。

## 插件是什么

一个插件包含本地目录里的 **Web 应用** 与 **plugin.json 清单**；从 eNest 0.2.0 起，还可携带声明并授权的 **Node 后端**。
壳子负责安装、隔离运行、Tab 管理与 API 白名单；插件只关心自己的 UI 与业务。

## 运行时模型

| 层 | 说明 |
|----|------|
| Shell | React 壳子 UI：市场、Tab 栏、设置、开发者控制台 |
| Node Backend（可选） | 插件包内 backend 入口；获得 backend.node 完整本机信任后，在 utilityProcess 中运行 |
| Plugin View | 独立 `WebContentsView`，partition = `persist:plugin-{id}` |
| 协议 | `enest://plugin/{id}/...`，仅映射许可的页面与公开资源，不暴露 backend |
| API | `window.enest`（zapi 为 deprecated 别名），IPC 权限门禁 |

## 与 uTools 的差异

- eNest 面向**桌面多窗口工作台**：顶部多 Tab，不是全局呼出搜索框为主。
- 插件页面默认**进程 / 会话隔离**；Node 后端是显式信任的独立进程，不是操作系统沙箱。关闭实例按生命周期回收页面与后端资源。
- 市场支持远端 registry 与最终包资源；开发检出可预览本地 dist 的对应版本。

## 文档结构

| 章节 | 内容 |
|------|------|
| [快速开始](getting-started.md) | 环境、最小插件、在壳子中加载 |
| [目录结构](structure.md) | 插件目录约定与必备文件 |
| [plugin.json](manifest.md) | 清单字段与完整示例 |
| [enest API](api.md) | 完整方法参考：UI / 主题 / 设置 / 存储 / 剪贴板 / 通知 / 生命周期 |
| [插件本机后端](backend.md) | 通用 backend.call、utility 协议、依赖打包与完整 Node 信任边界 |
| [TypeScript 类型](api-types.md) | `window.enest` 接口声明与使用建议 |
| [UI 集成标准](ui-standard.md) | chrome / 主题变量 / 透明底 / Canvas |
| [权限说明](permissions.md) | 权限键与 API 对照表 |
| [调试与热更新](debug.md) | 开发者控制台、Vite HMR、DevTools |
| [生命周期](lifecycle.md) | 状态机、事件时间线、handler 示例 |
| [错误码](errors.md) | 代码内完整错误字符串与处理 |
| [示例插件](examples.md) | 可复制的完整示例 + 仓库样例 |
| [FAQ](faq.md) | 高频问题 |

?> 建议顺序：**快速开始 → plugin.json → enest API → 生命周期 → 示例**。实际示例见插件仓库 `plugins/`；从 [主题与综合插件](themes.md) 或 [宿主开发](host-development.md) 进入专项。

## 下一步

[快速开始 →](getting-started.md)
