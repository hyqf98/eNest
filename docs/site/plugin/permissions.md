# 权限说明

插件的权限门禁分两层：**manifest 静态声明** + **运行时三态授权**。

## 授权模型（静态声明 + 运行时三态）

**第一层：manifest 静态声明。** `plugin.json` 的 `permissions` 数组声明插件会用到的能力（白名单 29 项，见下表）。调用未声明权限的方法直接 reject：

```text
permission denied: <perm>
```

**第二层：运行时三态授权。** 每项已声明权限还对应一份 **按插件持久化** 的运行时授权状态：

| 状态 | 行为 |
|------|------|
| `allow` | 直接放行（用户选过「总是允许」） |
| `ask` | **默认值**。壳子弹出授权弹窗：「本次允许 / 总是允许 / 拒绝」 |
| `deny` | 直接拒绝，等价未声明 |

弹窗细则：

- 「**本次允许**」：仅本次调用放行，状态保持 `ask`，下次再问；
- 「**总是允许**」：状态记为 `allow`，此后不再询问；
- 「**拒绝**」：本次拒绝，且状态 **记住为 `deny`**（后续同权限调用直接 reject，不再弹窗）；可在 **插件设置 → 权限管理** 中改回；
- **60 秒无响应**：自动按「本次拒绝」处理（状态保持 `ask`，下次调用再弹）。

所有拒绝路径（未声明 / `deny` / 弹窗拒绝）的错误串统一为 `permission denied: <perm>`。

?> 静态声明是「能力入口」：不声明则连弹窗机会都没有。合理做法仍是只声明用到的权限——运行时弹窗次数越少，插件体验越顺。

---

## 权限键全表（当前 29 项）

权限列表随版本演进逐步增加，新增贡献点类权限以更新说明为准。

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
| `shell.openExternal` | `enest.shell.openExternal(url)`<br>`enest.shell.saveTextFile(payload)` | 用系统默认浏览器打开 http(s)/mailto/tel 链接、另存文本文件 | 中 |
| `storage.local` | `enest.storage.get/set/remove/clear`<br>`enest.storage.session.get/set/remove/clear` | 持久化 KV **与** 会话态 KV（复用同一权限） | 低 |
| `notify` | `enest.notify({ title, body })` | 操作系统通知 | 低 |
| `ui.setTitle` | `enest.ui.setTitle(title)`<br>别名 `enest.setTitle` | 修改 Tab 标题 | 低 |
| `ui.setIcon` | `enest.ui.setIcon(icon)`<br>别名 `enest.setIcon` | 修改 Tab 图标 | 低 |
| `ui.setBadge` | `enest.ui.setBadge(badge)`<br>别名 `enest.setBadge` | 修改 Tab 角标 | 低 |
| `ui.resize` | `enest.ui.resize(size)`<br>`enest.ui.setHeight(height)`<br>别名 `enest.resize` | 建议内容尺寸 / Quick 高度上报 | 低 |
| `ui.toast` | `enest.ui.toast({ message, type? })` | 壳子应用内 Toast | 低 |
| `settings.register` | `enest.settings.register(section)` | 向壳子设置页注入插件设置分组 | 中 |
| `settings.page` | （预留） | 自定义设置页嵌入（当前版本暂未启用；设置 item `type: "page"` 需此项） | 中 |
| `hotkey` | `enest.hotkey.register(acc, opts?)`<br>`enest.hotkey.unregister(acc)` | 注册/注销全局快捷键（每插件上限 4 个；与 Quick 当前生效热键、其它插件启动热键、其它插件运行时热键及系统/其它应用占用互斥；启动键保存前经 `shell:probe-launch-hotkey` 归属探测） | 高 |
| `contribute` | `enest.contribute.registerQuickProvider(meta)`<br>`enest.contribute.unregisterQuickProvider(id)`<br>`enest.contribute.respondQuickQuery(reqId, items)` | 贡献点（Quick 搜索 provider 注册与查询回传）；`onQuickQuery` 纯订阅不校验；声明式 `contributes` 段无需此权限 | 中 |
| `theme` | `enest.theme.register(pack)` | 注册主题包到壳子主题下拉（每插件上限 8 包、同 id 只能覆盖自己的、token 值白名单过滤）；manifest `contributes.themePacks` 声明式路径等价，无需声明此权限 | 中 |
| `vault.write` | `enest.vault.set(key, secret)`<br>`enest.vault.has(keyOrRef)`<br>`enest.vault.remove(keyOrRef)` | 插件密钥保险库写入/存在/删除；`set` 返回 `secretRef`，无明文 get | 高 |
| `ssh.session` | `enest.ssh.connect(input)`<br>`enest.ssh.write/resize/disconnect`<br>`enest.ssh.listSessions()` | SSH 终端会话生命周期 | 高 |
| `ssh.exec` | `enest.ssh.exec(input)`<br>`enest.ssh.metrics.start/stop/latest`<br>`enest.ssh.completion.suggest(input)` | 远程命令执行 / 性能采样 / 命令补全 | 高 |
| `ssh.sftp` | `enest.ssh.sftp.list/download/upload/mkdir/rename/delete/chmod`<br>`enest.ssh.pickLocalFile(opts?)` | SFTP 文件列表、传输与目录/权限操作、本地文件选择 | 高 |
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
| `enest.i18n.getLocale()` / `onLocaleChange(cb)` | 语言感知是基础能力 |
| `enest.settings.get(key)` / `set(key, value)` | 读写本插件自己的设置，由 Bridge / SettingsStore 按 pluginId 隔离（仅限注册过的 key） |
| `enest.on / off` | 事件总线 |
| `enest.onEnter / onOut / onBeforeClose / onDestroy` | 生命周期 |
| `enest.contribute.onQuickQuery(cb)` | 纯订阅；门禁在 `registerQuickProvider` |
| `enest.getPluginId() / getEnterCode()` | 同步身份工具 |


