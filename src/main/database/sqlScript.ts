/**
 * Pure SQL script boundaries shared with the editor through generate-db-execution-parser.mjs.
 * A unit is a server request, not necessarily one semicolon-delimited statement. Client
 * directives never reach a driver; original UTF-16 offsets are retained for diagnostics.
 */
export type SqlUnitKind = 'statement' | 'definition' | 'block' | 'batch' | 'directive'
export interface SqlScriptUnit {
  sql: string
  start: number
  end: number
  contentEnd: number
  line: number
  endLine: number
  kind: SqlUnitKind
  delimiter: string
  error?: string
}
export interface SqlLexeme { kind: 'word' | 'symbol' | 'string' | 'identifier' | 'comment'; text: string; upper: string; start: number; end: number; error?: string }
const aliases: Record<string, string> = {
  mariadb: 'mysql', tidb: 'mysql', oceanbase: 'mysql', doris: 'mysql', starrocks: 'mysql',
  postgresql: 'postgres', timescale: 'postgres', cockroachdb: 'postgres', yugabytedb: 'postgres', questdb: 'postgres',
  tsql: 'mssql', sqlserver: 'mssql'
}
export function sqlDialect(value = 'generic'): string { const name = String(value).toLowerCase(); return aliases[name] || name }
const wordChar = /[\p{L}\p{N}_$]/u
const wordStart = /[\p{L}_$]/u

/** Quote/comment handling is dialect aware, including MySQL -- whitespace and PG E strings. */
export function lexSql(source: string, dialectValue = 'generic'): SqlLexeme[] {
  const dialect = sqlDialect(dialectValue), mysql = dialect === 'mysql', generic = dialect === 'generic'
  const tokens: SqlLexeme[] = []
  let i = 0
  const emit = (kind: SqlLexeme['kind'], start: number, error?: string) => {
    const text = source.slice(start, i); tokens.push({ kind, text, upper: text.toUpperCase(), start, end: i, ...(error ? { error } : {}) })
  }
  while (i < source.length) {
    const start = i, ch = source[i]!, next = source[i + 1]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '-' && next === '-' && (!mysql || !source[i + 2] || /[\s\x00-\x1f]/.test(source[i + 2]!)) || ch === '#' && (mysql || generic)) {
      while (i < source.length && source[i] !== '\n') i++
      emit('comment', start); continue
    }
    if (ch === '/' && next === '*') {
      const executable = source[i + 2] === '!' || source.slice(i + 2, i + 4).toUpperCase() === 'M!'
      i += 2; let nesting = 1
      while (i < source.length && nesting) {
        if (source.slice(i, i + 2) === '/*') { nesting++; i += 2 }
        else if (source.slice(i, i + 2) === '*/') { nesting--; i += 2 }
        else i++
      }
      emit('comment', start, executable ? 'Executable SQL comments are not accepted; use explicit statements' : nesting ? 'Unterminated SQL comment' : undefined); continue
    }
    const dollar = ch === '$' && (dialect === 'postgres' || generic) && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i))?.[0]
    if (dollar) {
      const end = source.indexOf(dollar, i + dollar.length); i = end < 0 ? source.length : end + dollar.length
      emit('string', start, end < 0 ? 'Unterminated dollar-quoted SQL value' : undefined); continue
    }
    // q'[...]', q'{...}', q'(...)', q'<...>' and arbitrary single-character delimiters.
    const alternative = dialect === 'oracle' && /^(?:n?q)'/i.exec(source.slice(i))?.[0]
    if (alternative && (i === 0 || !wordChar.test(source[i - 1]!))) {
      const opening = source[i + alternative.length], closing = ({ '[': ']', '{': '}', '(': ')', '<': '>' } as Record<string, string>)[opening!] || opening
      const end = opening && !/\s/.test(opening) ? source.indexOf(`${closing}'`, i + alternative.length + 1) : -1
      i = end < 0 ? source.length : end + 2; emit('string', start, end < 0 ? 'Unterminated Oracle alternative-quoted value' : undefined); continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[' && ['mssql', 'sqlite', 'generic'].includes(dialect)) {
      const closing = ch === '[' ? ']' : ch
      const escaped = mysql || generic || dialect === 'postgres' && ch === "'" && /(?:^|[^\p{L}\p{N}_$])E$/iu.test(source.slice(Math.max(0, i - 2), i))
      i++; let closed = false
      while (i < source.length) {
        if (escaped && source[i] === '\\' && (ch === "'" || ch === '"' && (mysql || generic))) { i = Math.min(source.length, i + 2); continue }
        if (source[i] === closing) { if (source[i + 1] === closing) { i += 2; continue }; i++; closed = true; break }
        i++
      }
      emit(ch === "'" ? 'string' : 'identifier', start, closed ? undefined : 'Unterminated SQL quoted value'); continue
    }
    if (wordStart.test(ch)) { i++; while (i < source.length && wordChar.test(source[i]!)) i++; emit('word', start); continue }
    i++; emit('symbol', start)
  }
  return tokens
}

