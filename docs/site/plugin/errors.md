# 错误码

常见宿主错误通过以下路径呈现；本页不是全部内部错误字符串的穷举，也不是插件可以订阅任意壳 IPC 的授权：

1. **API Promise reject** — `Error.message` 为下表字符串
2. **壳子事件** — `shell:event` 的 `plugin-error` 推送到开发者页 / Toast

字符串前缀可匹配。

---

## 运行时 API 错误（plugin:call）

以下错误来自插件 API 调用链（插件页 → 主进程权限断言）。

| 消息 | 触发 | 处理 |
|------|------|------|
| `permission denied: <perm>` | 未在 `plugin.json` → `permissions` 声明该敏感能力，或运行时授权为 `deny` / 弹窗被拒 | 未声明→增加对应权限键（`<perm>` 取值见 [权限说明](permissions.md)）；已声明→引导用户到 插件设置 → 权限管理 改回 |
| `os permission denied: screen` | macOS 系统层屏幕录制（TCC）被拒 | 到 系统设置 → 隐私与安全性 → 屏幕录制 开启 eNest 并 **重启 eNest** |
| `unknown method: <method>` | 调用了不存在的 method，或主进程映射表未收录 | 核对 [API 参考](api.md) 方法名；升级壳子 |
| `unauthorized sender` | 发起调用的页面不属于壳子管理的插件 | 正常插件不会出现；检查是否在非插件环境误用 API |
| `plugin id mismatch` | `request.pluginId` 与发送者实际插件 id 不一致 | 不要手动构造 IPC；使用 `window.enest`（`zapi` 为 deprecated 别名） |
| `manifest not found` | 发送者在 Host 中无对应 manifest | 重新打开插件；开发者控制台重新加载 |
| `notification rate limit: 10 per 10 seconds` | 短时间内提交过多壳通知 | 合并提示，避免轮询或批处理逐项发 toast |
| `invalid settings section` | `settings.register` 缺 `id` 或 `title` | 补齐 section 字段 |
| `unsupported settings schema version` | 注册版本既非省略，也非字符串 `'1'` | 不要传数字 `1` 或猜测新版本 |
| `unknown settings key: <key>` | `settings.set` 写入未注册或 `page` 项 | 写入键须来自当前插件可写声明；`get` 对未保存且无默认值的合法键返回 `undefined` |
| `storage quota exceeded` | 每插件超过 1000 键，或单值超过 512KB | 拆分存储 / 精简数据；超大二进制不要放 storage |
| `only http(s)/mailto/tel urls allowed` | `shell.openExternal` 传入非 http(s)/mailto/tel URL | 只允许 `http://` / `https://` / `mailto:` / `tel:`；`file://` 等会被拒 |
| `net.fetch timeout` | `net.fetch` 超时（默认 15s，上限 120s），或在途请求被终止 | 核对生命周期及目标可达性，不盲目重放有副作用的请求 |
| `plugin call failed` | preload 侧兜底：IPC 返回 `{ ok: false }` 但无 error 字符串 | 查看 DevTools 与主进程日志 |

### net.fetch 系列约束

| 消息 | 触发 |
|------|------|
| `only https urls allowed` / `only http(s) urls allowed` | URL 或重定向不符合当前 manifest 的协议限制；明文 HTTP 需声明 `net.allowInsecure` |
| `only GET/POST/PUT/PATCH/DELETE/HEAD allowed` | 使用了不支持的请求方法 |
| `response body too large` | 非流式响应超 2 MiB，或流式响应的声明大小超 32 MiB；实际流式失败也可能通过 `net.chunk` 终态 error 交付 |
| `net.fetch timeout` | 默认 15s，`timeoutMs` 范围 1s–120s；已有流式响应后的失败观察 chunk 终态 |
| `redirect without location` | 重定向响应（3xx）缺少 `Location` 头，无法继续跟随 |
| `net.fetch failed` | 请求无响应 / 网络层失败的兜底错误 |

### theme.register 系列

| 消息 | 触发 |
|------|------|
| `invalid theme pack: require id and name` | pack 缺 `id` 或 `name` |
| `invalid theme pack: tokens must be an object` | `tokens` 不是对象 |
| `theme pack id already registered by <src>` | 同 id 已被其它来源（插件 / 内置）注册，只允许覆盖自己的 |
| `theme pack limit reached for <src> (max 8)` | 本插件已注册 8 个主题包 |

### 私有设置与密钥库

- `reserved plugin settings key`：使用了 `permissionGrants`、`__proto__`、`prototype` 或 `constructor` 等宿主保留键，改用业务设置名。
- `secure credential storage unavailable`：系统密钥库不可用，解锁或配置系统密钥库后重试；不会静默存明文或混淆数据。
- `legacy insecure vault secret requires re-entry`：旧 XOR 凭据需要重新输入，原文件保留。
- vault 大小或数量超限：缩减或删除本插件旧凭据后重试，拒绝的写入不会覆盖已有凭据。

### 存储与关闭期间的失败

