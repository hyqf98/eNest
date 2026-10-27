# eNest 官方文档

`docs/` 只维护产品官网与官方插件开发文档，不存放开发过程、阶段汇报、审计结论或运行产物。

| 入口 | 内容 |
| --- | --- |
| [产品首页](site/index.html) | 软件定位、窗口形态、插件目录与使用场景 |
| [下载说明](site/download.html) | 真实发行入口、平台包与安装注意事项 |
| [官方 API 与开发指南](site/plugin/README.md) | 清单、公共 API、权限、存储、生命周期、主题、设置与 MCP |
| [网站维护](site/README.md) | 本地预览、内容来源与 GitHub Pages 发布方式 |

GitHub Pages 发布根保持为 `docs/site/`，由 `.github/workflows/deploy-pages.yml` 发布；API 文档与产品页共用同一站点，不需要重新部署另一套文档服务。

宿主的性质与开发约束统一在根 [AGENTS.md](../AGENTS.md)，项目命令在根 [README.md](../README.md)。官方 API 的可同步 Markdown 是 `docs/site/plugin/`；插件仓的 `docs/developer/` 是生成副本，不单独维护。

更新能力时直接修改对应指南和产品说明，不另建工程报告目录。验证输出放在被忽略的 `.cache/verification/`，临时文件完成后清理；当次验证结果在任务回复中说明。
