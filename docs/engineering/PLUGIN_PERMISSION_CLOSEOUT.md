# 插件能力与权限收口

日期：2026-10-13。接续[通用插件整改](PLUGIN_STANDARDIZATION_REPORT.md)，按“壳提供统一能力、插件自行实现业务、只管理敏感权限”的要求实施。ZTools 官方资料与本项目的取舍见 [ZTools 能力边界](ZTOOLS_CAPABILITY_BOUNDARY.md)。未提交、推送或发布。

## 本轮行为

- 插件私有存储、Tab 标题/图标/角标、受限尺寸、壳内提示、插件设置、主题注册和私有密钥保存直接可用。对应 10 个已有能力键无需 manifest 声明、无需用户授权，旧基础能力的拒绝记录不再阻挡运行。
- 系统文件、剪贴板、屏幕、网络、进程、外部配置、全局快捷键等 37 个敏感能力仍按“声明 → 原生授权 → 实例与资源归属检查”调用。动态 Quick provider 接收全局搜索文本，因此 `contribute` 仍属敏感权限；普通声明式功能入口不需要它。
- 权限清单约束外部资源访问，不是业务功能白名单。算法、界面、编辑器、数据模型和协议处理由插件实现。新增业务优先组合现有能力，不按业务名称扩展宿主权限；已有 SSH/数据库/中间件等适配器保持可用。
- 所有已安装插件均有权限设置入口，包括没有自定义设置项的插件。页面只为敏感能力提供三态开关；原生授权决定实时同步。详情页使用同一分类和中文名称，浏览器 mock 遵循同一持久化结构，失效的 renderer 授权弹窗已移除。
- 35 个官方插件移除冗余基础能力声明，保留实际使用的敏感项；说明和包资源同步更新。分类从 `src/shared/pluginPermissionPolicy.ts` 生成到插件仓库 `docs/plugin-permission-policy.json`，生成检查不会写文件。

## 同步封闭的边界

1. **插件设置不能自行授权。** `permissionGrants` 与原型相关保留键在注册、读取、写入和持久层统一限制，历史声明也被过滤。插件业务配置和宿主授权记录不再能经同一个公共设置接口互相覆盖。
2. **密钥库只保存安全密文。** 系统加密不可用、Linux 弱后端或加密失败时明确拒绝，不再降级为 XOR。旧 XOR/坏文件保留并要求重新输入；失败写入不覆盖原凭据。限制 key、单条密钥、总条数和总密文字节，写入采用私有临时文件与原子替换。
3. **主题不能借壳访问外部资源。** 插件注册强制绑定来源，`enest.builtin` 为保留 ID；主题背景限制为安全纯色或自身包内媒体。主题背景来源与用户自选背景分开，更新、撤销主题时重新派生背景，避免把主题内容永久复制成用户覆盖值。
4. **基础能力仍隔离。** 保留 Chromium sandbox、contextIsolation、禁止 Node、IPC 身份/主 frame/代次、文件句柄、参数和配额检查。参考 ZTools 的统一 API 开发方式，不复制其开放自定义 Node preload 的执行模型。

## 验证记录

- 宿主 `npm run typecheck`、`npm run build` 通过；最终集成 **136/136，0 跳过**。覆盖安装/市场、IPC、数据迁移、开发注册、Markdown、生命周期、存储、设置、Quick、授权策略、密钥库、主题来源及安全渐变。
- [基础能力原生证据](plugin-native-builtin-capabilities-2026-10-13.json)：在临时数据根和独立 profile 的真实 Electron 中，manifest 不声明任何权限，并写入旧基础能力拒绝值。实际 storage/session/settings/title/theme 正常、原生授权弹窗 **0**；文件、网络、剪贴板、全局搜索监听均被拒绝；设置授权表不能读写，伪造主题来源被归正，远程 CSS 背景被剔除。关闭后实例、资源、sessionBytes 均为 0。
- [35 个官方插件最终原生重跑](official-plugin-native-smoke-2026-10-13.json) **35/35 通过**：全部 sandbox=true、无 Node、非空 UI；无坏资源、图片、CSP 或未捕获异常。每个插件关闭后的实例、活动、sessionBytes、原生视图均为 0；本轮测试进程和临时目录已清理。此用例拒绝 OS/network 权限，验证启动与清理，不代表外部业务服务全部实测。
- 插件仓库完整测试 **83/83，0 跳过**；最终 35 ZIP、105 个必需媒体及索引摘要全部核验。此前 210 个布局组合的证据保留，本轮权限 UI 另验证全部 35 个设置入口、敏感授权持久化与事件同步，以及 1080/560/400 宽度下设置页和详情页无横向溢出、无脚本异常。见[插件验收报告](../../eNest_plugin/docs/PLUGIN_AUDIT_2026-10-13.md)和本地 `eNest_plugin/dist/permission-ui-audit.json`。
- SDK 的 133 个生成类型、16 篇同步指南、声明文件 TypeScript 检查、skill 结构校验及两仓 `git diff --check` 均通过。

权限相关定向回归可按以下命令运行；原生用例需要先执行宿主 build：

```sh
node --test src/main/plugin/PermissionService.test.mjs \
  src/main/ipc/pluginPermissionPolicy.test.mjs \
  src/main/settings/pluginPermissionSettings.test.mjs \
  src/main/settings/pluginSettingsBoundary.test.mjs \
  src/main/vault/secretVault.test.mjs \
  src/main/theme/themePacks.test.mjs \
  src/main/plugin/PluginRegistry.theme.test.mjs \
  src/renderer/hooks/useTheme.test.mjs \
  src/renderer/components/backgroundColorStyle.test.mjs
ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginBuiltinCapabilities.smoke.test.mjs
```

## 兼容与边界

- 插件 API 方法和标准包格式不变，已有基础能力声明仍可加载；新插件只列实际敏感权限。
- 旧版背景设置没有来源标记，无法可靠区分用户手选与曾从主题复制的值。本轮保留旧设置，不扫描删除用户背景；重新选择主题或背景后才明确记录来源。不能声称所有历史背景快照已自动清洗。
- 旧 XOR 密钥不自动迁移，不删除原文件。需要用户在系统密钥库可用后重新输入凭据；这种数据不会继续作为安全密文使用。
- 本轮原生验证环境为 macOS，系统 keyring 的 Linux 分支使用隔离 fixture。跨平台原生验证、真实外部服务和严格性能前后对照的边界仍见上一阶段报告；DSH 专属外部运行时不纳入通用页面沙箱保证。

开发说明：[权限](../site/plugin/permissions.md)、[宿主与插件职责](../site/plugin/host-development.md)、[API](../site/plugin/api.md)、[AI 开发技能](../../eNest_plugin/skills/enest-development/SKILL.md)。
