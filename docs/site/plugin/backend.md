# 插件本机后端

eNest **0.0.1** 的插件可以在自己的发布包中携带 Node.js 后端。前端继续运行于受隔离的 `WebContentsView`；协议驱动、数据库客户端、计算任务等代码放在插件 `backend/` 中，由宿主按当前插件实例启动 Electron `utilityProcess`。`protocolVersion: 1` 的通用后端控制协议提供实例上下文、活动租约、子进程归属、回环页面端点、代理解析和协作关闭；使用这些能力的插件须声明 `engines.enest: ">=0.0.1"`。

纯浏览器插件无需后端。需要后端的插件必须声明并取得 **`backend.node`** 授权。此权限表示信任插件执行完整 Node.js 代码：后端具有当前用户可用的本机文件、网络和进程能力。utility process 用于隔离生命周期和故障，**不是操作系统沙箱**；Chromium 页面沙箱及细分的前端 API 权限不能限制已授权后端的直接 Node 调用。

## 清单与产物

在 `plugin.json` 中增加：

```json
{
  "engines": { "enest": ">=0.0.1" },
  "permissions": ["backend.node"],
  "backend": { "entry": "backend/index.cjs" }
}
```

以上是需要合并到完整 manifest 的字段。`main` 仍为 `index.html`。后端入口必须是插件包内 `backend/` 下的真实 `.cjs`、`.mjs` 或 `.js` 文件；宿主拒绝符号链接、越界路径和不存在的入口。仓库构建工具统一输出 `backend/index.cjs`。`backend/` 只供进程启动器读取，不能通过 `enest://` 页面资源协议访问。

声明 `backend` 的插件还可携带私有 `runtime/` 附件，例如自身启动的 CLI 或服务运行文件。该规则不绑定插件 ID；附件中的源格式运行资源可以保留，但所有层级仍拒绝符号链接和非普通文件。未声明后端的包不能携带 `runtime/`，宿主不会因附件存在而自动启动它，页面资源协议也不开放 `runtime/`。附件的选择、版本与业务管理由插件负责。

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
    │   └── enest-distribution.json # 可选；新构建写入分发目标
    ├── backend/
    │   ├── index.cjs              # 编译后的入口
    │   ├── node_modules/          # 锁定的生产依赖及所需原生变体
    │   └── dependency-inventory.json
    └── runtime/                   # 可选；后端私有附件，不是页面资源
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

`enest.backend.call<T>(method, args?, { timeoutMs }?)` 返回 `Promise<T>`，`args` 默认为 `[]`。方法名由插件定义，必须以英文字母开头，后续可用字母、数字、下划线、点、连字符，总长不超过 80 个字符。该接口只调用当前插件自己的入口，不会查找另一个插件或宿主内置驱动。超时默认 30 秒，可设 250ms–24h；包含后端请求原生授权/选择器的等待时间，插件应将慢交互与短执行分开。`enest.backend.stop()` 终止本实例的后端及在途请求，确认回收后才能重建；可用于取消阻塞的原生操作，不能停止其他插件。

后端可以主动发送命名事件。前端统一从 `backend.event` 接收 `{ event, data }`；事件名可用字母、数字、下划线、点、连字符，长度为 1–80。宿主绑定事件来源，后端不能用这条通用事件通道冒充 `ssh.data`、壳事件或其它插件。

## utility process 协议

后端使用 **`process.parentPort`**，不是 `node:worker_threads.parentPort`，也不需要导入 `electron`。`message` 监听器收到的参数是 `{ data }`，消息对象在 `data` 内。

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| 宿主 → 后端 | `{ type: 'init', pluginId, generation, wcId, context }` | 当前实例身份与控制协议上下文；每次新进程发送一次 |
| 宿主 → 后端 | `{ id, pluginId, method, args, proxy }` | 请求；`id` 用于匹配响应 |
| 后端 → 宿主 | `{ id, ok: true, data }` | 成功结果 |
| 后端 → 宿主 | `{ id, ok: false, error }` | 失败；`error` 为可展示的错误字符串 |
| 后端 → 宿主 | `{ event, data }` | 主动事件，无请求 `id` |
| 后端 → 宿主 | `{ type: 'host.request', id, method, params }` | 调用下文列出的通用宿主控制能力 |
| 宿主 → 后端 | `{ type: 'host.response', id, ok, data?, error? }` | 控制请求结果；与业务请求分开关联 |
| 宿主 → 后端 | `{ type: 'shutdown', reason, deadlineAt }` | 停止接收新任务、取消工作并在截止时间内退出 |
| 后端 → 宿主 | `{ type: 'shutdown.complete', ok?, error? }` | 可选关闭确认；不能代替进程真正退出 |

