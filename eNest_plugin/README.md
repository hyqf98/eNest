# eNest_plugin

eNest 官方插件 monorepo。源码在 `plugins/<pluginId>/`，CI 自动生成 `registry.json` 并按变更打出 GitHub Release 资产。

壳子（eNest 桌面端）从本仓库 **Release** 读取插件列表与安装包：

```
GET https://github.com/hyqf98/eNest_plugin/releases/latest/download/registry.json
GET https://github.com/hyqf98/eNest_plugin/releases/latest/download/{id}@{version}.enestplugin
```

回退（无 Release 时）：`raw.githubusercontent.com/hyqf98/eNest_plugin/main/registry.json`

## 目录结构

```
eNest_plugin/
├── plugins/
│   └── com.example.hello/
│       ├── plugin.json          # 插件清单（权威元数据）
│       ├── index.html           # 入口
│       ├── icon.png             # 可选 128×128
│       └── ...
├── registry.json                # CI 生成，勿手改（本地可提交快照便于预览）
├── scripts/build-registry.mjs   # 扫 plugins/ 生成 registry
├── scripts/pack-plugin.mjs      # 打 .enestplugin（zip）
└── .github/workflows/release.yml
```

## 插件清单 `plugin.json`

必填字段与壳子 `PluginManifest` 对齐，市场扩展字段放在 `market` 段：

```jsonc
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "一句话说明插件做什么",
  "author": "Your Name",
  "main": "index.html",
  "permissions": ["storage.local"],
  "category": "效率",
  "icon": "icon.png",
  "homepage": "https://github.com/org/eNest_plugin/tree/main/plugins/com.example.hello",
  "engines": { "enest": ">=0.1.0" },
  "ui": {
    "chrome": "default",
    "themeAware": true,
    "background": "opaque",
    "preferredColorScheme": "auto"
  },
  "market": {
    "featured": false,
    "tags": ["剪贴板", "效率"],
    "screenshots": [],
    "minWidth": 400,
    "minHeight": 300
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 全局唯一，反向域名，目录名必须等于 id |
| `name` | ✓ | 显示名 |
| `version` | ✓ | semver，`major.minor.patch` |
| `description` | ✓ | 市场卡片描述（建议 ≤80 字） |
| `main` | ✓ | 入口 HTML 相对路径 |
| `category` | ✓ | 分类：效率 / 开发 / 设计 / 媒体 / 其它 |
| `icon` | | 相对路径；缺省用 name 首字 |
| `permissions` | | 与壳子权限表一致 |
| `ui` | | chrome / themeAware / background / preferredColorScheme |
| `market` | | 市场展示扩展 |

## registry.json（壳子列表索引）

CI 由所有 `plugin.json` 聚合，**一次下载即可渲染完整列表与分类**：

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-16T12:00:00.000Z",
  "channel": "stable",
  "categories": ["效率", "开发", "设计", "媒体", "其它"],
  "plugins": [
    {
      "id": "com.example.hello",
      "name": "Hello",
      "version": "1.0.0",
      "description": "…",
      "author": "…",
      "category": "效率",
      "icon": "https://github.com/<org>/eNest_plugin/releases/download/plugins-2026.09.16/icons/com.example.hello.png",
      "tags": ["示例"],
      "permissions": ["storage.local"],
      "engines": { "enest": ">=0.1.0" },
      "featured": false,
      "installs": 0,
      "asset": {
        "name": "com.example.hello@1.0.0.enestplugin",
        "url": "https://github.com/<org>/eNest_plugin/releases/download/plugins-2026.09.16/com.example.hello@1.0.0.enestplugin",
        "size": 10240,
        "sha256": "…"
      }
    }
  ]
}
```

### 壳子加载策略（约定）

1. **列表**：优先拉 `releases/latest/download/registry.json`，缓存到本地；失败回退上次缓存或内置 mock。
2. **分类**：直接用 registry.categories / plugin.category，无需二次请求。
3. **安装**：下载 `asset.url` → 校验 `sha256` → 解压 `.enestplugin`（zip）→ 本地 `~/eNest/plugins/`。
4. **更新**：对比本地已装 `version` 与 registry；有新版提示下载。

## 发布命名约定

- Release tag：`plugins-YYYY.MM.DD` 或 `plugins-YYYY.MM.DD.N`（同日多次）
- 资产：`{id}@{version}.enestplugin`
- 附属：`registry.json`、`icons/{id}.png`

## 开发流程

```bash
# 1. 新建插件目录
mkdir -p plugins/com.example.hello
# 2. 写 plugin.json + index.html
# 3. 本地生成索引预览
node scripts/build-registry.mjs
# 4. 单包
node scripts/pack-plugin.mjs com.example.hello
```

合并到 `main` 后由 GitHub Actions 扫描变更插件并创建 Release。

## 分类枚举

固定五类，CI 校验 `category` 必须落在枚举内：

- `效率` `开发` `设计` `媒体` `其它`
