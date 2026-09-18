/**
 * tokenizer.js — 轻量 SQL 语法高亮分词（无 Monaco/CDN）
 */

const DIALECT_KEYWORDS = {
  mysql: [
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','DATABASE','SCHEMA',
    'DROP','ALTER','TRUNCATE','INDEX','VIEW','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ON','AS','AND',
    'OR','NOT','IN','EXISTS','BETWEEN','LIKE','ILIKE','IS','NULL','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET',
    'UNION','ALL','DISTINCT','CASE','WHEN','THEN','ELSE','END','ASC','DESC','PRIMARY','KEY','FOREIGN','REFERENCES',
    'CONSTRAINT','DEFAULT','UNIQUE','CHECK','EXPLAIN','DESCRIBE','SHOW','USE','GRANT','REVOKE','BEGIN','COMMIT',
    'ROLLBACK','TRANSACTION','IF','EXISTS','REPLACE','IGNORE','DUPLICATE','WITH','RECURSIVE','OVER','PARTITION',
    'WINDOW','RANK','ROW_NUMBER','LATERAL','UNION','INTERSECT','EXCEPT','FOR','LOCK','SHARE','MODE','HAVING'
  ],
  sqlite: [
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','DROP','ALTER',
    'INDEX','VIEW','TRIGGER','JOIN','LEFT','INNER','ON','AS','AND','OR','NOT','IN','EXISTS','BETWEEN','LIKE',
    'GLOB','IS','NULL','GROUP','BY','ORDER','LIMIT','OFFSET','UNION','ALL','DISTINCT','CASE','WHEN','THEN','ELSE',
    'END','ASC','DESC','PRIMARY','KEY','FOREIGN','REFERENCES','CONSTRAINT','DEFAULT','UNIQUE','CHECK','PRAGMA',
    'EXPLAIN','QUERY','PLAN','BEGIN','COMMIT','ROLLBACK','TRANSACTION','IF','EXISTS','REPLACE','WITH','RETURNING',
    'STRICT','WITHOUT','ROWID','TEMP','TEMPORARY','VIRTUAL','USING','NATURAL'
  ],
  postgres: [
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','SCHEMA','DATABASE',
    'DROP','ALTER','INDEX','VIEW','MATERIALIZED','JOIN','LEFT','RIGHT','FULL','INNER','OUTER','ON','AS','AND','OR',
    'NOT','IN','EXISTS','BETWEEN','LIKE','ILIKE','SIMILAR','IS','NULL','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET',
    'UNION','INTERSECT','EXCEPT','ALL','DISTINCT','CASE','WHEN','THEN','ELSE','END','ASC','DESC','PRIMARY','KEY',
    'FOREIGN','REFERENCES','CONSTRAINT','DEFAULT','UNIQUE','CHECK','EXPLAIN','ANALYZE','BEGIN','COMMIT','ROLLBACK',
    'RETURNING','WITH','RECURSIVE','OVER','PARTITION','WINDOW','SERIAL','BIGSERIAL','JSONB','ARRAY','ON','CONFLICT',
    'DO','NOTHING','UPDATE','FILTER','WITHIN','GROUP','LATERAL','ONLY','TABLESAMPLE','FETCH','FIRST','ROWS','ONLY'
  ],
  influxql: [
    'SELECT','FROM','WHERE','GROUP','BY','FILL','LIMIT','SLIMIT','ORDER','DESC','ASC','SHOW','MEASUREMENTS',
    'TAG','KEYS','FIELD','KEYS','RETENTION','POLICIES','DATABASES','DROP','CREATE','DATABASE','RETENTION','POLICY',
    'SHARD','DURATION','REPLICATION','NAME','RESAMPLE','INTO','EVERY','FOR','NOW','TZ','LIMIT'
  ],
  tdengine: [
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','STABLE','DATABASE',
    'DROP','ALTER','INDEX','JOIN','ON','AS','AND','OR','NOT','IN','IS','NULL','GROUP','BY','ORDER','LIMIT','OFFSET',
    'INTERVAL','STATEWINDOW','SESSION','SLIDING','FILL','SLIMIT','SOFFSET','PARTITION','TIMEDIFF','NOW','LAST','FIRST',
    'TWA','IRATE','INTERP','DESC','ASC','EXPLAIN','DESCRIBE','SHOW','STABLES','TABLES','DATABASES','TAGS'
  ]
}

