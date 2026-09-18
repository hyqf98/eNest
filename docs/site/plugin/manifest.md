# plugin.json 核心配置

每个插件必须包含清单文件，描述入口、权限与开发态 URL。

## 完整示例

```json
{
  "id": "com.example.todo",
  "name": "轻清单",
  "version": "1.0.0",
  "description": "本地待办",
  "author": "you",
  "logo": "logo.png",
  "main": "index.html",
  "settings": "settings.html",
  "engines": { "enest": ">=0.1.0" },
  "permissions": [
    "storage.local",
    "notify",
    "ui.setTitle",
    "settings.register"
  ],
  "window": { "minWidth": 480, "minHeight": 320 },
  "features": [
    { "code": "main", "explain": "打开待办", "cmds": ["todo", "待办"] }
  ],
  "development": {
    "main": "http://127.0.0.1:5173/index.html"
  }
}
```

## 字段说明

| 字段 | 必选 | 说明 |
|------|------|------|
| `id` | 是 | 全局唯一，建议反向域名 |
| `name` | 是 | 显示名称 |
| `version` | 是 | semver |
| `main` | 是 | HTML 入口相对路径 |
| `description` | 否 | 市场描述文案（插件仓库 schema 必填；壳子安装校验仅建议） |
| `author` | 否 | 作者 |
| `logo` | 否 | 图标文件相对路径（png/svg），市场卡片与大图头展示 |
| `settings` | 否 | 设置页 HTML（保留/实验字段，壳子尚未消费） |
| `engines.enest` | 否 | 壳子版本约束（`*` / `^x.y.z` / `>=x.y.z` / 精确；复杂范围拒绝安装） |
| `permissions` | 否 | API 白名单（18 项，见 [权限](permissions.md)），未声明则调用失败 |
| `window` | 否 | 建议窗口尺寸（minWidth / minHeight） |
| `development.main` | 否 | 开发态 URL（Vite/Webpack） |
| `features` | 否 | 可搜索指令（Quick 命令面板，`{ code, explain?, cmds }`） |
| `form` | 否 | 打开形态：`mini` 命令面板小窗优先 / `panel` 主窗 Tab（缺省） |
| `ui` | 否 | UI 集成：chrome（缺省 `none`）/ themeAware / background / preferredColorScheme，见 [UI 集成标准](ui-standard.md) |

> ⚠️ **`id` 安装后用于数据目录与 partition，改名会导致数据「丢失」（仍在旧目录）。**

## 校验规则

两层校验：

1. **插件仓库 CI**（eNest_plugin，ajv + `plugin-manifest.schema.json`）：`id` / `name` / `version` / `main` / `description` 必填，权限枚举、`features` / `window` / `form` / `development` / `settings` / `ui` / `logo` 结构化定义。
2. **壳子安装/加载时**（程序化校验，见 `PluginInstaller.collectManifestIssues`）：
   - 目录内存在可读的 `plugin.json` 且 JSON 可解析
   - `id` 反向域名格式、`name` 非空、`version` semver、`main` 非空
   - `description` 建议但不强制（与 schema required 的差异）
   - `permissions` 每一项都在白名单 `PLUGIN_PERMISSIONS` 内
   - `engines.enest` 版本范围满足当前壳子版本（不支持的范围语法拒绝安装）
   - `main` 入口文件存在于插件根目录
   - 全部错误一次性收集返回（消息带插件 id 与字段名）

失败会抛出对应错误，见 [错误码](errors.md)。

## 下一步

[enest API →](api.md)
