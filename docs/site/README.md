# eNest 静态站（GitHub Pages）

## 部署方式（不需要独立仓库）

GitHub Pages **同一仓库即可**，两种源：

| 方式 | 配置 | 适合 |
|------|------|------|
| **GitHub Actions（推荐）** | Settings → Pages → Source = **GitHub Actions** | 任意子目录，本仓库用 `docs/site` |
| 分支 `/docs` | Source = branch `main`，Folder = `/docs` | 仅当把站点文件直接放在 `docs/` 根（会与工程 md 混放，不推荐） |

分支模式**不能**发布 `docs/site` 这种嵌套目录；嵌套目录请用 Actions。

## 本仓库结构

```
docs/
  engineering/          # 工程 Markdown（不发布）
  evaluation-docs.md    # 文档站模板选型与缺口评估
  site/                 # ← Pages 发布根
    index.html          # 软件官方页（营销落地）
    plugin/             # Docsify 插件开发文档站（零构建）
      index.html        # Docsify shell（CDN）
      README.md
      _sidebar.md
      _navbar.md
      getting-started.md
      structure.md
      manifest.md
      api.md
      permissions.md
      debug.md
      lifecycle.md
      errors.md
      examples.md
      faq.md
    assets/
      site.css
      icons/
  README.md             # docs 划分说明
```

- **官网**：`docs/site/index.html`（自定义 HTML + `assets/site.css`）
- **插件文档**：`docs/site/plugin/` 使用 [Docsify](https://docsify.js.org/)，源文件为 Markdown；改 md 即改站，无构建步骤。
- CDN 使用 jsdelivr；离线可把 `docsify.min.js` 与主题 CSS 放到 `plugin/vendor/` 并改 `plugin/index.html`（文件内有中文注释）。

后续官网介绍页请加在 `docs/site/`（如 `product.html`），并在 `index.html` 导航中挂链接。

## 启用步骤

1. 推送到 GitHub `main`
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**
3. 手动跑一次 workflow **Deploy Pages**，或改 `docs/site` 后 push 自动部署
4. 访问 `https://<user>.github.io/<repo>/`

## 本地预览

```bash
# 在仓库根
python3 -m http.server 8080 --directory docs/site
# 官网  http://127.0.0.1:8080/
# 文档  http://127.0.0.1:8080/plugin/
```