`context` 的版本 1 形状如下。`packagePath` 是本次加载的包根；`appDataPath` 是当前宿主数据目录，并不是只读挂载或插件文件沙箱。路径只作为运行上下文，不应硬编码用户目录。后端必须校验支持的协议版本，不能在缺少上下文时静默改用旧的宿主专用实现。

```ts
interface BackendContext {
  protocolVersion: 1
  appDataPath: string
  packagePath: string
  appExecPath: string
  pageOrigin: string | null // Authoritative current renderer origin, never supplied by the plugin
}
```

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
  if (request.type === 'shutdown') {
    // This example has no persistent resources or unfinished background jobs.
    port.postMessage({ type: 'shutdown.complete', ok: true })
    process.exit(0)
  }
  if (request.type === 'host.response') return
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

请求参数与返回值应保持可序列化，并在后端继续验证方法、参数和业务资源归属。不要把密钥、连接密码或完整文件内容写进错误消息及进度事件。示例不导入宿主模块。官方 SSH、数据库、中间件也使用下列相同通用控制能力；业务方法和 DTO 不属于宿主协议。

## 后端调用宿主控制能力

`host.request.id` 必须是安全整数，在途 ID 不得重复；`params` 必须是对象。后端单独维护控制请求表，处理 `host.response`，并为自己的等待设置超时。宿主只接受以下方法，不提供任意 IPC、文件、配置或内部服务透传。

| 方法 | 参数与边界 |
| --- | --- |
| `activity.acquire` | `{ token, reason }`；同 token 幂等，最多 128 份租约；token 最长 128 字符，reason 最长 160 字符 |
| `activity.release` | `{ token }`；幂等释放，关闭期间仍可调用 |
| `process.track` | `{ pid }`；最多 128 个显式登记子进程；必须是当前后端的真实存活后代，不能登记后端自身或任意 PID |
| `process.untrack` | `{ pid }`；确认退出或 PID 已复用后才移除，不能通过消息放弃仍存活的自有进程 |
| `endpoint.allow` | `{ token, url, kind: 'subFrame' \| 'webSocket', pid }`；最多 32 个；仅无凭据、无 fragment、显式端口的 loopback URL。子页面限 `http:`，套接字限 `ws:`；主机限 `127.0.0.1` / `localhost`，PID 必须是精确确认的当前后端或其存活后代 |
| `endpoint.revoke` | `{ token }`；幂等撤销，关闭期间仍可调用 |
| `network.resolveProxy` | `{ url }` → `{ proxy }`；仅无凭据 HTTP(S) URL，最长 8192 字符；返回当前宿主 session 的代理解析结果，不代发网络请求 |
| `secret.resolve` | `{ ref }` → `string \| null`；只解析本插件保险库引用，明文不能转发页面 |
| `permission.authorize` | `{ permission, summary }` → `true`；未知、未声明、拒绝或过期时抛错；业务 action 由插件解释 |
| `dialog.confirm` | `{ title, message, detail? }` → `boolean`；宿主标明真实来源，只允许当前可见插件，新鲜原生确认；`confirmed: true` 无效 |
| `files.open/read/close` | 打开 `{ handleId }` → `{ token, name, size }`；读取 `{ token, offset, length }` → `{ bytes: Uint8Array, bytesRead }`；关闭 `{ token }`，幂等 |
| `files.resolve` | `{ handleId, access?: 'read' \| 'write' }` → 已授权路径；仅可信 Node 后端可用，不返回页面 |
| `files.directoryTarget` | `{ handleId, name }` → 已授权目录内的单个目标路径 |
| `files.pick/save` | `{ options }` → 文件句柄列表 / 保存句柄或 null；复用原生选择器与归属校验；`save` 的可选 `defaultName` 由插件指定，省略时不预设文件类型 |
| `files.exportDirectory/export` | `{}` → 私有临时目录；`{ paths }` → `{ exportId }`，最多 1000 个、必须位于当前后端签发目录内 |
| `storage.get/set` | `{ key }` / `{ key, value }`；仅本插件 KV，沿用 512KiB 单值与写入/缓存配额 |
| `log.write` | `{ level: 'info' \| 'warn', source, message }`；宿主绑定插件来源，最长 16KiB，不应记录凭证或文件内容 |

