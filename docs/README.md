# docs/ 目录说明

按用途分成两块，互不混放：

```
docs/
├── engineering/     # 工程内部文档（Markdown，给开发者/维护者）
│   ├── ARCHITECTURE.md
│   ├── PLUGIN_SPEC.md
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