const DIALECT_FUNCTIONS = {
  mysql: [
    'COUNT','SUM','AVG','MIN','MAX','CONCAT','IFNULL','DATE_FORMAT','NOW','JSON_EXTRACT','COALESCE','ROUND',
    'CAST','CONVERT','SUBSTRING','LENGTH','TRIM','UPPER','LOWER','ABS','FLOOR','CEIL','CURDATE','CURTIME',
    'DATE_ADD','DATE_SUB','DATEDIFF','GROUP_CONCAT','IF','NULLIF','UUID','MD5','SHA1','RAND','LIMIT'
  ],
  sqlite: [
    'COUNT','SUM','AVG','MIN','MAX','COALESCE','STRFTIME','TOTAL','RANDOM','ABS','ROUND','LENGTH','TRIM',
    'UPPER','LOWER','SUBSTR','INSTR','PRINTF','GLOB','NULLIF','DATE','TIME','DATETIME','JULIANDAY','TYPEOF'
  ],
  postgres: [
    'COUNT','SUM','AVG','MIN','MAX','COALESCE','NOW','DATE_TRUNC','GENERATE_SERIES','ROUND','CAST','TO_CHAR',
    'TO_TIMESTAMP','LENGTH','TRIM','UPPER','LOWER','SUBSTRING','CONCAT','NULLIF','ARRAY_AGG','STRING_AGG',
    'JSON_BUILD_OBJECT','ROW_NUMBER','RANK','DENSE_RANK','LAG','LEAD','NTILE','FIRST_VALUE','LAST_VALUE','MD5'
  ],
  influxql: [
    'MEAN','SUM','LAST','FIRST','COUNT','MIN','MAX','MEDIAN','PERCENTILE','MODE','SPREAD','STDDEV','DIFF','ELAPSED'
  ],
  tdengine: [
    'NOW','TIMEDIFF','LAST','FIRST','COUNT','SUM','AVG','MIN','MAX','ABS','FLOOR','CEIL','ROUND','CAST','TWA','IRATE'
  ]
}

const BUILTIN_SNIPPETS = [
  { trigger: 'sel', insert: 'SELECT * FROM ${table} WHERE 1=1 LIMIT 200;', doc: '基础查询' },
  { trigger: 'ins', insert: 'INSERT INTO ${table} (${cols}) VALUES ();', doc: '插入语句' },
  { trigger: 'upd', insert: 'UPDATE ${table} SET ${col} = ${value} WHERE 1=1;', doc: '更新语句' },
  { trigger: 'del', insert: 'DELETE FROM ${table} WHERE 1=1;', doc: '删除语句' },
  { trigger: 'join', insert: 'JOIN ${table} AS ${alias} ON ${alias}.${col} = ${lhs}', doc: 'JOIN 子句' },
  { trigger: 'count', insert: 'SELECT COUNT(*) AS cnt FROM ${table};', doc: '计数' },
  { trigger: 'show', insert: 'SHOW TABLES;', doc: '列出表' }
]

export function keywordsFor(dialect) {
  return DIALECT_KEYWORDS[dialect] || DIALECT_KEYWORDS.mysql
}

export function functionsFor(dialect) {
  return DIALECT_FUNCTIONS[dialect] || DIALECT_FUNCTIONS.mysql
}

export function snippets() {
  return BUILTIN_SNIPPETS
}

const KW_RE_CACHE = new Map()
function kwSet(dialect) {
  if (!KW_RE_CACHE.has(dialect)) {
    KW_RE_CACHE.set(dialect, new Set(keywordsFor(dialect).map((k) => k.toUpperCase())))
  }
  return KW_RE_CACHE.get(dialect)
}

const FN_RE_CACHE = new Map()
function fnSet(dialect) {
  if (!FN_RE_CACHE.has(dialect)) {
    FN_RE_CACHE.set(dialect, new Set(functionsFor(dialect).map((k) => k.toUpperCase())))
  }
  return FN_RE_CACHE.get(dialect)
}

