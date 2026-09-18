# 错误码

壳子错误经两条路径回到你面前：

1. **API Promise reject** — `Error.message` 为下表字符串
2. **壳子事件** — `shell:event` 的 `plugin-error` 推送到开发者页 / Toast

字符串前缀可匹配。

---

## 运行时 API 错误（plugin:call）

以下错误来自 `pluginPreload`（`call()`）与主进程 `pluginHandlers` / `PluginPermissions`。

| 消息 | 触发 | 处理 |
|------|------|------|
| `permission denied: <perm>` | 未在 `plugin.json` → `permissions` 声明该能力 | 增加对应权限键；`<perm>` 取值见 [权限说明](permissions.md) |
| `unknown method: <method>` | 调用了不存在的 method，或主进程映射表未收录 | 核对 [API 参考](api.md) 方法名；升级壳子 |
| `unauthorized sender` | 发起调用的 WebContents 不属于 PluginHost | 正常插件不会出现；检查是否在非插件环境误用 API |
| `plugin id mismatch` | `request.pluginId` 与发送者实际插件 id 不一致 | 不要手动构造 IPC；使用 `window.enest`（`zapi` 为 deprecated 别名） |
| `manifest not found` | 发送者在 Host 中无对应 manifest | 重新打开插件；开发者控制台重新加载 |
| `toast message required` | `ui.toast({ message: '' })` 或缺 message | 传入非空 `message` |
| `invalid settings section` | `settings.register` 缺 `id` 或 `title` | 补齐 section 字段 |
| `only http(s) urls allowed` | `shell.openExternal` 传入非 http(s) URL | 只允许 `http://` / `https://`；`file://` 等会被拒 |
| `plugin call failed` | preload 侧兜底：IPC 返回 `{ ok: false }` 但无 error 字符串 | 查看 DevTools 与主进程日志 |

### 权限错误示例

```js
try {
  await enest.clipboard.writeText('x')
} catch (e) {
  console.error(e.message) // permission denied: clipboard.write
}
```

### 协议限制示例

```js
try {
  await enest.shell.openExternal('file:///etc/passwd')
} catch (e) {
  console.error(e.message) // only http(s) urls allowed
}
```

---

## 安装 / 清单错误

来自 `PluginInstaller` / `PluginRegistry` / `PluginHost`。

| 消息 | 触发 | 处理 |
|------|------|------|
| `plugin.json not found in <dir>` | 选中的目录内没有清单 | 确认是插件根目录 |
| `invalid plugin.json: not valid JSON` | JSON 语法错误 | 检查逗号、引号、尾逗号 |
| `invalid plugin.json: missing required fields (id, name, version, main)` | 缺必填字段 | 补齐 `id` / `name` / `version` / `main` |
| `plugin not installed: <id>` | 打开未安装插件 | 先安装，或开发者控制台加载本地目录 |
| `sample not found: <src>` | 示例包路径无效 | 检查仓库 `plugins-samples/` 是否完整 |
| `路径不存在: <path>` | 安装源路径为空或不存在 | 核对拖入的文件 / 文件夹 |
| `不支持的安装包类型: <name>（需要文件夹或 .enestplugin/.zip）` | 扩展名不匹配 | 打成 `.enestplugin` / `.zip`，或直接拖文件夹 |
| `无法读取安装包: <detail>` | zip 解压 / 读取失败 | 包是否损坏；权限是否足够 |
| `安装包为空或无法读取` | 解压后无有效内容 | 重新打包 |
| `安装包中未找到 plugin.json（需位于根目录或一级子目录）` | 包结构不合规范 | `plugin.json` 必须在 zip 根目录，或 **唯一一层** 子目录内 |

---

## 协议 / 资源

| 现象 | 触发 | 处理 |
|------|------|------|
| 静态资源 404 / 拒绝 | 路径穿越（`..`）或超出插件根目录 | 使用相对路径，不要跳出插件目录 |
| 白屏 + Console CSP | 生产 CSP 限制 | 避免内联脚本 / 外链，资源放插件目录内 |
| 主题 CSS 404 | `enest://plugin/<id>/__enest_theme.css` 的 id 写错 | 使用 `enest.getPluginId()` 对齐 |

---

## 生命周期事件（plugin-error）

主进程在加载失败等场景向壳子发送：

```ts
// 概念结构，具体字段以 @shared/types/ipc 为准
{
  type: 'plugin-error',
  pluginId: string,
  message: string
}
```

可在开发者页日志区查看；插件自身异常请用 DevTools Console。

---

## 建议排查顺序

1. **DevTools Console** 是否有 JS 异常（右键 → 检查 / 开发者控制台打开）
2. `plugin.json` 是否合法、`main` 是否可访问
3. `permissions` 是否覆盖当前调用的 API
4. 开发态端口 / `development.main` 是否正确
5. 是否在 `background: transparent` 时忘了把 `body` 设为透明（视觉问题）
6. 仍失败：**关 Tab 重开**，或卸载后重新加载本地目录
7. 修改过 `plugin.json` 权限后，必须 **关 Tab 重开**（reload 不会重读权限）

---

## 调试技巧

```js
// 1. 确认 API 是否注入
console.log('enest?', !!window.enest, 'zapi?', !!window.zapi)

// 2. 确认插件身份
console.log(window.enest?.getPluginId())

// 3. 全局捕获 API 错误
window.addEventListener('unhandledrejection', (e) => {
  console.error('API 失败:', e.reason?.message || e.reason)
})

// 4. 主题 Token 是否到位
window.enest?.theme.getTokens().then(console.log)
```

---

## 相关文档

- [调试与热更新](debug.md)
- [权限说明](permissions.md)
- [enest API](api.md)
- [FAQ](faq.md)
