# AGENTS.md — eNest 开发标准

## 软件性质与职责

eNest 是插件化桌面壳，不是把一组业务工具写在一起的桌面应用。宿主使用 Electron、React、TypeScript；业务插件可自行选择前端框架。依赖版本以 `package.json` 和锁文件为准。

- **宿主拥有通用原生能力**：窗口、实例生命周期、隔离与权限、安装更新、文件句柄、私有存储、全局快捷键、系统集成与 MCP 传输。
- **插件拥有业务**：界面、算法、数据模型、协议驱动、业务后台和自己的设置页面。不得按插件 ID 增加专属处理器、权限、驱动回退或默认安装逻辑。
- **主题拥有呈现**：首页/目录/详情、Quick、启动动画、外观参数及受限设置页面。宿主拥有安全控制器、持久化、输入资格和故障回退，不把可信权限交给主题。
- 唯一源码内置主题为 `enest.builtin / default`，浅/深是同一主题的模式。声明在 `src/shared/theme/defaultTheme/package.ts`，实现在 `src/renderer/themes/default/`，随壳编译，不从插件仓安装。第三方主题走相同贡献契约，不为主题 ID 写页面分支。
- `eNest_plugin/` 是独立 Git 仓库，包含官方插件、SDK、共享包、构建工具和开发 skill。修改跨仓契约时同步两边，但用户未要求不得 commit/push。

## 文档的唯一入口

- `docs/site/`：产品官网和下载页；`docs/site/plugin/`：官方插件 API 与开发指南。
- 本文件：宿主性质、工程边界与开发约束。根 `README.md`：项目入口与常用命令。
- 不再建立 `docs/engineering/`、`docs/TASK_STATES/` 或重复的架构/阶段/审计报告。修复过程和当次验证结论留在任务回复、PR 或 Git 记录；只有用户明确要求交付独立文档时再创建。
- 长期有效的契约直接更新对应官方指南，不能只写在过程报告中。产品页不把开发版本称为已发布版本，不把源码、截图、静态检查或构建通过称为原生验收。
- `docs/site/plugin/api-types.md` 与插件 SDK 类型由脚本生成，不手改；`eNest_plugin/docs/developer/` 是官方指南的同步副本，不另立一套标准。
- 工具自己的必要使用说明紧邻工具保存；运行报告、截图和性能输出使用被忽略的 `.cache/verification/`，不得回写 `docs/`，任务临时产物用完清理。

## 工程目录与导入

| 区域 | 职责 | 禁止内容 |
| --- | --- | --- |
| `src/main` | 原生窗口、宿主服务、IPC、持久化、资源与权限 | React UI、插件业务驱动 |
| `src/preload` | 最小 contextBridge 与事件桥接 | 业务实现、权限决策 |
| `src/renderer` | 壳控制器、主题、React UI 和动画 | 直接访问 Node/Electron 主进程 API |
| `src/shared` | 跨端 DTO、IPC 常量、无平台依赖的纯模型 | 原生运行时依赖 |
| `tests` | 用例、mock、fixture、浏览器预览、原生探针 | 正式运行时依赖 |

跨目录必须使用 `@main`、`@preload`、`@renderer`、`@shared`，分别指向 `src` 下同名目录；只有同目录可用 `./`。禁止跨目录 `../` 链。新增别名须同时维护 `electron.vite.config.ts` 和两份 `tsconfig.*.json`。

`@test` 指向 `tests`，只能用于验证支持。唯一允许的源码入口是 `shellApi.ts` 在 `import.meta.env.DEV` 且没有原生 preload 时动态加载浏览器预览；正式依赖图不得包含夹具，缺失 preload 必须失败而非使用假数据兜底。

### 命名与源码边界

- 按职责命名，遵循所在目录的大小写习惯；React 组件 PascalCase，hook 使用 `use` 前缀，独立脚本通常 kebab-case。
- 禁止给维护代码附创建日期、数字轮次、`final/new/copy` 等标签。`win32`、`sha256`、真实协议版本、资源尺寸和生成哈希等技术标识保留。
- 测试使用 `.test.mjs`、`.browser.test.mjs`、`.native.test.mjs` 等有意义后缀，全部放在 `tests/`。只为测试提供的观察器、伪数据和包装函数不能留在 `src`。
- 清理代码前核对生产调用者和跨仓消费者；重命名同步导入、脚本、CI 和现行文档，不靠保留死入口维持旧断言。
- 产品快捷键探测、代理连通检查和开发诊断是真实功能，不能仅凭名称中的 test/probe 删除。独立验证配置的 `ENEST_TEST_USER_DATA` / `ENEST_TEST_DATA_ROOT` 安全钩子保留，避免触碰用户真实目录。

