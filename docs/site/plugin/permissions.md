# 权限说明

未在 `plugin.json` 的 `permissions` 中声明的 API 调用会返回错误（`permission denied: <key>`）。

## 对照表

| 权限键 | API | 说明 |
|--------|-----|------|
| `ui.setTitle` | `enest.ui.setTitle` | 修改 Tab 标题 |
| `ui.setIcon` | `enest.ui.setIcon` | Tab 图标 |
| `ui.setBadge` | `enest.ui.setBadge` | 角标数字 |
| `ui.resize` | `enest.ui.resize` | 建议内容尺寸 |
| `storage.local` | `enest.storage.*` | 插件本地 KV |
| `clipboard.read` | `enest.clipboard.readText` | 读剪贴板 |
| `clipboard.write` | `enest.clipboard.writeText` | 写剪贴板 |
| `shell.openExternal` | `enest.shell.openExternal` | 系统浏览器 |
| `notify` | `enest.notify` | 系统通知 |
| `settings.register` | `enest.settings.*` | 设置页注入 |

## 原则

- **最小权限**：只申请当前版本用到的能力。
- 插件**不能**直接 `require('electron')` 或访问 Node 任意 API。
- 存储与 Cookie 按插件 partition 隔离，卸载可清理。

## 声明示例

```json
{
  "permissions": [
    "storage.local",
    "notify",
    "ui.setTitle"
  ]
}
```

调用未声明能力时：

```js
// 未在 permissions 中声明 → 失败
try {
  await enest.clipboard.writeText('x')
} catch (e) {
  console.error(e.message) // permission denied: clipboard.write
}
```

> ⚠️ 生产插件请勿申请与功能无关的敏感权限；壳子后续会对安装包做权限展示与二次确认。