文件流最多 64 个打开 token、8 个在途读取、单块 256KiB；使用普通文件 FD、拒绝最终符号链接，读前/读后比较 dev/ino/size/mtime/ctime。关闭或代次失效时拒绝新读取并等待在途读取后关闭 FD。大文件不能通过整文件缓冲规避限制。导出临时目录最多 32 个，1 小时过期或后端回收时删除；活动目录不能跨后端代次共享。`files.close` 在协作关闭期间仍可用。

控制资源绑定当前 `pluginId + generation + wcId`，调用方不能在参数里替换归属。子进程登记结合 PID、启动时间与真实父子链，避免 PID 复用误归属，并用于占用统计及关闭回收。进程退出时须解除登记；关联端点也会撤销。`endpoint.allow` 的子页面模式放行对应回环源及其资源，WebSocket 模式仅放行对应 origin 与 path；均不是任意外网导航授权。插件负责确保 URL 确实指向自身服务，并校验一次性 token 与 `context.pageOrigin`；该能力不构成端口所有权的操作系统级隔离。

长任务先取得 `activity.acquire`，请求在 30 秒内返回任务编号，完成或取消后在 `finally` 中释放租约，使用事件报告进度。活动租约防止正常空闲休眠，并不阻止用户主动关闭、撤权、重载或退出应用；任务仍应保存可恢复状态。

## 通用调用预算与生命周期

| 项目 | 当前限制与行为 |
| --- | --- |
| 同时等待的请求 | 每个通用后端最多 32 个；超出立即拒绝 |
| 后端控制请求 | 每个通用后端最多 64 个在途 `host.request`；重复 ID、非法消息或超预算会终止后端 |
| 请求大小 | `args` 的 JSON 字节预算最多 4 MiB |
| 后端发来的消息大小 | 回复、事件或控制请求整条消息的 JSON 字节预算最多 8 MiB；超限终止后端 |
| 请求超时 | 默认 30 秒，可按请求设置 250ms–24h；超时终止该后端，并拒绝该进程的其它在途请求 |
| JavaScript 堆 | 进程以 `--max-old-space-size=256` 启动；不是原生内存或总 RSS 的硬上限 |
| 正在执行的请求 | 持有当前实例的活动租约；回复或进程退出后释放 |
| 关闭、重载、撤权 | 撤销端点、拒绝新工作和在途请求，协作关闭后确认后端及其后代退出；旧进程的迟到业务消息被丢弃 |

同一实例按需复用通用后端进程；旧代次尚未退出时不会把请求交给旧进程，也不会无限叠加替代进程。后端异常退出（含 fatal error、协议错误和请求超时引发的退出）会向仍有效的来源实例发送 `backend.event`，其中 `event: 'backend.exit'`、`data: { code, unexpected: true }`；正常 `backend.stop` 和关闭不发送该异常事件。前端应停止展示旧任务仍在运行，在实例仍有效时由后续调用启动新进程。

关闭时宿主先停止新增控制资源，保留幂等释放通道并采集后代身份，然后发送截止时间约为 900 ms 的 `shutdown`。后端应取消下载/定时器/任务、停止服务并退出；超时后宿主使用 TERM、KILL 有界回收已确认归属的进程。关闭确认消息本身不能释放所有权；必须观察到真实退出。未确认退出会记录清理失败并阻止静默叠加替代进程，而不是把失败当作成功释放。

发事件本身不会自动取得活动租约。不要把长期任务的唯一状态留在进程内存中，也不要依赖窗口消失后仍能完成写入。

这些数值适用于 **`enest.backend.call` 通用通道**。数据库、中间件和 SSH 的私有适配器也使用该通道；可以按各自操作明确设置 `timeoutMs`，不能绕过通用请求、消息和资源配额。

## 生产依赖与原生包

插件的 `package.json` 声明自己的依赖和构建配置，例如 SSH 后端：

```json
{
  "dependencies": { "ssh2": "^1.17.0" },
  "enestBackend": {
    "entry": "backend/index.ts",
    "dependencies": ["ssh2"],
    "optionalExcluded": ["cpu-features", "nan"],
    "packageFilesExcluded": {
      "ssh2": ["lib/protocol/crypto/build"]
    }
  }
}
```

`enestBackend.entry` 指向源码入口；`enestBackend.dependencies` 列出需要保留为外部模块的 npm 根依赖，并且每个根依赖必须直接声明在该插件的 `dependencies`。仓库工具将业务 TypeScript 编译到 CJS，按插件仓库 `package-lock.json` 复制生产、必要 peer 和已安装 optional 依赖，保留重复版本的实际目录布局以及运行时资源、许可证。不会把整份工作区 `node_modules` 复制进包。