---

## method → 权限映射（与主进程一致）

壳子内置的方法到权限映射：

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
| `shell.saveTextFile` | `shell.openExternal` |
| `shell.openExternal` | `shell.openExternal` |
| `notify` | `notify` |
| `theme.register` | `theme` |
| `theme.getTokens` | — （无需） |
| `ui.setHeight` | `ui.resize`（复用，无需单独声明） |
| `hotkey.register` | `hotkey` |
| `hotkey.unregister` | `hotkey` |
| `i18n.getLocale` | — （无需） |
| `contribute.registerQuickProvider` | `contribute` |
| `contribute.unregisterQuickProvider` | `contribute` |
| `contribute.respondQuickQuery` | `contribute` |
| `contribute.onQuickQuery` | — （纯订阅，无需） |
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
| `ssh.sftp.mkdir` | `ssh.sftp` |
| `ssh.sftp.rename` | `ssh.sftp` |
| `ssh.sftp.delete` | `ssh.sftp` |
| `ssh.sftp.chmod` | `ssh.sftp` |
| `ssh.pickLocalFile` | `ssh.sftp` |
| `db.test` | `db.connect` |
| `db.open` | `db.connect` |
| `db.close` | `db.connect` |
| `db.listSessions` | `db.connect` |
| `db.pickSqliteFile` | `db.connect` |
| `db.pickImportFile` | `db.connect` |
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
    "settings.register",
    "theme"
  ]
}
```

---

## OS 层权限（系统门禁叠加）

壳子权限只是第一道门；部分能力还要过操作系统自身的授权。**即使插件已被用户 `allow`，OS 层被拒时调用依然失败**。

| 能力 | macOS | Windows | Linux |
|------|-------|---------|-------|
| `screen.*`（截屏 / 录屏 / 区域选择） | **TCC 门**：系统「屏幕录制」授权（`getMediaAccessStatus('screen')`）。首次调用弹系统授权框；被拒后需到 系统设置 → 隐私与安全性 → 屏幕录制 开启并 **重启 eNest**；denied 时调用直接报 `os permission denied: screen` | 无额外系统门 | X11 直取；**Wayland 走系统 portal**（壳子已启用 WebRTCPipeWireCapturer，首次经 portal 框选授权） |
| `notify`（系统通知） | 无额外门（通知中心自管） | 需 AppUserModelID 注册（**壳子已处理**，插件无感） | 桌面通知服务（dbus）自管 |
| `hotkey`（全局快捷键，常规键） | 无 OS 门 | 无 OS 门 | 无 OS 门；**Wayland 下注册可能受限，部分场景走 portal** |
| `hotkey`（**媒体键**，macOS） | 需「辅助功能」授权（系统设置 → 隐私与安全性 → 辅助功能） | — | — |
| `clipboard.*` | 无 OS 门 | 无 OS 门 | 无 OS 门 |
| `shell.openExternal` / 插件页外链 | 无 OS 门（scheme 限 http/https/mailto/tel） | 无 OS 门 | 无 OS 门 |

?> 排查顺序：先看错误串——`permission denied: <perm>` 是壳子层（声明 / 三态授权问题）；`os permission denied: screen` 是 macOS 系统层（去系统设置开启并重启 eNest）。

---

## 处理权限错误

```js
const api = window.enest // zapi 为 @deprecated 历史别名，计划 v2 移除

try {
  await api.clipboard.writeText('x')
} catch (e) {
  if (String(e.message).startsWith('permission denied:')) {
    // 两种可能：
    // 1) manifest 未声明该权限 → 补 plugin.json 的 permissions
    // 2) 已声明但运行时授权被拒（deny / 弹窗拒绝）→ 引导用户到 插件设置 → 权限管理 改回
    console.warn('权限被拒', e.message)
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

// 探测通常会留下副作用（且可能触发授权弹窗），更稳妥的做法是按 manifest 自己开关 UI
```

!> **生产插件请勿申请与功能无关的敏感权限。** 授权发生在运行时弹窗，过度申请意味着更频繁的弹窗打扰，用户更容易直接拒绝。

---

## 隔离模型（与权限互补）

权限管 **能力门禁**；下面的机制管 **数据与进程隔离**：

| 机制 | 说明 |
|------|------|
| 独立 partition | `persist:plugin-{id}`，cookie / localStorage / IndexedDB 互不可见 |
| 自定义协议 | `enest://plugin/{id}/...` 仅映射该插件根目录，拒绝路径穿越 |
| 统一 preload | 插件无 Node；一切走 `plugin:call` + 权限校验 |
| 身份校验 | sender 必须属于 PluginHost；伪造 pluginId 被拒 |
| 关闭策略 | 日常关 Tab **不清** partition 数据；**卸载**时清理 partition + storage（enest.db `plugin_storage` 行） |

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
