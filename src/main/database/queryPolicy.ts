/** Pure SQL boundary/security helpers. Strings, quoted identifiers and comments never become commands. */
export function sqlTokens(sql: string, keepIdentifiers = false): string {
  let out = '', i = 0
  while (i < sql.length) {
    const c = sql[i]!, n = sql[i + 1]
    if (c === '-' && n === '-' || c === '#') {
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && n === '*') {
      if (sql[i + 2] === '!') throw new Error('Executable SQL comments are not accepted; use explicit statements')
      i += 2; out += '  '; let depth = 1
      while (i < sql.length && depth) {
        if (sql.slice(i, i + 2) === '/*') { depth++; i += 2; out += '  ' }
        else if (sql.slice(i, i + 2) === '*/') { depth--; i += 2; out += '  ' }
        else { out += ' '; i++ }
      }
      if (depth) throw new Error('Unterminated SQL comment')
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const q = c === '[' ? ']' : c, identifier = keepIdentifiers && c !== "'"; out += ' '; i++; let closed = false
      while (i < sql.length) {
        if (sql[i] === '\\') { out += '  '; i += 2; continue }
        if (sql[i] === q) {
          if (sql[i + 1] === q) { out += '  '; i += 2; continue }
          out += ' '; i++; closed = true; break
        }
        out += identifier ? sql[i] : ' '; i++
      }
      if (!closed) throw new Error('Unterminated SQL quoted value')
    } else if (c === '$' && /^\$[a-zA-Z_0-9]*\$/.test(sql.slice(i))) {
      const tag = /^\$[a-zA-Z_0-9]*\$/.exec(sql.slice(i))![0]
      const end = sql.indexOf(tag, i + tag.length)
      if (end < 0) throw new Error('Unterminated dollar-quoted SQL value')
      const length = end + tag.length - i; out += ' '.repeat(length); i += length
    } else { out += c; i++ }
  }
  return out
}

export function splitSql(sql: string): string[] {
  const tokens = sqlTokens(sql), statements: string[] = []; let start = 0
  for (let i = 0; i <= tokens.length; i++) {
    if (i === tokens.length || tokens[i] === ';') {
      if (tokens.slice(start, i).trim()) statements.push(sql.slice(start, i).trim())
      start = i + 1
    }
  }
  return statements
}

export function isReadQuery(sql: string): boolean {
  const statements = splitSql(sql)
  if (!statements.length) return false
  return statements.every((statement) => {
    const text = sqlTokens(statement, true).trim()
    if (!/^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES|PRAGMA)\b/i.test(text)) return false
    if (/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|COPY|LOAD|ATTACH|DETACH|VACUUM|INTO|LOCK|UNLOCK|NEXTVAL|SETVAL|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_LOG_BACKEND_MEMORY_CONTEXTS|PG_NOTIFY|DBLINK_EXEC|LO_IMPORT|LO_EXPORT|PG_READ_FILE|PG_WRITE_FILE|SYS_EXEC|SYS_EVAL|GET_LOCK|RELEASE_LOCK)\b/i.test(text)) return false
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