## API 与安全标准

新增能力先查官方 API 和共享组件；只有现有能力无法表达的通用原生需求才扩展宿主。一次改动必须覆盖共享类型、IPC 常量、preload、主进程分发、权限、参数/配额、生命周期清理、SDK 和对应官方文档。

- IPC 名称只在 `src/shared/types/ipc.ts` 定义。跨端 DTO 复用 `src/shared/types/`，不在 main/preload/renderer/mock 各写一套同名接口。
- 每种原生表面在 `ipcSecurity` 显式登记角色和通道白名单；插件调用校验实例、主 frame、origin 和运行代次。异步授权或加载完成后再次校验，旧调用不能交给新实例。
- 页面关闭 Node 集成、开启 contextIsolation 与 sandbox；preload 为自包含 CJS。插件自有 `backend.entry` 经通用 RPC 运行，`backend.node` 是完整本机信任，utilityProcess 不是操作系统沙箱。
- 基础/敏感分类只用 `src/shared/pluginPermissionPolicy.ts`。本插件私有数据、设置、UI、主题、声明式入口和后台计时等基础能力仍需身份与配额检查；网络、剪贴板、系统控制、AI 配置/资产等敏感能力按标准授权。
- `fs.read` / `fs.write` 仅限宿主选择器选定目标或当前实例持有的句柄；选择目标即授权，拖入路径仍须确认，路径字符串不能充当授权。密钥仅经宿主密钥库，不放在普通设置或日志。
- 所有后台任务绑定当前实例及取消信号；关闭、禁用、升级、卸载和退出必须回收。MCP 沿用已获权限，不弹出授权/文件选择器、不自动安装、不把隐藏任务拉到前台；取消不代表已撤销业务副作用。
- 旧数据迁移只移交已验证来源和所有者的原始数据，业务解释留在插件。保留原数据、提交标记和归属校验；不能为消除插件 ID 字面量而开放任意旧数据路径。旧 `db.*` / `mw.*` 权限名称需兼容迁移，不能直接删掉已有授权。

## 数据与设置

- 全局 UI 状态使用 `shellStore`；宿主持久化由 `settingsStore` 管理，数据库为 `{dataRoot}/data/enest.db`，`~/.eNest/settings.json` 只保存数据根引导信息。保留用户指定目录，不把持久化只做在 renderer state/localStorage。
- 插件统一使用 `enest.storage`：KV、`assets` 图片资源和 `files` 完成输出各有明确生命周期。`set/remove` 是缓冲写入；需可靠提交时等待 `flush/commit`，KV 事务不等于跨图片/文件事务。旧 `blobs` 只是兼容入口，不再新增平行存储接口。
- 插件设置可以通过 `SettingsSectionContribution` 注册到宿主，也可声明 `page` 入口在插件内自绘；均按插件归属持久化，不能读写宿主保留设置键。
- 主题只获得白名单描述符和不透明字段 ID；插件字段只有 `shareWithThemes: true` 才可公开，每次跨插件写入原生确认并复核版本、当前值和代次。账号、权限、开发者、路径/媒体选择保留可信原生入口。
- 默认通知使用 `notifyService`；显示时读取 `general.notifyPosition`。主题只能控制受限视觉语义，不能篡改通知来源、内容、关闭与计时。

## 主题、页面与控件

