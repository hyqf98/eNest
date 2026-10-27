import type { QuickContentMatch } from '@shared/types/quick'

/** Plugin expressions run in a disposable renderer worker, never Electron's main/UI thread. */
export function matchDefaultQuickContent(
  catalog: Array<{ id: string; content?: QuickContentMatch }>, text: string, signal?: AbortSignal
): Promise<Set<string>> {
  const rules = catalog
    .filter(item => item.content && (item.content.type === 'regex' || item.content.type === 'over'))
    .map(item => ({ id: item.id, ...item.content! }))
  if (!rules.length || !text.trim() || signal?.aborted || typeof Worker === 'undefined') return Promise.resolve(new Set())
  let worker: Worker
  try { worker = new Worker(new URL('./patternWorker.ts', import.meta.url), { type: 'module' }) }
  catch { return Promise.resolve(new Set()) }
  return new Promise(resolve => {
    const matches = new Set<string>()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      resolve(matches)
    }
    const abort = () => { matches.clear(); finish() }
    let timer = setTimeout(finish, 3_000)
    worker.onmessage = ({ data }: MessageEvent<{ id?: string; started?: boolean; done?: boolean }>) => {
      if (data.started) { clearTimeout(timer); timer = setTimeout(finish, 180) }
      if (typeof data.id === 'string') matches.add(data.id)
      if (data.done) finish()
    }
    worker.onerror = finish
    signal?.addEventListener('abort', abort, { once: true })
    worker.postMessage({ text, rules })
  })
}
