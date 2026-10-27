# 数据存储与私有资源

宿主按**数据归属、提交语义和生命周期**提供存储能力，而不是把所有内容塞入一个无差别 store。普通页面的入口是 `enest.storage`；声明式设置、后台文档、用户文件和密钥仍有独立边界。

## 如何选择

| 数据 | 推荐入口 | 边界 |
|---|---|---|
| 用户可配置的插件偏好 | `enest.settings` | 必须先注册字段；宿主设置页、插件自绘页面可使用同一设置值 |
| 小型 JSON 业务数据、资源索引 | `enest.storage.get/set/remove/clear` | 本插件持久化 KV，单值 512 KiB；不是二进制仓库 |
| 必须确认提交的 JSON 状态 | `enest.storage.flush/commit` | 同插件 KV 的显式 SQLite FULL 提交回执；不包含图片或文件 |
| 可丢弃的当前会话状态 | `enest.storage.session` | 主进程内存；显式关闭清空，休眠可恢复有界快照 |
| 生成图片、画板贴图等持久化图片 | `enest.storage.assets` | 唯一推荐的前台图片资源接口；兼容读取旧图片附件 |
| 沙箱后台拥有的文档和导入附件 | `enestBackground.host.private` | 后台代次校验、原子文档与不可变 blob；主页面通过本插件 `background.call` 访问业务服务 |
| 录制等有序大文件输出 | `enest.files.stream` | 当前实例的私有输出流；有序写块、背压和关闭收尾，不是图片目录或任意文件系统 |
| 已完成的录制等私有输出 | `enest.storage.files` | 按不透明 ID 分页列举、分块读取、删除、原生确认导出；兼容旧完成文件 |
| 用户选择的现有文件 | `enest.localFiles`，按需配合 `enest.fs` | 原生选择签发、运行实例绑定的句柄；`fs` 只有受控改名，不提供任意路径读写 |
| 导出到用户选择的位置 | `enest.shell.saveFile/saveTextFile` | 每次通过原生保存对话框确认目标；取消返回 `null` |
| API token、密码 | `enest.vault` | 系统加密、页面只写不读；返回 `secretRef`，不能用普通 KV 或图片资源替代 |

宿主不提供通用 `enest.db` 或 SQL/文档数据库接口。数据库业务属于插件自己的后端；宿主内部的 SQLite 实现不构成插件可直连的公共协议。

## 图片资源：`storage.assets`

基础能力，无需声明或额外授权；宿主仍校验调用页面、插件身份、当前运行代次、输入、配额和退出状态。插件不能指定其它插件的数据目录。

| 方法 | 输入与结果 |
|---|---|
| `put(input)` | 二进制 `{ bytes: ArrayBuffer, mime, name?, assetId? }` **或** `{ dataUrl, name?, assetId? }`；返回 `PluginAssetPutResult` |
| `list()` | 返回 `PluginAsset[]`，包含本插件已有 assets 与旧 blobs 附件；当前接口不提供分页 |
| `get(assetId)` | 返回 `{ dataUrl, mime, bytes }`；不存在返回 `null` |
| `remove(assetId)` | 删除本插件资源，返回 `boolean`；建议的新调用名 |
| `delete(assetId)` | `remove` 的 deprecated 兼容别名 |

`PluginAsset` 的字段为 `{ assetId, name, mime, bytes, createdAt }`；`createdAt` 为时间戳。`put` 的旧 `path` 返回字段仅为兼容保留，已 deprecated：它不授予本地文件访问权限，也不是受支持的渲染 URL。

### 输入与稳定 ID

