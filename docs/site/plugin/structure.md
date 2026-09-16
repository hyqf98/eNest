# 目录结构

插件是一个**本地目录**，安装后按 `id` + `version` 落到数据根目录。

## 标准布局

```text
my-plugin/
├── plugin.json      # 必选：清单
├── logo.png         # 可选：图标（建议 512×512）
├── index.html       # 必选：主界面入口
├── README.md        # 建议：市场详情页渲染
├── settings.html    # 可选：设置面板
└── preload.js       # 可选（壳子已注入 enest API，一般无需自带）
```

## 约定说明

| 文件/目录 | 要求 | 说明 |
|-----------|------|------|
| `plugin.json` | 必选 | 描述 `id`、入口、权限；缺失则安装失败 |
| `main` 指向的 HTML | 必选 | 可以是相对路径，如 `index.html` 或 `dist/index.html` |
| `logo` | 可选 | 市场卡片与 Tab 图标；缺省用壳子默认图标 |
| `README.md` | 建议 | 详情弹窗用 Markdown 渲染 |
| `settings` | 可选 | 与 `settings.register` 二选一或并用 |
| 静态资源 | 自由 | 通过 `enest://plugin/{id}/...` 访问，禁止 `..` 穿越 |

## 框架工程示例（Vite）

```text
my-plugin/
├── plugin.json          # main 指向 dist/index.html
├── src/                 # 源码（不随插件包发布）
├── dist/                # 构建产物（发布内容）
│   └── index.html
├── package.json
└── README.md
```

开发态使用 `development.main` 指向 Vite 服务，见 [调试与热更新](debug.md)。

## 安装后落盘（壳子侧）

| 路径 | 用途 |
|------|------|
| `~/eNest/plugins/{id}/{version}/` | 插件安装目录 |
| `~/eNest/data/` | 壳子 SQLite 等数据 |
| session partition `persist:plugin-{id}` | Cookie / localStorage 隔离 |

> 改 `plugin.json` 的 `id` 等于换插件：旧数据目录不会自动迁移，见 [FAQ](faq.md)。
