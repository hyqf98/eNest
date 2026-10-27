import { normalizeSearchText } from '@shared/search'
import type { QuickThemeCatalogItem, QuickThemeOpenedReceipt } from '@shared/types/quickTheme'

export interface DefaultQuickUsage {
  version: 1
  recent: Array<{ stateKey: string; ts: number; count: number }>
  queryPreferences: Array<{ query: string; stateKey: string }>
}

export type DefaultQuickOpened = QuickThemeOpenedReceipt

const RECENT_LIMIT = 20
const PREFERENCE_LIMIT = 100
const QUERY_LIMIT = 32
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
const timestamp = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
const useCount = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1
const normalizedQuery = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 4_096) return ''
  const query = normalizeSearchText(value)
  return query.length <= QUERY_LIMIT ? query : ''
}

export const emptyDefaultQuickUsage = (): DefaultQuickUsage => ({ version: 1, recent: [], queryPreferences: [] })

/** The default provider owns this schema; the host stores only an opaque JSON document. */
export function readDefaultQuickUsage(value: unknown): DefaultQuickUsage {
  if (!record(value) || value.version !== 1) return emptyDefaultQuickUsage()
  const next = emptyDefaultQuickUsage(), keys = new Set<string>(), queries = new Set<string>()
  for (const entry of Array.isArray(value.recent) ? value.recent.slice(0, 256) : []) {
    if (!record(entry) || !validKey(entry.stateKey) || !timestamp(entry.ts) || keys.has(entry.stateKey)) continue
    keys.add(entry.stateKey)
    next.recent.push({ stateKey: entry.stateKey, ts: timestamp(entry.ts), count: useCount(entry.count) })
    if (next.recent.length === RECENT_LIMIT) break
  }
  for (const entry of Array.isArray(value.queryPreferences) ? value.queryPreferences.slice(0, 256) : []) {
    if (!record(entry) || !validKey(entry.stateKey)) continue
    const query = normalizedQuery(entry.query)
    if (!query || queries.has(query)) continue
    queries.add(query)
    next.queryPreferences.push({ query, stateKey: entry.stateKey })
    if (next.queryPreferences.length === PREFERENCE_LIMIT) break
  }
  return next
}

/** Legacy target identities are read only by the trusted source-bundled provider. */
export function defaultQuickLegacyIdentities(value: unknown): string[] {
  if (!record(value)) return []
  const ids = new Set<string>()
  const entries = [
    ...(Array.isArray(value.recent) ? value.recent.slice(0, RECENT_LIMIT) : []),
    ...(Array.isArray(value.queryPreferences) ? value.queryPreferences.slice(0, PREFERENCE_LIMIT) : [])
  ]
  for (const entry of entries) {
    if (record(entry) && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 4_096) ids.add(entry.id)
  }
  return [...ids]
}

export function migrateDefaultQuickUsage(value: unknown, identities: ReadonlyMap<string, string>): DefaultQuickUsage {
  if (!record(value)) return emptyDefaultQuickUsage()
  return readDefaultQuickUsage({ version: 1,
    recent: (Array.isArray(value.recent) ? value.recent.slice(0, RECENT_LIMIT) : []).flatMap(entry => {
      if (!record(entry) || typeof entry.id !== 'string') return []
      const stateKey = identities.get(entry.id)
      return stateKey ? [{ stateKey, ts: entry.ts, count: entry.count }] : []
    }),
    queryPreferences: (Array.isArray(value.queryPreferences) ? value.queryPreferences.slice(0, PREFERENCE_LIMIT) : []).flatMap(entry => {
      if (!record(entry) || typeof entry.id !== 'string') return []
      const stateKey = identities.get(entry.id)
      return stateKey ? [{ query: entry.query, stateKey }] : []
    })
  })
}

export function recordDefaultQuickOpened(current: DefaultQuickUsage, opened: DefaultQuickOpened): DefaultQuickUsage {
  if (!validKey(opened.stateKey) || !timestamp(opened.at)) return current
  const previous = current.recent.find(entry => entry.stateKey === opened.stateKey)
  const recent = [{ stateKey: opened.stateKey, ts: opened.at, count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1) },
    ...current.recent.filter(entry => entry.stateKey !== opened.stateKey)].slice(0, RECENT_LIMIT)
  const query = normalizedQuery(opened.query)
  return { version: 1, recent, queryPreferences: query
    ? [{ query, stateKey: opened.stateKey }, ...current.queryPreferences.filter(entry => entry.query !== query)].slice(0, PREFERENCE_LIMIT)
    : current.queryPreferences }
}

export function projectDefaultQuickUsage<T extends QuickThemeCatalogItem>(catalog: T[], usage: DefaultQuickUsage, query: string) {
  const recent = new Map(usage.recent.map(entry => [entry.stateKey, entry]))
  const normalized = normalizedQuery(query)
  const preferred = normalized ? usage.queryPreferences.find(entry => entry.query === normalized)?.stateKey : undefined
  return catalog.map(item => {
    const used = item.stateKey ? recent.get(item.stateKey) : undefined
    return { ...item, lastUsedTs: used?.ts, useCount: used?.count, preferred: Boolean(item.stateKey && item.stateKey === preferred) }
  })
}
