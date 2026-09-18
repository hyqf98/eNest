/**
 * database/completion — SQL 上下文解析 + Catalog 缓存 + 补全建议（Spec DB-E）
 * 职责：解析 { sql, cursor } 的光标上下文，结合 CompletionCatalog 产出 CompletionResponse。
 *      Catalog 缓存 TTL 60s，key = sessionKey + database + schema。
 * 被 dbSessionManager.dbCompletion 调用；catalog 由各 driver 提供。
 * 关键依赖：@shared/types/ssh-db、@main/database/dialects。
 */
import type {
  CompletionCatalog,
  CompletionItem,
  CompletionResponse,
  DbCompletionInput
} from '@shared/types/ssh-db'
import { dialectFunctions, dialectKeywords, dialectSnippets, driverDialect } from '@main/database/dialects'
import type { DbDriverId } from '@shared/types/ssh-db'

const CATALOG_TTL_MS = 60_000

interface CacheEntry {
  catalog: CompletionCatalog
  ts: number
}

const catalogCache = new Map<string, CacheEntry>()

export function catalogCacheKey(sessionKey: string, database?: string, schema?: string): string {
  return `${sessionKey}\u0000${database ?? ''}\u0000${schema ?? ''}`
}

export function setCatalog(
  sessionKey: string,
  database: string | undefined,
  schema: string | undefined,
  catalog: CompletionCatalog
): void {
  catalogCache.set(catalogCacheKey(sessionKey, database, schema), {
    catalog,
    ts: Date.now()
  })
}

export function getCatalog(
  sessionKey: string,
  database?: string,
  schema?: string
): CompletionCatalog | null {
  const hit = catalogCache.get(catalogCacheKey(sessionKey, database, schema))
  if (!hit) return null
  if (Date.now() - hit.ts > CATALOG_TTL_MS) {
    catalogCache.delete(catalogCacheKey(sessionKey, database, schema))
    return null
  }
  return hit.catalog
}

/** DDL 检测后失效缓存（CREATE/ALTER/DROP/TRUNCATE） */
export function invalidateCatalog(sessionKey?: string): void {
  if (!sessionKey) {
    catalogCache.clear()
    return
  }
  for (const k of [...catalogCache.keys()]) {
    if (k.startsWith(`${sessionKey}\u0000`)) catalogCache.delete(k)
  }
}

export function isDdlSql(sql: string): boolean {
  return /^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/i.test(sql)
}

/** 是否为写/危险语句（readOnly 与 confirmed 策略用） */
export function isWriteSql(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|CALL|MERGE|UPSERT|COPY|LOAD)\b/i.test(
    sql
  )
}

/** 只读查询白名单前缀 */
export function isReadOnlySql(sql: string): boolean {
  return /^\s*(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC|PRAGMA|VALUES|TABLE)\b/i.test(sql)
}

// —— 词法：跳过字符串/注释，找到光标处标识符范围 ——

interface TokenSpan {
  from: number
  to: number
  text: string
}

