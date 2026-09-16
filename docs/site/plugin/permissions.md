# 权限说明

未在 `plugin.json` 的 `permissions` 中声明的 API 调用会 **reject**，错误信息为：

```text
permission denied: <perm>
```

---

## 权限键全表

源码：`src/shared/types/plugin.ts` → `PluginPermission`

| 权限键 | 覆盖的 API | 说明 | 敏感度 |
|--------|-----------|------|--------|
| `clipboard.read` | `enest.clipboard.readText()` | 读系统剪贴板纯文本 | 高 |
| `clipboard.write` | `enest.clipboard.writeText(text)` | 写系统剪贴板纯文本 | 中 |
| `shell.openExternal` | `enest.shell.openExternal(url)` | 用系统默认浏览器打开 http(s) 链接 | 中 |
| `storage.local` | `enest.storage.get/set/remove/clear`<br>`enest.storage.session.get/set/remove/clear` | 持久化 KV **与** 会话态 KV（复用同一权限） | 低 |
| `notify` | `enest.notify({ title, body })` | 操作系统通知 | 低 |
| `ui.setTitle` | `enest.ui.setTitle(title)`<br>别名 `enest.setTitle` | 修改 Tab 标题 | 低 |
| `ui.setIcon` | `enest.ui.setIcon(icon)`<br>别名 `enest.setIcon` | 修改 Tab 图标 | 低 |
| `ui.setBadge` | `enest.ui.setBadge(badge)`<br>别名 `enest.setBadge` | 修改 Tab 角标 | 低 |
| `ui.resize` | `enest.ui.resize(size)`<br>别名 `enest.resize` | 建议内容尺寸（当前预留） | 低 |
| `ui.toast` | `enest.ui.toast({ message, type? })` | 壳子应用内 Toast | 低 |
| `settings.register` | `enest.settings.register(section)` | 向壳子设置页注入插件设置分组 | 中 |

---

## 无需权限的 API

以下方法 **所有插件可用**，不校验 `permissions`：

| API | 原因 |
|-----|------|
| `enest.theme.getTokens()` / `ui.getThemeTokens()` | 主题感知是基础能力 |
| `enest.ui.onThemeChange(cb)` | 同上 |
| `enest.theme.register(pack)` | 主题包注册；`source` 自动绑定插件 id |
| `enest.settings.get(key)` / `set(key, value)` | 读写本插件自己的设置，由 Bridge / SettingsStore 按 pluginId 隔离 |
| `enest.on / off` | 事件总线 |
| `enest.onEnter / onOut / onBeforeClose / onDestroy` | 生命周期 |
| `enest.getPluginId() / getEnterCode()` | 同步身份工具 |

---

## method → 权限映射（与主进程一致）

主进程 `pluginHandlers.ts` 中的 `METHOD_PERMISSION`：

| method | 所需权限 |
|--------|----------|
| `ui.setTitle` | `ui.setTitle` |
| `ui.setIcon` | `ui.setIcon` |
| `ui.setBadge` | `ui.setBadge` |
| `ui.resize` | `ui.resize` |
| `ui.toast` | `ui.toast` |
| `settings.register` | `settings.register` |
| `settings.get` | — （无需） |
| `settings.set` | — （无需） |
| `storage.get` | `storage.local` |
| `storage.set` | `storage.local` |
| `storage.remove` | `storage.local` |
| `storage.clear` | `storage.local` |
| `storage.session.get` | `storage.local` |
| `storage.session.set` | `storage.local` |
| `storage.session.remove` | `storage.local` |
| `storage.session.clear` | `storage.local` |
| `clipboard.readText` | `clipboard.read` |
| `clipboard.writeText` | `clipboard.write` |
| `shell.openExternal` | `shell.openExternal` |
| `notify` | `notify` |
| `theme.register` | — （无需） |
| `theme.getTokens` | — （无需） |

未出现在映射表中的 method 返回：`unknown method: <method>`。

---

## 声明示例

最小权限集（只用标题 + 本地存储 + Toast）：

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "main": "index.html",
  "permissions": [
    "ui.setTitle",
    "storage.local",
    "ui.toast"
  ]
}
```

完整能力演示：

```json
{
  "permissions": [
    "clipboard.read",
    "clipboard.write",
    "shell.openExternal",
    "storage.local",
    "notify",
    "ui.setTitle",
    "ui.setIcon",
    "ui.setBadge",
    "ui.resize",
    "ui.toast",
    "settings.register"
  ]
}
```

---

## 处理权限错误

```js
const api = window.enest || window.zapi

try {
  await api.clipboard.writeText('x')
} catch (e) {
  if (String(e.message).startsWith('permission denied:')) {
    console.warn('请在 plugin.json 的 permissions 中声明对应键', e.message)
    // permission denied: clipboard.write
  } else {
    throw e
  }
}
```

可选的运行时能力探测：

```js
async function canCall(fn) {
  try {
    await fn()
    return true
  } catch {
    return false
  }
}

// 探测通常会留下副作用，更稳妥的做法是按 manifest 自己开关 UI
```

!> **生产插件请勿申请与功能无关的敏感权限。** 壳子后续会对安装包做权限展示与二次确认；过度申请会降低安装转化。

---

## 隔离模型（与权限互补）

权限管 **能力门禁**；下面的机制管 **数据与进程隔离**：

| 机制 | 说明 |
|------|------|
| 独立 partition | `persist:plugin-{id}`，cookie / localStorage / IndexedDB 互不可见 |
| 自定义协议 | `enest://plugin/{id}/...` 仅映射该插件根目录，拒绝路径穿越 |
| 统一 preload | 插件无 Node；一切走 `plugin:call` + 权限校验 |
| 身份校验 | sender 必须属于 PluginHost；伪造 pluginId 被拒 |
| 关闭策略 | 日常关 Tab **不清** partition 数据；**卸载**时清理 partition + `plugin-storage/{id}.json` |

---

## 安全边界（插件做不到的事）

- `require('electron')` / 任意 Node API
- 读写插件根目录之外的文件
- 直接操作壳子 DOM / React 组件树
- 调用未声明权限的 API
- 跨插件读取 partition 或 storage
- `shell.openExternal` 打开非 http(s) 协议

---

## 相关文档

- [zapi API](api.md) — 各方法的权限标注与错误
- [错误码](errors.md) — `permission denied` 与其它错误
- [plugin.json](manifest.md) — 清单字段
