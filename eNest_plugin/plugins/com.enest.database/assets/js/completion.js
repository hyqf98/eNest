/**
 * completion.js — IDEA 式 SQL 补全（DB-E）
 * 优先 db.completion.suggest；300ms 超时 / HOST_LAG 时本地关键字+catalog+别名列回退
 * qualified：replace 只覆盖光标处标识符，避免抹掉 alias.
 */
import { DbHost, hostLag } from './api.js'
import { keywordsFor, functionsFor, snippets, parseAliases } from './tokenizer.js'
import { state, bumpCompletionUsage, usageScore } from './store.js'

const KIND_META = {
  keyword: { color: '#c792ea', label: '关键字' },
  table: { color: '#82aaff', label: '表' },
  view: { color: '#82aaff', label: '视图' },
  column: { color: '#c3e88d', label: '列' },
  function: { color: '#ffcb6b', label: '函数' },
  database: { color: '#89ddff', label: '库' },
  schema: { color: '#89ddff', label: '库' },
  snippet: { color: '#f78c6c', label: '模板' },
  alias: { color: '#f07178', label: '别名' },
  measurement: { color: '#82aaff', label: '时序表' }
}

export function kindMeta(kind) {
  return KIND_META[kind] || { color: '#9aa7b8', label: kind || '其它' }
}

/** driver → 方言词表 key */
export function dialectOf(driverOrDialect) {
  const d = String(driverOrDialect || 'mysql').toLowerCase()
  if (d === 'timescale' || d === 'postgres' || d === 'postgresql') return 'postgres'
  return d
}

/** 光标前标识符范围；replaceFrom 仅在 insertText 自带 qualifier 时使用 */
export function identifierRangeAt(text, cursor) {
  let i = cursor
  while (i > 0 && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(text[i - 1])) i--
  const start = i
  const prefix = text.slice(start, cursor)
  let qStart = start
  let qualifier = ''
  if (start > 0 && text[start - 1] === '.') {
    let j = start - 2
    while (j >= 0 && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(text[j])) j--
    qStart = j + 1
    qualifier = text.slice(qStart, start - 1)
  }
  return { from: start, to: cursor, prefix, qualifier, replaceFrom: qualifier ? qStart : start }
}

/** 从完整 SQL + 光标提取语句上下文 */
export function analyzeContext(sql, cursor) {
  const before = sql.slice(0, cursor)
  const idRange = identifierRangeAt(sql, cursor)
  const stmtStart = Math.max(0, before.lastIndexOf(';') + 1)
  return {
    before,
    idRange,
    prefix: idRange.prefix.toLowerCase(),
    qualifier: idRange.qualifier,
    cursor,
    stmtSql: before.slice(stmtStart),
    stmtStart
  }
}

/** 默认 replace：只替换当前标识符（与宿主 identifierAtCursor 对齐） */
function replaceRangeOf(ctx) {
  return { from: ctx.idRange.from, to: ctx.idRange.to }
}

function catalogOf(sessionKey) {
  const hit = state.runtime.catalogs.get(sessionKey)
  if (!hit) return null
  return hit.catalog
}

export function setCatalog(sessionKey, catalog) {
  if (!catalog) return
  const prev = state.runtime.catalogs.get(sessionKey)?.catalog
  state.runtime.catalogs.set(sessionKey, {
    catalog: prev ? { ...prev, ...catalog } : catalog,
    ts: Date.now()
  })
}

/** 合并补丁（列懒加载后只更新单表） */
export function patchCatalogTable(sessionKey, tableName, patch) {
  if (!tableName || !patch) return
  const hit = state.runtime.catalogs.get(sessionKey)
  if (!hit?.catalog) return
  const tables = (hit.catalog.tables || []).map((t) =>
    t.name.toLowerCase() === String(tableName).toLowerCase() ? { ...t, ...patch } : t
  )
  if (!tables.some((t) => t.name.toLowerCase() === String(tableName).toLowerCase()) && patch.name) {
    tables.push({ columns: [], type: 'table', ...patch })
  }
  hit.catalog = { ...hit.catalog, tables }
  hit.ts = Date.now()
}

