# MCP 工具贡献

eNest 作为本机 MCP 服务，聚合已安装、已启用的插件工具。插件负责业务处理，壳负责协议传输、鉴权、参数校验、实例生命周期和权限边界；插件不需要自行监听端口或持有 MCP 令牌。

> 服务默认关闭。宿主实现包含主进程服务、专用管理 IPC 与设置页「开发者 → MCP 服务」管理区（启用、端口、运行状态、复制连接配置、重置令牌与已注册工具目录）；插件不能自行启用服务，也不能让用户通过普通主题或插件设置绕过该入口。本文说明现有协议与限制，不代表所有 MCP 客户端、系统密钥库或退出重启场景已经完成目标平台验收。

## 1. 声明工具

在现有 `plugin.json` 的 `contributes` 中添加 `mcpTools`。其它必需字段遵循 [manifest 标准](manifest.md)。

```json
{
  "contributes": {
    "mcpTools": [
      {
        "id": "add",
        "title": "Add two numbers",
        "description": "Add two finite numbers without changing any stored data.",
        "inputSchema": {
          "type": "object",
          "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
          "required": ["a", "b"],
          "additionalProperties": false
        },
        "outputSchema": {
          "type": "object",
          "properties": { "sum": { "type": "number" } },
          "required": ["sum"],
          "additionalProperties": false
        },
        "annotations": { "readOnlyHint": true, "idempotentHint": true }
      }
    ]
  }
}
```

- 每个插件最多 128 个工具；ID 在插件内唯一，1–64 个字符，首位为字母或数字，其余可用字母、数字、`.`、`_`、`-`。
- `description` 必填，最多 4096 字符；`title` 可选，最多 128 字符。
- `inputSchema` 必须是 `type: "object"` 的 JSON Schema 2020-12；`outputSchema` 可选。引用只能使用本地 `#` 片段，不支持外部 `$ref`、`$id`、`$async`。
- 每份 schema 最多 64 KiB、20 层深度、10000 个节点，正则最长 256 字符。宿主在受限 Worker 中编译和校验，超时拒绝，不在 Electron 主线程执行不可信正则。
- `annotations` 仅是语义提示，不授予权限。支持 `title`、`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。
- 开发态/HMR 插件不进入 MCP 目录。先按普通插件流程构建、安装、启用，再检查目录；枚举工具本身不会启动或安装插件。

## 2. 注册处理器

在普通插件主页面完成业务初始化后调用一次 `enest.mcp.registerHandlers()`，键集合必须与 manifest 声明完全一致。不要等到 `onEnter` 或用户打开页面时才注册：MCP 冷启动页面是隐藏的，不发送前台进入事件。

```js
await enest.mcp.registerHandlers({
  add({ a, b }) {
    const sum = a + b
    if (!Number.isFinite(sum)) {
      return { isError: true, content: [{ type: 'text', text: 'The sum is not finite.' }] }
    }
    return {
      content: [{ type: 'text', text: String(sum) }],
      structuredContent: { sum }
    }
  }
})
```

注册是页面/运行代次绑定的握手，不是切换主题、安装工具或获取权限。页面重新加载后需要重新注册；同一页面重复注册会拒绝。后台桥 `enestBackground`、主题桥和辅助页不提供此 API。可复用普通插件已授权的 `backend.call`，但 MCP 不会自动授予 `backend.node`。

处理器签名为 `(argumentsValue, context) => McpToolResult | Promise<McpToolResult>`。`context` 包含 `requestId`、Unix 毫秒时间 `deadlineAt` 和 `onCancel(callback)`。取消监听返回取消订阅函数；若请求已取消，回调立即调用。长任务应把取消传播给自己的网络请求/Worker/后端，并在实际停止后结束 Promise。

结果必须包含 `content` 数组，可使用 `text`、`image`、`audio`、`resource`、`resource_link`。图片/音频使用 base64 `data` 与 `mimeType`，不是磁盘路径；资源返回引用不代表获得了文件读取权限。`structuredContent` 必须可 JSON 序列化，`false`、`0`、`null` 是有意义的值；为兼容不同客户端，优先返回对象并同时提供文本摘要。若声明 `outputSchema`，成功结果必须包含符合该 schema 的 `structuredContent`。业务失败返回 `isError: true`；失败时不校验成功输出 schema。

## 3. 外部客户端调用模型

当前适配器使用有会话的 Streamable HTTP，地址为 `http://127.0.0.1:<port>/mcp`，默认端口 `43921`。客户端先执行 `initialize`，之后携带服务返回的 `Mcp-Session-Id`；不是 stdio，也不承诺仅支持无初始化 discovery 的客户端可直接连接。