- `bytes + mime` 与 `dataUrl` 必须二选一，不能混传；data URL 自带 MIME，不再附加 `mime`。
- 支持 PNG、JPEG、WebP、GIF；`ArrayBuffer` 只传实际内容范围，不要把其它数据共用的大 buffer 整个传入。
- 不传 `assetId` 时由宿主生成。传入此前返回的 `assetId` 可替换同一资源，不会重复追加文件后缀。
- 已有带类型后缀的 ID 不能改用不匹配的 MIME；需要转成另一种图片格式时新建资源，不自行改写旧 ID。
- `assetId` 是不透明字符串。业务记录保存原值，读、改、删时原样传回；不要假定它一定是 UUID，也不要自行增删扩展名。
- 单文件最多 32 MiB；每插件前台图片合计 1 GiB、最多 10,000 个逻辑资源。旧 attachments 与 assets 一并计入，兼容入口不会获得第二份配额。
- 同插件图片操作共用串行队列，最多 16 个未完成操作，其中最多 2 个写入。批量预览或恢复使用有界调度（建议同时发起 2–4 个读取），不要对整库无界 `Promise.all()`；超出队列预算会 reject，不能将其当成资源不存在。
- 既有超额数据仍可按 ID 读取和删除；同大小或缩小覆盖不再增加占用。每个私有图片目录（含旧附件目录）另有 **40,000 个物理条目**的枚举保护上限：不超过时可 `list` 和进行不增长的覆盖；超过时 `list/put` 拒绝，已知 ID 的 `get/remove` 不依赖全库枚举，仍可逐项处理。

旧附件缺少 sidecar、元数据损坏或记录不完整时，`list()` 保留可删除占位行：`assetId/name` 为原 ID，`mime: 'application/octet-stream'`、`bytes: 0`、`createdAt: 0`。这不表示资源是可正常预览的空文件；`get()` 可能返回 `null` 或 reject，仍可用原 ID 调用 `remove()` 清理逻辑记录。磁盘访问错误、非法目录或上述枚举上限仍可能令列表整体失败。

```ts
const image = await enest.storage.assets.put({
  dataUrl: canvas.toDataURL('image/png'),
  name: '画板预览'
})
// JSON 仅保存标识及业务索引，不复制图片内容。
await enest.storage.commit([{ op: 'set', key: 'preview', value: { assetId: image.assetId } }])

// 同一 ID 覆盖：原样回传，不能自己追加 .png。
await enest.storage.assets.put({
  assetId: image.assetId,
  dataUrl: canvas.toDataURL('image/png'),
  name: '画板预览'
})

const saved = await enest.storage.assets.get(image.assetId)
if (saved) document.querySelector<HTMLImageElement>('#preview')!.src = saved.dataUrl
await enest.storage.assets.remove(image.assetId)
```

已有二进制时，直接使用 `put({ bytes, mime: 'image/png', name })`，不必先转为 base64。资源写入完成后才更新业务索引；写入失败应展示错误，不能偷偷把大图塞回 512 KiB 的 KV。图片提交与业务 KV 更新是两个操作，不提供跨两者的事务。

### 预览、导出与资源释放

预览使用 `get()` 的 `dataUrl`，或在页面中创建 `Blob` URL；不用时调用 `URL.revokeObjectURL()`。不要依赖私有磁盘布局、`file://` 或把 `path` 交给 `openExternal()`。

```ts
const saved = await enest.storage.assets.get(assetId)
if (saved) {
  const exported = await enest.shell.saveFile({ defaultName: 'image.png', dataUrl: saved.dataUrl })
  if (exported?.ok) await enest.ui.toast({ body: '已导出图片', level: 'success' })
}
```

资源关闭页面后保留，卸载时清理。进行中的图片操作绑定原实例，关闭或代次失效后不能成为新实例的操作。应用退出、磁盘失败或调用拒绝都不是保存成功；只有成功返回的资源才应显示为已保存。

### 提交失败与结果不确定

新写入先保存不可变图片内容，再以原子替换元数据指针作为提交点，避免新内容与旧元数据半写配对。但 **Promise reject 不等于资源一定没有更新**：指针替换之后，目录同步失败会报告 `Private image was committed but its durability is uncertain; read the asset before retrying`；资源可能已经更新，只是崩溃后的持久性不能确认。提交后的实例关闭也可能使回执失败，删除操作同样不保证失败时完全未执行。

