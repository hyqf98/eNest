import { useEffect, useMemo, useRef, useState } from 'react'
import type { QuickCommandKind } from '@shared/types/quick'
import { ACTION_COPY, namesOf, type DefaultQuickMatch, type DefaultSearchEntry } from './catalogPolicy'
import type { QuickNameHit, QuickNameRow } from './nameSearchTypes'
import { createNameSearch } from './nameSearchClient'

export function useQuickNameSearch<T extends DefaultSearchEntry>(
  catalog: T[], query: string, filter: QuickCommandKind | null, enabled: boolean, paused: boolean, requestRevision: number, preferredStateKey?: string
) {
  const client = useRef<ReturnType<typeof createNameSearch> | null>(null)
  const indexRef = useRef<{ rows: QuickNameRow[]; revision: number }>({ rows: [], revision: 0 })
  const entriesRef = useRef<T[]>([])
  const [visible, setVisible] = useState(() => !document.hidden)
  const entries = useMemo(() => {
    const next = catalog.filter(item => !item.content && !item.provider), previous = entriesRef.current
    if (next.length === previous.length && next.every((item, index) => item === previous[index])) return previous
    entriesRef.current = next
    return next
  }, [catalog])
  const index = useMemo(() => {
    const previous = indexRef.current
    const unchanged = entries.length === previous.rows.length && entries.every((item, position) => {
      const row = previous.rows[position], names = namesOf(item)
      return item.id === row.key && item.kind === row.kind && item.title === row.title && names.length === row.names.length
        && (item.textInput?.trigger === 'prefix') === row.prefix
        && names.every((name, nameIndex) => name === row.names[nameIndex])
    })
    if (unchanged) return previous
    const next = { rows: entries.map(item => ({ key: item.id, kind: item.kind, title: item.title, names: namesOf(item), prefix: item.textInput?.trigger === 'prefix' })), revision: previous.revision + 1 }
    indexRef.current = next
    return next
  }, [entries])
  const rows = index.rows, signature = String(index.revision)
  const positions = useMemo(() => {
    const next = new Map<string, number[]>()
    entries.forEach((item, index) => { if (item.stateKey) next.set(item.stateKey, [...(next.get(item.stateKey) ?? []), index]) })
    return next
  }, [entries])
  const preferred = useMemo(() => preferredStateKey ? positions.get(preferredStateKey) ?? [] : [], [positions, preferredStateKey])
  const key = useMemo(() => JSON.stringify([signature, query, filter, preferred, requestRevision]), [signature, query, filter, preferred, requestRevision])
  const [result, setResult] = useState<{ key: string; hits: QuickNameHit[]; error?: string }>({ key: '', hits: [] })

  useEffect(() => {
    const sync = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  useEffect(() => {
    if (!enabled) { client.current?.dispose(); client.current = null; return }
    // A visible, already opened Quick prepares safe text before the first key.
    // Hidden windows and IME pause new jobs without discarding the prepared index.
    if (!visible || paused || !rows.length) return
    const controller = new AbortController()
    try {
      if (!client.current || client.current.disposed) client.current = createNameSearch()
      void client.current.search(rows, signature, query, filter, preferred, controller.signal)
        .then(hits => { if (!controller.signal.aborted) setResult({ key, hits }) })
        .catch(() => { if (!controller.signal.aborted) setResult({ key, hits: [], error: '搜索组件加载失败，请重试。' }) })
    } catch { setResult({ key, hits: [], error: '搜索组件加载失败，请重试。' }) }
    return () => controller.abort()
    // Rows exclude handles/icons/provider payloads; retries reuse the same index.
  }, [enabled, visible, paused, key])
  useEffect(() => () => { client.current?.dispose(); client.current = null }, [])

  const matches = useMemo(() => result.key !== key ? [] : result.hits.flatMap(({ index, keyword, prefix }): Array<DefaultQuickMatch<T>> => {
    const item = entries[index]
    return item ? [{ ...item, title: item.action ? ACTION_COPY[item.action].title : item.kind === 'plugin' ? keyword : item.title, group: 'best', ...(prefix ? { prefix } : {}) }] : []
  }), [result, key, entries])
  return { matches, pending: enabled && visible && !paused && rows.length > 0 && Boolean(query.trim()) && result.key !== key,
    error: enabled && !paused && result.key === key ? result.error : undefined }
}
