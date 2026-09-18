# plugin.json 字段说明（manifest 参考）

权威 schema：同目录 [`plugin-manifest.schema.json`](./plugin-manifest.schema.json)。
运行时类型：壳子 `src/shared/types/plugin.ts`（`PluginManifest` / `PluginContributes` / `PLUGIN_PERMISSIONS`）。

## 必填字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 全局唯一反向域名（`^[a-z0-9]+(\.[a-z0-9-]+)+$`），必须与目录名一致 |
| `name` | string | 显示名 |
| `version` | string | semver（`x.y.z`，允许 `-beta.1` / `+build` 后缀） |
| `main` | string | HTML 入口相对路径（缺省 `index.html`） |
| `description` | string | 一句话说明（≤200 字符） |

## 可选字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `author` / `logo` / `icon` / `homepage` / `category` | — | 市场展示元数据 |
| `engines.enest` | string | 壳子版本范围：`*` / `^x.y.z` / `>=x.y.z` / 精确 |
| `permissions` | string[] | API 白名单（**21 项**，见下） |
| `features[]` | `{ code, cmds[], explain? }` | Quick 可搜索指令；`cmds` 为触发关键词 |
| `window` | `{ minWidth?, minHeight? }` | 建议窗口最小尺寸 |
| `form` | `mini \| panel` | 打开形态：mini 小窗优先；panel 主窗 Tab（缺省） |
| `development.main` | string | 开发态 dev server URL |
| `settings` | string | 设置页 HTML 路径（保留/实验） |
| `ui` | object | UI 集成：`chrome` / `themeAware` / `background` / `preferredColorScheme` |
| `contributes` | object | **贡献点声明（插槽化架构）**，见下节 |

### UI 一致性：themeAware 与 followShellTheme

与壳子 UI Standard v2 对齐时请注意：`ui` 整段或 `themeAware` 字段缺失时，**`themeAware` 缺省为 `true`**（壳子注入 CSS Token 并推送主题变更），与 `plugin-manifest.schema.json` / 壳子 `DEFAULT_PLUGIN_UI` 描述一致。插件侧 **SHOULD** 另经 `enest.settings.register` 或 `contributes.settings` 暴露布尔设置 **`followShellTheme`（缺省 `true`）**：`true` 时消费壳子 Token 并跟随主题；`false` 时插件钉住自有 `preferredColorScheme`。视觉 Token 清单、设计语言与检查清单见主仓 `docs/site/plugin/ui-standard.md`（设计语言与样式规范 · UI Standard v2）。

## permissions（21 项）

`clipboard.read` `clipboard.write` `clipboard.readImage` `clipboard.writeImage`
`clipboard.history` `screen.capture` `screen.record` `pin.create` `net.fetch`
`shell.openExternal` `storage.local` `notify` `ui.setTitle` `ui.setIcon`
`ui.setBadge` `ui.resize` `ui.toast` `settings.register` `settings.page` `hotkey`
`contribute`

- `settings.page`：自定义设置页嵌入（预留，本期仅声明与校验）。
- `contribute`：运行时贡献点 API（`enest.contribute.*`，Quick 搜索 provider）。

## contributes（贡献点，插槽化架构）

声明式注册：安装 / Registry 扫描时写入壳子 `enest.db` 的 `contributions` 表，
**重启即显示，不依赖插件运行**。`schemaVersion` 缺省视为 `'1'`，不匹配整条拒绝；
同 `(slot, id)` 后注册覆盖前者。变更经 `shell:event`
`contributions-changed { slot, source }` 广播。

```jsonc
"contributes": {
  // 设置 section：设置页插件分组（等价运行时 enest.settings.register）
  "settings": [
    {
      "id": "hello.prefs",
      "title": "Hello 工具",
      "items": [
        { "key": "name", "type": "text", "label": "称呼", "default": "朋友" },
        { "key": "opacity", "type": "slider", "label": "不透明度", "min": 0, "max": 100, "step": 5, "default": 80 },
        { "key": "accent", "type": "color", "label": "强调色", "default": "#5b8cff" }
      ]
    }
  ],
  // 首页卡片：市场页（首页）「插件扩展」区块
  "homeCards": [
    { "id": "hello-card", "title": "Hello", "glyph": "H", "color": "#5b8cff",
      "explain": "快速打招呼", "openCode": "main" }
  ],
  // 左侧轨道入口（orb 模式；数据层已下发，渲染消费后续批次接线）
  "railEntries": [
    { "id": "hello-rail", "glyph": "H", "color": "#5b8cff", "title": "Hello", "openCode": "main" }
  ],
  // 主题包（等价运行时 enest.theme.register；source 强制绑插件 id）
  "themePacks": [ { "id": "...", "name": "...", "mode": "dark", "tokens": {} } ]
}
```

| 插槽 | 字段 | 消费方 |
|------|------|--------|
| `settings` | `contributes.settings[]` | 设置页插件分组（值仍存 settings.json plugins 段） |
| `home-cards` | `contributes.homeCards[]` | 市场页「插件扩展」卡片，点击 `openPlugin(pluginId, { code: openCode })` |
| `rail-entries` | `contributes.railEntries[]` | orb 圆轨底部入口（orb-state 下发） |
| `theme-packs` | `contributes.themePacks[]` | 设置 → 主题下拉 |
| quick provider | 运行时 only | `enest.contribute.registerQuickProvider`（manifest 声明不生效） |

设置 item `type`：`text` / `string` / `switch` / `boolean` / `bool` / `select`（需
`options`）/ `number` / `slider`（需 `min` / `max` / `step`）/ `color` / `page`
（预留，需 `settings.page` 权限）。非法 type 渲染层回退 text。
