/** SSH / Database 插件宿主 API 共享类型（Spec docs/compose/spec/ssh-db-plugins.md） */

// —— Vault ——

export interface VaultSetResult {
  secretRef: string
}

// —— SSH ——

export type SshAuthType = 'password' | 'key' | 'agent'

export interface SshJumpConfig {
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  privateKeyPath?: string
  secretRef?: string
  ephemeralSecret?: string
}

/** ssh.connect 入参：密钥走 secretRef / ephemeralSecret / password（一次性） */
export interface SshConnectInput {
  profileId?: string
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  secretRef?: string
  ephemeralSecret?: string
  /** 插件 UI 一次性口令别名，等价 ephemeralSecret */
  password?: string
  privateKeyPath?: string
  jump?: SshJumpConfig | null
  keepAliveSec?: number
  timeoutMs?: number
  cols?: number
  rows?: number
  term?: string
  env?: string
}

export interface SshSessionInfo {
  sessionId: string
  profileId?: string
  host: string
  port?: number
  username?: string
  status?: string
  connectedAt?: number
  fingerprint?: string
  serverIdent?: string
  cols?: number
  rows?: number
}

export interface SshExecInput extends Partial<SshConnectInput> {
  sessionId?: string
  command?: string
  cmd?: string
  timeoutMs?: number
}

export interface SshExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
}

export interface SshMetricsSample {
  ts: number
  cpuPercent?: number
  memUsed?: number
  memTotal?: number
  memPercent?: number
  load1?: number
  disks?: Array<{ mount: string; usedPercent: number; used?: number; total?: number }>
  net?: Array<{ iface: string; rxKbps: number; txKbps: number }>
  uptimeSec?: number
  topProcesses?: Array<{ pid: number; cpuPercent?: number; memPercent?: number; command: string }>
  error?: string
}

export interface SshCompletionSuggestInput {
  sessionId: string
  /** 当前输入行（用于前缀匹配）；插件也可用 prefix */
  line?: string
  prefix?: string
  cursor?: number
  history?: string[]
  snippets?: Array<{ title: string; command: string }>
}

export type SshCompletionKind = 'cmd' | 'flag' | 'path' | 'history' | 'snippet'

export interface SshCompletionItem {
  label: string
  kind: SshCompletionKind
  detail?: string
  insertText: string
  sortText: string
  /** 危险命令说明；true/字符串均可能 */
  dangerous?: boolean | string | null
}

export interface SshCompletionResult {
  items: SshCompletionItem[]
  danger?: string | null
  word?: string
}

export interface SftpListInput {
  sessionId?: string
  path?: string
  host?: string
  port?: number
  username?: string
  authType?: SshAuthType
  secretRef?: string
  ephemeralSecret?: string
  privateKeyPath?: string
}

export interface SftpEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  size: number
  mtime: number
}

export interface SftpDownloadInput extends SftpListInput {
  remotePath?: string
  localPath?: string
}

export interface SftpUploadInput extends SftpListInput {
  localPath?: string
  remotePath?: string
}

export interface SftpTransferResult {
  ok: boolean
  path?: string
  remotePath?: string
  localPath?: string
  size?: number
  bytes?: number
  message?: string
  error?: string
}

export type SshPluginEvent =
  | { type: 'ssh.data'; sessionId: string; data: string }
  | { type: 'ssh.exit'; sessionId: string; code?: number | null; signal?: string }
  | { type: 'ssh.error'; sessionId?: string; message: string }
  | { type: 'ssh.metrics'; sessionId?: string; profileId?: string; sample: SshMetricsSample }

// —— Database ——

export type DbDriverId = 'mysql' | 'sqlite' | 'influxdb' | 'timescale' | 'tdengine'

export type DbDialect = 'mysql' | 'sqlite' | 'postgres' | 'influxql' | 'tdengine' | string

export interface DbConnectionConfig {
  driver: DbDriverId
  host?: string
  port?: number
  database?: string
  username?: string
  secretRef?: string
  ephemeralSecret?: string
  connectionId?: string
  env?: string
  readOnly?: boolean
  /** sqlite / 用户文件库（不是壳子 enest.db） */
  filePath?: string
  sqlitePath?: string
  createIfMissing?: boolean
  /** influxdb */
  org?: string
  bucket?: string
  /** 通用选项 */
  options?: {
    readOnly?: boolean
    requireConfirm?: boolean
    charset?: string
    ssl?: boolean
    schema?: string
    env?: string
    createIfMissing?: boolean
    file?: string
    org?: string
    bucket?: string
    [key: string]: unknown
  }
}

export interface DbTestResult {
  ok: boolean
  message: string
  version?: string
  latencyMs?: number
}

export interface DbSessionInfo {
  sessionKey: string
  driver: DbDriverId
  host?: string
  database?: string
  filePath?: string
  readOnly?: boolean
  openedAt: number
  connectionId?: string
}

export interface DbExecuteInput {
  sessionKey: string
  sql: string
  maxRows?: number
  timeoutMs?: number
  /** prod / 保护连接写操作确认（Spec DB-B5） */
  confirmed?: boolean
  params?: unknown[] | Record<string, unknown>
}