/** 分词：[{ type, value }] type: kw|fn|string|comment|number|ident|op|punct */
export function tokenize(sql, dialect = 'mysql') {
  const out = []
  if (!sql) return out
  const kws = kwSet(dialect)
  const fns = fnSet(dialect)
  const n = sql.length
  let i = 0
  let line = 1
  while (i < n) {
    const ch = sql[i]
    const start = i
    // whitespace
    if (ch === '\n') {
      out.push({ type: 'ws', value: ch, line })
      line++
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++
      while (i < n && ' \t\r'.includes(sql[i])) i++
      out.push({ type: 'ws', value: sql.slice(start, i), line })
      continue
    }
    // line comment
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n') i++
      out.push({ type: 'comment', value: sql.slice(start, i), line })
      continue
    }
    if (ch === '#') {
      while (i < n && sql[i] !== '\n') i++
      out.push({ type: 'comment', value: sql.slice(start, i), line })
      continue
    }
    // block comment
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') line++
        i++
      }
      i = Math.min(n, i + 2)
      out.push({ type: 'comment', value: sql.slice(start, i), line })
      continue
    }
    // strings
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          break
        }
        if (sql[i] === '\n') line++
        i++
      }
      const type = quote === '`' || quote === '"' ? 'identq' : 'string'
      out.push({ type, value: sql.slice(start, i), line })
      continue
    }
    // number
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      i++
      while (i < n && /[0-9._eE+-]/.test(sql[i])) {
        if ((sql[i] === '+' || sql[i] === '-') && !/[eE]/.test(sql[i - 1])) break
        i++
      }
      out.push({ type: 'number', value: sql.slice(start, i), line })
      continue
    }
    // identifier / keyword
    if (/[A-Za-z_$\u4e00-\u9fff]/.test(ch)) {
      i++
      while (i < n && /[A-Za-z0-9_$\u4e00-\u9fff]/.test(sql[i])) i++
      const word = sql.slice(start, i)
      const up = word.toUpperCase()
      let type = 'ident'
      if (kws.has(up)) type = 'kw'
      else if (fns.has(up)) type = 'fn'
      // function call heuristic
      if (type === 'ident' && sql[i] === '(') type = 'fn'
      out.push({ type, value: word, line })
      continue
    }
    // operators / punct
    const two = sql.slice(i, i + 2)
    if (['<=', '>=', '<>', '!=', '||', '&&', '::'].includes(two)) {
      out.push({ type: 'op', value: two, line })
      i += 2
      continue
    }
    if ('+-*/%=<>!|&'.includes(ch)) {
      out.push({ type: 'op', value: ch, line })
      i++
      continue
    }
    out.push({ type: 'punct', value: ch, line })
    i++
  }
  return out
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function highlightHtml(sql, dialect = 'mysql') {
  const tokens = tokenize(sql, dialect)
  let html = ''
  for (const t of tokens) {
    const esc = escapeHtml(t.value)
    switch (t.type) {
      case 'ws':
        html += esc
        break
      case 'kw':
        html += `<span class="tok-kw">${esc}</span>`
        break
      case 'fn':
        html += `<span class="tok-fn">${esc}</span>`
        break
      case 'string':
        html += `<span class="tok-str">${esc}</span>`
        break
      case 'comment':
        html += `<span class="tok-cmt">${esc}</span>`
        break
      case 'number':
        html += `<span class="tok-num">${esc}</span>`
        break
      case 'identq':
        html += `<span class="tok-identq">${esc}</span>`
        break
      case 'op':
        html += `<span class="tok-op">${esc}</span>`
        break
      case 'punct':
        html += esc
        break
      default:
        html += esc
    }
  }
  return html
}

