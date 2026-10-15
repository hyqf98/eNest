# 插件本机后端

从 eNest **0.2.0** 起，插件可以在自己的发布包中携带 Node.js 后端。前端继续运行于受隔离的 `WebContentsView`；协议驱动、数据库客户端、计算任务等代码放在插件 `backend/` 中，由宿主按当前插件实例启动 Electron `utilityProcess`。

纯浏览器插件无需后端。需要后端的插件必须声明并取得 **`backend.node`** 授权。此权限表示信任插件执行完整 Node.js 代码：后端具有当前用户可用的本机文件、网络和进程能力。utility process 用于隔离生命周期和故障，**不是操作系统沙箱**；Chromium 页面沙箱及细分的前端 API 权限不能限制已授权后端的直接 Node 调用。

## 清单与产物

在 `plugin.json` 中增加：

```json
{
  "engines": { "enest": ">=0.2.0" },
  "permissions": ["backend.node"],
  "backend": { "entry": "backend/index.cjs" }
}
```

以上是需要合并到完整 manifest 的字段。`main` 仍为 `index.html`。后端入口必须是插件包内 `backend/` 下的真实 `.cjs`、`.mjs` 或 `.js` 文件；宿主拒绝符号链接、越界路径和不存在的入口。仓库构建工具统一输出 `backend/index.cjs`。`backend/` 只供进程启动器读取，不能通过 `enest://` 页面资源协议访问。

```text
plugins/com.example.worker/
├── plugin.json
├── package.json
├── index.html
├── src/
├── backend/index.ts               # 插件后端源码
├── public/assets/
└── dist/
    ├── plugin.json
    ├── index.html
    ├── assets/
    └── backend/
        ├── index.cjs              # 编译后的入口
        ├── node_modules/          # 锁定的生产依赖及所需原生变体
        └── dependency-inventory.json
```

## 前端调用与事件

```js
const onBackendEvent = ({ event, data }) => {
  if (event === 'job.progress') console.log(data)
}
enest.on('backend.event', onBackendEvent)

try {
  const result = await enest.backend.call('text.sha256', ['hello'])
  console.log(result.sha256)
} finally {
  enest.off('backend.event', onBackendEvent)
}
```

`enest.backend.call<T>(method, args?)` 返回 `Promise<T>`，`args` 默认为 `[]`。方法名由插件定义，必须以英文字母开头，后续可用字母、数字、下划线、点、连字符，总长不超过 80 个字符。该接口只调用当前插件自己的入口，不会查找另一个插件或宿主内置驱动。

后端可以主动发送命名事件。前端统一从 `backend.event` 接收 `{ event, data }`；事件名可用字母、数字、下划线、点、连字符，长度为 1–80。宿主绑定事件来源，后端不能用这条通用事件通道冒充 `ssh.data`、壳事件或其它插件。

## utility process 协议

后端使用 **`process.parentPort`**，不是 `node:worker_threads.parentPort`，也不需要导入 `electron`。`message` 监听器收到的参数是 `{ data }`，消息对象在 `data` 内。

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| 宿主 → 后端 | `{ type: 'init', pluginId, generation, wcId }` | 当前实例身份；每次新进程发送一次 |
| 宿主 → 后端 | `{ id, pluginId, method, args, proxy }` | 请求；`id` 用于匹配响应 |
| 后端 → 宿主 | `{ id, ok: true, data }` | 成功结果 |
| 后端 → 宿主 | `{ id, ok: false, error }` | 失败；`error` 为可展示的错误字符串 |
| 后端 → 宿主 | `{ event, data }` | 主动事件，无请求 `id` |

`proxy` 包含当次宿主的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 环境配置快照，未设置项可以缺省。进程继承宿主环境并启用 `NODE_USE_ENV_PROXY`；第三方客户端是否使用这些配置仍取决于该客户端，插件需为自行创建的网络连接明确配置代理，不能假定全部 Node 网络库都会自动遵从。

