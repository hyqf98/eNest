import type { DbCompareInput, DbCompareResult, DbCompareValueRule } from '@shared/types/db-workbench'
import type { QueryResult } from '@shared/types/ssh-db'
import { parse as parseJson, isLosslessNumber } from 'lossless-json'

export function canonicalValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'bigint') return `bigint:${value}`
  if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']'
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalValue((value as Record<string, unknown>)[key])).join(',') + '}'
  return `${typeof value}:${JSON.stringify(value)}`
}

function decimal(value: unknown): string {
  const text = String(value).trim()
  const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i.exec(text)
  if (!match) throw new Error('Numeric comparison encountered a non-numeric value; choose another rule')
  const exponent = Number(match[3] || 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000000) throw new Error('Numeric comparison exponent exceeds the supported range')
  const parts = match[2]!.split('.')
  let digits = parts.join('').replace(/^0+/, '')
  if (!digits) return '0'
  const zeros = /0*$/.exec(digits)![0].length
  digits = digits.slice(0, digits.length - zeros)
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent - (parts[1]?.length || 0) + zeros}`
}

export function comparisonValue(value: unknown, rule: DbCompareValueRule): string {
  if (value === null || value === undefined) return canonicalValue(value)
  if (rule === 'strict') return canonicalValue(value)
  if (rule === 'numeric') {
    if (!['number', 'string', 'bigint'].includes(typeof value)) throw new Error('Numeric comparison requires number or decimal text values')
    return `numeric:${decimal(value)}`
  }
  if (rule === 'text') return `text:${typeof value === 'object' ? canonicalValue(value) : String(value)}`
  if (rule === 'json') {
    let parsed: unknown = value
    if (typeof value === 'string') {
      try { parsed = parseJson(value) } catch { throw new Error('JSON comparison encountered invalid JSON text') }
    }
    const jsonValue = (item: unknown): string => {
      if (typeof item === 'number' || typeof item === 'bigint' || isLosslessNumber(item)) return `number:${decimal(isLosslessNumber(item) ? item.value : item)}`
      if (Array.isArray(item)) return '[' + item.map(jsonValue).join(',') + ']'
      if (item && typeof item === 'object') return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + jsonValue((item as Record<string, unknown>)[key])).join(',') + '}'
      return canonicalValue(item)
    }
    return `json:${jsonValue(parsed)}`
  }
  throw new Error('Unknown comparison value rule')
}

/** Duplicate keys are ambiguous, never silently paired or overwritten. This module cannot write. */
export function compareResults(left: QueryResult, right: QueryResult, options: string[] | Pick<DbCompareInput, 'keyColumns' | 'columnMappings' | 'defaultRule'>): DbCompareResult {
  const config = Array.isArray(options) ? { keyColumns: options } : options
  const keys = config.keyColumns
  if (!keys.length || new Set(keys).size !== keys.length) throw new Error('Choose one or more distinct comparison key columns')
  for (const result of [left, right]) {
    if (new Set(result.columns.map(column => column.name)).size !== result.columns.length) throw new Error('Comparison requires unique column names; alias duplicate result columns')
  }
  const leftNames = left.columns.map(column => column.name), rightNames = right.columns.map(column => column.name)
  const mappings: Array<{ left: string; right: string; rule?: DbCompareValueRule }> = config.columnMappings?.length ? config.columnMappings : [...new Set([...leftNames, ...rightNames])].map(name => ({ left: name, right: name }))
  if (new Set(mappings.map(item => item.left)).size !== mappings.length || new Set(mappings.map(item => item.right)).size !== mappings.length) throw new Error('Map each column only once')
  const prepared = mappings.map(item => {
    const rule = item.rule || config.defaultRule || 'strict'
    if (!['strict', 'text', 'numeric', 'json'].includes(rule)) throw new Error('Unknown comparison value rule')
    const leftIndex = leftNames.indexOf(item.left), rightIndex = rightNames.indexOf(item.right)
    if (config.columnMappings?.length && (leftIndex < 0 || rightIndex < 0)) throw new Error('Mapped column is missing from a result')
    return { ...item, rule, leftIndex, rightIndex }
  })
  const keyMappings = keys.map(key => {
    const mapping = prepared.find(item => item.left === key)
    if (!mapping || mapping.leftIndex < 0 || mapping.rightIndex < 0) throw new Error('Comparison key column is missing from a result or its mapping')
    return mapping
  })
  const map = (result: QueryResult, side: 'leftIndex' | 'rightIndex') => {
    const grouped = new Map<string, unknown[][]>()
    for (const row of result.rows) {
      const key = canonicalValue(keyMappings.map(mapping => comparisonValue(row[mapping[side]], mapping.rule)))
      const group = grouped.get(key) || []; group.push(row); grouped.set(key, group)
    }
    return grouped
  }
  const l = map(left, 'leftIndex'), r = map(right, 'rightIndex')
  const rows: DbCompareResult['rows'] = [...new Set([...l.keys(), ...r.keys()])].map(key => {
    const a = l.get(key) || [], b = r.get(key) || []
    const equal = a.length === 1 && b.length === 1 && prepared.every(mapping => mapping.leftIndex >= 0 && mapping.rightIndex >= 0 && comparisonValue(a[0]![mapping.leftIndex], mapping.rule) === comparisonValue(b[0]![mapping.rightIndex], mapping.rule))
    const status = a.length > 1 || b.length > 1 ? 'ambiguous' : !a.length ? 'right-only' : !b.length ? 'left-only' : equal ? 'equal' : 'different'
    return { key, status, left: a[0], right: b[0] }
  })
  return { left, right, rows, partial: !!left.truncated || !!right.truncated, snapshot: 'independent-query-snapshots', comparedAt: Date.now(),
    columnMappings: prepared.map(({ left, right, rule }) => ({ left, right, rule })),
    coverage: { leftRows: left.rows.length, rightRows: right.rows.length, leftTruncated: !!left.truncated, rightTruncated: !!right.truncated } }
}