export type RowChange =
  | {
      type: 'update'
      table: TableRef
      key: Record<string, unknown>
      set: Record<string, unknown>
      original?: Record<string, unknown>
    }
  | { type: 'insert'; table: TableRef; values: Record<string, unknown> }
  | { type: 'delete'; table: TableRef; key: Record<string, unknown> }

export interface TableRef {
  database?: string
  schema?: string
  table: string
}

export interface BatchResultItem {
  index: number
  ok: boolean
  affected?: number
  error?: string
  sql?: string
}

export interface BatchResult {
  ok: boolean
  results: BatchResultItem[]
  durationMs: number
}

export interface DbApplyChangesInput {
  sessionKey: string
  changes: RowChange[]
  mode?: 'stop-on-error' | 'continue'
  confirmed?: boolean
}

export interface QueryResultColumn {
  name: string
  dataType?: string
  nullable?: boolean
  primaryKey?: boolean
}

export interface QueryResult {
  columns: QueryResultColumn[]
  rows: unknown[][]
  rowCount: number
  affectedRows?: number
  durationMs: number
  truncated?: boolean
  messages?: string[]
  warnings?: string[]
  rowIdentity?: { keyColumns: string[]; keys: unknown[][] }
  sql?: string
  error?: string
}

export interface DbSchemaTreeInput {
  sessionKey: string
  parent?: string
  database?: string
  schema?: string
  table?: string
  filter?: string
  node?: { type?: string; database?: string; schema?: string; table?: string }
}

export interface SchemaObject {
  name: string
  type: 'database' | 'schema' | 'table' | 'view' | 'measurement' | 'supertable' | 'column' | 'other'
  database?: string
  schema?: string
  comment?: string
  children?: SchemaObject[]
  column?: DbColumnMeta
}

export interface DbColumnMeta {
  name: string
  type?: string
  dataType?: string
  nullable?: boolean
  default?: unknown
  key?: string
  primaryKey?: boolean
  comment?: string
  pk?: boolean
}

export interface TableDetail {
  name?: string
  table?: string
  schema?: string
  database?: string
  columns: DbColumnMeta[]
  primaryKey?: string[]
  indexes?: Array<{ name: string; columns: string[]; unique?: boolean }>
  comment?: string
  ddl?: string
}

export interface CompletionCatalog {
  dialect: string
  databases: string[]
  schemas: string[]
  tables: Array<{
    name: string
    schema?: string
    type?: string
    columns: Array<{ name: string; type?: string; comment?: string; pk?: boolean }>
    comment?: string
  }>
  functions?: Array<{ name: string; signature?: string; doc?: string; kind?: string }>
  keywords?: string[]
  usageBoost?: Record<string, number>
}

export type CompletionItemKind =
  | 'keyword'
  | 'table'
  | 'view'
  | 'column'
  | 'function'
  | 'database'
  | 'schema'
  | 'snippet'
  | 'alias'
  | 'measurement'

export interface CompletionItem {
  label: string
  kind: CompletionItemKind
  detail?: string
  doc?: string
  insertText: string
  sortText: string
  filterText?: string
  owner?: string
}

export interface CompletionResponse {
  replace: { from: number; to: number }
  items: CompletionItem[]
  isIncomplete?: boolean
}

export interface DbCompletionInput {
  sessionKey: string
  sql: string
  cursor?: number
  database?: string
  schema?: string
  usageBoost?: Record<string, number>
}

export interface DbDialectInfo {
  id: DbDriverId | string
  label: string
  dialect: DbDialect
  defaultPort?: number
  keywords?: string[]
  keywordsSample?: string[]
  functions?: Array<{ name: string; signature?: string; doc?: string; kind?: string }>
  snippets?: Array<{
    prefix?: string
    body?: string
    detail?: string
    name?: string
    label?: string
    sql?: string
    text?: string
  }>
  [key: string]: unknown
}

export interface DbImportPreviewInput {
  sessionKey: string
  table: TableRef
  csvText?: string
  /** 仅允许宿主 picker 白名单路径 */
  filePath?: string
  options?: {
    delimiter?: string
    hasHeader?: boolean
    columns?: string[]
    sampleRows?: number
  }
}

export interface DbImportPreviewResult {
  columns: string[]
  sampleRows: string[][]
  totalRowsEstimate: number
  mappedColumns: Array<{ source: string; target: string }>
  sqlPreview: string[]
}

export interface DbImportRunInput {
  sessionKey: string
  table: TableRef
  csvText?: string
  /** 仅允许宿主 picker 选中的路径 */
  filePath?: string
  options?: {
    delimiter?: string
    hasHeader?: boolean
    columns?: string[]
    conflict?: 'insert' | 'upsert' | 'skip'
    sampleRows?: number
  }
  /** prod / 保护连接写入确认 */
  confirmed?: boolean
}

export interface DbImportRunResult {
  ok: boolean
  inserted: number
  failed: number
  errors?: string[]
  durationMs: number
}
