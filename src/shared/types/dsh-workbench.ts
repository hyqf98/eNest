/** DeepSeek Harness（dsh）工作台类型：运行时探测/进程管理、SDK JSON-RPC 桥、
 * profile 管理与备份、runtime 热更新版本管理的 workbench action 契约。
 * 与 mw-workbench.ts 同构：action 判别联合 + 三档权限（dsh.connect / dsh.chat / dsh.admin）。 */

// —— 运行时探测 ——

/** runtime 解析来源：数据目录热更新版 > 插件捆绑版 > 系统 PATH */
export type DshRuntimeSource = 'data' | 'bundled' | 'system' | 'none'

export interface DshRuntimeInfo {
  available: boolean
  source: DshRuntimeSource
  /** dsh 版本（--version 输出；不可用时缺省） */
  version?: string
  /** runtime 根目录（node_modules 布局所在）或系统 dsh 可执行路径 */
  root?: string
  /** 运行引擎：electron-runas = 复用 eNest Electron（ELECTRON_RUN_AS_NODE）；node = 捆绑/系统 Node */
  engine: 'electron-runas' | 'node'
  /** 插件专属 Harness home（DSH_HOME），缺省 ~/.eNest/dsh-home */
  dshHome: string
  error?: string
}

// —— 进程状态 ——

export interface DshWebProcessStatus {
  running: boolean
  pid?: number
  port?: number
  /** stdout 捕获的就绪 URL（可能带鉴权参数，原样交给 iframe） */
  readyUrl?: string
  profile: string
  startedAt?: number
  /** 端口冲突自动换口重试次数 */
  portRetries: number
  lastError?: string
}

export interface DshSdkProcessStatus {
  running: boolean
  pid?: number
  /** 当前或最近一次启动使用的 SDK profile，不等于下次启动选择。 */
  profile?: string
  initialized: boolean
  /** initialize 握手结果；失败时携带错误（如未配置模型凭据） */
  serverInfo?: { name: string; version: string }
  lastError?: string
}

export interface DshRuntimeStatus {
  runtime: DshRuntimeInfo
  web: DshWebProcessStatus
  sdk: DshSdkProcessStatus
}

// —— SDK JSON-RPC（stdio 换行协议；方法集见 @deepseek-ai/dsh-sdk-protocol）——

