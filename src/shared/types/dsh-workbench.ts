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
  /** 记录在 SDK 会话头的工作目录 */
  cwd: string
  /** 模型路由（provider + model；需先在完全体 Settings→Models 配置凭据） */
  provider: string
  model: string
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
  /** 是否保留名（desktop）或活跃使用中 */
  reserved?: boolean
  createdAt?: number
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
  /** data = 数据目录热更新安装；bundled = 插件包内捆绑 */
  channel: 'data' | 'bundled'
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
  | { action: 'profiles.list'; input?: Record<string, never> }
  | { action: 'backup.list'; input?: Record<string, never> }
  | { action: 'runtime.versions.list'; input?: Record<string, never> }
  | { action: 'runtime.versions.available'; input?: { limit?: number } }
  | { action: 'rpc.call'; input: { method: 'session/wait' | 'session/working-directory/get'; params: Record<string, unknown> } }
  | { action: 'logs.tail'; input: { kind: 'web' | 'sdk'; lines?: number } }
  // dsh.chat（会话写）
  | { action: 'sdk.start'; input: DshSdkStartInput }
  | { action: 'sdk.stop'; input?: Record<string, never> }
  | { action: 'rpc.write'; input: { method: 'session/prompt' | 'session/working-directory/set'; params: Record<string, unknown> } }
  // dsh.admin（进程/profile/备份/热更新）
  | { action: 'web.start'; input: { profile?: string; port?: number } }
  | { action: 'web.stop'; input?: Record<string, never> }
  | { action: 'web.restart'; input?: { profile?: string; port?: number } }
  | { action: 'profiles.create'; input: { name: string; template: string } }
  | { action: 'profiles.delete'; input: { name: string; backupFirst?: boolean } }
  | { action: 'profiles.backup'; input: { name: string } }
  | { action: 'profiles.restore'; input: { backupId: string } }
  | { action: 'backup.create'; input?: { label?: string } }
  | { action: 'backup.restore'; input: { backupId: string } }
  | { action: 'backup.delete'; input: { backupId: string } }
  | { action: 'runtime.download'; input: { version: string } }
  | { action: 'runtime.activate'; input: { version: string } }
  | { action: 'runtime.remove'; input: { version: string } }
  | { action: 'upgrade.oneClick'; input: { version: string } }

/** 会话写类 action 集合（rpc.write 方法 + sdk 启停），权限映射与其保持同步 */
export const DSH_CHAT_ACTIONS: readonly string[] = ['sdk.start', 'sdk.stop', 'rpc.write']

/** admin 变更类 action（未知 action 一律按 admin 拒绝并报错） */
export const DSH_ADMIN_ACTIONS: readonly string[] = [
  'web.start', 'web.stop', 'web.restart',
  'profiles.create', 'profiles.delete', 'profiles.backup', 'profiles.restore',
  'backup.create', 'backup.restore', 'backup.delete',
  'runtime.download', 'runtime.activate', 'runtime.remove',
  'upgrade.oneClick'
]