export function invalidateCatalog(sessionKey) {
  state.runtime.catalogs.delete(sessionKey)
}

function collectCatalogItems(catalog, { ctx, aliases, tables }) {
  const items = []
  const q = ctx.qualifier
  const bare = ctx.stmtSql.replace(/--[^\n]*/g, '')
  const inFrom = /\b(from|join)\s+[A-Za-z0-9_`.]*$/i.test(ctx.before.trim())
  const lastSelect = bare.toUpperCase().lastIndexOf('SELECT')
  const inSelectList = lastSelect >= 0 && !/\bfrom\b/i.test(bare.slice(lastSelect))

  if (!catalog) return items

  if (q) {
    const ql = q.toLowerCase()
    const aliasRec = aliases.get(ql)
    const tableName = aliasRec?.name || q
    const table = (catalog.tables || []).find((t) => t.name.toLowerCase() === tableName.toLowerCase())
    if (table) {
      for (const col of table.columns || []) {
        items.push({
          label: col.name,
          kind: 'column',
          detail: `${col.type || ''}${col.pk ? ' · PK' : ''}${col.comment ? ' · ' + col.comment : ''}`.trim(),
          doc: col.comment || `${tableName}.${col.name}`,
          insertText: col.name,
          owner: table.name,
          sortText: `1_${col.name}`,
          filterText: col.name
        })
      }
    } else {
      for (const t of catalog.tables || []) {
        const schemaL = (t.schema || '').toLowerCase()
        if (schemaL === ql || ql === 'public') {
          items.push({
            label: t.name,
            kind: t.type === 'view' ? 'view' : 'table',
            detail: t.comment || t.type || 'table',
            doc: t.comment,
            insertText: t.name,
            owner: t.schema,
            sortText: `2_${t.name}`
          })
        }
      }
      for (const db of catalog.databases || []) {
        if (db.toLowerCase() === ql) {
          for (const t of catalog.tables || []) {
            items.push({
              label: t.name,
              kind: 'table',
              detail: t.type || 'table',
              insertText: t.name,
              sortText: `2_${t.name}`
            })
          }
        }
      }
    }
  } else if (inFrom) {
    for (const t of catalog.tables || []) {
      const kind = t.type === 'view' ? 'view' : t.type === 'measurement' ? 'measurement' : 'table'
      items.push({
        label: t.name,
        kind,
        detail: t.comment || t.schema || t.type || '',
        doc: t.comment,
        insertText: t.name,
        owner: t.schema,
        sortText: `0_${t.name}`
      })
    }
    for (const db of catalog.databases || []) {
      items.push({ label: db, kind: 'database', detail: '数据库', insertText: db, sortText: `3_${db}` })
    }
  } else if (inSelectList || tables.length || aliases.size) {
    const fromTables = tables.length ? tables : [...aliases.values()]
    if (fromTables.length) {
      const multi = fromTables.length > 1
      for (const tb of fromTables) {
        const table = (catalog.tables || []).find((t) => t.name.toLowerCase() === tb.name.toLowerCase())
        for (const col of table?.columns || []) {
          const prefixLabel = multi ? `${tb.alias || tb.name}.${col.name}` : col.name
          items.push({
            label: prefixLabel,
            kind: 'column',
            detail: `${table?.name || tb.name}.${col.name}${col.type ? ' · ' + col.type : ''}`,
            doc: col.comment,
            insertText: prefixLabel,
            owner: table?.name || tb.name,
            sortText: `0_${prefixLabel}`,
            filterText: `${tb.alias || ''} ${col.name}`.trim()
          })
        }
      }
    } else {
      for (const t of catalog.tables || []) {
        items.push({
          label: t.name,
          kind: t.type === 'view' ? 'view' : 'table',
          detail: t.type || '',
          insertText: t.name,
          sortText: `2_${t.name}`
        })
        for (const col of (t.columns || []).slice(0, 40)) {
          items.push({
            label: col.name,
            kind: 'column',
            detail: `${t.name}.${col.type || ''}`,
            insertText: col.name,
            owner: t.name,
            sortText: `4_${col.name}`
          })
        }
      }
    }
  } else {
    for (const t of catalog.tables || []) {
      items.push({
        label: t.name,
        kind: t.type === 'view' ? 'view' : 'table',
        detail: t.comment || t.type || '',
        insertText: t.name,
        sortText: `2_${t.name}`
      })
    }
    for (const f of catalog.functions || []) {
      items.push({
        label: f.name,
        kind: 'function',
        detail: f.signature || '',
        doc: f.doc,
        insertText: f.name + '(',
        sortText: `5_${f.name}`
      })
    }
    for (const kw of catalog.keywords || []) {
      items.push({
        label: kw,
        kind: 'keyword',
        detail: '关键字',
        insertText: kw,
        sortText: `9_${kw}`
      })
    }
  }

  // FROM t / JOIN t 后建议别名
  if (/\b(from|join)\s+[`A-Za-z0-9_.]+\s+(as\s+)?$/i.test(ctx.before)) {
    for (const [a, rec] of aliases) {
      if (!a) continue
      items.push({ label: a, kind: 'alias', detail: rec?.name || '别名', insertText: a, sortText: `0_${a}` })
    }
    items.push({ label: 't1', kind: 'alias', detail: '别名', insertText: 't1', sortText: `1_t1` })
    items.push({ label: 'a', kind: 'alias', detail: '别名', insertText: 'a', sortText: `1_a` })
  }
  return items
}

