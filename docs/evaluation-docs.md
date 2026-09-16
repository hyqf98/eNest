# eNest 公开文档站评估（2026-09）

> 范围：`docs/site`（原自定义 HTML 插件文档 + 官网落地页）  
> 结论：已采用 **Docsify 4** 作为插件文档模板；官网 `docs/site/index.html` 保留。

---

## 1. 原文档完整性评估

对照「真实插件开发文档集」清单：

| 章节 | 原状态 | 缺口 |
|------|--------|------|
| 快速开始 | ✅ `getting-started.html` | 内容可用 |
| 目录结构 | ⚠️ 仅嵌在概览 | 无独立页；缺框架工程布局、安装落盘路径 |
| plugin.json | ✅ `manifest.html` | 缺校验失败说明 |
| API | ✅ `api.html` | 缺方法级参数/返回/权限矩阵（已部分补到 md） |
| 权限 | ✅ `permissions.html` | 缺「未声明时错误文案」 |
| 调试 | ✅ `debug.html` | FAQ 表偏薄 |
| 生命周期 | ❌ 缺失 | 打开/切换/重载/关闭/卸载无文档 |
| 错误码 | ❌ 缺失 | 源码 `Error.message` 未成文 |
| 示例 | ⚠️ 仅提及 hello | 无 `plugins-samples` 一览 |
| FAQ | ⚠️ 仅调试页小表 | 无独立 FAQ |

其它问题：

- 每页复制粘贴侧栏/顶栏，改导航需改 6+ 个 HTML，维护成本高。
- 无全文搜索、无移动端友好侧栏折叠策略。
- 站点根 `.nojekyll` 已有，适合 GitHub Pages；无构建链则与 Docsify 天然匹配。

---

## 2. 模板选型

| 候选 | 构建 | 与本仓匹配度 | 结论 |
|------|------|--------------|------|
| **Docsify 4** | 无（运行时渲染 MD） | `docs/site` 已是静态根；Markdown 即源 | **采用** |
| VitePress | Node 构建产物 | 需 package.json、主题定制、CI 构建步骤 | 过重 |
| Docusaurus | 重型 React 文档框架 | 单产品多页面尚可，对「壳子文档子站」过重 | 否决 |

**选择 Docsify 的原因：**

1. **零构建**：`plugin/index.html` + `*.md` 直接可挂 GitHub Pages（Actions 已发布 `docs/site`）。
2. **中文 UI** 可配置；侧栏 `_sidebar.md` / 导航 `_navbar.md` 单点维护。
3. 原内容为短篇 API 文档，无需 MDX/组件化；Docsify 插件（search）够用。
4. 官网落地页与文档站目录隔离（`index.html` vs `plugin/`），互不干扰。
5. CDN 引入 + 注释标明本地 vendor 回退，满足内网降级。

**未选 VitePress 的反例条件**（若未来触发可再迁）：需要版本化文档、SSG SEO 刚需、组件级交互 demo、与 monorepo 包类型联合发布。

---

## 3. 落地结构

```text
docs/site/
  index.html              # 官网（保留，链接改指 Docsify 路由）
  plugin/                 # Docsify 根
    index.html            # docsify shell（CDN + 中文配置注释）
    README.md             # 概览
    _sidebar.md
    _navbar.md
    getting-started.md
    structure.md          # 新增
    manifest.md
    api.md
    permissions.md
    debug.md
    lifecycle.md          # 新增
    errors.md             # 新增
    examples.md           # 新增
    faq.md                # 新增
  assets/                 # 官网样式与图标（复用）
  README.md               # 部署说明（已更新）

docs/evaluation-docs.md   # 本文件
docs/engineering/         # 未改动（内部工程文档）
```

原 `plugin/*.html` 正文已全文迁入对应 Markdown，侧栏/顶栏由 Docsify 统一渲染。

---

## 4. 遗留缺口（后续）

1. **API 参考粒度**：`enest.settings` / `theme` 等尚未方法级参数表与 TS 类型文件外置。
2. **zip 安装 / 签名 / 权限二次确认** 文档需在功能落地后补。
3. **版本化**（`v0.1` / `next`）未做；Docsify 需手动多目录或再评估 VitePress。
4. **CDN 依赖**：国内网络可改 jsdelivr → unpkg 或 vendor 到 `plugin/vendor/`。
5. **官网导航** `GitHub` 仍为占位链接，需换成真实仓库 URL。
6. 截图/GIF（开发者控制台、市场详情）尚未补充。

---

## 5. 本地预览

```bash
python3 -m http.server 8080 --directory docs/site
# 官网 http://127.0.0.1:8080/
# 文档 http://127.0.0.1:8080/plugin/
```