`optionalExcluded` 只排除确认具有可用回退实现的可选依赖。`packageFilesExcluded` 由插件声明包内可省略的文件或目录：键必须是 `enestBackend.dependencies` 中的 npm 根依赖名，值为该 npm 包根下的精确相对路径数组；目录匹配时只在复制过程中跳过该子树，不修改已安装依赖。禁止绝对路径、`..`、隐藏段、反斜杠、通配符、编码分隔符及 `node_modules` 段；不允许省略包的入口、`package.json` 或许可证/版权告知文件。排除路径的中间段不能是软链接；完整跳过的子树内，非受保护名称的软链接只作为不复制的叶子处理，不读取链接目标，其它待复制内容仍拒绝软链接。不存在的可选编译目录可以保留声明。

SSH 与远程桌面各自在自己的 `package.json` 排除 `cpu-features`、`nan`，并精确排除 `ssh2/lib/protocol/crypto/build` 中的可选 `sshcrypto` 本地编译产物，使用 Node crypto 的纯 JavaScript 路径。通用构建器只执行这些声明，不认识 SSH 包或业务插件 ID；插件维护者须验证回退实现及内部运行依赖，不能用排除配置任意裁剪其它驱动的 `.node` 文件。

原生依赖必须与目标 OS、CPU 架构及运行时 ABI/N-API 匹配。当前数据库插件通过 `platformPackages` 显式声明四个可分发 DuckDB 变体：

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

该字段属于 `enestBackend`。构建工具从锁文件查找精确版本与摘要；缺少的变体从锁定的 npm 源获取并校验完整性，不运行下载包的安装脚本。`universal` 包携带全部已声明变体；显式平台包只保留匹配的原生依赖和运行所需依赖闭包。不能按文件体积任意删除运行依赖，例如数据库的 `@tdengine/websocket` 直接依赖 `typescript`，它不是可直接移除的开发附件。包内存在某个平台变体不代表已完成该平台运行验收；每个平台仍需验证驱动加载和实际功能。

后端源码可使用 Node 内置模块和插件自己的 workspace 包；`@backend` 指向当前插件的 `backend/`。构建禁止导入 `electron` 或 `@main`、`@preload`、`@renderer`、`@shared` 宿主模块。公共类型应来自 SDK 或插件自身契约，不通过复制宿主运行时来恢复旧驱动。

## 开发、发布与兼容

在插件仓库先安装锁定依赖并构建：

```sh
npm ci
node scripts/build-plugin.mjs ssh remote-desktop
```

构建与打包入口都接受源码目录短名或精确的完整 manifest ID，例如 `ssh` 与 `com.github.eNest.ssh`；完整 ID 不做前缀剥离、大小写折叠或末段猜测，未知或歧义标识直接报错。两种写法解析到同一源码和产物，归档仍使用 `<短名>@<version>.enestplugin`，不会修改安装、权限或存储身份。

连接 Vite 开发服务器时，前端可以 HMR，后端仍从源码根的 **`dist/backend/index.cjs`** 加载，因此必须先构建。后端修改后在插件目录重新运行构建命令（如 `npm run build`），再关闭/重载插件以创建新进程；Vite HMR 不会替换已经运行的后端。开发者控制台没有 dev/prod 切换：验证完整发布行为时让开发服务离线，壳会按 `enest.output` 产物目录以生产 CSP 预览。不要使用「静态源码」预览直接运行 TypeScript 后端。

`.enestplugin` 的根仍是 `dist` 的直接内容，包含声明的 `backend/**`。普通市场下载上限统一为 **256 MiB**，安装解压总量上限为 **2 GiB**；这些上限不豁免身份、摘要、路径和符号链接检查。

### 平台分发与旧包兼容

默认命令仍只构建/打包通用版本，不因 `--all` 自动重复构建四个平台。平台变体复用已校验的前端产物，按锁定原生依赖清单裁剪；不会将本机裁剪包冒充通用包。

| 产物 | 命名与用途 |
| --- | --- |
| 通用包 | `<短名>@<version>.enestplugin`；默认输出不变 |
| 平台包 | `<短名>@<version>-<os>-<arch>.enestplugin`；不覆盖通用包 |
| 通用市场索引 | `registry.json`；保持 `schemaVersion: 1` 与旧客户端协议 |
| 平台市场索引 | `registry-<os>-<arch>.json`；原生插件优先指向对应平台包，可移植插件复用通用包 |
| 目标标记 | `assets/enest-distribution.json`：`{ "schemaVersion": 1, "target": "darwin-arm64" }` |
| 后端清单 | `backend/dependency-inventory.json` 的 `target` 必须与目标标记一致；`supportedTargets` 是声明支持范围，`platformPackages/nativePackages` 是实际装入的原生包 |