function localItems(req) {
  const { sql, cursor, sessionKey, dialect } = req
  const ctx = analyzeContext(sql, cursor)
  const stmt = { sql: req.statementSql || ctx.stmtSql, start: ctx.stmtStart, end: cursor }
  const { aliases, tables } = parseAliases(stmt.sql)
  const catalog = catalogOf(sessionKey)
  const items = []
  const d = dialectOf(dialect)

  items.push(...collectCatalogItems(catalog, { ctx, aliases, tables }))

  const isStmtStart = !ctx.before.trim() || /;\s*$/.test(ctx.before)
  const showKeywords = !ctx.qualifier || isStmtStart
  if (showKeywords) {
    for (const kw of keywordsFor(d)) {
      items.push({
        label: kw,
        kind: 'keyword',
        detail: '关键字',
        insertText: kw,
        sortText: isStmtStart ? `0_${kw}` : `8_${kw}`
      })
    }
    for (const fn of functionsFor(d)) {
      items.push({
        label: fn,
        kind: 'function',
        detail: '内置函数',
        insertText: fn + '(',
        sortText: `6_${fn}`
      })
    }
    for (const sn of snippets()) {
      items.push({
        label: sn.trigger,
        kind: 'snippet',
        detail: sn.doc,
        doc: sn.insert,
        insertText: sn.insert,
        sortText: `0_snip_${sn.trigger}`
      })
    }
  }

  return {
    replace: replaceRangeOf(ctx),
    items,
    isIncomplete: false,
    _local: true,
    _aliases: aliases,
    _tables: tables
  }
}

function withUsageSort(items) {
  return [...items].sort((a, b) => {
    const ua = usageScore(a.kind, a.owner, a.label) || 0
    const ub = usageScore(b.kind, b.owner, b.label) || 0
    if (ua !== ub) return ub - ua
    return String(a.sortText || a.label).localeCompare(String(b.sortText || b.label))
  })
}

/** 请求补全（DB-E2 / E7.10） */
export async function requestCompletion({
  sessionKey,
  sql,
  cursor,
  dialect,
  statementSql,
  database,
  schema,
  usageBoost
}) {
  const req = {
    sessionKey,
    sql,
    cursor,
    database,
    schema,
    usageBoost: usageBoost && Object.keys(usageBoost).length ? usageBoost : undefined
  }
  let hostRes = null
  try {
    hostRes = await Promise.race([
      DbHost.completion(req),
      new Promise((_, reject) =>
        setTimeout(() => {
          const e = new Error('completion timeout')
          e.code = 'TIMEOUT'
          reject(e)
        }, 300)
      )
    ])
  } catch (e) {
    if (!hostLag(e) && e?.code !== 'TIMEOUT' && !/session not found|not open/i.test(String(e?.message || e))) {
      console.warn('completion error', e)
    }
    hostRes = null
  }

  const ctx = analyzeContext(sql, cursor)
  const replace = replaceRangeOf(ctx)

  if (hostRes && Array.isArray(hostRes.items) && hostRes.items.length) {
    // 宿主 replace 仅覆盖标识符；若缺失则用本地范围
    const hostReplace = hostRes.replace || replace
    const items = withUsageSort(hostRes.items)
    return { replace: hostReplace, items, isIncomplete: !!hostRes.isIncomplete, _local: false }
  }

  const local = localItems({ sql, cursor, sessionKey, dialect, statementSql })
  local.items = withUsageSort(local.items)
  local.replace = replace
  return local
}

