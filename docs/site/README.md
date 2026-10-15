# eNest 产品官网与插件文档

`docs/site/` 是 GitHub Pages 的发布根目录。官网使用原生 HTML、CSS 和 JavaScript，无安装依赖和构建步骤；插件开发文档继续使用 Docsify。

## 本地预览

在仓库根目录运行：

```bash
python3 -m http.server 8080 --directory docs/site
```

- 产品首页：<http://127.0.0.1:8080/>
- 下载页：<http://127.0.0.1:8080/download.html>
- 插件文档：<http://127.0.0.1:8080/plugin/>

通过 HTTP 预览，避免 `file://` 与实际部署的资源加载行为差异。所有站内资源使用相对路径，可部署在域名根目录或 `/eNest/` 等子路径。

要验证子路径，可在临时目录创建指向站点的链接后提供服务：

```bash
preview_root=$(mktemp -d)
ln -s "$PWD/docs/site" "$preview_root/eNest"
python3 -m http.server 8081 --directory "$preview_root"
```

打开 <http://127.0.0.1:8081/eNest/>。停止预览后可删除该临时目录中的链接和空目录。

## 文件组织

```text
docs/site/
  index.html               产品首页：工具聚合、窗口形态、使用场景与插件目录
  download.html            平台下载入口与安装指引
  DESIGN.md                设计方向、交互编排与独立视觉审阅记录
  VALIDATION.md            本轮实际验证结果与验证边界
  assets/
    site.css               两页共享设计系统、响应式布局与动效样式
    theme.js               首次绘制前恢复主题偏好，处理主题切换与系统跟随
    landing.js             导航、滚动舞台、筛选和截图展示交互
    fonts/fonts.css        本地字体定义
    icons/                 产品标志
    ASSETS.md              截图、插件图标与字体来源及更新方法
  plugin/                  既有 Docsify 插件开发文档
```

页面设计与动效约定见 [DESIGN.md](DESIGN.md)，实际验证结果及边界见 [VALIDATION.md](VALIDATION.md)。资源的来源、处理与替换方式见 [assets/ASSETS.md](assets/ASSETS.md)。不要把演示截图中的内容当作用户实际业务数据，也不要用展示画面推导未经验证的产品能力。

## 内容与样式维护

- 首页采用暖灰、石墨与橙色的「模块化工具桌」风格。修改两页时共用 `site.css` 的颜色、字体、按钮、导航和页脚；下载页专有布局集中在 `download.html` 的样式块。
- 产品能力与插件名称以当前宿主实现和插件 manifest 为依据。更新插件目录时同步更新本地展示资料，网站运行时不读取开发目录或远程插件索引。
- 下载按钮链接到真实 GitHub Releases。不要把仓库 `package.json` 中的开发版本直接标为已发布版本，也不要加入没有发布说明支持的包体大小或最低系统要求。
- 主题偏好保留在 `enest-site-theme`，默认跟随系统。首页与下载页统一由 `theme.js` 负责首次绘制前恢复、主题切换和系统跟随；`landing.js` 不负责主题状态。
- 保留 `#features`、`download.html`、`plugin/` 等既有入口。新增锚点时确保导航链接在移动端和子路径部署下可用。
- 动效应允许用户直接选择场景，并尊重减少动态效果的系统设置。移动端、短屏和无 JavaScript 环境必须能正常阅读和获取下载入口。
- 插件文档位于 `plugin/`，修改 Markdown 即更新内容。Docsify 的 CDN 配置在 `plugin/index.html`；官网资源本地化不意味着插件文档已离线化。

## 发布

仓库已有 `.github/workflows/deploy-pages.yml`，会将 `docs/site/` 上传为 Pages 静态产物。

1. 在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
2. 将经确认的站点改动推送到 `main`，相关路径变更会触发 **Deploy Pages**；也可手动运行该 workflow。
3. 在 Actions 中确认部署成功，再访问 Pages 提供的地址。

分支式 Pages 只能选择分支根目录或 `/docs`，不能直接选择 `docs/site/`；本目录使用 Actions 发布。站点维护本身不要求自动提交、推送或发布。

## 更新后的检查

这些是维护检查项，不代表每次修改已经完成验证：

- 在 320、390、768、1440px 宽度及短屏横屏检查浅色、深色两种主题，确认文字和截图完整、没有水平溢出。
- 检查菜单、章节跳转、插件筛选、场景切换、截图大图、主题跨页保持，以及键盘焦点与关闭操作。
- 检查减少动态效果、JavaScript 不可用和资源加载失败时的阅读及下载路径。
- 检查根路径和 `/eNest/` 子路径下的页面、图片、字体及开发文档入口。
- 需要验证仓库整体时运行 `npm run typecheck` 和 `npm run build`，在报告中区分既有错误与本次改动引入的问题。
