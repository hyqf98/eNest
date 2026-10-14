import type { HostDbConnectionConfig as DbConnectionConfig } from '@main/database/hostDbConfig'
/** Database driver contract and lazy native adapter registry. Runs only in dbUtility. */
import type {
  BatchResult,
  CompletionCatalog,
  DbDriverId,
  DbTestResult,
  QueryResult,
  RowChange,
  SchemaObject,
  TableDetail
} from '@shared/types/ssh-db'
import { DIALECT_INFO } from '@main/database/dialects'
import { adapterBase } from '@main/database/adapterUtils'
import { upgradeMysql, upgradePostgres } from '@main/database/relationalRuntime'
import { sqliteAdapter } from '@main/database/sqliteRuntime'
import { mongoAdapter, redisAdapter, cassandraAdapter, neo4jAdapter } from '@main/database/documentAdapters'
import { influxAdapter, tdengineAdapter, searchAdapter } from '@main/database/httpAdapters'
import { duckdbAdapter, oracleAdapter, mssqlAdapter, clickhouseAdapter } from '@main/database/additionalSqlAdapters'
import { COMPATIBILITY_ENGINES } from '@main/database/driverCatalog'
import { attachRowEditing } from '@main/database/rowChanges'

export const DEFAULT_MAX_ROWS = 1000

export interface DriverHandle {
  id: DbDriverId
  /** mysql2 pool / pg Client / DatabaseSync / null for http */
  raw: unknown
  config: DbConnectionConfig
  readOnly: boolean
  password?: string
  database?: string
  runtime?: Record<string, unknown>
  closed?: boolean
  controller?: AbortController
}

export interface DriverExecuteOptions {
  maxRows?: number
  timeoutMs?: number
  params?: unknown[] | Record<string, unknown>
  signal?: AbortSignal
  executionId?: string
}

export interface DbDriver {
  id: DbDriverId
  label: string
  dialect: string
  defaultPort?: number
  capabilities: {
    multiStatement: boolean
    explain: boolean
    schemas: boolean
    timeSeries: boolean
    fileBased: boolean
    updatableResult: boolean
    ddl: boolean
    import: boolean
  }
  test(config: DbConnectionConfig, password?: string): Promise<DbTestResult>
  open(config: DbConnectionConfig, password?: string): Promise<DriverHandle>
  close(h: DriverHandle): Promise<void>
  execute(
    h: DriverHandle,
    sql: string,
    opts?: DriverExecuteOptions
  ): Promise<QueryResult>
  cancel?(h: DriverHandle, executionId?: string): Promise<boolean>
  transaction?(h: DriverHandle, operation: 'begin' | 'commit' | 'rollback'): Promise<void>
  explain?(h: DriverHandle, sql: string): Promise<QueryResult>
  listDatabases(h: DriverHandle): Promise<string[]>
  listSchemas(h: DriverHandle, database?: string): Promise<string[]>
  listTables(h: DriverHandle, scope: { database?: string; schema?: string }): Promise<SchemaObject[]>
  describeTable(
    h: DriverHandle,
    scope: { database?: string; schema?: string },
    table: string
  ): Promise<TableDetail>
  getDdl?(h: DriverHandle, scope: { database?: string; schema?: string }, table: string): Promise<string>
  completionCatalog(
    h: DriverHandle,
    scope: { database?: string; schema?: string }
  ): Promise<CompletionCatalog>
  applyBatch?(h: DriverHandle, changes: RowChange[], mode: 'stop-on-error' | 'continue'): Promise<BatchResult>
}

// —— Registry ——

function relationalBase(id: 'mysql' | 'postgres' | 'timescale', label: string, dialect: string, port: number): DbDriver {
  const driver = adapterBase(id, label, dialect, port)
  driver.capabilities = { ...driver.capabilities, multiStatement: true, explain: true, schemas: id !== 'mysql', timeSeries: id === 'timescale', updatableResult: true, ddl: true, import: true }
  return driver
}
const mysqlRuntimeDriver = upgradeMysql(relationalBase('mysql', 'MySQL', 'mysql', 3306))
const postgresRuntimeDriver = upgradePostgres(relationalBase('postgres', 'PostgreSQL', 'postgres', 5432))
export const DRIVER_REGISTRY: Partial<Record<DbDriverId, DbDriver>> = {
  mysql: mysqlRuntimeDriver, postgres: postgresRuntimeDriver,
  timescale: upgradePostgres(relationalBase('timescale', 'TimescaleDB', 'postgres', 5432)), sqlite: sqliteAdapter(),
  influxdb: influxAdapter('influxdb'), influxdb1: influxAdapter('influxdb1'), influxdb3: influxAdapter('influxdb3'),
  tdengine: tdengineAdapter(), mongodb: mongoAdapter(), redis: redisAdapter(),
  cassandra: cassandraAdapter(), scylladb: cassandraAdapter('scylladb'), neo4j: neo4jAdapter(), duckdb: duckdbAdapter(), oracle: oracleAdapter(),
  mssql: mssqlAdapter(), clickhouse: clickhouseAdapter(), elasticsearch: searchAdapter('elasticsearch'), opensearch: searchAdapter('opensearch')
}
for (const id of ['mysql', 'postgres', 'timescale', 'sqlite'] as const) attachRowEditing(DRIVER_REGISTRY[id]!, id === 'mysql' ? 'mysql' : id === 'sqlite' ? 'sqlite' : 'postgres')
for (const [id, descriptor] of Object.entries(COMPATIBILITY_ENGINES)) {
  const base = descriptor.base === 'mysql' ? mysqlRuntimeDriver : postgresRuntimeDriver
  const limited = ['doris', 'starrocks', 'questdb'].includes(id)
  const compatible: DbDriver = { ...base, id: id as DbDriverId, label: descriptor.label, defaultPort: descriptor.port,
    open: (config, password) => base.open({ ...config, port: config.port ?? descriptor.port }, password),
    capabilities: { ...base.capabilities, updatableResult: !limited && base.capabilities.updatableResult, import: !limited && base.capabilities.import } }
  if (limited) { compatible.transaction = undefined; compatible.applyBatch = undefined }
  DRIVER_REGISTRY[id as DbDriverId] = compatible
}
for (const driver of Object.values(DRIVER_REGISTRY)) {
  driver.test = async (config, password) => {
    const started = Date.now(); let handle: DriverHandle | undefined
    try { handle = await driver.open(config, password); return { ok: true, message: 'Connected', latencyMs: Date.now() - started } }
    catch (error) { return { ok: false, message: (error as Error).message, latencyMs: Date.now() - started } }
    finally { if (handle) await driver.close(handle).catch(() => undefined) }
  }
  const original = (DIALECT_INFO[driver.id]?.dialect === driver.dialect ? DIALECT_INFO[driver.id] : undefined) || Object.values(DIALECT_INFO).find(d => d.dialect === driver.dialect)
  DIALECT_INFO[driver.id] = { ...original, functions: driver.dialect === 'postgres' && driver.id !== 'timescale' ? original?.functions?.filter(fn => fn.name !== 'time_bucket') : original?.functions, id: driver.id, label: driver.label, dialect: driver.dialect, defaultPort: driver.defaultPort, capabilities: driver.capabilities }
}

export function getDriver(id: string): DbDriver {
  const d = DRIVER_REGISTRY[id as DbDriverId]
  if (!d) throw new Error(`unknown db driver: ${id}`)
  return d
}
