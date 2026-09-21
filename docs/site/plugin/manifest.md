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
| `settings` | 否 | 设置页 HTML（实验特性，当前版本暂未启用） |
| `engines.enest` | 否 | 壳子版本约束（`*` / `^x.y.z` / `>=x.y.z` / 精确；复杂范围拒绝安装） |
| `permissions` | 否 | API 白名单（28 项，见 [权限](permissions.md)），未声明则调用失败 |
| `contributes` | 否 | 贡献点声明（见下节）：`settings` / `homeCards` / `railEntries` / `themePacks` |
| `window` | 否 | 建议窗口尺寸（minWidth / minHeight） |
| `development.main` | 否 | 开发态 URL（Vite/Webpack） |
| `features` | 否 | 可搜索指令（Quick 命令面板，`{ code, explain?, cmds }`） |
| `form` | 否 | 打开形态：`mini` 命令面板小窗优先 / `panel` 主窗 Tab（缺省） |
| `ui` | 否 | UI 集成：chrome（缺省 `none`）/ themeAware / background / preferredColorScheme，见 [UI 集成标准](ui-standard.md) |

## contributes 贡献点

声明式的功能挂载：在 `plugin.json` 里写好，安装后壳子扫描注册，**无需插件运行** 即出现在对应位置（重启后仍在）。四类插槽：

```json
{
  "contributes": {
    "settings": [
      {
        "title": "同步设置",
        "items": [
          { "key": "autoSync", "type": "boolean", "label": "自动同步", "default": true },
          { "key": "interval", "type": "number", "label": "间隔（分钟）", "default": 15 }
        ]
      }
    ],
    "homeCards": [
      { "title": "今日待办", "action": { "type": "open-plugin" } }
    ],
    "railEntries": [
      { "title": "待办", "icon": "check", "featureCode": "main" }
    ],
    "themePacks": [
      { "id": "my-theme", "name": "晨雾", "mode": "dark", "tokens": { "--accent": "#14b892" } }
    ]
  }
}
```

| 插槽 | 位置 | 说明 |
|------|------|------|
| `settings` | 设置页 | 分组 + 表单项（boolean / number / string / select），值经 `enest.settings.get/set` 读写 |
| `homeCards` | 首页 | 「插件扩展」区块的入口卡片 |
| `railEntries` | 左侧轨道（orb 模式） | 圆轨上的快捷入口，`featureCode` 关联 `features[].code` |
| `themePacks` | 主题设置 | 等价运行时 `enest.theme.register`，但安装即生效 |

?> Quick 搜索 provider 无法声明式注册（查询逻辑在插件页面里），请用运行时 `enest.contribute.registerQuickProvider`，见 [enest API](api.md)。

> ⚠️ **`id` 安装后用于数据目录与 partition，改名会导致数据「丢失」（仍在旧目录）。**

## 校验规则

两层校验：

1. **插件仓库 CI**：`id` / `name` / `version` / `main` / `description` 必填，权限枚举、`features` / `window` / `form` / `development` / `settings` / `ui` / `contributes` / `logo` 结构化定义。
2. **壳子安装/加载时**（程序化校验）：
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