/** 剥离字符串/注释后的文本（用于语句切分与别名解析） */
export function stripStringsAndComments(sql) {
  let out = ''
  const n = sql.length
  let i = 0
  while (i < n) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (ch === '#') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2
          continue
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += quote === '`' ? '``' : "''"
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 切分语句，识别字符串/注释内分号；返回 [{ sql, start, end }] */
export function splitStatements(sql) {
  const stmts = []
  if (!sql) return stmts
  const n = sql.length
  let i = 0
  let start = 0
  let inSingle = false
  let inDouble = false
  let inBack = false
  let inLine = false
  let inBlock = false
  const push = (end) => {
    const raw = sql.slice(start, end)
    if (raw.trim()) stmts.push({ sql: raw, start, end })
  }
  while (i < n) {
    const ch = sql[i]
    if (inLine) {
      if (ch === '\n') inLine = false
      i++
      continue
    }
    if (inBlock) {
      if (ch === '*' && sql[i + 1] === '/') {
        inBlock = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (!inSingle && !inDouble && !inBack) {
      if (ch === '-' && sql[i + 1] === '-') {
        inLine = true
        i += 2
        continue
      }
      if (ch === '#') {
        inLine = true
        i++
        continue
      }
      if (ch === '/' && sql[i + 1] === '*') {
        inBlock = true
        i += 2
        continue
      }
      if (ch === ';') {
        push(i + 1)
        start = i + 1
        i++
        continue
      }
    }
    if (!inDouble && !inBack && ch === "'") {
      inSingle = !inSingle
      i++
      continue
    }
    if (!inSingle && !inBack && ch === '"') {
      inDouble = !inDouble
      i++
      continue
    }
    if (!inSingle && !inDouble && ch === '`') {
      inBack = !inBack
      i++
      continue
    }
    i++
  }
  push(n)
  return stmts
}

export function statementAtCursor(sql, cursor) {
  const list = splitStatements(sql)
  if (!list.length) return { sql: '', start: 0, end: 0 }
  for (const s of list) {
    if (cursor >= s.start && cursor <= s.end) return s
  }
  return cursor >= sql.length ? list[list.length - 1] : list[0]
}

/** 解析 FROM/JOIN 表别名（P0） */
export function parseAliases(stmtSql) {
  const bare = stripStringsAndComments(stmtSql || '')
  const aliases = new Map() // aliasLower -> table
  const tables = [] // { name, alias, schema? }
  const re =
    /\b(?:from|join)\s+(`?[A-Za-z0-9_$\u4e00-\u9fff]+`?(?:\s*\.\s*`?[A-Za-z0-9_$\u4e00-\u9fff]+`?)?)(?:\s+(?:as\s+)?(`?[A-Za-z0-9_$\u4e00-\u9fff]+`?))?/gi
  let m
  while ((m = re.exec(bare))) {
    let rawTable = m[1].replace(/\s+/g, '').replace(/`/g, '')
    let schema
    let name = rawTable
    if (rawTable.includes('.')) {
      const parts = rawTable.split('.')
      schema = parts[0]
      name = parts[1]
    }
    let alias = m[2] ? m[2].replace(/`/g, '') : null
    // "FROM t alias" 时，alias 可能是关键字误吞
    if (alias && /^(where|join|left|right|inner|outer|cross|full|on|group|order|limit|having|union|set|values)$/i.test(alias)) {
      alias = null
    }
    const rec = { name, alias, schema }
    tables.push(rec)
    const key = (alias || name).toLowerCase()
    aliases.set(key, rec)
  }
  return { aliases, tables }
}

/** 危险 SQL 检测（DB-D3.8） */
export function detectDangerousSql(sql) {
  const bare = stripStringsAndComments(sql || '').trim()
  if (!bare) return null
  const upper = bare.toUpperCase()
  if (/\b(DROP|TRUNCATE)\b/.test(upper)) {
    return { level: 'danger', reason: '包含 DROP/TRUNCATE' }
  }
  if (/\bALTER\b/.test(upper)) {
    return { level: 'warn', reason: '包含 ALTER' }
  }
  if (/\bUPDATE\b[\s\S]*\bSET\b/i.test(bare) && !/\bWHERE\b/i.test(bare)) {
    return { level: 'danger', reason: '无 WHERE 的 UPDATE' }
  }
  if (/\bDELETE\s+FROM\b/i.test(bare) && !/\bWHERE\b/i.test(bare)) {
    return { level: 'danger', reason: '无 WHERE 的 DELETE' }
  }
  return null
}
