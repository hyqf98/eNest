import type { QuickNameHit, QuickNameRow, QuickNameSearchRequest, QuickNameSearchResponse } from './nameSearchTypes'

interface Work {
  id: number
  rows: QuickNameRow[]
  signature: string
  query: string
  filter: QuickNameSearchRequest['filter']
  preferred: number[]
  resolve(hits: QuickNameHit[]): void
  reject(error: Error): void
  detach(): void
}

/** One running job and one latest replacement; only changed index rows cross the worker boundary. */
export function createNameSearch() {
  const worker = new Worker(new URL('./nameSearchWorker.ts', import.meta.url), { type: 'module' })
  let sequence = 0, disposed = false
  let active: Work | undefined, queued: Work | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let indexed = new Map<string, string>(), order: string[] = []
  let indexedRows: QuickNameRow[] | undefined, indexedSignature: string | undefined
  const abortError = () => new DOMException('Search superseded', 'AbortError')
  const retire = (work: Work | undefined, error: Error) => { work?.detach(); work?.reject(error) }
  const dispose = (error: Error = abortError()) => {
    if (disposed) return
    disposed = true; clearTimeout(timer); worker.terminate()
    retire(active, error); retire(queued, error); active = queued = undefined
    indexed.clear(); order = []; indexedRows = undefined; indexedSignature = undefined
  }
  const pump = () => {
    if (disposed || active || !queued) return
    active = queued; queued = undefined
    const work = active
    let delta: QuickNameSearchRequest['index']
    if (work.rows !== indexedRows || work.signature !== indexedSignature) {
      const next = new Map<string, string>(), upsert: QuickNameRow[] = []
      const nextOrder = work.rows.map(row => {
        const signature = JSON.stringify([row.kind, row.title, row.names, row.prefix])
        next.set(row.key, signature)
        if (indexed.get(row.key) !== signature) upsert.push(row)
        return row.key
      })
      const remove = [...indexed.keys()].filter(key => !next.has(key))
      const reordered = nextOrder.length !== order.length || nextOrder.some((key, index) => key !== order[index])
      if (upsert.length || remove.length || reordered) delta = { upsert, remove, ...(reordered ? { order: nextOrder } : {}) }
      indexed = next; order = nextOrder; indexedRows = work.rows; indexedSignature = work.signature
    }
    timer = setTimeout(() => dispose(new Error('Name search timed out')), 10_000)
    worker.postMessage({ id: work.id, query: work.query, filter: work.filter, preferred: work.preferred,
      ...(delta ? { index: delta } : {}) } satisfies QuickNameSearchRequest)
  }
  worker.onmessage = ({ data }: MessageEvent<QuickNameSearchResponse>) => {
    if (!active || data.id !== active.id) return
    clearTimeout(timer)
    const work = active; active = undefined
    work.detach(); work.resolve(data.hits)
    try { pump() } catch { dispose(new Error('Name search unavailable')) }
  }
  worker.onerror = () => dispose(new Error('Name search unavailable'))
  worker.onmessageerror = () => dispose(new Error('Invalid name search response'))
  return {
    get disposed() { return disposed },
    search(rows: QuickNameRow[], signature: string, query: string, filter: QuickNameSearchRequest['filter'], preferred: number[], signal: AbortSignal) {
      if (disposed || signal.aborted) return Promise.reject<QuickNameHit[]>(abortError())
      return new Promise<QuickNameHit[]>((resolve, reject) => {
        retire(queued, abortError())
        const work: Work = { id: ++sequence, rows, signature, query, filter, preferred, resolve, reject,
          detach: () => signal.removeEventListener('abort', abort) }
        const abort = () => { if (queued === work) queued = undefined; retire(work, abortError()) }
        signal.addEventListener('abort', abort, { once: true }); queued = work
        try { pump() } catch { dispose(new Error('Name search unavailable')) }
      })
    },
    dispose
  }
}
