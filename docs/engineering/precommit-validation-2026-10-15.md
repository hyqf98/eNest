# 本地提交前校验记录

日期：2026-10-15。按用户要求提交主仓库和 `eNest_plugin` 独立仓库当前代码、技术文档与验收素材；不推送或发布。遵循各仓库忽略规则，不强制添加 `out/`、`dist/`、依赖和本地工具目录。

## 主仓库

- `npm run typecheck`：通过，覆盖主进程与 renderer。
- `npm run build`：通过。仍有主进程静态/动态导入混用的构建警告。
- 非 UI 回归：90 个 `.test.mjs` 文件，619 项中 617 通过、1 失败、1 跳过。
- 唯一失败为 `src/shared/pluginCommands.test.mjs:87` 的安装测试。fixture 缺少现行契约要求的 `description`、`icon` 和 `market`，在安装成功断言前被拒绝。该测试与 `PluginInstaller.ts` 均无本轮改动；本轮 schema 改动也未改变这些必填规则。保留并记录既有失败，不将本轮测试报告为全部通过。
- 数据库策略与本地引擎测试：shell Node v22.22.1 下两项 SQLite 测试因缺少 `setAuthorizer` 失败；使用 `ELECTRON_RUN_AS_NODE=1`、Electron 内置 Node v24.21.0 复核同组，19 项中 15 通过、4 项外部服务测试跳过、0 失败。
- 独立启用 `ENEST_DB_INTEGRATION=sqlite` 的 SQL 脚本集成：1 项通过，2 项远端数据库测试跳过。
- 暂存文件空白检查通过；新增字体许可证仅规范化行尾空白，许可正文未变。

本轮提交检查没有重新执行 Electron 原生 UI、真实远程数据库/SSH 或全量浏览器套件。此前功能验收分别见同目录对应报告；官网的浏览器、降级与响应式验证见 [官网验收](../site/VALIDATION.md)。

## 插件独立仓库

- `npm run validate`、`npm run api:check`、`npm run docs:check`：通过，覆盖 149 个 API 类型和 16 份开发文档。
- 初次开发文档检查发现 `api.md` 与 `themes.md` 过期，使用仓库同步脚本更新后复查通过。
- `npm test`：346 项通过、1 项跳过、0 失败；新增 Codex 宠物插件独立测试 12 项通过。
- 数据库、中间件、SSH、Codex 宠物四插件构建及发行检查通过。构建保留 chunk 大小和 SSH 静态 vendor 提示，发行资源存在。
- 暂存文件空白检查通过；两份新增文件清理了 EOF 多余空行。未运行插件浏览器 UI 套件。

插件提交：`70e77c57a4126b5585daaed891bdb6e89fd87464`（`feat: 增强插件工作台并同步开发契约`），250 个文件。主仓库提交以包含本记录的 Git 提交为准。
