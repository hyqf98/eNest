import { useEffect, useMemo, useState } from 'react'
import type { QuickThemeCatalogItem } from '@shared/types/quickTheme'
import { matchDefaultQuickContent } from './patternMatching'

/** Provider/thumbnail updates and query handle rotation do not invalidate static declarations. */
export function useQuickContentMatches(catalog: QuickThemeCatalogItem[], query: string, enabled: boolean, retryRevision: number) {
  const [visible, setVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const sync = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  const entries = useMemo(() => catalog.filter(item => item.content?.type === 'regex' || item.content?.type === 'over'), [catalog])
  const signature = useMemo(() => JSON.stringify(entries.map(item => item.content)), [entries])
  const key = useMemo(() => JSON.stringify([signature, query, retryRevision]), [signature, query, retryRevision])
  const [result, setResult] = useState<{ key: string; indices: Set<string> }>({ key: '', indices: new Set() })
  const pending = enabled && visible && Boolean(query.trim()) && entries.length > 0 && result.key !== key
  useEffect(() => {
    if (!enabled || !visible || !query.trim() || !entries.length) return
    const controller = new AbortController()
    const rules = entries.map((item, index) => ({ id: String(index), content: item.content }))
    void matchDefaultQuickContent(rules, query, controller.signal).then(indices => {
      if (!controller.signal.aborted) setResult({ key, indices })
    })
    return () => controller.abort()
  }, [enabled, visible, key])
  const matches = useMemo(() => new Set(result.key === key
    ? entries.flatMap((item, index) => result.indices.has(String(index)) ? [item.id] : []) : []), [result, key, entries])
  return { matches, pending }
}