遇到这种结果，覆盖操作先按原稳定 ID `get()` 核对当前内容；新建且未拿到 ID 时先 `list()` 核对，不要直接改用新 ID 盲目重试。读取确认的是当前可读状态，不补足失败的磁盘持久性保证。未确认之前显示“保存状态待确认”或可重试错误，不更新业务索引为确定成功；图片与业务 KV 之间仍无跨域事务。

### 旧 `storage.blobs` 兼容

`storage.blobs.put({ dataUrl, name? }) → { id, bytes }`、`get(id)`、`remove(id)` 保留为同一主进程图片服务的兼容适配。新插件统一使用 `storage.assets`。

旧附件 UUID 和已有 assetId 无需启动全量迁移，均可通过 assets 读取、删除和列出。现有业务字段可以继续叫 `blobId`，其值直接作为 assetId 使用，不必重写整份业务 JSON。新 `blobs.put` 返回的 `id` 也可能带扩展名，必须当作不透明标识保存。

这里保证的是**新宿主读取旧数据、继续支持旧插件 API**，不保证旧宿主识别新磁盘格式。新写或覆盖的图片使用不可变内容和元数据指针，降级到不支持该格式的旧宿主后可能不可见；尤其不能在同一数据根同时运行新旧宿主。首次运行升级版前备份整个数据根；需要降级时同时恢复对应旧版数据快照，不只替换应用程序。

`storage.clear()` **只清持久化 KV**，不会删除图片、session、settings、后台文档、输出文件或密钥。需要清理图片时，显式枚举并逐项 `assets.remove()`；应在删除成功后再清理相应业务索引。

## JSON 与写入完成语义

| 接口 | 成功意味着什么 |
|---|---|
| `storage.set/remove` | 已进入宿主有界脏键队列，读取可见；50ms 合并落库，不是磁盘提交回执 |
| `storage.flush` | 本插件此前入队的 KV 已完成 FULL WAL 提交；即使队列已空，也写提交标记同步此前的普通事务 |
| `storage.commit` | 本批次与本插件已有待写 KV 在同一 FULL WAL 事务中提交，成功后才发布本批新值 |
| `storage.clear` | 当前插件 KV 清理完成，不能当作其它存储域的总清理 |
| `storage.session.set` | 内存状态更新完成，不承诺跨显式关闭或退出保存 |
| `settings.set` | 真实持久化成功后才广播确认值；失败 reject，不发布成功态 |
| `storage.assets.put` | 图片内容和索引已完成提交；不是仍在等待执行的排队写 |
| 后台 `private.writeDocument` | 原子文档替换完成；用于需要先提交再确认迁移的后台状态 |
| `files.stream.finish` | 已有写块处理完毕，私有输出文件同步、关闭、发布并完成支持平台的目录同步 |

KV 仅接受有限、纯 JSON 数据；不接受 `undefined`、函数、循环、非有限数值或自定义类。持久化 KV 每插件最多 1000 键、单值 512 KiB、键最长 1024 UTF-8 字节；待提交数据另有每插件 8 MiB、全局 64 MiB 上限。磁盘失败保留待写并记录错误，不代表之后必然成功。`set/remove` 保留原有的快速入队语义；需要提交回执时使用下述接口，不能把普通 `set()` 成功显示为已持久提交。

### 显式提交：`flush` 与 `commit`

```ts
await enest.storage.set('draft', draft)
const receipt = await enest.storage.flush()
// receipt: { commitId, committedAt, committedKeys }

await enest.storage.commit([
  { op: 'set', key: 'document', value: document },
  { op: 'set', key: 'migration', value: { completed: true } },
  { op: 'remove', key: 'legacyIndex' }
])
```