export function applyCompletionItem(item) {
  try {
    bumpCompletionUsage(item.kind, item.owner, item.label)
  } catch {
    /* ignore */
  }
}

export function filterItems(items, prefix, limit = 80) {
  const p = (prefix || '').toLowerCase()
  if (!p) return items.slice(0, limit)
  const exact = []
  const start = []
  const sub = []
  for (const it of items) {
    const label = String(it.label || '').toLowerCase()
    const filter = String(it.filterText || it.label || '').toLowerCase()
    if (label === p || filter === p) exact.push(it)
    else if (label.startsWith(p) || filter.startsWith(p) || p.split(/\s+/).some((tok) => tok && filter.startsWith(tok)))
      start.push(it)
    else if (label.includes(p) || filter.includes(p)) sub.push(it)
  }
  return [...exact, ...start, ...sub].slice(0, limit)
}

/** 将 catalog 写入运行时缓存（打开连接 / 执行 DDL 后刷新） */
export function warmCatalogFromSchema(sessionKey, schemaData) {
  if (!schemaData) return
  const catalog = {
    dialect: schemaData.dialect,
    databases: schemaData.databases || [],
    schemas: schemaData.schemas || [],
    tables: schemaData.tables || [],
    functions: schemaData.functions || [],
    keywords: schemaData.keywords || keywordsFor(dialectOf(schemaData.dialect || 'mysql')),
    usageBoost: state.completionUsage
  }
  setCatalog(sessionKey, catalog)
}

/** 从宿主表列表 + describe 预热本地 catalog（离线/超时回退仍可用） */
export async function warmCatalogFromHost(sessionKey, { driver, database, schema, describeFn, tablesFn }) {
  if (!sessionKey || !tablesFn) return null
  try {
    const raw = await tablesFn({ sessionKey, database, schema })
    let list = []
    if (Array.isArray(raw)) list = raw
    else if (Array.isArray(raw?.tables)) list = raw.tables
    else if (Array.isArray(raw?.children)) list = raw.children
    else if (Array.isArray(raw?.items)) list = raw.items
    else if (raw && typeof raw === 'object') {
      for (const v of Object.values(raw)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
          list = v
          break
        }
      }
    }
    const tables = list
      .map((t) => ({
        name: t.name || t.table || t.label,
        schema: t.schema,
        type: t.type || 'table',
        columns: t.columns || [],
        comment: t.comment
      }))
      .filter((t) => t.name)

    if (describeFn) {
      await Promise.all(
        tables.slice(0, 40).map(async (tb) => {
          if (tb.columns?.length) return
          try {
            const detail = await describeFn({
              sessionKey,
              database,
              schema: tb.schema || schema,
              table: tb.name
            })
            const cols = detail?.columns || []
            tb.columns = cols.map((c) => ({
              name: c.name,
              type: c.type || c.dataType,
              comment: c.comment,
              pk: !!(c.pk || c.primaryKey)
            }))
          } catch {
            /* 懒加载 */
          }
        })
      )
    }

    const d = dialectOf(driver)
    const catalog = {
      dialect: d,
      databases: database ? [database] : [],
      schemas: [...new Set(tables.map((t) => t.schema).filter(Boolean))],
      tables,
      functions: functionsFor(d).map((n) => ({ name: n, kind: 'native' })),
      keywords: keywordsFor(d),
      usageBoost: state.completionUsage
    }
    setCatalog(sessionKey, catalog)
    return catalog
  } catch {
    return null
  }
}

export function detectDdl(sql) {
  return /\b(create|alter|drop|truncate)\b/i.test(sql || '')
}