`storage.set/remove` 成功只确认入队，需要提交回执时使用 `flush/commit`。图片指针替换、完成文件发布或原生导出替换后，目录同步失败、实例退役或通信中断可能导致“已提交但回执/持久性未确认”；不能把所有 reject 都解释为磁盘未改变。按稳定 ID 或业务记录核对，再幂等重试；不要删除仍可能是唯一副本的数据。完整预算、旧数据与结果不确定语义见[存储标准](storage.md)。

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
  console.error(e.message) // only http(s)/mailto/tel urls allowed
}
```

---

## 安装 / 清单错误

来自安装与运行流程。manifest 校验错误会 **全部收集后一次抛出**，形如：

```text
invalid plugin.json:
  - com.example.todo: 字段 version "1.0" 不是 semver（x.y.z）
  - com.example.todo: 字段 permissions 含未知权限 "foo.bar"（白名单见 PLUGIN_PERMISSIONS / plugin-manifest.schema.json）
```

逐字段错误串（前缀为插件 id 或 `(unknown id)`）：

| 消息（中文逐字段） | 触发 | 处理 |
|------|------|------|
| `plugin.json 根节点必须是对象` | 清单 JSON 不是对象 | 检查最外层结构 |
| `字段 id 缺失或不是字符串（必填，反向域名）` | 缺 `id` 或非字符串 | 补齐反向域名 id |
| `字段 id "<id>" 不是合法反向域名（形如 com.example.plugin）` | id 不符合当前 manifest schema | 按 schema 使用反向域名；保留 `com.github.eNest` 的大小写，不自行归一化来源 |
| `字段 name 缺失或为空（必填）` | 缺 `name` 或空白 | 补齐显示名 |
| `字段 version "<v>" 不是 semver（x.y.z）` | 版本号不合 semver（允许 `-beta.1` / `+build` 后缀） | 改为 `x.y.z` |
| `字段 main 缺失或不是字符串（必填，HTML 入口相对路径）` | 缺 `main` | 补 HTML 入口 |
| `字段 description 若存在必须是字符串` | `description` 类型错误 | 改为字符串（建议但不强制填写） |
| `字段 permissions 若存在必须是字符串数组` | `permissions` 非数组 | 改为数组 |
| `字段 permissions 含未知权限 "<p>"（白名单见 PLUGIN_PERMISSIONS / plugin-manifest.schema.json）` | 能力键不在 schema 定义范围内 | 核对 [权限说明](permissions.md) 的权限键拼写 |
| `字段 engines.enest "<r>" 不支持（仅允许 * / ^x.y.z / >=x.y.z / 精确 x.y.z）` | 版本范围语法不支持 | 简化为四种支持写法之一 |
| `字段 engines.enest "<r>" 不满足当前壳子版本 <v>` | 壳子版本不在声明范围内 | 升级壳子或放宽范围 |
| `入口文件 <main> 不存在于插件根目录 <dir>` | `main` 指向的文件缺失 | 检查打包是否漏文件、路径大小写 |

包装与流程错误：

| 消息 | 触发 | 处理 |
|------|------|------|
| `plugin.json not found in <dir>` | 选中的目录内没有清单 | 确认是插件根目录 |
| `invalid plugin.json: not valid JSON` | JSON 语法错误 | 检查逗号、引号、尾逗号 |
| `invalid plugin.json:` + 上述逐字段列表 | manifest 校验失败（一次收集全部） | 按列表逐条修复 |
| `plugin not installed: <id>` | 打开未安装插件 | 先安装，或开发者控制台加载本地目录 |
| `plugin not installable: <id>（远程市场无可用资产…）` | 市场条目没有可下载的发行资产 | 插件仓库发布对应 `.enestplugin` Release 资产；本地源码调试走开发者控制台加载，不从市场安装 |
| `路径不存在: <path>` | 安装源路径为空或不存在 | 核对拖入的文件 / 文件夹 |
| `不支持的安装包类型: <name>（需要文件夹或 .enestplugin/.zip）` | 扩展名不匹配 | 打成 `.enestplugin` / `.zip`，或直接拖文件夹 |
| `无法读取安装包: <detail>` | zip 解压 / 读取失败 | 包是否损坏；权限是否足够 |
| `安装包为空或无法读取` | 解压后无有效内容 | 重新打包 |
| `安装包根目录必须包含 plugin.json，不支持外层目录` | 包内多包了一层文件夹，或缺少根清单 | ZIP 根直接包含 `plugin.json`、`index.html` 与发行资源，不含 `dist/` 或插件目录外壳 |

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
3. `permissions` 是否覆盖当前调用的敏感 API（基础能力无需声明）
4. 开发态端口 / `development.main`（或 `enest.dev.url`）是否正确，启动命令能否在插件目录手动跑通
5. 是否在 `background: transparent` 时忘了把 `body` 设为透明（视觉问题）
6. 仍失败：先关闭重开实例并查看指定插件日志；不要把会清理私有数据的卸载当作默认排查步骤
7. 修改过 `plugin.json` 后刷新开发注册，或构建并安装新包；普通 HMR 不等于已更新清单和授权

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

// 4. 主题变量 是否到位
window.enest?.theme.getTokens().then(console.log)
```

---

## 相关文档

- [调试与热更新](debug.md)
- [权限说明](permissions.md)
- [enest API](api.md)
- [FAQ](faq.md)
