# 宿主开发与集成

eNest 是插件化桌面壳，不是内置各类业务工具的应用集合。宿主使用 Electron + React + TypeScript，负责原生能力、安全边界、生命周期与数据服务；插件拥有业务界面、算法、协议驱动和数据模型，主题拥有可替换的外观与呈现。插件可以使用其它前端框架。本指南可独立阅读；参与宿主仓库开发时，还须遵守该 checkout 根目录的 `AGENTS.md`。

| 目录 | 职责 |
| --- | --- |
| `src/main` | 原生窗口、插件宿主、IPC、权限、文件能力、持久化和网络 |
| `src/preload` | contextBridge API 与生命周期事件桥接，不放业务实现 |
| `src/renderer` | React UI、zustand 状态、主题和动画，不直接调 Node |
| `src/shared` | 三端共享类型、协议与常量，避免运行时依赖 |
| `tests` | 单元用例、浏览器 mock/样例目录、原生探针与打包夹具，不进入生产依赖图 |

跨目录导入使用 `@main`、`@preload`、`@renderer`、`@shared`，同目录可用 `./`。新增顶层目录同时维护 electron-vite 与 node/web tsconfig 别名。IPC 通道在 `src/shared/types/ipc.ts` 定义。

`@test` 仅用于验证支持与 DEV 浏览器预览。源码唯一允许的入口是 `shellApi.ts` 在 `import.meta.env.DEV` 分支中的动态加载；正式构建移除该分支，缺失 preload 时不能使用假数据兜底。

## 修改能力

壳只提供可复用的能力和运行容器，插件拥有业务实现。新增插件功能先判断能否用浏览器代码、WASM、私有存储与已提供的网络/文件 API 完成；文本处理、图片算法、业务表单、协议编解码和业务数据模型应放在插件仓库。不要为“某插件新增一个功能”就向主进程增加同名处理器或权限。

只有需要新的原生资源访问且现有能力无法表达时，才扩展宿主通用接口，同时处理共享类型、preload、主进程分发、权限分类与关闭清理。`src/shared/pluginPermissionPolicy.ts` 是基础/敏感能力分类的单一来源：本插件私有数据、设置、界面、主题和声明式入口直接可用；网络、剪贴板、系统控制和动态 Quick 全局搜索监听等敏感能力需要声明和授权。`fs.read` / `fs.write` 仅接受用户经宿主选择器选定的文件或当前实例持有的句柄，选择目标即授权；拖入路径仍须宿主确认，不能静默访问任意路径。基础能力仍校验归属、参数、配额和运行代次。

SSH、数据库、中间件和 DSH 的协议驱动、业务 DTO 与后端路由在插件仓库，通过 manifest 的 `backend.entry` 和通用 RPC 运行。专注阶段、统计和旧记录解释由番茄插件负责，壳只提供通用 deadline 计时能力，不存在内置驱动回退。历史 `db.*` / `mw.*` 授权名称保留兼容已有清单和授权记录，不等于宿主拥有对应业务处理器。

旧宿主数据的迁移仍需原生侧验证来源和归属：剪贴板固定 OWNER 防止其他插件领取用户历史，计时旧容器按原 `pluginId` 分区移交；业务解释留在插件中。不能为了清除插件 ID 字面量就移除这些护栏。坏的旧计时数据保留并延后重试，不得阻断所有插件的通用计时服务。

参考 `PluginRuntimeScope` 将连接和在途操作绑定当前代次；等待原生授权后再次检查代次，不能把旧调用交给新页面。文件从 `localFiles` 获取带用途句柄，不接受 renderer 提供的本地绝对路径授权。权限表、分类快照和插件 schema 随 SDK 生成检查，不能只更新文档。

`ipcSecurity` 注册 shell、Quick、orb、panel、region 等窗口身份和允许通道。插件 IPC 另外校验运行实例与主 frame。preload 打成自包含 CJS，生产 Electron sandbox 必须开启。浏览器能力限制在 `pluginSessionPolicy`；改变策略需覆盖跨插件、非法 origin、localhost 端口及撤权测试。

## 原生视图与响应式

插件和主题 Workspace 的 `WebContentsView` 在 shell DOM 上方，renderer 模态层无法盖住它们。目录与详情走 `navigateWorkspace` 与路由 ACK，已安装是主题本地筛选；设置入口通过 `openSettings` 请求宿主隐藏 Workspace 并切换 `set-view: settings`。`SettingsSurfaceController` 选择主题隔离 `settingsPage`，未提供或故障时回退源码内置默认主题设置，不存在“受保护设置恢复”通道。账号、授权、开发者和路径/媒体选择由可信原生表面负责。classic 标题栏高度与 `TITLEBAR_HEIGHT`/CSS 变量保持 36px 一致。orb 顶层原生 rail 在插件挂载后需重新置顶。

Grid/Flex 的可缩项设置 `min-width:0` / `min-height:0`，控制滚动拥有者，标题栏像素和图标像素无需机械改成百分比。动画使用 `marketMotion` 的 d/dy/ease；低动画档尊重现有约定。

