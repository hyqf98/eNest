# 宿主开发与集成

宿主是 Electron + React + TypeScript；插件可以使用其它前端框架。先读宿主根 `AGENTS.md` 和本指南，再修改职责对应的区域。

| 目录 | 职责 |
| --- | --- |
| `src/main` | 原生窗口、插件宿主、IPC、权限、文件能力、持久化和网络 |
| `src/preload` | contextBridge API 与生命周期事件桥接，不放业务实现 |
| `src/renderer` | React UI、zustand 状态、主题和动画，不直接调 Node |
| `src/shared` | 三端共享类型、协议与常量，避免运行时依赖 |

跨目录导入使用 `@main`、`@preload`、`@renderer`、`@shared`，同目录可用 `./`。新增顶层目录同时维护 electron-vite 与 node/web tsconfig 别名。IPC 通道在 `src/shared/types/ipc.ts` 定义。

## 修改能力

壳只提供可复用的能力和运行容器，插件拥有业务实现。新增插件功能先判断能否用浏览器代码、WASM、私有存储与已提供的网络/文件 API 完成；文本处理、图片算法、业务表单、协议编解码和业务数据模型应放在插件仓库。不要为“某插件新增一个功能”就向主进程增加同名处理器或权限。

只有需要新的原生资源访问且现有能力无法表达时，才扩展宿主通用接口，同时处理共享类型、preload、主进程分发、权限分类与关闭清理。`src/shared/pluginPermissionPolicy.ts` 是基础/敏感能力分类的单一来源：本插件私有数据、设置、界面、主题和声明式入口直接可用；文件、网络、剪贴板、系统控制和动态 Quick 全局搜索监听等敏感能力需要声明和授权。基础能力仍校验归属、参数、配额和运行代次。

现存 SSH、数据库、中间件、专注计时和 DSH 适配器继续支持已有插件，不构成新业务必须移入壳的模式。新增业务应优先复用这些接口或更基础的网络能力；DSH 的专属外部 runtime 不作为通用插件模板。

参考 `PluginRuntimeScope` 将连接和在途操作绑定当前代次；等待原生授权后再次检查代次，不能把旧调用交给新页面。文件从 `localFiles` 获取带用途句柄，不接受 renderer 提供的本地绝对路径授权。权限表、分类快照和插件 schema 随 SDK 生成检查，不能只更新文档。

`ipcSecurity` 注册 shell、Quick、orb 的窗口身份和允许通道。插件 IPC 另外校验运行实例与主 frame。preload 打成自包含 CJS，生产 Electron sandbox 必须开启。浏览器能力限制在 `pluginSessionPolicy`；改变策略需覆盖跨插件、非法 origin、localhost 端口及撤权测试。

## 原生视图与响应式

插件和主题 Workspace 的 `WebContentsView` 在 shell DOM 上方，renderer 模态层无法盖住它们。目录、已安装、详情及普通设置走 `navigateWorkspace` 与路由 ACK；受保护设置走 `openSettingsRecovery`，先锁定隐藏原生内容，不能只调用 `hidePlugins` 后切换 DOM。授权使用主进程原生对话框。classic 标题栏高度与 `TITLEBAR_HEIGHT`/CSS 变量保持 36px 一致。orb 顶层原生 rail 在插件挂载后需重新置顶。

Grid/Flex 的可缩项设置 `min-width:0` / `min-height:0`，控制滚动拥有者，标题栏像素和图标像素无需机械改成百分比。动画使用 `marketMotion` 的 d/dy/ease；低动画档尊重现有约定。

外观由主进程 `appearanceService` 解析，页面只消费 `ResolvedAppearance`；主题设置按 Schema 投影到主题 Tab。主题工作区只使用 `enestWorkspace` 的数据、动作和设置描述符，不获得完整 `shellApi`。契约见[主题包规范](themes.md)与[主题工作区](home.md)，宿主责任划分以 `docs/engineering/THEME_STANDARD.md` 为准。

## 本地开发与检查

```sh
npm install
npm run dev
npm run typecheck
npm run build
```

主进程或 preload 改动后重启 dev；renderer 可 HMR。API 生成工具位于插件仓库，不依赖宿主被忽略的本地 scripts 或 packages：

```sh
node /path/to/eNest_plugin/scripts/generate-api-types.mjs --host-root /path/to/eNest
node /path/to/eNest_plugin/scripts/generate-api-types.mjs --host-root /path/to/eNest --check
```

测试使用临时 `ENEST_TEST_DATA_ROOT` 和独立 `ENEST_TEST_USER_DATA`，不要让测试读取用户真实剪贴板、SSH 密钥、数据库或配置。原生 smoke 脚本在 `src/main/plugin/`、`src/main/window/`，按各文件开头说明启用；默认跳过不能报告为实测通过。常规主进程测试用 `node --test <相关.test.mjs>`。

生命周期策略为后台 3 分钟、6 个实例软上限与 LRU；活动任务 lease 和开发调试有例外。先读 [生命周期](lifecycle.md)，新功能不得自行添加无法回收的轮询。性能改动记录同机同场景的数据，不以代码缓存的存在推导固定加速比例。

保留工作区未提交改动；用户未要求时不 commit/push。不提交 out、插件 dist 或用户数据。DSH 专属 runtime 与未测试操作系统在验收报告中单独标注。