协议层只公开两个通用工具，插件的工具不是扁平地混入 `tools/list`：

| 工具 | 参数 | 结果 |
|---|---|---|
| `enest_list_tools` | 可选 `pluginId`、`query`、`cursor`、`limit` | `tools` 中包含插件归属、声明和 schema；有下一页时带 `nextCursor` |
| `enest_call_tool` | 必填 `pluginId`、`toolId`、`arguments` 对象 | 插件 `McpToolResult` 或宿主标准错误 |

`limit` 默认 20，范围 1–100。目录改变后旧 cursor 会失效，需重新从第一页枚举。调用前宿主重新检查安装、启用、构建版本、禁用/卸载屏障和处理器身份；未知插件或工具不会被自动安装。

请求与结果上限为 1 MiB（协议封装预留空间，插件应保持明显低于此限制）。最多 8 个 HTTP 会话、4 个同时执行的插件任务，每个插件只允许 1 个；插件运行/注册准备阶段限时 15 秒，处理器执行阶段限时 60 秒。闲置且没有打开响应的会话在 15 分钟后清理。

取消或超时只表示调用方不再等待，**不代表副作用已撤销**。宿主不会自动重试；处理器/宿主 RPC 未实际结束前，不释放该插件的执行槽和非交互保护。超过宽限期仍未停止时，当前实例会被标记为不可再执行，避免重复写入。

## 4. 安全与权限

- 只监听 IPv4 loopback；严格检查 Host、请求路径和 Origin，拒绝非本机来源。每个 HTTP 请求都需 `Authorization: Bearer <token>`，会话 ID 不能代替鉴权。
- 令牌用系统密钥库异步加密保存，不进入 `settings.general`、插件私有设置、主题描述符或 `getMcpStatus()`。密钥库不可用、密文无法解密或安全检查失败时拒绝启动，保留已有凭据，不降级成明文或简单混淆。
- 原生配置的 `{ enabled, port }` 保存在默认宿主数据根下的私有 `host-mcp/configuration.json`，凭据位于同一宿主管理目录；它们不随用户配置的插件数据根切换。`setSettings` 不能写入 `mcp`/`mcpToken`。导出连接配置通过可信原生动作直接写系统剪贴板，不把令牌返回 renderer。
- 不新增 `mcp` 权限。MCP 执行期间沿用插件已获得的敏感权限，`ask` 返回 `needs-consent`，`deny` 返回 `permission-denied`；禁止自动显示权限框、文件选择器、录屏选择器或其它需要交互的表面。
- 执行时复用现有实例或静默冷启动，不把窗口拉到前台。禁用、卸载、升级、崩溃、导航、休眠会使对应运行身份失效；旧页面的迟到结果不能结束新实例的请求。
- 关闭服务、成功轮换令牌与退出应用都会取消现有调用并退休会话。端口占用时保持错误状态，不偷偷换端口。

启用服务意味着持有令牌的本机客户端可以调用所有合格插件的声明工具。当前没有逐客户端或逐工具 ACL；只应向可信客户端分享连接配置。不要将令牌粘贴进日志、文档、工单或插件设置。

### 凭据兼容与轮换

旧版本由同步 `safeStorage` API 生成的安全密文可直接由当前异步实现读取；升级本身不会更换 Bearer 令牌。系统提示密钥轮换时，宿主重新加密原令牌并原子替换密文；这与用户明确重置为一个新的随机令牌不同。解密、重新加密或保存失败不会自动覆盖旧文件，需由用户解锁系统密钥库，或通过可信宿主管理动作明确重置。

重置令牌先保存新密文，成功后才退休旧会话并按当前配置重新启动服务；若加密或保存失败，当前可用的令牌和会话保留。重置成功后应重新导出连接配置给可信客户端。关闭服务或退出应用不会删除已保存的令牌。

