import { assertValidScript, maskSql, planSqlScript } from '@main/database/sqlScript'

/** Strings, quoted identifiers and comments never become executable commands. */
export function sqlTokens(sql: string, keepIdentifiers = false, dialect = 'generic'): string {
  return maskSql(sql, dialect, keepIdentifiers)
}

export function splitSql(sql: string, dialect = 'generic'): string[] {
  const plan = planSqlScript(sql, dialect)
  assertValidScript(plan)
  return plan.filter(unit => unit.kind !== 'directive').map(unit => unit.sql)
}

export function isReadQuery(sql: string, dialect = 'generic'): boolean {
  const statements = splitSql(sql, dialect)
  if (!statements.length) return false
  return statements.every(statement => {
    const text = sqlTokens(statement, true, dialect).trim()
    // A SQL Server request can contain several statements in a single GO batch.
    if (!sqlTokens(statement, false, dialect).split(';').filter(part => part.trim()).every(part => /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES|PRAGMA)\b/i.test(part.trim()))) return false
    if (/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|COPY|LOAD|ATTACH|DETACH|VACUUM|INTO|LOCK|UNLOCK|NEXTVAL|SETVAL|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_LOG_BACKEND_MEMORY_CONTEXTS|PG_NOTIFY|DBLINK_EXEC|LO_IMPORT|LO_EXPORT|PG_READ_FILE|PG_WRITE_FILE|SYS_EXEC|SYS_EVAL|GET_LOCK|RELEASE_LOCK)\b/i.test(text)) return false
    if (/^PRAGMA\b/i.test(text) && !/^PRAGMA\s+(?:\w+\.)?(table_info|table_xinfo|index_list|index_info|index_xinfo|foreign_key_list|database_list|page_count|page_size|freelist_count|compile_options|integrity_check|quick_check)\b/i.test(text)) return false
    return true
  })
}

export function normalizeLimit(value?: number, quick = false): number {
  const n = Number.isFinite(value) ? Math.floor(value!) : (quick ? 200 : 1000)
  return Math.max(1, Math.min(quick ? 200 : 10000, n))
}

/** Wire representation preserves integer/decimal precision and avoids IPC BigInt JSON failures. */
export function wireValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(wireValue)
  if (value && typeof value === 'object') {
    if ('toExtendedJSON' in value && typeof value.toExtendedJSON === 'function') return wireValue(value.toExtendedJSON())
    if ('toJSON' in value && typeof value.toJSON === 'function') return wireValue(value.toJSON())
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wireValue(v)]))
  }
  return value
}

export function quoteIdentifier(name: string, flavor = 'postgres'): string {
  if (!name || name.includes('\0')) throw new Error('Invalid database identifier')
  const q = flavor === 'mysql' ? '`' : '"'
  return q + name.replaceAll(q, q + q) + q
}

export class ResultBudget {
  private bytes = 0
  constructor(private readonly maximum = 6 * 1024 * 1024) {}
  add(row: unknown): void {
    this.bytes += Buffer.byteLength(JSON.stringify(row, (_, value) => typeof value === 'bigint' ? value.toString() : value) || '')
    if (this.bytes > this.maximum) throw new Error('Result exceeds 6 MiB; select fewer columns or narrow the query')
  }
}
