import { useEffect, useMemo, useRef, useState } from 'react'
import type { QuickCommandKind } from '@shared/types/quick'
import { ACTION_COPY, namesOf, type DefaultQuickMatch, type DefaultSearchEntry } from './catalogPolicy'
import type { QuickNameHit, QuickNameRow, QuickNameSearchRequest, QuickNameSearchResponse } from './nameSearchTypes'

interface Work {
  request: QuickNameSearchRequest
  signature: string
  rows: QuickNameRow[]
  resolve(hits: QuickNameHit[]): void
  reject(error: Error): void
  detach(): void
}

/** One running query plus one latest replacement; typing never queues an unbounded worker backlog. */
function createNameSearch() {
  const worker = new Worker(new URL('./nameSearchWorker.ts', import.meta.url), { type: 'module' })
  let sequence = 0, signature = '', disposed = false
  let active: Work | undefined, queued: Work | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const abortError = () => new DOMException('Search superseded', 'AbortError')
  const retire = (work: Work | undefined, error: Error) => { work?.detach(); work?.reject(error) }
  const dispose = (error: Error = abortError()) => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    worker.terminate()
    retire(active, error); retire(queued, error)
    active = queued = undefined
  }
  const pump = () => {
    if (disposed || active || !queued) return
    active = queued; queued = undefined
    const work = active
    const rows = signature === work.signature ? undefined : work.rows
    signature = work.signature
    timer = setTimeout(() => dispose(new Error('Name search timed out')), 10_000)
    worker.postMessage({ ...work.request, ...(rows ? { rows } : {}) } satisfies QuickNameSearchRequest)
  }
  worker.onmessage = ({ data }: MessageEvent<QuickNameSearchResponse>) => {
    if (!active || data.id !== active.request.id) return
    clearTimeout(timer)
    const work = active
    active = undefined
    work.detach(); work.resolve(data.hits)
    try { pump() } catch { dispose(new Error('Name search unavailable')) }
  }
  worker.onerror = () => dispose(new Error('Name search unavailable'))
  worker.onmessageerror = () => dispose(new Error('Invalid name search response'))
  return {
    get disposed() { return disposed },
    search(rows: QuickNameRow[], nextSignature: string, query: string, filter: QuickCommandKind | null, preferred: number[], signal: AbortSignal) {
      if (disposed || signal.aborted) return Promise.reject(abortError())
      return new Promise<QuickNameHit[]>((resolve, reject) => {
        retire(queued, abortError())
        const work: Work = {
          request: { id: ++sequence, query, filter, preferred }, signature: nextSignature, rows, resolve, reject,
          detach: () => signal.removeEventListener('abort', abort)
        }
        const abort = () => { if (queued === work) queued = undefined; retire(work, abortError()) }
        signal.addEventListener('abort', abort, { once: true })
        queued = work
        try { pump() } catch { dispose(new Error('Name search unavailable')) }
      })
    },
    dispose
  }
}

export function useQuickNameSearch<T extends DefaultSearchEntry>(
  catalog: T[], query: string, filter: QuickCommandKind | null, enabled: boolean, paused: boolean, requestRevision: number
) {
  const client = useRef<ReturnType<typeof createNameSearch> | null>(null)
  const indexRef = useRef<{ rows: QuickNameRow[]; revision: number }>({ rows: [], revision: 0 })
  const [visible, setVisible] = useState(() => !document.hidden)
  const entries = useMemo(() => catalog.filter(item => !item.content && !item.provider), [catalog])
  const index = useMemo(() => {
    const previous = indexRef.current
    const unchanged = entries.length === previous.rows.length && entries.every((item, position) => {
      const row = previous.rows[position], names = namesOf(item)
      return item.kind === row.kind && item.title === row.title && names.length === row.names.length
        && names.every((name, nameIndex) => name === row.names[nameIndex])
    })
    if (unchanged) return previous
    const next = { rows: entries.map(item => ({ kind: item.kind, title: item.title, names: namesOf(item) })), revision: previous.revision + 1 }
    indexRef.current = next
    return next
  }, [entries])
  const rows = index.rows, signature = String(index.revision)
  const preferred = useMemo(() => entries.flatMap((item, index) => item.preferred ? [index] : []), [entries])
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

  const matches = useMemo(() => result.key !== key ? [] : result.hits.flatMap(({ index, keyword }): Array<DefaultQuickMatch<T>> => {
    const item = entries[index]
    return item ? [{ ...item, title: item.action ? ACTION_COPY[item.action].title : item.kind === 'plugin' ? keyword : item.title, group: 'best' }] : []
  }), [result, key, entries])
  return { matches, pending: enabled && visible && !paused && rows.length > 0 && Boolean(query.trim()) && result.key !== key,
    error: enabled && !paused && result.key === key ? result.error : undefined }
}
