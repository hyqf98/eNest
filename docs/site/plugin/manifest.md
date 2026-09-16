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
| `description` | 否 | 市场描述文案 |
| `author` | 否 | 作者 |
| `logo` | 否 | 图标路径 |
| `preload` | 否 | 自定义预加载（一般不需要，壳子已注入 zapi） |
| `settings` | 否 | 设置页 HTML |
| `engines.enest` | 否 | 壳子版本约束 |
| `permissions` | 否 | API 白名单，未声明则调用失败 |
| `window` | 否 | 建议窗口尺寸（minWidth / minHeight） |
| `development.main` | 否 | 开发态 URL（Vite/Webpack） |
| `features` | 否 | 可搜索指令（后续市场接入） |
| `ui` | 否 | UI 集成：chrome / themeAware / background / preferredColorScheme，见 [UI 集成标准](ui-standard.md) |

> ⚠️ **`id` 安装后用于数据目录与 partition，改名会导致数据「丢失」（仍在旧目录）。**

## 校验规则

壳子安装/加载本地目录时会校验：

1. 目录内存在可读的 `plugin.json`
2. JSON 可解析
3. 至少包含 `id` / `name` / `version` / `main`

失败会抛出对应错误，见 [错误码](errors.md)。

## 下一步

[zapi API →](api.md)