Linux 沿用[密钥保险库的安全策略](permissions.md#旧数据与系统密钥库)：拒绝 `basic_text` / 未知后端，也拒绝异步加密器实际返回的 Linux 固定密钥 `v10` fallback。只有 Secret Portal、但传统后端未被识别的环境当前仍保守拒绝；不承诺所有 Flatpak / Portal 环境可用。该 Linux 限制不影响 macOS 正常旧密文的兼容读取。

**内部实现边界**：宿主使用 Electron 的 `isAsyncEncryptionAvailable()`、`encryptStringAsync()`、`decryptStringAsync()`，并处理 `shouldReEncrypt`；这些方法、密文格式及文件位置都不是插件 API。每次异步凭据操作在保存或采用结果前复核服务状态、凭据代次和目标位置。服务停止或应用退出后，迟到结果不能重新启用旧令牌或复活服务。插件工具的执行归属则绑定当前插件运行代次；二者不是同一个身份，插件不能通过工具参数指定宿主凭据或修改其代次。

## 5. 标准错误

宿主失败结果含 `isError: true`、文本错误码和 `structuredContent.errorCode`。插件业务错误可以返回自己的有界内容；不要把原始堆栈或密钥放进错误内容。

| 错误码 | 含义与处理 |
|---|---|
| `busy` | 已有本机交互、并发槽已满或插件正在处理请求；不要盲目重放有副作用的调用 |
| `needs-consent` | 需要用户先在可信原生界面授权 |
| `permission-denied` | 权限被拒绝或身份不合法 |
| `interaction-required` | 此操作需要新的真实用户交互，MCP 不可代办 |
| `not-found` | 当前目录没有该插件/工具 |
| `invalid-arguments` | 参数或分页 cursor 无效 |
| `timeout` / `cancelled` | 等待超时或已取消；业务结果可能未知，不自动重试 |
| `unavailable` | 服务退出、实例退役、版本变化或隔离中的旧任务 |
| `internal-error` | 处理器/结果不合法或内部故障，错误细节不对外透传 |
| `result-too-large` | 请求或响应超过资源边界 |
| `not-ready` | 契约保留错误码；当前注册等待超时返回 `timeout` |

## 6. 可信宿主管理边界

以下是可信壳的管理接口，**不属于 `window.enest` 插件 API**：`getMcpStatus()`、`configureMcp({ enabled, port })`、`copyMcpConnectionConfig()`、`resetMcpToken()`、`listMcpTools(query)`。它们只接受已登记的原生 shell 主 frame；Quick、Workspace、第三方主题设置、面板和普通插件均无权调用。

服务管理的串行队列最多接受 **8 个普通任务**，包含正在执行与等待的初始化、配置、复制连接配置和重置令牌操作；内部凭据读写队列也最多接受 8 个待完成任务。队列满时管理 Promise 拒绝，界面应避免重复点击，待当前操作完成或系统密钥库解锁后再重试。退出和内部停止清理保留独立准入，不因普通任务队列已满而被拒绝；这不表示操作系统的密钥库请求可以立即被取消。

上述 8 个管理任务不是 HTTP 会话数或插件工具并发数，`getMcpStatus()` 等只读查询也不占该管理队列。外部 MCP 客户端不能直接调用这些管理接口；管理接口的“繁忙”拒绝不等同于第 5 节工具结果中的 `busy` 错误码。工具调用仍遵循第 3 节的会话与执行预算。

启动时读取独立配置，退出时关闭 HTTP/Worker；安装、启停、更新与卸载影响工具目录及运行资格。管理入口在宿主设置页「开发者 → MCP 服务」（启用/端口、状态与会话计数、复制连接配置、重置令牌、工具目录分页与最近调用），由可信壳视图直接调用上述管理接口；第三方主题快照不发布可用的 MCP 原生分组，不能靠拼接 section ID 进入。字段细节以自动生成的 [TypeScript 类型](api-types.md) 中 `McpToolDeclaration`、`McpToolResult`、`McpHandlerContext` 为准；宿主扩展管理入口还须遵守[宿主开发标准](host-development.md)的来源、生命周期和原生确认规则。

## 7. 图像返回实践

需要把画布、预览或任何位图回传给 AI 客户端时，用 `image` 内容块：`{ type: 'image', data: <base64，不含 data URL 前缀>, mimeType: 'image/png' }`，同时附一条 `text` 摘要（尺寸、来源草稿等），让不支持图像的客户端也能理解结果。整条结果受 1 MiB 上限约束（含 JSON 封装），生成端应主动控制体积：

- 按内容包围盒而非固定大画幅合成；提供 `format`（JPEG 远小于 PNG）与最大边长参数，超限时自动降采样重试。
- base64 前先在离屏 canvas 合成（如 `canvas.toDataURL` 去前缀），不读磁盘路径，也不依赖窗口可见——MCP 冷启动页面是隐藏的，`screen.capture` 一类依赖可见性的能力不可用。
- 超限不是可重试错误：返回业务失败并说明缩小范围（更少元素、更小尺寸、JPEG）的方法。

官方画板插件 `com.github.eNest.drawboard` 的 `capture` 工具是按上述约束实现的可参考样例：隐藏页离屏合成、按包围盒导出、png/jpeg 与最大边长降采样、超限给出可操作提示。

协议参考：[MCP TypeScript SDK 工具](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md)、[HTTP 会话管理](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md)。
