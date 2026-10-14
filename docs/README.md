# docs/ 目录说明

当前插件开发标准从 [开发文档入口](site/plugin/README.md) 开始；本轮改动与实际验证见 [标准化交付报告](engineering/PLUGIN_STANDARDIZATION_REPORT.md) 和后续 [能力与权限收口](engineering/PLUGIN_PERMISSION_CLOSEOUT.md)。SDK、构建工具、文档同步副本和 `skills/enest-development` 在独立插件仓库维护。旧评审/决策记录只用于追溯，不作为现行契约。

按用途分成两块，互不混放：

```
docs/
├── compose/         # 组成式规格（模块级 spec，给维护者）
│   └── spec/
│       ├── core-plugins.md
│       ├── quick-launcher.md
│       └── ssh-db-plugins.md
│
├── engineering/     # 工程内部文档（Markdown，给开发者/维护者）
│   ├── ARCHITECTURE.md
│   ├── PLUGIN_SPEC.md
│   ├── LIFECYCLE_REVIEW.md
│   ├── PERF_REPORT.md
│   ├── SMOKE_MANUAL.md
│   ├── DEVELOPMENT.md
│   └── AUTOMATION.md
│
└── site/            # 对外静态站（GitHub Pages 发布根）
    ├── index.html   # 软件官方首页（可继续扩展介绍页）
    ├── plugin/      # 插件开发文档站
    └── assets/      # 站点样式与图标
```

| 类型 | 路径 | 是否上 Pages |
|------|------|----------------|
| 组成式规格 | `docs/compose/` | 否 |
| 工程文档 | `docs/engineering/` | 否 |
| 官网 / 文档站 | `docs/site/` | 是（Actions 发布） |

后续设计**软件官网介绍页**时，继续在 `docs/site/` 下加页面即可，例如：

```
docs/site/
├── index.html          # 首页（现状）
├── product.html        # 产品介绍（待设计）
├── download.html       # 下载
├── changelog.html      # 更新日志
└── plugin/             # 插件文档（已有）
```

部署：Settings → Pages → Source = **GitHub Actions**，workflow 发布 `docs/site`。

本地预览：

```bash
python3 -m http.server 8080 --directory docs/site
```