- `flush()` 只提交调用插件的待写 KV，不强制提交其他插件的待写队列。先 `await` 必要的 `set/remove`，再调用 flush，不能依赖不同调用方的并发顺序。
- `commit(operations)` 接受 1–100 个唯一键操作（`set` 或 `remove`）；重复键、非法 JSON 或超限会整批拒绝。本批与本插件已有待写值合并后不超过 8 MiB（含键和记账开销），单值和键数沿用 KV 限额。旧超额键库仍可不增长更新或删除。
- 成功返回 `{ commitId, committedAt, committedKeys }`。`commitId` 是唯一回执，不是 CAS 版本或可用于跨域事务的标识；`committedKeys` 包含此前待写的不同键，不是实际改变的数据库行数。
- 普通写维持 SQLite WAL/NORMAL；显式提交临时启用 FULL，macOS 同时启用 fullfsync，提交后恢复普通设置。空队列也更新内部提交标记，避免“之前已被定时器写入”被误当成已同步落盘。
- 参数校验失败不发布本批值；数据库事务失败时保留此前已接收的待写数据，本批未成功的新值不会自动排队重试。通信中断或实例关闭可能丢失已经提交的回执，收到失败不应假定磁盘必定未变；重新读取业务状态再决定幂等重试。
- 该保证依赖 SQLite、文件系统和设备遵守同步语义，不是对损坏磁盘或错误硬件写缓存的保证。不要逐按键调用 FULL 提交；通常在保存、迁移确认或生命周期检查点使用。

`@enest/plugin-kit` 的 `kit.save()` 仍按键串行排队，`kit.flush()` 等待 kit 当前写入后取得宿主提交回执。`kit.api` 是已有 `window.enest`（兼容 `window.zapi`）的只读引用，不新增或绕过宿主能力。旧宿主没有提交能力时 `kit.flush()` 明确失败，不伪造成功；kit 的关闭/休眠回调在支持的宿主上会等待显式提交。插件自己的防抖尚未进入 kit 队列时，仍须在 `onBeforeClose/onBeforeSuspend/onSaveRequested` 返回包含“提交防抖快照”的 Promise；不能只依赖浏览器 `beforeunload`。

### 已完成文件：`storage.files`

`files.stream.finish()` 成功后的 `id` 直接用于这里；旧 `plugin-files` 内的 UUID 完成文件可按需识别，不启动全量迁移。`storage.files` 与图片 assets 分属不同索引和配额，不接收裸路径，旧 `finish().path` 仅兼容展示。

| 方法 | 契约 |
|---|---|
| `list({cursor?,limit?})` | 返回 `{items,nextCursor}`；默认 100、最多 200 条，以 ID 稳定排序；下一页原样传回 cursor |
| `get(id,{offset?,length?})` | 返回 `{file,offset,bytes,nextOffset}` 或 `null`；默认从 0 读取最多 512 KiB，`bytes` 为 ArrayBuffer |
| `remove(id)` | 删除完成文件并释放输出配额；不存在返回 `false`，未完成输出不能通过此接口删除 |
| `export(id,{defaultName?})` | 必须弹宿主原生保存框；取消返回 `null`，成功返回 `{ok:true,path,size}` |

`items/file` 为 `{id,extension,size,createdAt}`。读偏移必须为非负安全整数，`length` 必须为 1–524288，零长度不合法；到达或越过 EOF 返回空 buffer、`nextOffset:null`。读取时复核文件身份，不能把分块读取变成任意路径能力。

```ts
const completed = await enest.files.stream.finish(streamId)
await enest.storage.commit([{ op: 'set', key: 'lastOutput', value: { id: completed.id } }])
const page = await enest.storage.files.list({ limit: 30 })
const firstChunk = await enest.storage.files.get(completed.id, { offset: 0, length: 65536 })
const exported = await enest.storage.files.export(completed.id, { defaultName: 'recording.webm' })
// 用户明确删除自己的历史资源时再调用；导出并不会自动删除私有原件。
await enest.storage.files.remove(completed.id)
```

完成文件关闭或重启后保留，卸载清理；新增流受每插件 4096 项、4 GiB 和单文件 1 GiB 限额约束。`list/open` 的目录扫描最多 8192 个物理条目；已知 ID 的 `get/remove/export` 使用常量内存流式扫描，独立受 5 秒和 262144 个物理条目上限约束，使一般旧超额目录仍有回收路径。达到保护上限或同一 ID 对应多个扩展名时拒绝，不无界枚举或擅自选择文件。普通完成文件操作每插件最多 16 个在途、全局 64 个；有界活跃流另保留 open/finish 的收尾额度，不因普通读取占满而丢弃录制。页面批量处理仍需有界调度。