以下 `backend/index.ts` 可与前端示例配合使用。它只使用 Node 内置模块，因此构建配置的 `dependencies` 可为空：

```ts
import { createHash } from 'node:crypto'

type Request = {
  type?: string
  id?: number
  pluginId?: string
  generation?: number
  method?: string
  args?: unknown[]
}
interface ParentPort {
  on(event: 'message', listener: (message: { data: Request }) => void): void
  postMessage(message: unknown): void
}
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('This entry requires the eNest utility process')
let owner: string | undefined

port.on('message', ({ data: request }) => {
  if (request.type === 'init') {
    if (!owner && typeof request.pluginId === 'string') owner = request.pluginId
    return
  }
  if (!Number.isSafeInteger(request.id)) return
  void (async () => {
    if (!owner || request.pluginId !== owner) throw new Error('Invalid backend owner')
    if (request.method !== 'text.sha256') throw new Error('Unknown backend method')
    const [text] = request.args ?? []
    if (typeof text !== 'string') throw new Error('text must be a string')
    const sha256 = createHash('sha256').update(text).digest('hex')
    port.postMessage({ event: 'job.progress', data: { state: 'completed' } })
    return { sha256 }
  })().then(
    data => port.postMessage({ id: request.id, ok: true, data }),
    error => port.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  )
})
```

请求参数与返回值应保持可序列化，并在后端继续验证方法、参数和业务资源归属。不要把密钥、连接密码或完整文件内容写进错误消息及进度事件。通用协议没有内置的后端 → 宿主 API 调用接口；示例也不访问宿主模块。官方 SSH 的文件、密钥和活动桥接由其兼容门面单独实现，不能当作所有自定义后端都可调用的公共协议。

## 通用调用预算与生命周期

| 项目 | 当前限制与行为 |
| --- | --- |
| 同时等待的请求 | 每个通用后端最多 32 个；超出立即拒绝 |
| 请求大小 | `args` 的 JSON 字节预算最多 4 MiB |
| 回复或事件大小 | 整条消息的 JSON 字节预算最多 8 MiB；超限终止后端 |
| 请求超时 | 30 秒；超时终止该后端，并拒绝该进程的其它在途请求 |
| JavaScript 堆 | 进程以 `--max-old-space-size=256` 启动；不是原生内存或总 RSS 的硬上限 |
| 正在执行的请求 | 持有当前实例的活动租约；回复或进程退出后释放 |
| 关闭、重载、撤权 | 撤销当前代次、终止对应进程、拒绝在途请求；旧进程的迟到消息被丢弃 |

同一实例按需复用通用后端进程；旧代次尚未退出时不会把请求交给旧进程，也不会无限叠加替代进程。后端异常退出或超时后，前端应提示任务失败，在实例仍有效时由后续调用启动新进程。

耗时任务应先返回任务编号，在 30 秒内结束这次请求，再用事件报告状态。后台任务不会因为发事件而自动获得宿主活动租约；插件仍须保存可恢复状态并处理关闭、休眠。不要把长期任务的唯一状态留在进程内存中，也不要依赖窗口消失后仍能完成写入。

这些数值适用于 **`enest.backend.call` 通用通道**。已有数据库、中间件和 SSH 门面使用各自的请求、取消和会话生命周期约束，不套用通用通道的 30 秒超时。

## 生产依赖与原生包

插件的 `package.json` 声明自己的依赖和构建配置，例如 SSH 后端：

```json
{
  "dependencies": { "ssh2": "^1.17.0" },
  "enestBackend": {
    "entry": "backend/index.ts",
    "dependencies": ["ssh2"],
    "optionalExcluded": ["cpu-features", "nan"]
  }
}
```

`enestBackend.entry` 指向源码入口；`enestBackend.dependencies` 列出需要保留为外部模块的 npm 根依赖，并且每个根依赖必须直接声明在该插件的 `dependencies`。仓库工具将业务 TypeScript 编译到 CJS，按插件仓库 `package-lock.json` 复制生产、必要 peer 和已安装 optional 依赖，保留重复版本的实际目录布局以及运行时资源、许可证。不会把整份工作区 `node_modules` 复制进包。

