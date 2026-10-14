/** SSH / Database 插件宿主 API 共享类型（Spec docs/compose/spec/ssh-db-plugins.md） */

// —— Vault ——

export interface VaultSetResult {
  secretRef: string
}

// —— SSH ——

export type SshAuthType = 'password' | 'key' | 'agent' | 'keyboard-interactive'

/** Per-connection TCP transport. Only the first SSH hop uses this proxy. */
export interface SshProxyConfig {
  type: 'http-connect' | 'socks5'
  host: string
  port: number
  username?: string
  /** Proxy password is kept in the requesting plugin's vault. */
  secretRef?: string
  /** One-off test credential, never saved with the profile. */
  ephemeralSecret?: string
}

export interface SshJumpConfig {
  host: string
  port?: number
  username: string
  authType?: SshAuthType
  privateKeyHandleId?: string
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
  privateKeyHandleId?: string
  jump?: SshJumpConfig | null
  /** Explicit proxy; omitted means direct TCP, independent of shell HTTP proxy. */
  proxy?: SshProxyConfig
  /** Ordered jump chain, from the local-facing bastion to the target. Max 8. */
  jumps?: SshJumpConfig[]
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
  /** Current working directory from explicit shell integration (OSC 7). */
  cwd?: string
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
  privateKeyHandleId?: string
}

export interface SftpEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  size: number
  mtime: number
}

export interface SftpDownloadInput extends SftpListInput {
  remotePath?: string
  localDirectoryHandleId: string
}

export interface SftpUploadInput extends SftpListInput {
  localHandleId: string
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
  | { type: 'ssh.auth'; sessionId: string; challengeId: string; host: string; instructions: string; prompts: Array<{ prompt: string; echo: boolean }> }
  | { type: 'ssh.data'; sessionId: string; data: string }
  | { type: 'ssh.exit'; sessionId: string; code?: number | null; signal?: string }
  | { type: 'ssh.error'; sessionId?: string; message: string }
  | { type: 'ssh.metrics'; sessionId?: string; profileId?: string; sample: SshMetricsSample }

// —— Database ——

export type DbDriverId = 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'influxdb' | 'influxdb1' | 'influxdb3' | 'timescale' | 'tdengine' | 'mongodb' | 'redis' | 'clickhouse' | 'mssql' | 'duckdb' | 'oracle' | 'cassandra' | 'scylladb' | 'neo4j' | 'elasticsearch' | 'opensearch' | 'tidb' | 'oceanbase' | 'cockroachdb' | 'yugabytedb' | 'questdb' | 'doris' | 'starrocks'

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
  fileHandleId?: string
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
  transactionActive?: boolean
}

export interface DbExecuteInput {
  executionId?: string
  surface?: 'quick' | 'shell'
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
  editable?: boolean
  transactionActive?: boolean
  executionId?: string
  results?: QueryResult[]
  format?: 'table' | 'document' | 'key-value'
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
  type: 'database' | 'schema' | 'table' | 'view' | 'measurement' | 'supertable' | 'collection' | 'key' | 'column' | 'other'
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
  defaultValue?: unknown
  key?: string
  primaryKey?: boolean
  comment?: string
  pk?: boolean
}

export interface TableDetail {
  metadata?: Record<string, unknown>
  name?: string
  table?: string
  schema?: string
  database?: string
  columns: DbColumnMeta[]
  primaryKey?: string[]
  indexes?: Array<{ name: string; columns: string[]; unique?: boolean }>
  foreignKeys?: Array<{ name: string; columns: string[]; referencedTable: string; referencedSchema?: string; referencedColumns: string[] }>
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
    /** FK 元数据（可选，driver 提供时用于 JOIN ON 条件建议） */
    fks?: Array<{ column: string; refTable: string; refColumn: string }>
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
  /** 前缀/子序列匹配的区间（label 内 0-based，字符下标数组），供前端高亮 */
  matchRanges?: number[]
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
  /** Host-selected file capability, valid only in the current runtime. */
  fileHandleId?: string
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
  /** Host-selected file capability, valid only in the current runtime. */
  fileHandleId?: string
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