export function maskSql(source: string, dialect = 'generic', keepIdentifiers = false): string {
  return maskLexemes(source, lexSql(source, dialect), keepIdentifiers, true)
}
function maskLexemes(source: string, tokens: SqlLexeme[], keepIdentifiers = false, strict = false): string {
  let masked = '', end = 0
  for (const token of tokens) {
    if (strict && token.error) throw new Error(token.error)
    masked += source.slice(end, token.start)
    if (token.kind === 'string' || token.kind === 'comment' || token.kind === 'identifier') {
      const identifier = token.kind === 'identifier' && keepIdentifiers
      masked += identifier ? ` ${token.text.slice(1, -1)} ` : token.text.replace(/[^\r\n]/g, ' ')
    } else masked += token.text
    end = token.end
  }
  return masked + source.slice(end)
}

const routineNames = new Set(['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'EVENT', 'PACKAGE'])
const declarationModifiers = new Set(['TEMP', 'TEMPORARY', 'UNIQUE', 'FORCE', 'NO', 'EDITIONABLE', 'NONEDITIONABLE', 'GLOBAL', 'LOCAL', 'UNLOGGED', 'CONSTRAINT', 'AGGREGATE'])
function declaration(tokens: SqlLexeme[]): { name: string; index: number } {
  if (!['CREATE', 'ALTER'].includes(tokens[0]?.upper || '')) return { name: '', index: -1 }
  let i = 1
  if (tokens[i]?.upper === 'OR' && ['REPLACE', 'ALTER'].includes(tokens[i + 1]?.upper || '')) i += 2
  while (declarationModifiers.has(tokens[i]?.upper || '')) i++
  if (tokens[i]?.upper === 'DEFINER') {
    i++; if (tokens[i]?.text === '=') i++; i++
    if (tokens[i]?.text === '(' && tokens[i + 1]?.text === ')') i += 2
    if (tokens[i]?.text === '@') i += 2
  }
  return { name: tokens[i]?.upper || '', index: i }
}
function unlabel(tokens: SqlLexeme[], dialect: string): SqlLexeme[] {
  let offset = 0
  if (dialect === 'oracle') {
    while (tokens[offset]?.text === '<' && tokens[offset + 1]?.text === '<' && tokens[offset + 3]?.text === '>' && tokens[offset + 4]?.text === '>') offset += 5
  } else if (dialect === 'mysql' && ['word', 'identifier'].includes(tokens[0]?.kind) && tokens[1]?.text === ':') offset = 2
  return tokens.slice(offset)
}
function unitKind(tokens: SqlLexeme[], dialect: string): SqlUnitKind {
  const lead = unlabel(tokens, dialect), decl = declaration(lead)
  if (routineNames.has(decl.name) || dialect === 'oracle' && decl.name === 'TYPE') return 'definition'
  if (dialect === 'oracle' && ['DECLARE', 'BEGIN'].includes(lead[0]?.upper) && lead[1]?.text !== ';' && !['WORK', 'TRANSACTION'].includes(lead[1]?.upper)) return 'block'
  if (dialect === 'mysql' && lead[0]?.upper === 'BEGIN' && lead[1]?.upper === 'NOT' && lead[2]?.upper === 'ATOMIC' || dialect === 'postgres' && lead[0]?.upper === 'BEGIN' && lead[1]?.upper === 'ATOMIC') return 'block'
  return 'statement'
}

/** Never emit an inner statement from a compound definition or guarded block. */
function statementEnds(tokens: SqlLexeme[], dialect: string): Array<{ end: number; kind: SqlUnitKind; error?: string }> {
  const ends: Array<{ end: number; kind: SqlUnitKind; error?: string }> = []
  let start = 0, depth = 0, frames: string[] = [], kind: SqlUnitKind = 'statement', skipSuffix = false, started = false, oracleRoot = false
  const reset = (index: number) => { start = index + 1; depth = 0; frames = []; kind = 'statement'; skipSuffix = false; started = false; oracleRoot = false }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!, word = token.kind === 'word' ? token.upper : '', next = tokens[i + 1], previous = tokens[i - 1]
    if (token.text === '(') depth++
    else if (token.text === ')') depth = Math.max(0, depth - 1)
    const head = tokens.slice(start, Math.min(i + 3, start + 40)), classified = unitKind(head, dialect)
    if (classified !== 'statement') kind = classified
    const procedural = kind === 'block' || kind === 'definition' && ['mysql', 'oracle', 'sqlite', 'postgres'].includes(dialect)
    const lead = unlabel(head, dialect), decl = declaration(lead)
    const packageBody = dialect === 'oracle' && ['PACKAGE', 'TYPE'].includes(decl.name)
    // Package specifications and bodies can contain sibling routines. Their SQL*Plus slash
    // (or end-of-input when executing a selected definition) is the unambiguous boundary.
    if (packageBody) continue
    if (skipSuffix && ['IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT'].includes(word)) { skipSuffix = false; continue }
    skipSuffix = false
    if (procedural) {
      if (dialect === 'oracle' && !oracleRoot) { frames.push('declaration'); oracleRoot = true }
      const statementStart = !previous || previous.text === ';' || ['BEGIN', 'THEN', 'ELSE', 'DO', 'ATOMIC', 'DECLARE', 'IS', 'AS'].includes(previous.upper)
      if (dialect === 'oracle' && ['PROCEDURE', 'FUNCTION'].includes(word) && i > start + decl.index && frames.at(-1) === 'declaration' && statementStart) frames.push('declaration')
      if (word === 'DECLARE' && dialect === 'oracle' && started && statementStart) frames.push('declaration')
      if (word === 'BEGIN' && !['WORK', 'TRANSACTION', 'TRAN'].includes(next?.upper || '') && next?.text !== ';') {
        if (frames.at(-1) === 'declaration') frames[frames.length - 1] = 'BEGIN'
        else frames.push('BEGIN')
        started = true
      } else if (word === 'CASE' && started) frames.push('CASE')
      else if (started && dialect !== 'sqlite' && (word === 'LOOP' || ['IF', 'REPEAT', 'WHILE'].includes(word) && statementStart && !(word === 'WHILE' && dialect === 'oracle'))) frames.push(word)
      else if (word === 'END' && frames.length) { frames.pop(); skipSuffix = true }
    }
    if (token.text !== ';' || depth || frames.length) continue
    if (kind === 'definition' && ['oracle', 'sqlite'].includes(dialect) && !started) continue
    ends.push({ end: token.end, kind }); reset(i)
  }
  if (start < tokens.length) ends.push({ end: tokens.at(-1)!.end, kind, ...(frames.length ? { error: 'Incomplete procedural block; include its matching END' } : {}) })
  return ends
}

/** Parse the complete source before execution. Tolerant descriptors let an editor still run
 * an earlier valid statement while a later statement is unfinished. The host rejects any
 * descriptor error before issuing the first request. GO repeat counts are never guessed. */
export function planSqlScript(source: string, dialectValue = 'generic', options: { mysqlDelimiter?: boolean } = {}): SqlScriptUnit[] {
  const dialect = sqlDialect(dialectValue), lexemes = lexSql(source, dialect), masked = maskLexemes(source, lexemes)
  const units: SqlScriptUnit[] = []
  const lineAt = (offset: number) => 1 + (source.slice(0, offset).match(/\n/g)?.length || 0)
  const add = (start: number, end: number, contentEnd: number, kind: SqlUnitKind, delimiter = ';', error?: string) => {
    const localTokens = lexemes.filter(token => token.start >= start && token.start < contentEnd)
    const lexicalError = localTokens.find(token => token.error)?.error
    if (kind !== 'directive' && !localTokens.some(token => token.kind !== 'comment') && !lexicalError) return
    const raw = source.slice(start, contentEnd)
    const terminal = kind !== 'definition' && kind !== 'block' && kind !== 'batch' ? raw.replace(/;\s*$/, '') : raw
    const first = localTokens.find(token => token.kind !== 'comment')?.start ?? start
    units.push({ sql: kind === 'directive' ? '' : terminal.trim(), start, end, contentEnd, line: lineAt(first), endLine: lineAt(Math.max(first, contentEnd - 1)), kind, delimiter, ...(error || lexicalError ? { error: error || lexicalError } : {}) })
  }
  const parseRegion = (start: number, end: number, delimiter: string) => {
    const relevant = lexemes.filter(token => token.start >= start && token.start < end && token.kind !== 'comment')
    if (!relevant.length) { const invalid = lexemes.find(token => token.error && token.start >= start && token.start < end); if (invalid) add(start, end, end, 'statement', delimiter, invalid.error); return }
    if (dialect === 'mssql') { add(start, end, end, unitKind(relevant, dialect) === 'definition' ? 'definition' : 'batch', 'GO'); return }
    if (delimiter !== ';') {
      let from = start
      for (let cursor = start; cursor < end; cursor++) {
        if (!masked.startsWith(delimiter, cursor)) continue
        const inner = lexSql(source.slice(from, cursor), dialect).filter(token => token.kind !== 'comment')
        const boundaries = statementEnds(inner, dialect)
        const error = boundaries.length > 1 ? 'A custom delimiter must enclose one SQL statement or compound definition' : boundaries[0]?.error
        add(from, cursor + delimiter.length, cursor, boundaries[0]?.kind || 'statement', delimiter, error)
        from = cursor + delimiter.length; cursor = from - 1
      }
      if (masked.slice(from, end).trim()) add(from, end, end, unitKind(lexSql(source.slice(from, end), dialect).filter(token => token.kind !== 'comment'), dialect), delimiter, 'Missing custom delimiter at the end of this statement')
      return
    }
    let from = start
    for (const boundary of statementEnds(relevant, dialect)) { add(from, boundary.end, boundary.end, boundary.kind, delimiter, boundary.error); from = boundary.end }
  }
  let start = 0, delimiter = ';', offset = 0
  for (const rawLine of source.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const end = offset + rawLine.length, codeLine = masked.slice(offset, end).trim(), original = rawLine.trim()
    if (dialect === 'mysql' && options.mysqlDelimiter !== false && /^DELIMITER\b/i.test(codeLine)) {
      parseRegion(start, offset, delimiter)
      const next = /^DELIMITER\s+(\S+)\s*$/i.exec(original)?.[1]
      const valid = next && /^[!$%&*+/:;<=>?@^|~.\-]{1,16}$/.test(next) && !/--|\/\*|\*\//.test(next)
      add(offset, end, end, 'directive', delimiter, valid ? undefined : 'Invalid DELIMITER; use 1–16 punctuation characters such as $$ or //')
      if (valid) delimiter = next
      start = end
    } else if (dialect === 'mssql' && /^GO\b/i.test(codeLine)) {
      parseRegion(start, offset, ';')
      const match = /^GO(?:\s+(\d+))?\s*$/i.exec(codeLine)
      add(offset, end, end, 'directive', 'GO', !match ? 'Invalid GO batch separator' : match[1] && match[1] !== '1' ? 'GO repeat counts are not supported; use explicit batches' : undefined)
      start = end
    } else if (dialect === 'oracle' && codeLine === '/') {
      parseRegion(start, offset, ';'); add(offset, end, end, 'directive', '/'); start = end
    } else if (dialect === 'mssql' && /^(?::|!!)/.test(codeLine)) {
      parseRegion(start, offset, ';'); add(offset, end, end, 'directive', 'GO', 'SQLCMD commands are not supported; execute explicit SQL batches'); start = end
    }
    offset = end
  }
  parseRegion(start, source.length, delimiter)
  // A malformed trailing comment may follow an already-terminated statement. It still
  // invalidates execute-all before any side effect, while earlier caret units stay usable.
  for (const token of lexemes) if (token.error && !units.some(unit => unit.start <= token.start && token.start < unit.contentEnd)) add(token.start, token.end, token.end, 'statement', delimiter, token.error)
  return units
}

export function assertValidScript(units: SqlScriptUnit[]): void {
  const invalid = units.find(unit => unit.error)
  if (invalid) throw new Error(`SQL lines ${invalid.line}–${invalid.endLine}: ${invalid.error}`)
}