`optionalExcluded` 只排除确认具有可用回退实现的可选依赖。官方 SSH 排除 `cpu-features`、`nan` 和可选 `sshcrypto` 本地编译产物，使用 Node crypto 的纯 JavaScript 路径；不能用相同方法任意删除其它驱动的 `.node` 文件。

原生依赖必须与目标 OS、CPU 架构及运行时 ABI/N-API 匹配。当前数据库插件通过 `platformPackages` 显式携带四个 DuckDB 变体：

```json
{
  "platformPackages": [
    "@duckdb/node-bindings-darwin-arm64",
    "@duckdb/node-bindings-darwin-x64",
    "@duckdb/node-bindings-win32-x64",
    "@duckdb/node-bindings-linux-x64"
  ]
}
```

该字段属于 `enestBackend`。构建工具从锁文件查找精确版本与摘要；缺少的变体从锁定的 npm 源获取并校验完整性，不运行下载包的安装脚本。发布包携带四个平台变体不代表四个平台均已完成运行验收；每个平台仍需验证驱动加载和实际功能。

后端源码可使用 Node 内置模块和插件自己的 workspace 包；`@backend` 指向当前插件的 `backend/`。构建禁止导入 `electron` 或 `@main`、`@preload`、`@renderer`、`@shared` 宿主模块。公共类型应来自 SDK 或插件自身契约，不通过复制宿主运行时来恢复旧驱动。

## 开发、发布与兼容

在插件仓库先安装锁定依赖并构建：

```sh
npm ci
node scripts/build-plugin.mjs com.enest.ssh com.enest.remote-desktop
```

连接 Vite 开发服务器时，前端可以 HMR，后端仍从源码根的 **`dist/backend/index.cjs`** 加载，因此必须先构建。后端修改后重新构建，再关闭/重载插件以创建新进程；Vite HMR 不会替换已经运行的后端。验证完整发布行为时选择“预览 dist 构建产物”。不要使用普通“静态源码”模式直接运行 TypeScript 后端。

`.enestplugin` 的根仍是 `dist` 的直接内容，包含声明的 `backend/**`。普通市场下载上限统一为 **256 MiB**，安装解压总量上限为 **2 GiB**；这些上限不豁免身份、摘要、路径和符号链接检查。

| 官方插件 | 迁移后版本 | 最低宿主版本 |
| --- | --- | --- |
| 数据库 `com.enest.database` | 1.2.0 | 0.2.0 |
| 中间件 `com.enest.middleware` | 0.2.0 | 0.2.0 |
| SSH `com.enest.ssh` | 1.2.0 | 0.2.0 |
| 远程桌面 `com.enest.remote-desktop` | 1.1.0 | 0.2.0 |

`enest.db.*`、`enest.mw.*`、`enest.ssh.*` 保留原有前端调用形状；宿主将它们转交给**调用方自己的后端包**，不再内置协议驱动。它们继续检查原有细分权限，并额外要求 `backend.node`；旧授权不会隐含完整 Node 信任。数据库方言/驱动资料也来自插件后端，需要 `backend.node`，但资料查询本身不授予数据库内容访问能力。`db.pickSqliteFile` 与 `ssh.pickLocalFile` 仍是无需启动后端的宿主原生选择器。

官方数据库、中间件、SSH 后端可能实现专用方法名、事件和宿主回调；应继续通过对应兼容门面调用，不能把 `enest.db.*` 等会话和通用 `enest.backend.call` 创建的进程混用。新业务优先使用通用后端协议，不要为插件业务向壳加入新的驱动依赖、专用主进程处理器或权限名。缺少后端入口时，宿主会提示更新/重新构建插件，不回退到旧壳驱动。

DSH 现有 `runtime/` 附件继续使用其专属集成；它与通用 `backend/` 是不同的加载路径，两者都不属于 Chromium 页面沙箱的保证范围。