- 外观唯一链路是 `appearanceService → ResolvedAppearance → useAppearance/appearanceDom`。不新增独立可写的字体、背景、动画或 Tab 外观 store；预览通过 `updateThemeProfile` 提交，以确认 revision 为准，失败恢复。
- 新主题使用 `ThemePackV2` 与 schema；`theme.register` 只登记，不自动切换。`layout.variant` 是可扩展语义，不是内置主题枚举。
- 默认目录、详情、设置、Quick、开屏及专属 CSS/动效归 `themes/default/`。公共基础控件、Markdown、安全控制器、跨窗口背景引擎可共享，不把真实主题实现放回公共组件。
- Workspace 只有 `catalog/detail` 路由和匹配代次的 ACK；已安装是提供者本地筛选。设置经 `openSettings` 请求切换宿主设置视图，不是 Workspace 路由，也没有旧的“受保护设置恢复”通道。
- `SettingsSurfaceController` 选择隔离 `settingsPage`，未提供或故障时使用内置默认设置。Workspace、Quick、设置、chrome、辅助页各用自己的受限桥，不得获得普通插件 `enest` 或完整 `shellApi`。
- Quick 默认检索、拼音、排序、最近/推荐和旧历史解释归默认主题；宿主只提供安全目录、来源传输、成功启动事实及 source/pack 私有 JSON/CAS。图片预览在输入框左侧，不移到上方；缩略图不授予路径/原始数据访问权。
- 启动直接加载有效主题，隐藏预热与开屏并行；ready、路由 ACK、提交后复用同一首页。不恢复首启选主题、确认标记或正常“准备首页”中间页，不绕过故障恢复门禁。
- 基础控件统一复用 `src/renderer/components/ui/`（Radix 行为 + 主题 CSS）；升级公共控件时同步派生插件仓 `src/ui` 模板，不在页面重复造裸控件。
- GSAP 时长、位移和缓动走 `marketMotion` 的 `d/dy/ease`；CSS 动画尊重动画档位和减少动态效果。背景材质不覆盖选中控件状态，不改变现有 CSS 级联顺序。

## 窗口、快捷键与生命周期

- 插件使用原生 `WebContentsView`，位于 shell DOM 之上；模态、菜单和拖动不能仅靠 CSS z-index。classic/orb 共享会话，orb 原生导航在插件挂载后保持置顶，启动可见性由 `App` 统一控制。
- 标题栏几何与 `TITLEBAR_HEIGHT` / `--titlebar-h` 保持一致；折叠、展开同步原生内容 bounds，不在页面重复补高度。
- 插件切换主窗、Quick、独立窗、自由面板必须走宿主 placement/生命周期，不重造业务实例来伪装移动。全局快捷键统一处理归属、冲突、录制租约、注册结果与持久化回滚；不能先保存再忽略系统注册失败。
- 自由面板默认关闭。面板组件常驻可见，免于空闲休眠/LRU；布局由主进程写独立 `panels` 段，不混入 `windowSession/sessionTabs`，renderer 不能直接提交该段。
- 面板拖动/缩放由主进程读光标与 `setBounds` 驱动，不逐帧 React setState/IPC，不使用 `-webkit-app-region: drag`；覆盖层期间隐藏该面板插件原生视图，结束恢复。
- 关闭面板走完整插件关闭链路；关闭功能保留布局。恢复先建窗口再限并发装载，多屏丢失时映射到可见工作区；恢复/关闭串行、代次失效立即生效，退出不能用空活动表覆盖保存布局。

## 开发与交付

Node.js 版本满足 `package.json.engines`；使用现有工具链与锁文件，不擅自全局安装工具。主进程/preload 修改后重启 dev，纯 renderer 可使用 HMR。网络相关实现沿用 `proxyService`，不得绕过用户代理配置。

```bash
npm run dev
npm run typecheck
npm run audit:source
npm run build
npm run audit:source -- --build-output
```

公共契约或指南变更后，从宿主根目录同步并检查：

```bash
node eNest_plugin/scripts/generate-api-types.mjs --host-root .
node eNest_plugin/scripts/generate-api-types.mjs --host-root . --check
node eNest_plugin/scripts/sync-developer-docs.mjs --host-root .
node eNest_plugin/scripts/sync-developer-docs.mjs --host-root . --check
```

- 不主动运行单元测试、浏览器/native smoke 或性能用例；只有用户明确要求时才执行。构建遇到历史测试失败应跳过，不为变绿去修改无关历史断言。静态检查、构建和真实运行验收分别报告。
- 修改前检查工作区，保留已有改动；遇到未知并发改动先确认，不用 reset/checkout 覆盖，不擅自提交或推送。
- 打包图标只认 `build/icon.{icns,ico,png}`；`assets/icons` 是运行时资源。系统关联声明同步 `build/open-with.json` 与 builder；通用运行时/许可证不能为减包体随意裁剪。
- 不提交 `out/`、`release/`、插件 `dist/`、用户数据或临时验证产物。提交前保证所需 typecheck、静态边界、生成一致性和两仓 diff 检查通过；未执行的目标平台行为明确标注。
