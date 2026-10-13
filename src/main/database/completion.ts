/**
 * database/completion — SQL 上下文解析 + Catalog 缓存 + 补全建议（Spec DB-E）
 * 职责：解析 { sql, cursor } 的光标上下文，结合 CompletionCatalog 产出 CompletionResponse。
 *      Catalog 缓存 TTL 60s，key = sessionKey + database + schema。
 * 增强（IDEA DataGrip 式）：
 *   - CTE（WITH x AS (...)）与派生表（FROM (SELECT...) t）虚拟表：列从内层 SELECT 推导
 *   - INSERT INTO t (…) 建议尚未列出的列；UPDATE … SET 建议未赋值列
 *   - JOIN ON 同名列 / 后缀关联（user_id↔id）/ FK 元数据（driver 提供时）的完整条件建议
 *   - 子序列模糊匹配（精确 > 前缀 > 子序列），matchRanges 供前端高亮
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

// —— 结构中和：字符串/注释内容替换为等长空格，保持与原文偏移一致 ——

/**
 * 与原文等长：'…' / "…" / `…` 字符串与 -- 注释、块注释的内容全部替换为空格。
 * 后续所有结构解析（正则/括号匹配/列名截取）都基于 neutralize 后的文本，
 * 截取名字时用相同偏移回原文 slice。
 */
export function neutralize(sql: string): string {
  const chars = sql.split('')
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i++
      while (i < chars.length) {
        if (chars[i] === '\\' && q !== '`') {
          chars[i] = ' '
          if (i + 1 < chars.length) chars[i + 1] = ' '
          i += 2
          continue
        }
        if (chars[i] === q) break
        chars[i] = ' '
        i++
      }
      i++
      continue
    }
    if (ch === '-' && chars[i + 1] === '-') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' '
        i++
      }
      continue
    }
    if (ch === '/' && chars[i + 1] === '*') {
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        chars[i] = ' '
        i++
      }
      if (i < chars.length) {
        chars[i] = ' '
        chars[i + 1] = ' '
        i += 2
      }
      continue
    }
    i++
  }
  return chars.join('')
}

