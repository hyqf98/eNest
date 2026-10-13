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
  "category": "效率",
  "market": {
    "featured": true,
    "tags": ["待办", "效率"],
    "screenshots": ["assets/screenshots/overview.webp"]
  },
  "main": "index.html",
  "settings": "settings.html",
  "engines": { "enest": ">=0.1.0" },
  "permissions": [
    "storage.local",
    "notify",
    "ui.setTitle",
    "settings.register"
  ],
  "window": { "width": 760, "height": 400, "minWidth": 480, "minHeight": 240 },
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
| `logo` / `icon` | 否 | 图标相对路径或 HTTPS URL，`logo` 优先、`icon` 兜底；本地支持 PNG / JPEG / WebP / GIF / SVG / ICO |
| `homepage` | 否 | 插件主页 URL（string），市场详情页展示 |
| `category` | 否 | 市场分类：效率 / 开发 / 设计 / 媒体 / 其它 |
| `market` | 否 | 市场展示元数据：`featured` 推荐标记、`tags` 标签数组、`screenshots` 有序截图，见下节 |
| `settings` | 否 | 设置页 HTML（实验特性，当前版本暂未启用） |
| `engines.enest` | 否 | 壳子版本约束（`*` / `^x.y.z` / `>=x.y.z` / 精确；复杂范围拒绝安装） |
| `permissions` | 否 | API 白名单（29 项，见 [权限](permissions.md)），未声明则调用失败；运行时另有按插件的三态授权（allow / ask / deny） |
| `contributes` | 否 | 贡献点声明（见下节）：`settings` / `homeCards` / `railEntries` / `themePacks` |
| `window` | 否 | Quick 内嵌时的内容区尺寸建议 width / height，及下限 minWidth / minHeight；主窗尺寸由用户控制 |
| `development.main` | 否 | 开发态 URL（Vite/Webpack） |
| `features` | 否 | 可搜索指令（Quick 命令面板，`{ code, explain?, cmds }`） |
| `ui` | 否 | UI 集成：chrome（缺省 `none`）/ themeAware / background / preferredColorScheme，见 [UI 集成标准](ui-standard.md) |

打开容器不由 manifest 决定：从 Quick 快捷启动打开 → quick 容器（小窗内嵌）；从主窗（市场 / 圆轨 / Tab）打开 → shell 容器（主窗 Tab）。用户可在插件详情中为每插件覆盖启动方式（`settings.pluginLaunch[id]`），见 [UI 集成标准 → 双入口样式](ui-standard.md)。

## 市场截图与推荐

市场数据由独立的 `eNest_plugin` 仓库生成。插件作者在 `plugins/<id>/plugin.json` 中声明：

```json
{
  "category": "效率",
  "market": {
    "featured": true,
    "tags": ["待办", "效率"],
    "screenshots": [
      "assets/screenshots/overview.webp",
      "assets/screenshots/detail.webp"
    ]
  }
}
```

- `featured` 默认为 `false`。首页优先排列推荐插件，其余保持索引顺序，最多展示 5 个产品横幅。
- `tags` 为插件标签数组（市场索引透传，供搜索与分类展示）。
- `screenshots` 最多 8 张，保持声明顺序，第一张作为首页产品封面。建议横向截图，图片完整显示，不裁掉界面内容。
- 本地截图路径相对于插件根目录，文件必须存在，支持 PNG、JPEG、WebP、GIF；不能使用绝对路径、`..` 或指向目录外的符号链接。也支持不带账号密码的 HTTPS 图片 URL。
- 本地生成的 `registry.json` 将路径转换为 `plugins/<id>/...`；发布脚本将截图复制为 `<id>@<version>-screenshot-<序号>.<扩展名>` 附件，并写入包含 Release 版本的完整 URL。外部 HTTPS URL 原样保留。

壳子读取的是索引条目顶层的 `screenshots`、`featured` 和 `category`，不会直接请求远程 `plugin.json`。相对图片 URL 按索引所在目录解析；安装后仍保留市场截图和推荐信息，开发插件优先使用本地清单里的截图。首页可手动浏览多张截图、点击查看大图；加载失败的图片会被跳过，无可用截图时显示插件图标与分类。