`finish` 的 rename 是发布提交点；提交后目录同步失败或实例失效会明确报告“已提交”，保留完成文件，不再当作未完成输出删除。此时应先刷新列表核对。目录同步在 macOS/Linux 执行；Windows 不执行目录 fsync，不能据此承诺各平台具有完全相同的断电恢复保证。

导出持有原始文件句柄，按块写入用户所选目录内的临时文件，成功同步后才原子替换目标；取消、实例失效或提交前失败不会先截断原目标。提交后目录同步失败会报告已提交但持久性不确定；提交后实例失效或不再可交互也明确报告已提交，目标不会因此回滚。删除回执失败也不代表文件仍存在。应核对状态，不盲目重复操作。`get/list/remove` 是插件私有基础能力；导出以用户在原生保存框选定目标作为授权，不再弹通用文件权限框。

session 的总载荷限每插件 8 MiB、全局 64 MiB，和持久化 KV 的单值配额不同。需要永久保留的状态写持久化存储；临时图片 URL、DOM、网络连接和运行时句柄都不能当作可恢复 JSON 保存。

## 为什么还有后台文档和输出流

沙箱后台只有专用 `enestBackground`，不拿到主页面的完整 `enest`。后台 `host.private.writeDocument(key,value)` 提供每文档 16 MiB、最多 128 文档的原子替换。后台 blob 的稳定 ID 是**同内容幂等**：同 ID 不同内容会拒绝，而前台 assets 允许替换；后台 blob 还承担经宿主核验的旧数据导入预算。这些约束不能通过别名迁到可覆盖的前台图片接口。

`files.stream` 面向持续产生的大文件，具有单块、序号、背压、打开流数、总容量以及 beforeClose 收尾边界；完成后交给 `storage.files` 管理。它不能接受资源 ID 当路径，也不能利用 `path` 绕过用户文件选择；完成输出与图片图库不是同一索引。

用户文件保存保留原生确认；保险库保留系统加密和无明文读取；设置保留已注册字段、宿主保留键及主题分享规则。这些是不同的安全边界，不因底层都“写磁盘”而合并。

## 旧宿主数据的定向移交

旧数据导入是受限的升级兼容接口，不是允许插件读取宿主数据目录的通用迁移服务。

| 来源 | 宿主承担的责任 | 插件承担的责任 |
|---|---|---|
| `clipboard-history-v1` | 仅向原所有者 `com.github.eNest.clipboard` 的沙箱后台提供有界原文与已校验 PNG；核验来源 token、文件身份、预算与完成标记 | 解释旧历史格式、去重、保留策略、保存自己的文档/blob，并在持久化成功后确认导入 |
| `focus-timers-v1` | 只校验旧容器和归属，按容器原 `pluginId` 把不透明载荷分块移交对应私有 KV | 解释步骤、会话与统计，按业务 ID 幂等合并，不覆盖已有用户记录或重复统计 |

这些固定来源与所有者检查不能由插件自报路径替代，未授权的插件不能通过改名或调用参数领取其他用户历史。文件损坏、超限、符号链接或读取期间身份变化时拒绝，保留原数据，不将失败标记为成功。旧计时容器的导入失败会记录诊断并延后重试，不阻断通用 `deadlineTasks` 初始化。

原文件作为升级备份保留；**已成功移交的宿主完成标记不会因插件卸载而清除**，以免卸载后重新导入用户已删除的数据。插件自己的迁移标记只应在新状态真实提交后推进；尚未出现旧来源不等于该来源永远不会出现，后续重试仍应按业务 ID 幂等合并。

上述保护是有限兼容边界，不是永久保留所有历史格式的承诺。移除某个来源须先明确支持的升级路径和数据交接方式；不能以开发机上没有旧文件为理由删掉所有者验证或完成标记，也不能把整个历史业务模型搬回宿主。

完整签名见 [TypeScript 类型](api-types.md)，用户文件与权限见 [权限说明](permissions.md)，后端宿主控制见 [插件本机后端](backend.md)。
