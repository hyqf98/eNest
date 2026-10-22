# ZTools 能力边界与 eNest 的取舍

核对日期：2026-10-13。ZTools 源码固定为 [`6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c`](https://github.com/ZToolsCenter/ZTools/tree/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c)，官方文档固定为 [`8d3068edf31e45d665a19c77332710240a021032`](https://github.com/ZToolsCenter/ZTools-doc/tree/8d3068edf31e45d665a19c77332710240a021032)。以下区分已核对的上游事实与 eNest 自己的设计决定，不把二者描述为完全兼容。

> 历史比较与整改快照：能力数量、背景来源机制和验证结果均对应上述日期。现行权限以 [权限说明](../site/plugin/permissions.md) 为准，主题迁移与设置标准见 [THEME_STANDARD.md](THEME_STANDARD.md)，不继续使用旧独立主题 store。

## 官方资料能够证明什么

| 已核对事实 | 官方证据 |
| --- | --- |
| ZTools 提供全局 `ztools` API，涵盖界面、通知、模拟输入、持久化等宿主能力；支持 UI 和无界面插件。 | [README_CN](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/README_CN.md#L105-L114) |
| 插件有按名称隔离的数据库 Bucket，提供 `db` 和类似 localStorage 的 `dbStorage`。已核对的数据库处理器按调用来源添加插件前缀，读写路径中没有逐次授权对话框。 | [存储文档](https://github.com/ZToolsCenter/ZTools-doc/blob/8d3068edf31e45d665a19c77332710240a021032/docs/plugin-api.md#L261-L340)、[宿主处理器](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/main/api/shared/database.ts#L45-L99) |
| 插件可以声明自定义 preload，调用 Node.js 和 Electron 原生 API；官方示例直接使用 `require('fs').readFileSync`。文档要求 preload 和引入的第三方源码清晰可读，不压缩混淆。 | [preload 文档](https://github.com/ZToolsCenter/ZTools-doc/blob/8d3068edf31e45d665a19c77332710240a021032/docs/preload-js.md#L1-L38)、[manifest preload](https://github.com/ZToolsCenter/ZTools-doc/blob/8d3068edf31e45d665a19c77332710240a021032/docs/plugin-json.md#L71-L76) |
| 该版本原生插件视图设置 `nodeIntegration: false`，但 `contextIsolation: false`、`sandbox: false`、`webSecurity: false`，并加载插件自带 preload。因此不能仅看到 nodeIntegration=false 就将其称为隔离沙箱。 | [WebContentsView 配置](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/main/managers/pluginManager.ts#L300-L318)、[插件 preload 加载](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/main/managers/pluginManager.ts#L691-L701) |
| macOS 辅助功能有明确的操作系统授权检查和引导窗口。它属于应用的系统授权，不等同于 eNest 的逐插件敏感能力授权。 | [辅助功能检查](https://github.com/ZToolsCenter/ZTools/blob/6c9dee8c998ed7b4e6d0a80ad4311d3d8d24f72c/src/main/core/accessibilityPermissionGate.ts#L21-L35) |

上述证据支持借鉴统一 API、私有存储和低摩擦插件开发体验；不能据此断言 ZTools 已实现某份“只有几项”的逐插件权限清单。此次未穷尽其全部 API 与各平台实现。

## eNest 的实现边界

壳子提供公共能力、资源隔离、生命周期和开发协议，插件自行决定业务、算法、页面与前端框架。权限清单描述跨越资源边界时需要什么能力，不是插件能开发哪些业务的白名单。增加计算、排版、编辑器、图表等插件内部业务，不需要向壳子增加一种业务权限。

本轮把现有 47 个能力键分为 **10 个基础能力**与 **37 个外部敏感能力**。权威分类在 `src/shared/pluginPermissionPolicy.ts`，使用说明在 [插件权限文档](../site/plugin/permissions.md)。基础能力无需 manifest 声明，也不出现运行时授权弹窗；旧 manifest 已有的对应键继续兼容。

| 类别 | 范围与约束 |
| --- | --- |
| 10 个基础能力 | `storage.local`；`ui.setTitle`、`ui.setIcon`、`ui.setBadge`、`ui.resize`、`ui.toast`；`settings.register`、`settings.page`；`theme`；`vault.write`。仍执行调用者身份、当前实例、插件归属、输入和资源上限检查。 |
| 37 个敏感能力 | 剪贴板与跨应用回贴、屏幕采集、全局快捷键、文件读写/改名、网络/端口/局域网、系统进程和外部应用配置、SSH Agent 及远程服务操作等仍按声明与用户决定控制。后台计时、系统通知、贴图窗口与全局 Quick 动态搜索监听（`contribute`）也保持在此类；不能因其提供 UI 就自动视为插件内部功能。 |
| 纯插件业务 | renderer 内的计算、编辑、渲染、排序等由插件自行实现。使用自己数据的业务不增加授权；访问外部资源时调用对应宿主能力。 |

eNest **不复制开放 Node 或自定义 preload 的模型**。保留 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 与宿主提供的 preload。插件不得绕过宿主直接取得用户系统文件、进程或其他插件数据。框架开发/HMR、插件业务自由与这些边界并不冲突。

manifest 中声明式 `features`、首页卡片、设置/主题入口属于普通贡献点；`contribute` 这个现有能力键实际用于动态 Quick provider，可收到用户在全局搜索框输入的内容，因此仍须授权。插件名称搜索和静态入口不要求这项授权。

## 基础能力仍须守住的边界

- **settings**：只访问自己的业务配置。宿主的权限决定等内部字段不能经 `settings.register/get/set` 暴露或改写；注册一个同名 key 不能变成自授权入口。
- **theme**：注册主题是贡献候选项，用户选择主题由壳负责。来源强制绑定调用插件，不允许覆盖其他来源的主题；CSS token 名和值经过校验，单插件包数受限。插件不能借此写任意全局 CSS、请求外链或改变授权。
- **vault**：当前公共 API 只有本插件 `set/has/remove`，没有读取明文和列举系统凭据的 API；宿主按同一插件身份解析 `secretRef`。本机 SSH Agent、外部 CLI 配置等继续使用独立敏感能力。系统加密不可用或 Linux 使用 `basic_text/unknown` 后端时拒绝存取；旧 XOR、坏文件或解密失败明确要求解锁密钥库/重新输入，保留原文件，不再静默返回无凭据。新 key 最多 128 UTF-8 字节、secret 最多 64 KiB，每插件最多 256 条/8 MiB 密文；已有超额文件允许删除和不增加占用的替换，不静默清除。加密与临时文件写入成功后原子替换，失败不覆盖旧凭据。
- **清理**：关闭、断开、取消自己已持有的资源不应因为撤权而制造新的授权循环；即便是清理，仍须验证资源归属和实例身份。

免授权只移除不必要的用户确认，不移除数据命名空间、参数验证、配额、原生视图回收和当前实例校验。

## 本轮边界修复

原来 `settings.register` 可注册 `permissionGrants` 这个宿主保留字段，再经 `settings.set` 写入和真实授权表同一个对象，形成自授权入口。现在 IPC、设置桥和持久层共用保留 key 检查，屏蔽 `permissionGrants`、`__proto__`、`prototype`、`constructor`；历史 manifest 的设置贡献也过滤这些 key。插件仍可正常读写自己的业务设置，读取配置时不再返回宿主授权表。

原密钥库在系统加密失败时降级为 XOR，且缺少私有存储配额。现已改为上面的失败拒绝和有界存储规则。旧文件未被扫描删除或静默改写，用户重新输入后才保存新的安全密文。

主题包背景只允许纯色和本插件打包媒体，不能通过背景让 shell 请求外网、任意本地文件或其他插件资源。插件入口拒绝使用宿主保留来源 `enest.builtin`。新背景配置另记录 `backgroundSource`：明确选择主题包时保存 `pack`，显示背景由当前已净化的主题表派生；用户选择背景时保存 `user`，更新/卸载主题不覆盖用户选择。切换配色或编辑 token 不会把派生的主题背景重新复制到用户设置。

旧配置中只有 `packId/background`，无法可靠区分用户手选背景与旧主题复制的背景。**未标来源的旧值继续保留，没有自动清洗历史背景快照**；用户重新选择主题或背景后才建立来源。现有本地媒体目录授权迁移也未扩大处理。旧 `color` 值显示改为 `backgroundColor`；兼容既有无资源函数的渐变，通过受限 `backgroundImage` 显示，拒绝 `url/image-set/image/cross-fade/paint`、转义、引号和注释，保留内置 `color-mix/var` 渐变。

当时独立设置、密钥库和主题来源/背景样式回归 **13/13** 通过：实际自授权路径、历史保留字段过滤、跨插件隔离、正常加密、弱后端/坏密文/写入失败、UTF-8 长度和数量/容量上限、已有超额数据缩减，以及主题刷新/卸载、用户覆盖、旧值保留、合法渐变和资源函数拒绝。旧主题测试已随统一外观架构替换；现行检查入口见 [宿主开发](../site/plugin/host-development.md)，这里不保留失效执行命令。

密钥库测试使用临时文件与模拟 Electron safeStorage 后端验证宿主分支，不代表本轮在 Windows/Linux 真实桌面密钥库上完成运行验收。