添加截图需要同时提交实际图片与清单路径，并通过插件仓库的校验、打包和发布流程。仅修改清单、尚未上传图片的地址无法显示。

## contributes 贡献点

声明式的功能挂载：在 `plugin.json` 里写好，安装后壳子扫描注册，**无需插件运行** 即出现在对应位置（重启后仍在）。四类插槽：

```json
{
  "contributes": {
    "settings": [
      {
        "id": "sync",
        "title": "同步设置",
        "schemaVersion": "1",
        "items": [
          { "key": "autoSync", "type": "boolean", "label": "自动同步", "default": true },
          { "key": "interval", "type": "number", "label": "间隔（分钟）", "default": 15 }
        ]
      }
    ],
    "homeCards": [
      {
        "id": "todo-card",
        "title": "今日待办",
        "glyph": "办",
        "color": "#5b8cff",
        "explain": "打开轻清单",
        "openCode": "main"
      }
    ],
    "railEntries": [
      {
        "id": "todo-rail",
        "glyph": "办",
        "title": "待办",
        "openCode": "main"
      }
    ],
    "themePacks": [
      { "id": "my-theme", "name": "晨雾", "mode": "dark", "tokens": { "--accent": "#14b892" } }
    ]
  }
}
```

字段契约（`@shared/types/plugin.ts`）：

| 插槽 | 位置 | 字段 |
|------|------|------|
| `settings` | 设置页 | `{ id, title, schemaVersion?, items }`；item：`{ key, type, label, default?, options?, min?/max?/step? }`。控件类型全集见下表 |
| `homeCards` | 首页「插件扩展」区块 | `{ id, title, glyph?, color?, explain?, openCode?, schemaVersion? }` — `openCode` 为点击打开插件时透传的 feature code（无 `action` 字段）；`glyph` 缺省用插件名首字，`color` 缺省回退插件色 |
| `railEntries` | 左侧轨道（orb 模式） | `{ id, glyph（**必填**）, color?, title?, openCode?, schemaVersion? }` — 无 `icon` / `featureCode` 字段，入口透传用 `openCode` |
| `themePacks` | 主题设置 | `ThemePack` 形状 `{ id, name, mode?, tokens, background? }`，等价运行时 `enest.theme.register`（需 `theme` 权限的是运行时路径；声明式路径无需声明），但安装即生效；`source` 强制绑定本插件 id |

每个贡献项可带 `schemaVersion`（缺省视为当前版本 `'1'`）；与壳子 `ContributionRegistry` 支持版本不匹配时整条拒绝注册。

设置 item `type` 控件类型全集：

| type | 说明 |
|------|------|
| `text` / `string` | 文本输入 |
| `switch` / `boolean` / `bool` | 开关 |
| `select` | 下拉选择，需 `options: Array<{ label, value }>` |
| `number` | 数字输入 |
| `slider` | 滑杆，需 `min` / `max` / `step` |
| `color` | 颜色输入 |
| `page` | **预留**：自定义设置页嵌入（本期仅声明，需 `settings.page` 权限，页面嵌入后续批次启用） |

非法 type 渲染层回退 `text`。

注册 / 卸载 / 禁用引起的贡献变更会广播 `shell:event` `contributions-changed { slot, source }`，渲染层据此刷新对应插槽；`themePacks` 变更则经 `theme-packs-changed` 刷新主题下拉。

?> Quick 搜索 provider 无法声明式注册（查询逻辑在插件页面里），请用运行时 `enest.contribute.registerQuickProvider`，见 [enest API](api.md)。

> ⚠️ **`id` 安装后用于数据目录与 partition，改名会导致数据「丢失」（仍在旧目录）。**

## 校验规则

两层校验：

1. **插件仓库 CI**：`id` / `name` / `version` / `main` / `description` 必填，权限枚举、`features` / `window` / `development` / `settings` / `ui` / `contributes` / `logo` 结构化定义。
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