export interface DshSdkStartInput {
  /** 未指定时使用持久化设置选定的 SDK profile。 */
  profile?: string
  /** 记录在 SDK 会话头的工作目录；未指定时使用隔离 DSH_HOME。 */
  cwd?: string
  /** 模型路由（provider + model；需先在完全体 Settings→Models 配置凭据） */
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

// —— 会话持久化扫描（含完全体 web 进程创建的会话）———

export interface DshSessionHeader {
  sessionId: string
  title?: string
  workspace?: string
  createdAt?: number
  updatedAt?: number
  /** 最近 turn/step 摘要（由持久化事件投影） */
  lastActivity?: string
  /** 当前是否处于运行中（sdk 事件流佐证；仅 sdk 进程内会话可信） */
  live?: boolean
}

export interface DshSessionEventDump {
  sessionId: string
  /** 持久化 SessionEvent 原始数组（倒序裁剪） */
  events: Array<Record<string, unknown>>
}

// —— profile 管理 ——

export type DshProfileTemplate = 'web' | 'headless' | 'sdk' | 'sdk-minimal' | 'acp'

/** 宿主拥有的启动选择，不是 DSH 全局环境变量或原生 profile 字段。 */
export interface DshWorkbenchSettings {
  webProfile: string
  sdkProfile: string
  webPortPolicy: 'auto' | 'fixed'
  /** 固定策略下使用；自动策略仍保留上次配置值。 */
  webPort: number
}

export interface DshConfigurationApplication {
  ok: true
  /** 变更已持久化，进程已真实停止；下次启动才应用，不暗示已热重载。 */
  application: 'stopped'
  message: string
}

export interface DshSettingsUpdateResult extends DshConfigurationApplication {
  settings: DshWorkbenchSettings
}

export interface DshProfileInfo {
  name: string
  /** 内置模板（web/headless/sdk/sdk-minimal/acp）或自定义 */
  builtin: boolean
  /** dsh.profile.bundles 有序栈 */
  bundles: string[]
  /** cordis.patch.yml 是否存在及行数（可视化概览） */
  patchLines: number
  /** profile 依赖的 out-of-tree 插件 */
  plugins: string[]
  /** 保留名 desktop 不可由工作台修改/启动。 */
  reserved?: boolean
  /** 未初始化的内置模板也可被列出/选择；首次写入或启动时才落盘。 */
  exists: boolean
  template?: DshProfileTemplate
  /** 根据真实已选 bundle 判断，未知自定义 bundle 不猜测角色。 */
  webCompatible: boolean
  sdkCompatible: boolean
  error?: string
  createdAt?: number
}

export interface DshProfileConfig extends DshProfileInfo {
  /** profile 自己的 cordis.patch.yml；home 级补丁的优先级仍高于它。 */
  patch: string
  /** eNest 私有元数据，只允许安全白名单键；仅用于该 profile 子进程启动环境。 */
  environment: Record<string, string>
  dependencies: Record<string, string>
}

export interface DshProfileUpdateInput {
  name: string
  bundles: string[]
  patch: string
  environment: Record<string, string>
}

export interface DshProfileUpdateResult extends DshConfigurationApplication {
  profile: DshProfileConfig
  backupId: string
}

export interface DshEnvironmentResetInput {
  /** 默认 config 保留所有会话/存储；home 明确清空隔离 home（含会话）。 */
  scope: 'config' | 'home'
  backup: true
  /** 必须与 scope 精确匹配，不接受布尔式确认。 */
  confirmation: 'RESET CONFIG' | 'RESET HOME'
}

export interface DshEnvironmentResetResult extends DshConfigurationApplication {
  backupId: string
  scope: 'config' | 'home'
  preservedSessions: boolean
}

// —— 备份 ——

export interface DshBackupEntry {
  backupId: string
  /** profile = 单 profile 目录；home = 全量 $DSH_HOME */
  scope: 'profile' | 'home'
  name?: string
  target?: string
  sizeBytes: number
  createdAt: number
  runtimeVersion?: string
}

// —— runtime 热更新 ——

export interface DshRuntimeVersion {
  version: string
  /** data = 数据目录热更新安装；bundled = 插件包内捆绑；system = 明确选择的 PATH 命令。 */
  channel: 'data' | 'bundled' | 'system'
  path?: string
  installedAt?: number
  active: boolean
}

export interface DshRemoteVersion {
  version: string
  distTag?: string
  date?: string
  /** 下载资产（eNest_plugin Release）地址与校验 */
  assetUrl?: string
  sha256?: string
}

// —— 事件（dsh:event 推送）——

export type DshWorkbenchEvent =
  | { type: 'web-ready'; port: number; readyUrl?: string }
  | { type: 'web-port'; port: number; readyUrl?: string; retries: number }
  | { type: 'web-exit'; code: number | null; lastError?: string }
  | { type: 'web-stderr'; tail: string }
  | { type: 'sdk-exit'; code: number | null; lastError?: string }
  | { type: 'sdk-notify'; method: string; params: Record<string, unknown> }
  | { type: 'runtime-progress'; phase: string; detail?: string; percent?: number }

// —— workbench action 契约（权限映射见 main/dsh/workbench.ts）——

export type DshWorkbenchRequest =
  // dsh.connect（只读）
  | { action: 'runtime.detect'; input?: Record<string, never> }
  | { action: 'runtime.status'; input?: Record<string, never> }
  | { action: 'sessions.list'; input?: { limit?: number } }
  | { action: 'sessions.read'; input: { sessionId: string; maxEvents?: number } }
  | { action: 'settings.get'; input?: Record<string, never> }
  | { action: 'profiles.list'; input?: Record<string, never> }
  | { action: 'backup.list'; input?: Record<string, never> }
  | { action: 'runtime.versions.list'; input?: Record<string, never> }
  | { action: 'runtime.versions.available'; input?: { limit?: number } }
  | { action: 'rpc.call'; input: { method: 'session/wait' | 'session/working-directory/get'; params: Record<string, unknown> } }
  | { action: 'logs.tail'; input: { kind: 'web' | 'sdk'; lines?: number } }
  // dsh.chat（会话写）
  | { action: 'sdk.start'; input?: DshSdkStartInput }
  | { action: 'sdk.stop'; input?: Record<string, never> }
  | { action: 'rpc.write'; input: { method: 'session/prompt' | 'session/working-directory/set'; params: Record<string, unknown> } }
  // dsh.admin（进程/profile/备份/热更新）
  | { action: 'web.start'; input?: { profile?: string; port?: number } }
  | { action: 'web.stop'; input?: Record<string, never> }
  | { action: 'web.restart'; input?: { profile?: string; port?: number } }
  | { action: 'sdk.restart'; input?: DshSdkStartInput }
  | { action: 'settings.update'; input: Partial<DshWorkbenchSettings> }
  /** 显式编辑读取包含 profile 密钥，不能降为 connect。 */
  | { action: 'profiles.read'; input: { name: string } }
  | { action: 'profiles.create'; input: { name: string; template: DshProfileTemplate } }
  | { action: 'profiles.update'; input: DshProfileUpdateInput }
  | { action: 'profiles.sync'; input: { source: string; target: string; scope?: 'environment' | 'configuration' } }
  | { action: 'environment.reset'; input: DshEnvironmentResetInput }
  | { action: 'profiles.delete'; input: { name: string; backupFirst?: boolean } }
  | { action: 'profiles.backup'; input: { name: string } }
  | { action: 'profiles.restore'; input: { backupId: string } }
  | { action: 'backup.create'; input?: { label?: string } }
  | { action: 'backup.restore'; input: { backupId: string } }
  | { action: 'backup.delete'; input: { backupId: string } }
  | { action: 'runtime.download'; input: { version: string } }
  | { action: 'runtime.activate'; input: { version: string; source?: 'data' | 'bundled' | 'system' } }
  | { action: 'runtime.remove'; input: { version: string } }
  | { action: 'upgrade.oneClick'; input: { version: string } }

/** 连接读取类 action；主进程仍逐项校验 RPC 方法和参数。 */
export const DSH_CONNECT_ACTIONS: readonly string[] = [
  'runtime.detect', 'runtime.status', 'settings.get', 'profiles.list',
  'sessions.list', 'sessions.read', 'backup.list', 'runtime.versions.list',
  'runtime.versions.available', 'rpc.call', 'logs.tail'
]

/** 会话写类 action 集合（rpc.write 方法 + sdk 启停），权限映射与其保持同步 */
export const DSH_CHAT_ACTIONS: readonly string[] = ['sdk.start', 'sdk.stop', 'rpc.write']

/** admin 变更类 action（未知 action 一律按 admin 拒绝并报错） */
export const DSH_ADMIN_ACTIONS: readonly string[] = [
  'web.start', 'web.stop', 'web.restart', 'sdk.restart', 'settings.update',
  'profiles.read', 'profiles.create', 'profiles.update', 'profiles.sync', 'profiles.delete', 'profiles.backup', 'profiles.restore',
  'environment.reset',
  'backup.create', 'backup.restore', 'backup.delete',
  'runtime.download', 'runtime.activate', 'runtime.remove',
  'upgrade.oneClick'
]