/** 兼容旧调用：剥离字符串/注释（不再用于需要偏移的解析） */
function stripLiterals(sql: string): string {
  return neutralize(sql)
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

export interface TableAliasInfo {
  table: string
  alias: string
  schema?: string
  /** FROM/JOIN 关键字在语句中的起始偏移（用于 JOIN ON 只取光标前的表） */
  index?: number
}

const FROM_JOIN_RE = () => /\b(FROM|JOIN)\s+((?:"[^"]*"|`[^`]+`|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[\w$#]+))?|(\())\s*(?:AS\s+)?(`[^`]+`|"[^"]+"|[\w$#]+)?/gi

/** 从当前语句中解析 FROM/JOIN 表与别名（含派生表 `(...) alias`，table 记为 '(subquery)'） */
export function extractTableAliases(statement: string): Array<TableAliasInfo> {
  const results: Array<TableAliasInfo> = []
  const zoned = neutralize(statement)
  const re = FROM_JOIN_RE()
  let m: RegExpExecArray | null
  while ((m = re.exec(zoned)) !== null) {
    const kwIndex = m.index
    const isParen = m[3] === '('
    let alias = m[4]?.replace(/["`]/g, '') ?? ''
    if (alias && /^(WHERE|GROUP|ORDER|LIMIT|ON|LEFT|RIGHT|INNER|OUTER|CROSS|JOIN|HAVING|UNION|SET|VALUES|AS|USING|WINDOW|FULL)$/i.test(alias)) {
      alias = ''
    }
    if (isParen) {
      // 派生表：别名后置才合法；无别名时跳过
      if (!alias) continue
      results.push({ table: '(subquery)', alias, index: kwIndex })
      continue
    }
    const rawTable = m[2] ?? ''
    const parts = rawTable.split('.').map((p) => p.replace(/["`]/g, '').trim())
    const table = parts[parts.length - 1] ?? ''
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined
    results.push({ table, alias: alias || table, schema, index: kwIndex })
  }
  return results
}

/** 括号匹配：openIdx 指向 '('，返回对应 ')' 下标（字符串/注释已中和的文本上运算） */
function matchParen(zoned: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < zoned.length; i++) {
    if (zoned[i] === '(') depth++
    else if (zoned[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
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

// —— CTE / 派生表虚拟表解析 ——

export interface VirtualColumn {
  name: string
  type?: string
  comment?: string
  pk?: boolean
}

export interface VirtualTable {
  name: string
  kind: 'cte' | 'derived'
  columns: VirtualColumn[]
}

/**
 * 解析语句中的 CTE（WITH x AS (SELECT ...)）与派生表（FROM (SELECT ...) t）。
 * 列名从子查询最外层 SELECT 列表推导：别名 > t.col 的 col > 函数名 > 首个标识符。
 * `SELECT *` 且内层 FROM 是单表时，可用 catalog 展开为真实列（resolveColumns 回调）。
 */
export function parseVirtualTables(
  statement: string,
  resolveColumns?: (table: string, schema?: string) => VirtualColumn[] | null
): Map<string, VirtualTable> {
  const zoned = neutralize(statement)
  const out = new Map<string, VirtualTable>()
  const put = (vt: VirtualTable): void => {
    if (vt.columns.length || vt.kind === 'cte') out.set(vt.name.toLowerCase(), vt)
  }

  // CTE：WITH [RECURSIVE] name AS ( ... ) [, name AS ( ... )]*
  const withM = /^\s*WITH\s+(?:RECURSIVE\s+)?/i.exec(zoned)
  if (withM) {
    let i = withM[0].length
    for (let guard = 0; guard < 32; guard++) {
      // name
      const idM = /^[\s]*([\w$#]+)/.exec(zoned.slice(i))
      if (!idM) break
      const name = idM[1]!
      i += idM[0].length
      // AS
      const asM = /^\s*AS\b/.exec(zoned.slice(i))
      if (!asM) break
      i += asM[0].length
      // ( body )
      const open = zoned.indexOf('(', i)
      if (open < 0) break
      const close = matchParen(zoned, open)
      if (close < 0) break
      const body = statement.slice(open + 1, close)
      put({ name, kind: 'cte', columns: deriveSelectColumns(body, resolveColumns, 0) })
      i = close + 1
      const commaM = /^\s*,/.exec(zoned.slice(i))
      if (!commaM) break
      i += commaM[0].length
    }
  }

  // 派生表：FROM/JOIN ( SELECT ... ) alias
  const re = FROM_JOIN_RE()
  let m: RegExpExecArray | null
  while ((m = re.exec(zoned)) !== null) {
    if (m[3] !== '(') continue
    const alias = m[4]?.replace(/["`]/g, '') ?? ''
    if (!alias) continue
    // m[2] 以 '(' 开头，其偏移在 FROM/JOIN 关键字之后
    const parenOffset = zoned.indexOf('(', m.index)
    const close = matchParen(zoned, parenOffset)
    if (close < 0) continue
    const body = statement.slice(parenOffset + 1, close)
    put({ name: alias, kind: 'derived', columns: deriveSelectColumns(body, resolveColumns, 0) })
  }
  return out
}

/** 从子查询文本推导最外层 SELECT 列表（depth 防递归失控） */
function deriveSelectColumns(
  body: string,
  resolveColumns: ((table: string, schema?: string) => VirtualColumn[] | null) | undefined,
  depth: number
): VirtualColumn[] {
  if (depth > 4) return []
  const zoned = neutralize(body)
  const selM = /\bSELECT\b/i.exec(zoned)
  if (!selM) return []
  let fromIdx = -1
  {
    const fm = /\bFROM\b/i.exec(zoned.slice(selM.index + 6))
    fromIdx = fm ? selM.index + 6 + fm.index : zoned.length
  }
  const listText = zoned.slice(selM.index + 6, fromIdx)
  const rawText = body.slice(selM.index + 6, fromIdx)
  const cols: VirtualColumn[] = []
  // 顶层逗号切分
  const items = splitTopLevel(listText)
  for (const { start, end } of items) {
    const segZ = listText.slice(start, end)
    const seg = rawText.slice(start, end)
    const trimmed = segZ.trim()
    if (!trimmed) continue
    // expr AS alias
    const asM = /^(.*?)\bAS\s+([\w$#]+)\s*$/i.exec(trimmed)
    if (asM && asM[2]) {
      cols.push({ name: asM[2] })
      continue
    }
    // t.col → col
    const dotM = /^(?:[\w$#]+|"([^"]+)"|`([^`]+)`)\s*\.\s*([\w$#]+|"([^"]+)"|`([^`]+)`)$/.exec(trimmed)
    if (dotM) {
      const col = dotM[3] || dotM[4] || dotM[5]
      if (col && col !== '*') cols.push({ name: col })
      continue
    }
    // t.* → 用内层 FROM 单表展开
    const starM = /^([\w$#]+)\s*\.\s*\*$/.exec(trimmed)
    if (starM && resolveColumns && depth < 4) {
      const t = resolveColumns(starM[1]!)
      if (t) cols.push(...t)
      continue
    }
    // 纯 *：尝试内层 FROM 单表展开
    if (trimmed === '*' && resolveColumns && depth < 4) {
      const inner = singleFromTable(zoned.slice(fromIdx))
      if (inner) {
        const t = resolveColumns(inner.table, inner.schema)
        if (t) {
          cols.push(...t)
          continue
        }
      }
      continue
    }
    // 函数调用 → 函数名
    const fnM = /^([\w$#]+)\s*\(/.exec(trimmed)
    if (fnM) {
      cols.push({ name: fnM[1]!.toLowerCase() === 'count' ? 'count' : fnM[1]! })
      continue
    }
    // 裸标识符
    const idM = /^([\w$#]+)$/.exec(trimmed)
    if (idM) {
      cols.push({ name: idM[1]! })
      continue
    }
    // 兜底：首个标识符
    const first = /^([\w$#]+)/.exec(trimmed)
    if (first) cols.push({ name: first[1]! })
  }
  return cols
}

/** 顶层逗号切分（忽略括号内逗号），返回原文偏移区间 */
function splitTopLevel(text: string): Array<{ start: number; end: number }> {
  const parts: Array<{ start: number; end: number }> = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      parts.push({ start, end: i })
      start = i + 1
    }
  }
  parts.push({ start, end: text.length })
  return parts
}

/** 从 FROM 子句文本中取首个表名（供 SELECT * 展开回退） */
function singleFromTable(fromClause: string): { table: string; schema?: string } | null {
  const m = /\b(?:FROM|JOIN)\s+((?:"[^"]+"|`[^`]+`|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[\w$#]+))?)/i.exec(fromClause)
  if (!m) return null
  const parts = (m[1] ?? '').split('.').map((p) => p.replace(/["`]/g, '').trim())
  const table = parts[parts.length - 1] ?? ''
  if (!table) return null
  return { table, schema: parts.length > 1 ? parts[parts.length - 2] : undefined }
}

// —— 上下文检测 ——

export type CompletionContext =
  | 'stmt_start'
  | 'select_list'
  | 'from_item'
  | 'join_on'
  | 'where'
  | 'group_order_having'
  | 'qualified'
  | 'alias_suggest'
  | 'insert_columns'
  | 'insert_table'
  | 'update_set'
  | 'unknown'

export function detectContext(statement: string, cursorInStmt: number): {
  context: CompletionContext
  qualifier?: string
  prefix: string
  target?: { table: string; schema?: string; written: string[] }
} {
  const before = statement.slice(0, cursorInStmt)
  const cleanedBefore = stripLiterals(before)
  const q = qualifierBeforeCursor(statement, cursorInStmt)
  if (q && q.qualifier) {
    return { context: 'qualified', qualifier: q.qualifier, prefix: q.ident.text }
  }
  // INSERT INTO t ( 已写列… → 建议剩余列
  const insCols = parseInsertColumnsContext(cleanedBefore)
  if (insCols) {
    return { context: 'insert_columns', prefix: lastWord(cleanedBefore), target: insCols }
  }
  // INSERT INTO t_ → 建议表
  if (/\bINSERT\s+INTO\s+[`"\w$#]*$/i.test(cleanedBefore)) {
    return { context: 'insert_table', prefix: lastWord(cleanedBefore) }
  }
  // UPDATE t SET 已赋值… → 建议未赋值列
  const updSet = parseUpdateSetContext(cleanedBefore)
  if (updSet) {
    return { context: 'update_set', prefix: lastWord(cleanedBefore), target: updSet }
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

/** INSERT INTO t (col1, col2 → { table, written } */
function parseInsertColumnsContext(before: string): { table: string; schema?: string; written: string[] } | null {
  const m = /\bINSERT\s+INTO\s+((?:"[^"]+"|`[^`]+`|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[\w$#]+))?)\s*\(([^()]*)$/i.exec(before)
  if (!m) return null
  const parts = (m[1] ?? '').split('.').map((p) => p.replace(/["`]/g, '').trim())
  const table = parts[parts.length - 1] ?? ''
  if (!table) return null
  const written = (m[2] ?? '')
    .split(',')
    .map((s) => s.replace(/["`]/g, '').trim().toLowerCase())
    .filter(Boolean)
  return { table, schema: parts.length > 1 ? parts[parts.length - 2] : undefined, written }
}

/** UPDATE t SET a = 1, b = → { table, written }（written 为已赋值列） */
function parseUpdateSetContext(before: string): { table: string; schema?: string; written: string[] } | null {
  const m = /\bUPDATE\s+((?:"[^"]+"|`[^`]+`|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|[\w$#]+))?)\s+SET\s+(.*)$/is.exec(before)
  if (!m) return null
  const parts = (m[1] ?? '').split('.').map((p) => p.replace(/["`]/g, '').trim())
  const table = parts[parts.length - 1] ?? ''
  if (!table) return null
  const assignText = (m[2] ?? '').replace(/\((?:[^()]|\([^()]*\))*\)/g, '()') // 折叠括号避免逗号误切
  const written = assignText
    .split(',')
    .map((s) => (/^\s*([\w$#]+)/.exec(s)?.[1] ?? '').toLowerCase())
    .filter(Boolean)
  return { table, schema: parts.length > 1 ? parts[parts.length - 2] : undefined, written }
}

function lastWord(s: string): string {
  const m = /([\w$#`"\u4e00-\u9fff]*)$/.exec(s)
  return m?.[1] ?? ''
}

// —— 模糊匹配（精确 > 前缀 > 子序列），返回高亮区间 ——

interface FuzzyRank {
  rank: number // 3=精确 2=前缀/包含 1=子序列
  ranges: number[]
}

export function fuzzyMatch(label: string, prefix: string): FuzzyRank | null {
  if (!prefix) return { rank: 2, ranges: [] }
  const l = label.toLowerCase()
  const p = prefix.toLowerCase()
  const idx = l.indexOf(p)
  if (idx >= 0) {
    const ranges: number[] = []
    for (let i = 0; i < p.length; i++) ranges.push(idx + i)
    return { rank: idx === 0 ? 3 : 2, ranges }
  }
  const ranges: number[] = []
  let li = 0
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi]!
    let found = -1
    while (li < l.length) {
      if (l[li] === ch) {
        found = li
        break
      }
      li++
    }
    if (found < 0) return null
    ranges.push(found)
    li = found + 1
  }
  return { rank: 1, ranges }
}

function sortKey(rank: number, boost: number, label: string): string {
  // rank 越大越靠前；同 rank 内 boost（含使用频次）优先；字典序兜底
  const pad = String(Math.max(0, 999 - boost)).padStart(3, '0')
  const rankChar = rank >= 3 ? '0' : rank === 2 ? '1' : '2'
  return `${rankChar}${pad}_${label.toLowerCase()}`
}

type ItemPartial = Omit<CompletionItem, 'sortText'> & { boost?: number; usage?: Record<string, number> }

function makeItem(rank: number, partial: ItemPartial): CompletionItem {
  const { boost, usage, ...rest } = partial
  const usageBoost = usage?.[rest.label] ?? usage?.[`${rest.owner}.${rest.label}`] ?? 0
  return {
    ...rest,
    sortText: sortKey(rank, (boost ?? 0) + usageBoost, rest.label)
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
  const { context, qualifier, prefix, target } = detectContext(stmt.text, cursorInStmt)
  const dialect = driverDialect(driverId)
  const keywords = catalog?.keywords?.length ? catalog.keywords : dialectKeywords(dialect)
  const functions = catalog?.functions?.length ? catalog.functions : dialectFunctions(dialect)
  const snippets = dialectSnippets(dialect)
  const usage = input.usageBoost ?? catalog?.usageBoost
  const ident = identifierAtCursor(sql, cursor)
  const prefixLower = (prefix || ident.text).toLowerCase().replace(/["`]/g, '')
  const items: CompletionItem[] = []
  const tables = catalog?.tables ?? []

  const quoteIdent = (name: string): string => {
    if (/^[a-z_][a-z0-9_]*$/i.test(name)) return name
    return `\`${name.replace(/`/g, '')}\``
  }

  // CTE / 派生表虚拟表（SELECT * / t.* 可借 catalog 展开）
  const resolveCatalogColumns = (table: string, schema?: string): VirtualColumn[] | null => {
    const hit =
      tables.find((t) => t.name.toLowerCase() === table.toLowerCase() && (!schema || !t.schema || t.schema === schema)) ??
      tables.find((t) => t.name.toLowerCase() === table.toLowerCase())
    return hit ? hit.columns.map((c) => ({ name: c.name, type: c.type })) : null
  }
  const virtuals = parseVirtualTables(stmt.text, resolveCatalogColumns)

  /** 别名/表名 → 列（虚拟表优先，catalog 兜底） */
  const resolveColumns = (name: string, schema?: string): VirtualColumn[] | null => {
    const vt = virtuals.get(name.toLowerCase())
    if (vt) return vt.columns
    return resolveCatalogColumns(name, schema)
  }

  /**
   * 统一 push：先对 bare（过滤目标，通常是不带 qualifier 的名字）做模糊匹配，
   * 命中才入列；ranges 平移 offset 后挂到 label 上供前端高亮。
   */
  const push = (partial: ItemPartial, bare?: string, offset = 0): void => {
    const filterTarget = (bare ?? partial.label).toLowerCase().replace(/["`]/g, '')
    const fz = fuzzyMatch(filterTarget, prefixLower)
    if (!fz) return
    const ranges = fz.ranges.length ? fz.ranges.map((i) => i + offset) : undefined
    items.push(makeItem(fz.rank, ranges ? { ...partial, matchRanges: ranges } : partial))
  }

  // qualified：alias. 或 table. → 该表列；库/schema → 子对象；CTE → 其推导列
  if (context === 'qualified' && qualifier) {
    const q = qualifier.toLowerCase().replace(/["`]/g, '')
    const aliases = extractTableAliases(stmt.text)
    const aliasHit = aliases.find((a) => a.alias.toLowerCase() === q || a.table.toLowerCase() === q)
    const tableName = aliasHit?.table ?? q
    const schemaName = aliasHit?.schema
    const qualifiedPrefix = `${aliasHit?.alias ?? q}.`
    // 派生表/CTE 名或真实表列
    const cols = resolveColumns(tableName, schemaName)
    if (cols) {
      for (const col of cols) {
        push(
          {
            label: `${qualifiedPrefix}${quoteIdent(col.name)}`,
            kind: 'column',
            detail: col.type ?? '',
            insertText: quoteIdent(col.name),
            owner: tableName,
            boost: 90,
            usage
          },
          col.name,
          qualifiedPrefix.length
        )
      }
    } else {
      const tableHit =
        tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase() && (!schemaName || !t.schema || t.schema === schemaName)) ??
        tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase())
      if (tableHit) {
        for (const col of tableHit.columns) {
          push(
            {
              label: `${qualifiedPrefix}${quoteIdent(col.name)}`,
              kind: 'column',
              detail: col.type ?? '',
              doc: col.comment,
              insertText: quoteIdent(col.name),
              owner: tableHit.name,
              boost: col.pk ? 90 : 70,
              usage
            },
            col.name,
            qualifiedPrefix.length
          )
        }
      }
    }
    // 库名 / schema 名下的表
    const asDb = catalog?.databases?.find((d) => d.toLowerCase() === q)
    const asSchema = catalog?.schemas?.find((s) => s.toLowerCase() === q)
    if (asDb || asSchema) {
      for (const t of tables) {
        push(
          {
            label: t.name,
            kind: t.type === 'view' ? 'view' : 'table',
            detail: t.schema ?? asDb ?? '',
            insertText: quoteIdent(t.name),
            boost: 80,
            usage
          }
        )
      }
    }
  } else if (context === 'insert_columns' && target) {
    // INSERT INTO t (… → 尚未列出的列
    const cols = resolveColumns(target.table, target.schema) ?? []
    const written = new Set(target.written)
    for (const col of cols) {
      if (written.has(col.name.toLowerCase())) continue
      push(
        {
          label: quoteIdent(col.name),
          kind: 'column',
          detail: `${col.type ?? ''}${col.pk ? ' · PK' : ''}`,
          doc: col.comment,
          insertText: quoteIdent(col.name),
          owner: target.table,
          boost: 92,
          usage
        },
        col.name
      )
    }
  } else if (context === 'insert_table') {
    for (const t of tables) {
      push(
        {
          label: t.schema ? `${t.schema}.${t.name}` : t.name,
          kind: t.type === 'view' ? 'view' : 'table',
          detail: t.comment ?? t.type,
          insertText: quoteIdent(t.name),
          boost: 88,
          usage
        }
      )
    }
  } else if (context === 'update_set' && target) {
    // UPDATE t SET … → 未赋值列
    const cols = resolveColumns(target.table, target.schema) ?? []
    const written = new Set(target.written)
    for (const col of cols) {
      if (written.has(col.name.toLowerCase())) continue
      push(
        {
          label: quoteIdent(col.name),
          kind: 'column',
          detail: `${col.type ?? ''} = `,
          doc: col.comment,
          insertText: `${quoteIdent(col.name)} = `,
          owner: target.table,
          boost: 90,
          usage
        },
        col.name
      )
    }
  } else if (context === 'from_item' || context === 'alias_suggest') {
    if (context === 'alias_suggest') {
      for (const [i, a] of extractTableAliases(stmt.text).entries()) {
        if (!a.alias) continue
        const suggest = `${a.alias[0]}${i + 1}`
        items.push(makeItem(2, { label: suggest, kind: 'alias', detail: a.table, insertText: suggest, boost: 85 }))
      }
      items.push(makeItem(2, { label: 't1', kind: 'alias', insertText: 't1', boost: 40 }))
      items.push(makeItem(2, { label: 'a', kind: 'alias', insertText: 'a', boost: 30 }))
    } else {
      // CTE 优先于真实表（IDEA 行为）
      for (const vt of virtuals.values()) {
        if (vt.kind !== 'cte') continue
        push(
          {
            label: vt.name,
            kind: 'table',
            detail: `CTE · ${vt.columns.length} 列`,
            insertText: vt.name,
            boost: 85,
            usage
          }
        )
      }
      for (const d of catalog?.databases ?? []) {
        push({ label: d, kind: 'database', insertText: quoteIdent(d), boost: 50, usage })
      }
      for (const t of tables) {
        push(
          {
            label: t.schema ? `${t.schema}.${t.name}` : t.name,
            kind: t.type === 'view' ? 'view' : t.type === 'measurement' ? 'measurement' : 'table',
            detail: t.comment ?? t.type,
            insertText: quoteIdent(t.name),
            boost: t.type === 'table' ? 80 : 70,
            usage
          }
        )
      }
    }
  } else {
    // select_list / where / group_order_having / join_on / stmt_start / unknown / insert_table 之外的通用路径
    const aliases = extractTableAliases(stmt.text)
    const useAliasPrefix = context === 'select_list' && aliases.length > 1
    const pushColumns = (boostBase: number): void => {
      const fromTables = aliases
      if (fromTables.length === 0) {
        for (const t of tables) {
          for (const col of t.columns) {
            push(
              {
                label: col.name,
                kind: 'column',
                detail: `${t.name}.${col.type ?? ''}`,
                doc: col.comment,
                insertText: quoteIdent(col.name),
                owner: t.name,
                boost: boostBase + (col.pk ? 10 : 0),
                usage
              },
              col.name
            )
          }
        }
        return
      }
      for (const a of fromTables) {
        const cols = resolveColumns(a.table, a.schema)
        if (!cols) continue
        for (const col of cols) {
          const display = useAliasPrefix ? `${a.alias}.${quoteIdent(col.name)}` : quoteIdent(col.name)
          const prefixLen = useAliasPrefix ? `${a.alias}.`.length : 0
          push(
            {
              label: display,
              kind: 'column',
              detail: `${a.table}${col.type ? ` · ${col.type}` : ''}`,
              doc: col.comment,
              insertText: display,
              owner: a.table,
              boost: boostBase + (col.pk ? 15 : 0) + (aliases.length > 1 ? 5 : 0),
              usage
            },
            col.name,
            prefixLen
          )
        }
      }
    }

    if (context === 'select_list') {
      pushColumns(75)
      push({ label: '*', kind: 'column', detail: '全部列', insertText: '*', boost: 40 })
    } else if (context === 'where' || context === 'join_on' || context === 'group_order_having') {
      pushColumns(80)
    }

    // JOIN ON：同名列 / 后缀关联 / FK → 完整等值条件（IDEA 式一键补全）
    if (context === 'join_on') {
      const beforeAliases = aliases.filter((a) => a.index === undefined || a.index < cursorInStmt)
      if (beforeAliases.length >= 2) {
        const newA = beforeAliases[beforeAliases.length - 1]!
        let pushed = 0
        for (let j = beforeAliases.length - 2; j >= 0 && pushed < 8; j--) {
          const other = beforeAliases[j]!
          const newCols = resolveColumns(newA.table, newA.schema) ?? []
          const otherCols = resolveColumns(other.table, other.schema) ?? []
          const otherByName = new Map(otherCols.map((c) => [c.name.toLowerCase(), c]))
          // FK 元数据（driver 提供时）
          const fkList = tables.find((t) => t.name.toLowerCase() === newA.table.toLowerCase())?.fks ?? []
          for (const fk of fkList) {
            if (fk.refTable.toLowerCase() !== other.table.toLowerCase()) continue
            pushCondition(newA.alias, fk.column, other.alias, fk.refColumn, 96)
            pushed++
          }
          for (const c of newCols) {
            if (pushed >= 8) break
            const cl = c.name.toLowerCase()
            const same = otherByName.get(cl)
            if (same) {
              pushCondition(newA.alias, c.name, other.alias, same.name, 95)
              pushed++
              continue
            }
            // user_id ↔ id 后缀关联
            for (const oc of otherCols) {
              const ocl = oc.name.toLowerCase()
              if (cl.endsWith(`_${ocl}`) || ocl.endsWith(`_${cl}`)) {
                pushCondition(newA.alias, c.name, other.alias, oc.name, 88)
                pushed++
                break
              }
            }
          }
        }
      }
    }

    if (context === 'stmt_start' || context === 'unknown' || context === 'select_list' || context === 'where') {
      for (const fn of functions ?? []) {
        push(
          {
            label: fn.name,
            kind: 'function',
            detail: fn.signature,
            doc: fn.doc,
            insertText: context === 'select_list' || context === 'where' ? `${fn.name}(` : fn.name,
            boost: context === 'select_list' || context === 'where' ? 60 : 50,
            usage
          }
        )
      }
      for (const kw of keywords ?? []) {
        push({
          label: kw,
          kind: 'keyword',
          insertText: kw,
          boost: context === 'stmt_start' ? 30 : 10
        })
      }
      for (const sn of snippets ?? []) {
        const snPrefix = sn.prefix ?? sn.name ?? ''
        const snBody = sn.body ?? sn.sql ?? sn.text ?? ''
        const fz = fuzzyMatch(snPrefix.toLowerCase(), prefixLower)
        const bodyHit = !fz && prefixLower && snBody.toLowerCase().includes(prefixLower)
        if (!fz && !bodyHit) continue
        items.push(
          makeItem(bodyHit ? 1 : fz!.rank, {
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
  }

  function pushCondition(leftAlias: string, leftCol: string, rightAlias: string, rightCol: string, boost: number): void {
    const label = `${leftAlias}.${quoteIdent(leftCol)} = ${rightAlias}.${quoteIdent(rightCol)}`
    // 条件项对光标前缀（可能是任一侧列名片段）做子序列匹配
    const fz = fuzzyMatch(label.toLowerCase().replace(/["`]/g, ''), prefixLower)
    if (!fz) return
    items.push(
      makeItem(fz.rank, {
        label,
        kind: 'column',
        detail: 'JOIN 条件',
        doc: `${leftAlias}.${leftCol} = ${rightAlias}.${rightCol}`,
        insertText: label,
        boost,
        usage
      })
    )
  }

  // Catalog 未就绪时仍返回关键字+片段（静态回退已在上方关键字路径覆盖）
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
