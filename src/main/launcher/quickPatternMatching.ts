import { Worker } from 'node:worker_threads'
import { logWarn } from '@main/logs/logService'

export interface QuickPatternRule {
  key: number
  type: 'regex' | 'over'
  source?: string
  flags?: string
  minLength: number
  maxLength?: number
}

/** A plugin's expression must never run on Electron's main thread. */
const WORKER_SOURCE = String.raw`
  const { parentPort } = require('node:worker_threads');
  const patterns = new Map();
  function pattern(source, flags) {
    const key = JSON.stringify([source, flags]);
    if (patterns.has(key)) return patterns.get(key);
    let compiled = null;
    try { compiled = new RegExp(source, flags); } catch {}
    if (patterns.size >= 256) patterns.delete(patterns.keys().next().value);
    patterns.set(key, compiled);
    return compiled;
  }
  parentPort.on('message', ({ id, text, rules }) => {
    parentPort.postMessage({ id, started: true });
    for (const rule of rules) {
      if (text.length < rule.minLength || text.length > (rule.maxLength ?? Infinity)) continue;
      const regex = rule.source === undefined ? null : pattern(rule.source, rule.flags || '');
      if (rule.source !== undefined && !regex) continue;
      if (regex) regex.lastIndex = 0;
      const accepted = rule.type === 'regex' ? Boolean(regex && regex.test(text)) : !regex || !regex.test(text);
      if (accepted) parentPort.postMessage({ id, key: rule.key });
    }
    parentPort.postMessage({ id, done: true });
  });
`

const MATCH_TIMEOUT_MS = 180
const START_TIMEOUT_MS = 3_000
const IDLE_TIMEOUT_MS = 5_000
let worker: Worker | null = null
let nextRequest = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
let disposed = false
const terminations = new Set<Promise<number>>()
const pending = new Map<number, { keys: Set<number>; started(): void; finish(): void }>()

function stopWorker(target: Worker): void {
  if (worker !== target) return
  worker = null
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  for (const request of [...pending.values()]) request.finish()
  const termination = target.terminate().catch(() => 0)
  terminations.add(termination)
  void termination.finally(() => terminations.delete(termination))
}

function getWorker(): Worker {
  if (worker) return worker
  const current = new Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32 } })
  worker = current
  current.on('message', (message: { id: number; key?: number; started?: boolean; done?: boolean }) => {
    if (worker !== current) return
    const request = pending.get(message.id)
    if (!request) return
    if (message.started) request.started()
    if (message.key !== undefined) request.keys.add(message.key)
    if (message.done) request.finish()
  })
  current.on('error', () => stopWorker(current))
  current.on('exit', () => stopWorker(current))
  current.unref()
  return current
}

/** Batch matching preserves input verbatim; abort/timeout also stop runaway expressions. */
export function matchQuickPatterns(rules: QuickPatternRule[], text: string, signal?: AbortSignal): Promise<Set<number>> {
  if (!rules.length || signal?.aborted || disposed) return Promise.resolve(new Set())
  let current: Worker
  try { current = getWorker() }
  catch {
    logWarn('quick', 'text command worker could not be started')
    return Promise.resolve(new Set())
  }
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const id = ++nextRequest
  return new Promise((resolve) => {
    const keys = new Set<number>()
    const finish = () => {
      if (!pending.delete(id)) return
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(keys)
      if (!pending.size && worker === current) {
        idleTimer = setTimeout(() => stopWorker(current), IDLE_TIMEOUT_MS)
        idleTimer.unref?.()
      }
    }
    const abort = () => { keys.clear(); stopWorker(current) }
    const timeout = () => {
      logWarn('quick', 'text command matching exceeded its time budget')
      stopWorker(current)
    }
    // Worker startup can be slow on a busy machine. Bound it separately so valid
    // commands retain their full execution budget after entering the worker.
    let timer = setTimeout(timeout, START_TIMEOUT_MS)
    const started = () => {
      clearTimeout(timer)
      timer = setTimeout(timeout, MATCH_TIMEOUT_MS)
    }
    pending.set(id, { keys, started, finish })
    signal?.addEventListener('abort', abort, { once: true })
    try { current.postMessage({ id, text, rules }) }
    catch { stopWorker(current) }
  })
}

/** Shutdown prevents another query from recreating a worker while native windows close. */
export async function disposeQuickPatternMatching(): Promise<void> {
  disposed = true
  for (const request of pending.values()) request.keys.clear()
  if (worker) stopWorker(worker)
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  await Promise.all([...terminations])
}