/** 从 cursor 向前取当前标识符（含引号形态） */
export function identifierAtCursor(sql: string, cursor: number): TokenSpan {
  const pos = Math.max(0, Math.min(cursor, sql.length))
  let start = pos
  let end = pos
  const isIdent = (ch: string): boolean => /[\w$#\u4e00-\u9fff"`[\]]/.test(ch)
  // 反引号 / 双引号包裹
  const before = sql.slice(0, pos)
  if (before.endsWith('`') || before.endsWith('"')) {
    const q = before[before.length - 1]!
    const open = before.lastIndexOf(q, before.length - 2)
    if (open >= 0) {
      const closeIdx = sql.indexOf(q, pos)
      return { from: open, to: closeIdx >= 0 ? closeIdx + 1 : pos, text: sql.slice(open, closeIdx >= 0 ? closeIdx + 1 : pos) }
    }
  }
  while (start > 0 && isIdent(sql[start - 1]!)) start--
  while (end < sql.length && isIdent(sql[end]!)) end++
  return { from: start, to: end, text: sql.slice(start, end) }
}

/** 取光标前的「限定词.」前缀（alias. 或 table.） */
function qualifierBeforeCursor(sql: string, cursor: number): { qualifier: string; ident: TokenSpan } | null {
  const pos = Math.max(0, Math.min(cursor, sql.length))
  let i = pos
  while (i > 0 && /[\w$#\u4e00-\u9fff"`[\]]/.test(sql[i - 1]!)) i--
  // 跳过标识符后的空格检查点
  const identStart = i
  const ident = identifierAtCursor(sql, pos)
  // 标识符前应是 '.'
  if (identStart > 0 && sql[identStart - 1] === '.') {
    let qEnd = identStart - 1
    let qStart = qEnd
    while (qStart > 0 && /[\w$#\u4e00-\u9fff"`[\]]/.test(sql[qStart - 1]!)) qStart--
    const qualifier = sql.slice(qStart, qEnd)
    if (qualifier) return { qualifier, ident }
  }
  return null
}

/** 从当前语句中解析 FROM/JOIN 表与别名 */
export function extractTableAliases(statement: string): Array<{ table: string; alias: string; schema?: string }> {
  const results: Array<{ table: string; alias: string; schema?: string }> = []
  // 去掉字符串与注释，避免误匹配
  const cleaned = stripLiterals(statement)
  const re = /\b(?:FROM|JOIN)\s+((?:"[^"]+"|`[^`]+`|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[\w$#]+))?)\s*(?:AS\s+)?(`[^`]+`|"[^"]+"|[\w$#]+)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const rawTable = m[1] ?? ''
    const parts = rawTable.split('.').map((p) => p.replace(/["`]/g, '').trim())
    const table = parts[parts.length - 1] ?? ''
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined
    let alias = m[2]?.replace(/["`]/g, '') ?? ''
    // 别名不能是关键字
    if (alias && /^(WHERE|GROUP|ORDER|LIMIT|ON|LEFT|RIGHT|INNER|OUTER|CROSS|JOIN|HAVING|UNION|SET)$/i.test(alias)) {
      alias = ''
    }
    results.push({ table, alias: alias || table, schema })
  }
  return results
}

function stripLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i++
      while (i < sql.length && sql[i] !== q) i++
      i++
      out += ' '
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 提取当前语句（光标所在，分号切分但忽略字符串内分号） */
export function currentStatement(sql: string, cursor: number): { text: string; start: number; end: number } {
  const pos = Math.max(0, Math.min(cursor, sql.length))
  const start = findSemiBoundary(sql, pos, -1)
  const end = findSemiBoundary(sql, pos, 1)
  return { text: sql.slice(start, end), start, end }
}

function findSemiBoundary(sql: string, pos: number, dir: -1 | 1): number {
  let i = pos
  let inStr: string | null = null
  // 向前或向后扫描未闭合引号外的分号
  if (dir < 0) {
    for (i = pos; i > 0; i--) {
      const ch = sql[i - 1]!
      if (inStr) {
        if (ch === inStr) inStr = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inStr = ch
        continue
      }
      if (ch === ';') return i
    }
    return 0
  }
  inStr = null
  for (i = pos; i < sql.length; i++) {
    const ch = sql[i]!
    if (inStr) {
      if (ch === inStr && sql[i - 1] !== '\\') inStr = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === ';') return i
  }
  return sql.length
}

export type CompletionContext =
  | 'stmt_start'
  | 'select_list'
  | 'from_item'
  | 'join_on'
  | 'where'
  | 'group_order_having'
  | 'qualified'
  | 'alias_suggest'
  | 'unknown'

export function detectContext(statement: string, cursorInStmt: number): {
  context: CompletionContext
  qualifier?: string
  prefix: string
} {
  const before = statement.slice(0, cursorInStmt)
  const cleanedBefore = stripLiterals(before)
  const q = qualifierBeforeCursor(statement, cursorInStmt)
  if (q && q.qualifier) {
    return { context: 'qualified', qualifier: q.qualifier, prefix: q.ident.text }
  }
  // FROM / JOIN 后
  if (/(?:FROM|JOIN)\s+[`"\w$#.\s]*$/i.test(cleanedBefore) && !/\bON\b/i.test(cleanedBefore.split(/\bFROM\b|\bJOIN\b/i).pop() ?? '')) {
    return { context: 'from_item', prefix: q?.ident.text ?? lastWord(cleanedBefore) }
  }
  // AS 之后建议别名
  if (/\b(?:FROM|JOIN)\s+\S+\s+(?:AS\s+)?$/i.test(cleanedBefore)) {
    return { context: 'alias_suggest', prefix: '' }
  }
  if (/\bON\s+$/i.test(cleanedBefore) || /\bON\s+[\w.]*$/i.test(cleanedBefore)) {
    return { context: 'join_on', prefix: q?.ident.text ?? lastWord(cleanedBefore) }
  }
  if (/\bWHERE\s+[\w\s.`"']*(?:AND|OR)?\s*$/i.test(cleanedBefore) && /\bWHERE\b/i.test(cleanedBefore)) {
    return { context: 'where', prefix: q?.ident.text ?? lastWord(cleanedBefore) }
  }
  if (/\b(GROUP|ORDER|HAVING)\s+(BY\s+)?[\w.`]*$/i.test(cleanedBefore)) {
    return { context: 'group_order_having', prefix: q?.ident.text ?? lastWord(cleanedBefore) }
  }
  const selectIdx = cleanedBefore.search(/\bSELECT\b/i)
  const fromIdx = cleanedBefore.search(/\bFROM\b/i)
  if (selectIdx >= 0 && (fromIdx < 0 || fromIdx < selectIdx)) {
    return { context: 'select_list', prefix: q?.ident.text ?? lastWord(cleanedBefore) }
  }
  if (/^\s*(?:[;\s]|$)/.test(cleanedBefore) || /;\s*[\w]*$/.test(cleanedBefore)) {
    return { context: 'stmt_start', prefix: lastWord(cleanedBefore) }
  }
  return { context: 'unknown', prefix: lastWord(cleanedBefore) }
}

function lastWord(s: string): string {
  const m = /([\w$#`"\u4e00-\u9fff]*)$/.exec(s)
  return m?.[1] ?? ''
}

function sortKey(boost: number, label: string): string {
  // boost 越大越靠前；字典序兜底
  const pad = String(Math.max(0, 999 - boost)).padStart(3, '0')
  return `${pad}_${label.toLowerCase()}`
}

function makeItem(
  partial: Omit<CompletionItem, 'sortText'> & { boost?: number; usage?: Record<string, number> }
): CompletionItem {
  const { boost, usage, ...rest } = partial
  const usageBoost = usage?.[rest.label] ?? usage?.[`${rest.owner}.${rest.label}`] ?? 0
  return {
    ...rest,
    sortText: sortKey((boost ?? 0) + usageBoost, rest.label)
  }
}

export interface CompletionBuildContext {
  input: DbCompletionInput
  driverId: DbDriverId
  catalog: CompletionCatalog | null
}

export function buildCompletion({ input, driverId, catalog }: CompletionBuildContext): CompletionResponse {
  const sql = String(input.sql ?? '')
  const cursor = typeof input.cursor === 'number' && Number.isFinite(input.cursor) ? input.cursor : sql.length
  const stmt = currentStatement(sql, cursor)
  const cursorInStmt = Math.max(0, Math.min(cursor - stmt.start, stmt.text.length))
  const { context, qualifier, prefix } = detectContext(stmt.text, cursorInStmt)
  const dialect = driverDialect(driverId)
  const keywords = catalog?.keywords?.length ? catalog.keywords : dialectKeywords(dialect)
  const functions = catalog?.functions?.length ? catalog.functions : dialectFunctions(dialect)
  const snippets = dialectSnippets(dialect)
  const usage = input.usageBoost ?? catalog?.usageBoost
  const ident = identifierAtCursor(sql, cursor)
  const prefixLower = (prefix || ident.text).toLowerCase().replace(/["`]/g, '')
  const items: CompletionItem[] = []
  const tables = catalog?.tables ?? []
  const aliases = extractTableAliases(stmt.text)

  const matches = (label: string): boolean =>
    !prefixLower || label.toLowerCase().replace(/["`]/g, '').startsWith(prefixLower)

  const quoteIdent = (name: string): string => {
    if (/^[a-z_][a-z0-9_]*$/i.test(name)) return name
    return `\`${name.replace(/`/g, '')}\``
  }

  // qualified：alias. 或 table. → 该表列；库/schema → 子对象
  if (context === 'qualified' && qualifier) {
    const q = qualifier.toLowerCase().replace(/["`]/g, '')
    const aliasHit = aliases.find((a) => a.alias.toLowerCase() === q || a.table.toLowerCase() === q)
    const tableName = aliasHit?.table ?? q
    const schemaName = aliasHit?.schema
    const tableHit =
      tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase() && (!schemaName || !t.schema || t.schema === schemaName)) ??
      tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase())
    if (tableHit) {
      for (const col of tableHit.columns) {
        if (!matches(col.name)) continue
        items.push(
          makeItem({
            label: `${aliasHit?.alias || tableHit.name}.${quoteIdent(col.name)}`,
            kind: 'column',
            detail: col.type ?? '',
            doc: col.comment,
            insertText: quoteIdent(col.name),
            owner: tableHit.name,
            boost: col.pk ? 90 : 70,
            usage
          })
        )
      }
    }
    // 库名 / schema 名下的表
    const asDb = catalog?.databases?.find((d) => d.toLowerCase() === q)
    const asSchema = catalog?.schemas?.find((s) => s.toLowerCase() === q)
    if (asDb || asSchema) {
      for (const t of tables) {
        if (!matches(t.name)) continue
        items.push(
          makeItem({
            label: t.name,
            kind: t.type === 'view' ? 'view' : 'table',
            detail: t.schema ?? asDb ?? '',
            insertText: quoteIdent(t.name),
            boost: 80,
            usage
          })
        )
      }
    }
  } else if (context === 'from_item' || context === 'alias_suggest') {
    if (context === 'alias_suggest') {
      for (const [i, a] of aliases.entries()) {
        if (!a.alias) continue
        const suggest = `${a.alias[0]}${i + 1}`
        items.push(
          makeItem({
            label: suggest,
            kind: 'alias',
            detail: a.table,
            insertText: suggest,
            boost: 85
          })
        )
      }
      items.push(makeItem({ label: 't1', kind: 'alias', insertText: 't1', boost: 40 }))
      items.push(makeItem({ label: 'a', kind: 'alias', insertText: 'a', boost: 30 }))
    } else {
      // 表 / 视图 / 测量；当前库优先
      for (const d of catalog?.databases ?? []) {
        if (!matches(d)) continue
        items.push(
          makeItem({ label: d, kind: 'database', insertText: quoteIdent(d), boost: 50, usage })
        )
      }
      for (const t of tables) {
        if (!matches(t.name)) continue
        items.push(
          makeItem({
            label: t.schema ? `${t.schema}.${t.name}` : t.name,
            kind: t.type === 'view' ? 'view' : t.type === 'measurement' ? 'measurement' : 'table',
            detail: t.comment ?? t.type,
            insertText: quoteIdent(t.name),
            boost: t.type === 'table' ? 80 : 70,
            usage
          })
        )
      }
    }
  } else {
    // select_list / where / group_order_having / join_on / stmt_start / unknown
    const useAliasPrefix = context === 'select_list' && aliases.length > 1
    const pushColumns = (boostBase: number) => {
      const fromTables = aliases
      if (fromTables.length === 0) {
        for (const t of tables) {
          for (const col of t.columns) {
            if (!matches(col.name)) continue
            items.push(
              makeItem({
                label: col.name,
                kind: 'column',
                detail: `${t.name}.${col.type ?? ''}`,
                doc: col.comment,
                insertText: quoteIdent(col.name),
                owner: t.name,
                boost: boostBase + (col.pk ? 10 : 0),
                usage
              })
            )
          }
        }
        return
      }
      for (const a of fromTables) {
        const t = tables.find((x) => x.name.toLowerCase() === a.table.toLowerCase())
        if (!t) continue
        for (const col of t.columns) {
          const display = useAliasPrefix ? `${a.alias}.${quoteIdent(col.name)}` : col.name
          if (prefixLower && !display.toLowerCase().startsWith(prefixLower) && !col.name.toLowerCase().startsWith(prefixLower)) {
            continue
          }
          items.push(
            makeItem({
              label: display,
              kind: 'column',
              detail: `${t.name}${col.type ? ` · ${col.type}` : ''}`,
              doc: col.comment,
              insertText: display,
              owner: t.name,
              boost: boostBase + (col.pk ? 15 : 0) + (aliases.length > 1 ? 5 : 0),
              usage
            })
          )
        }
      }
    }

    if (context === 'select_list') {
      pushColumns(75)
      items.push(makeItem({ label: '*', kind: 'column', detail: '全部列', insertText: '*', boost: 40 }))
    } else if (context === 'where' || context === 'join_on' || context === 'group_order_having') {
      pushColumns(80)
    }

    if (context === 'stmt_start' || context === 'unknown' || context === 'select_list' || context === 'where') {
      for (const fn of functions ?? []) {
        if (!matches(fn.name)) continue
        items.push(
          makeItem({
            label: fn.name,
            kind: 'function',
            detail: fn.signature,
            doc: fn.doc,
            insertText: context === 'select_list' || context === 'where' ? `${fn.name}(` : fn.name,
            boost: context === 'select_list' || context === 'where' ? 60 : 50,
            usage
          })
        )
      }
      for (const kw of keywords ?? []) {
        if (!matches(kw)) continue
        items.push(
          makeItem({
            label: kw,
            kind: 'keyword',
            insertText: kw,
            boost: context === 'stmt_start' ? 30 : 10
          })
        )
      }
      for (const sn of snippets ?? []) {
        const snPrefix = sn.prefix ?? sn.name ?? ''
        const snBody = sn.body ?? sn.sql ?? sn.text ?? ''
        if (
          prefixLower &&
          !snPrefix.toLowerCase().startsWith(prefixLower) &&
          !snBody.toLowerCase().includes(prefixLower)
        )
          continue
        items.push(
          makeItem({
            label: snPrefix || snBody.slice(0, 20),
            kind: 'snippet',
            detail: sn.detail ?? sn.label,
            doc: snBody,
            insertText: snBody,
            boost: context === 'stmt_start' ? 70 : 20
          })
        )
      }
    }

    // 无别名且多表：补全时带 owner detail（已在 pushColumns 处理 display）
  }

  // Catalog 未就绪时仍返回关键字+片段（E10 静态回退已在上方关键字路径覆盖）
  const seen = new Set<string>()
  const unique = items.filter((it) => {
    const k = `${it.kind}:${it.label}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  unique.sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0))

  return {
    replace: { from: ident.from, to: ident.to },
    items: unique.slice(0, 200),
    isIncomplete: unique.length > 200
  }
}
