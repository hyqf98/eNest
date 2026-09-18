# 权限说明

未在 `plugin.json` 的 `permissions` 中声明的 API 调用会 **reject**，错误信息为：

```text
permission denied: <perm>
```

---

## 权限键全表（当前 28 项）

权威源：`src/shared/types/plugin.ts` → `PluginPermission` / `PLUGIN_PERMISSIONS`（运行时 manifest 校验同源）。权限列表随壳子演进动态增加——新增贡献点类权限以「插槽化 / 贡献点」相关文档为准。

| 权限键 | 覆盖的 API | 说明 | 敏感度 |
|--------|-----------|------|--------|
| `clipboard.read` | `enest.clipboard.readText()` | 读系统剪贴板纯文本 | 高 |
| `clipboard.write` | `enest.clipboard.writeText(text)` | 写系统剪贴板纯文本 | 中 |
| `clipboard.readImage` | `enest.clipboard.readImage()` | 读系统剪贴板图片 | 高 |
| `clipboard.writeImage` | `enest.clipboard.writeImage(dataUrl)` | 写系统剪贴板图片 | 中 |
| `clipboard.history` | `enest.clipboard.history.list/get/remove/clear/togglePin` | 读取主机侧剪贴板历史 | 高 |
| `screen.capture` | `enest.screen.capture()`<br>`enest.screen.selectRegion()` | 屏幕截图 / 区域选择 | 高 |
| `screen.record` | `enest.screen.record.start/stop/cancel` | 屏幕录制 | 高 |
| `pin.create` | `enest.pin.open/close/list/closeAll` | 创建置顶贴图窗口 | 中 |
| `net.fetch` | `enest.net.fetch(req)` | 受控 HTTPS 请求（仅 GET/POST，2MB 上限） | 中 |
| `shell.openExternal` | `enest.shell.openExternal(url)` | 用系统默认浏览器打开 http(s) 链接 | 中 |
| `storage.local` | `enest.storage.get/set/remove/clear`<br>`enest.storage.session.get/set/remove/clear` | 持久化 KV **与** 会话态 KV（复用同一权限） | 低 |
| `notify` | `enest.notify({ title, body })` | 操作系统通知 | 低 |
| `ui.setTitle` | `enest.ui.setTitle(title)`<br>别名 `enest.setTitle` | 修改 Tab 标题 | 低 |
| `ui.setIcon` | `enest.ui.setIcon(icon)`<br>别名 `enest.setIcon` | 修改 Tab 图标 | 低 |
| `ui.setBadge` | `enest.ui.setBadge(badge)`<br>别名 `enest.setBadge` | 修改 Tab 角标 | 低 |
| `ui.resize` | `enest.ui.resize(size)`<br>`enest.ui.setHeight(height)`<br>别名 `enest.resize` | 建议内容尺寸 / Quick 高度上报 | 低 |
| `ui.toast` | `enest.ui.toast({ message, type? })` | 壳子应用内 Toast | 低 |
| `settings.register` | `enest.settings.register(section)` | 向壳子设置页注入插件设置分组 | 中 |
| `settings.page` | （预留） | 自定义设置页嵌入（页面嵌入后续批次接线；设置 item `type: "page"` 需此项） | 中 |
| `hotkey` | `enest.hotkey.register(acc, opts?)`<br>`enest.hotkey.unregister(acc)` | 注册/注销全局快捷键（每插件上限 4 个；与壳子 Quick 热键、系统/其它应用占用互斥） | 高 |
| `contribute` | `enest.contribute.registerQuickProvider(meta)`<br>`enest.contribute.unregisterQuickProvider(id)`<br>`enest.contribute.respondQuickQuery(reqId, items)` | 贡献点（Quick 搜索 provider 注册与查询回传）；声明式 `contributes` 段无需此权限 | 中 |
| `vault.write` | `enest.vault.set(key, secret)`<br>`enest.vault.has(keyOrRef)`<br>`enest.vault.remove(keyOrRef)` | 插件密钥保险库写入/存在/删除；`set` 返回 `secretRef`，无明文 get | 高 |
| `ssh.session` | `enest.ssh.connect(input)`<br>`enest.ssh.write/resize/disconnect`<br>`enest.ssh.listSessions()` | SSH 终端会话生命周期 | 高 |
| `ssh.exec` | `enest.ssh.exec(input)`<br>`enest.ssh.metrics.start/stop/latest`<br>`enest.ssh.completion.suggest(input)` | 远程命令执行 / 性能采样 / 命令补全 | 高 |
| `ssh.sftp` | `enest.ssh.sftp.list/download/upload`<br>`enest.ssh.pickLocalFile(opts?)` | SFTP 文件列表与传输、本地文件选择 | 高 |
| `db.connect` | `enest.db.test/open/close/listSessions/pickSqliteFile` | 数据库连接生命周期与 SQLite 文件选择 | 高 |
| `db.query` | `enest.db.execute/explain/cancel`<br>`enest.db.applyChanges`<br>`enest.db.importPreview/importRun` | SQL 执行、结果集变更与 CSV 导入 | 高 |
| `db.schema` | `enest.db.schema.tree/describe/ddl`<br>`enest.db.completion.suggest`<br>`enest.db.dialects.list` | 对象树 / 表详情 / DDL / SQL 补全 / 方言词库 | 中 |