目标枚举为 `universal`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`win32-x64`。当前 `linux-x64` 仅表示 **glibc**，不承诺 musl 或 Linux arm64。目标构建输出在仓库 `dist/platform-builds/<target>/<短名>`，不改写 `plugins/<短名>/dist`。未知目标、原生支持范围不匹配、清单与标记冲突均报错，不能回退后再贴上不支持的平台标签。

```sh
# 单个平台构建与打包；此处可直接拿产物安装验证。
node scripts/build-plugin.mjs database --target=darwin-arm64
node scripts/pack-plugin.mjs database --no-build --target=darwin-arm64

# CI：已有全部 universal dist 后，再分发已声明的原生平台变体。
node scripts/pack-plugin.mjs --all --no-build --platform-variants
node scripts/build-registry.mjs --target=darwin-arm64
```

发版流程保留通用包/索引，同时上传平台包/索引及各自字节摘要。新壳优先请求本机 `registry-<os>-<arch>.json`，无平台索引时使用 `registry.json`；安装时核验包内目标，拒绝其他 OS/架构的显式目标包。没有目标元数据的旧包按通用包兼容，不据此保证它包含所有原生平台实现。每个平台索引仍校验已声明原生支持范围，不能用通用回退伪装未支持目标。

| 官方插件 | 首版配套版本 | 最低宿主版本 |
| --- | --- | --- |
| 数据库 `com.github.eNest.database` | 0.0.1 | 0.0.1 |
| 中间件 `com.github.eNest.middleware` | 0.0.1 | 0.0.1 |
| SSH `com.github.eNest.ssh` | 0.0.1 | 0.0.1 |
| 远程桌面 `com.github.eNest.remote-desktop` | 0.0.1 | 0.0.1 |
| AI 配置 `com.github.eNest.ccswitch` | 0.0.1 | 0.0.1 |
| 桌面宠物 `com.github.eNest.codex-pets` | 0.0.1 | 0.0.1 |
| 局域网分享 `com.github.eNest.lan-share` | 0.0.1 | 0.0.1 |
| 番茄钟 `com.github.eNest.pomodoro` | 0.0.1 | 0.0.1 |
| DSH `com.github.eNest.dsh` | 0.0.1 | 0.0.1 |

宿主不提供 `enest.db.*`、`enest.mw.*`、`enest.ssh.*`、`enest.agent.*`、`enest.net.share` 门面、业务事件和 DTO。官方插件内部适配器可以保持原来的业务调用形状，但只能使用 `backend.call`、`backend.event` 和通用宿主控制协议，不可覆盖冻结的 `window.enest`。

远程桌面也自行承担 RDCleanPath、X.224 与 RDP TLS 协商；壳的 `net.socket.serveWs` 只有字节流桥接，不再嗅探应用协议。远程桌面将私有 RDP 服务与 SSH 能力组合在同一按需后端，不为 RDP 再起一份常驻进程。

数据库、中间件的细分授权由插件解释 action 并请求通用 `permission.authorize`；SSH 只额外请求系统 agent 权限。AI 应用适配/白名单/最小侵入合并/快照/资产 staging、LAN HTTP/Range/分享码/过期/日志均归插件。通用控制接口不提供任意宿主服务透传；获得 `backend.node` 的代码具有完整 Node 信任，不是文件沙箱。新权限不会由旧的 `config.agent.*`、`lan.share` 或旧 SSH 限权授权自动升级。

番茄钟使用[后台步骤计划](deadline-tasks.md)，不启动 Node 进程；其周期、历史编辑、统计以及旧数据解释由插件负责。上述旧插件应同步更新，缺失后端或旧宿主 API 不会回退到壳业务实现。

DSH 的配置/profile、运行时版本管理、下载升级、工作台与子进程业务位于插件仓 `plugins/dsh/backend/`，前端通过通用 `enest.backend.call` 和 `backend.event` 调用，宿主只保留上述可复用控制能力。原有 `runtime/` 路径作为插件的私有附件保留，不再有宿主按 DSH ID 放行或加载的分支。旧开发包须更新到与 eNest 0.0.1 配套的新包；旧 `dsh.*` 专属权限/API 已移除，不会静默映射为 `backend.node` 授权。新版首次启动 Node 后端仍需用户明确同意，兼容门面由各插件自身提供。