外观由主进程 `appearanceService` 解析，页面只消费 `ResolvedAppearance`；主题设置按 Schema 投影到主题 Tab，提交以宿主持久化的 revision 为准，不建立另一份可写外观 store。主题工作区只使用 `enestWorkspace` 的目录、外观与动作；设置描述符属于独立 `enestSettings` 桥，两者都不获得完整 `shellApi`。契约见[主题包规范](themes.md)、[主题工作区](home.md)与[设置页面](settings-and-windows.md)。

默认 Workspace、Quick 策略、设置布局和启动编排分别留在 `src/renderer/themes/default/` 的对应目录；源码内置默认主题随宿主编译，是保底主题，不是磁盘中必须安装的业务插件。公共控件、语义 Token 应用、背景引擎、原生几何与安全控制器仍是共享设施，不应复制到每个主题。主题通知只能改变受限外观，不能改写来源、内容、关闭和计时语义。自由面板复用插件 View 与主机拖动能力，详见[自由面板](panels.md)。

## 扩展公共 API 的完整链路

1. 先定义共享 DTO、输入边界、资源预算、权限分类和失效语义；不要在 preload、主进程与插件 SDK 各写一份请求类型。
2. 接通 preload、IPC 分发和真实处理器；声明存在但调用落入 `unknown method` 不算实现。只读接口也必须校验真实调用者，不能信任参数中的插件 ID。
3. 异步调用绑定运行代次、数据根和资源所有者；授权、原生选择与磁盘操作等待后重新校验。撤权、关闭、禁用和卸载有明确取消与清理路径，旧任务不得向新实例交付结果。
4. 明确 Promise 成功的含义。排队、内存可见、原子提交和磁盘同步不是同一状态；提交后丢失回执不能声称没有副作用。参考[存储标准](storage.md)。
5. 更新 canonical manifest schema、权限分类源、官方 API 指南、示例和生成类型；兼容别名标注 deprecated，不偷偷扩大旧权限。共享类型存在不代表所有页面都获得相应桥。
6. 用独立验证源码覆盖边界与失败路径，并区分静态检查、构建和原生运行验收。新验证源码放 `tests/`，不进入生产源码或生产依赖图。

扩展后端控制协议也遵循上述要求。完整 Node 信任与前台沙箱不是同一级权限；不要把插件自有 Node 驱动的能力包装成“受前台文件沙箱限制”。具体见[本机后端](backend.md)与[权限说明](permissions.md)。

## 本地开发与检查

```sh
npm ci
npm run dev
npm run typecheck
npm run build
npm run audit:source -- --build-output
```

主进程或 preload 改动后重启 dev；renderer 可 HMR。API 生成工具位于插件仓库，不依赖宿主被忽略的本地 scripts 或 packages：

```sh
node /path/to/eNest_plugin/scripts/generate-api-types.mjs --host-root /path/to/eNest
node /path/to/eNest_plugin/scripts/generate-api-types.mjs --host-root /path/to/eNest --check
node /path/to/eNest_plugin/scripts/sync-developer-docs.mjs --host-root /path/to/eNest
node /path/to/eNest_plugin/scripts/sync-developer-docs.mjs --host-root /path/to/eNest --check
```

`audit:source` 只扫描物理文件、语法树依赖和可选构建产物，不执行应用或测试。浏览器预览样例在 `tests/fixtures/browser-preview/`，图标生成器也只能写入该目录。开发 checkout 的本地预览仅按扫描得到的完整插件 ID 安装，安装器再次核对清单身份；正式包禁止从 checkout 回退安装。

仅在用户明确要求时运行测试。使用临时 `ENEST_TEST_DATA_ROOT` 和独立 `ENEST_TEST_USER_DATA`，不要让测试读取用户真实剪贴板、SSH 密钥、数据库或配置。这两个变量对应的三个原生路径/启动隔离点保留在宿主，也保护打包应用验证。原生 smoke 脚本在 `tests/main/plugin/`、`tests/main/window/`，按各文件开头说明启用；默认跳过不能报告为实测通过。常规主进程测试用 `node --test tests/main/<模块>/<相关.test.mjs>`。

生命周期策略为后台 3 分钟、6 个实例软上限与 LRU；可见独立窗口、自由面板组件、活动任务 lease 和开发调试有各自保留条件。先读 [生命周期](lifecycle.md)，新功能不得自行添加无法回收的轮询。性能改动记录同机同场景的数据，不以代码缓存的存在推导固定加速比例。

性能统计只归属已确认的 PID 与启动身份，不按进程名猜测所有者，也不收集命令行或凭据。共享进程和宿主无法细分的内存单独标注；未知指标显示不可用，不用零值伪装成功。平台内存口径不同，不能把 macOS physical footprint、Windows private bytes 与 Linux RSS 当作完全等价的数据。停止资源须等待实际退役，不能从界面移除行后就宣布操作完成。

保留工作区未提交改动；用户未要求时不 commit/push。不提交 out、插件 dist 或用户数据。插件自有 runtime 与未验证操作系统在验收报告中单独标注；静态检查和构建通过不能替代原生运行验收。