---

## 无需权限的 API

以下方法 **所有插件可用**，不校验 `permissions`：

| API | 原因 |
|-----|------|
| `enest.theme.getTokens()` / `ui.getThemeTokens()` | 主题感知是基础能力 |
| `enest.ui.onThemeChange(cb)` | 同上 |
| `enest.theme.register(pack)` | 主题包注册；`source` 自动绑定插件 id（每插件上限 8 个，仅能覆盖自己的 pack） |
| `enest.i18n.getLocale()` / `onLocaleChange(cb)` | 语言感知是基础能力 |
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
| `clipboard.readImage` | `clipboard.readImage` |
| `clipboard.writeImage` | `clipboard.writeImage` |
| `clipboard.history.list` | `clipboard.history` |
| `clipboard.history.get` | `clipboard.history` |
| `clipboard.history.remove` | `clipboard.history` |
| `clipboard.history.clear` | `clipboard.history` |
| `clipboard.history.togglePin` | `clipboard.history` |
| `screen.capture` | `screen.capture` |
| `screen.selectRegion` | `screen.capture` |
| `screen.record.start` | `screen.record` |
| `screen.record.stop` | `screen.record` |
| `screen.record.cancel` | `screen.record` |
| `pin.open` | `pin.create` |
| `pin.close` | `pin.create` |
| `pin.closeAll` | `pin.create` |
| `pin.list` | `pin.create` |
| `net.fetch` | `net.fetch` |
| `shell.openExternal` | `shell.openExternal` |
| `notify` | `notify` |
| `theme.register` | — （无需） |
| `theme.getTokens` | — （无需） |
| `ui.setHeight` | `ui.resize`（复用，无需单独声明） |
| `hotkey.register` | `hotkey` |
| `hotkey.unregister` | `hotkey` |
| `i18n.getLocale` | — （无需） |
| `contribute.registerQuickProvider` | `contribute` |
| `contribute.unregisterQuickProvider` | `contribute` |
| `contribute.respondQuickQuery` | `contribute` |
| `vault.set` | `vault.write` |
| `vault.has` | `vault.write` |
| `vault.remove` | `vault.write` |
| `ssh.connect` | `ssh.session` |
| `ssh.write` | `ssh.session` |
| `ssh.resize` | `ssh.session` |
| `ssh.disconnect` | `ssh.session` |
| `ssh.listSessions` | `ssh.session` |
| `ssh.exec` | `ssh.exec` |
| `ssh.metrics.start` | `ssh.exec` |
| `ssh.metrics.stop` | `ssh.exec` |
| `ssh.metrics.latest` | `ssh.exec` |
| `ssh.completion.suggest` | `ssh.exec` |
| `ssh.sftp.list` | `ssh.sftp` |
| `ssh.sftp.download` | `ssh.sftp` |
| `ssh.sftp.upload` | `ssh.sftp` |
| `ssh.pickLocalFile` | `ssh.sftp` |
| `db.test` | `db.connect` |
| `db.open` | `db.connect` |
| `db.close` | `db.connect` |
| `db.listSessions` | `db.connect` |
| `db.pickSqliteFile` | `db.connect` |
| `db.execute` | `db.query` |
| `db.explain` | `db.query` |
| `db.cancel` | `db.query` |
| `db.applyChanges` | `db.query` |
| `db.importPreview` | `db.query` |
| `db.importRun` | `db.query` |
| `db.schema.tree` | `db.schema` |
| `db.schema.describe` | `db.schema` |
| `db.schema.ddl` | `db.schema` |
| `db.completion.suggest` | `db.schema` |
| `db.dialects.list` | `db.schema` |

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
const api = window.enest // zapi 为 @deprecated 历史别名，计划 v2 移除

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

- [enest API](api.md) — 各方法的权限标注与错误
- [错误码](errors.md) — `permission denied` 与其它错误
- [plugin.json](manifest.md) — 清单字段（含声明式 `contributes` 贡献点段）
