import { utilityProcess, type UtilityProcess } from 'electron'
import { getRuntimeScope, type PluginRuntimeScope } from './PluginRuntimeScope'
import { resolvePluginBackendEntry } from './pluginBackend'
import { pluginHost } from './PluginHost'
import { registerPluginProcess } from './pluginOwnedProcesses'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  release: () => void
  timer: ReturnType<typeof setTimeout>
}
interface Backend {
  scope: PluginRuntimeScope
  child: UtilityProcess
  pending: Map<number, Pending>
  closed: boolean
  exited: boolean
  detach: () => void
  exit: Promise<void>
  resolveExit: () => void
  releases: Set<() => void>
  killTimer?: ReturnType<typeof setTimeout>
}
const backends = new Map<string, Backend>()
let sequence = 0
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, (_, x) => typeof x === 'bigint' ? String(x) : x) ?? '')

function stop(backend: Backend, reason: string): void {
  if (!backend.closed) {
    backend.closed = true
    for (const pending of backend.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
      backend.releases.add(pending.release)
    }
    backend.pending.clear()
  }
  if (backend.exited) return
  try { backend.child.kill() } catch { /* escalate after spawn */ }
  if (backend.child.pid && !backend.killTimer) {
    const pid = backend.child.pid
    backend.killTimer = setTimeout(() => {
      if (!backend.exited && backend.child.pid === pid) { try { process.kill(pid, 'SIGKILL') } catch { /* exit listener owns cleanup */ } }
    }, 250)
    backend.killTimer.unref()
  }
}

async function waitForExit(backend: Backend): Promise<void> {
  if (backend.exited) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([backend.exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('plugin backend exit not confirmed')), 1000) })]) }
  finally { if (timer) clearTimeout(timer) }
}

function backendFor(pluginId: string): Backend {
  // Recheck permission/path before every call, even when a process already exists.
  const entry = resolvePluginBackendEntry(pluginId), scope = getRuntimeScope(pluginId)!
  const old = backends.get(pluginId)
  if (old) {
    if (old.scope === scope && !old.closed) return old
    stop(old, 'plugin backend replaced')
    if (!old.exited) throw new Error('previous plugin backend is still retiring')
  }
  const child = utilityProcess.fork(entry, [], { serviceName: `eNest backend ${pluginId} #${scope.owner.generation}`, stdio: 'ignore', execArgv: ['--max-old-space-size=256'], env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const backend: Backend = { scope, child, exit, resolveExit, pending: new Map(), closed: false, exited: false, detach: () => {}, releases: new Set() }
  backends.set(pluginId, backend)
  const abort = () => stop(backend, 'plugin backend closed')
  const shutdown = async () => { abort(); await waitForExit(backend) }
  const unregister = registerPluginProcess({ pluginId, generation: scope.owner.generation, kind: 'backend', getPid: () => backend.exited ? undefined : child.pid, stop: shutdown })
  child.once('spawn', () => { if (backend.closed || scope.signal.aborted) stop(backend, 'plugin backend closed') })
  // UtilityProcess fatal errors are followed by exit; retain ownership until then.
  child.once('error', () => stop(backend, 'plugin backend failed'))
  child.once('exit', () => {
    backend.exited = true
    stop(backend, 'plugin backend exited')
    if (backend.killTimer) clearTimeout(backend.killTimer)
    unregister()
    scope.signal.removeEventListener('abort', abort)
    backend.detach()
    for (const release of backend.releases) release()
    backend.releases.clear()
    if (backends.get(pluginId) === backend) backends.delete(pluginId)
    resolveExit()
  })
  scope.signal.addEventListener('abort', abort, { once: true })
  backend.detach = scope.addDisposer(shutdown)
  if (scope.signal.aborted) abort()
  child.on('message', (message: { id?: number; ok?: boolean; data?: unknown; error?: string; event?: string }) => {
    if (backend.closed || !scope.isCurrent() || scope.isClosing) return
    try {
      if (bytes(message) > 8 * 1024 * 1024) throw new Error('plugin backend response exceeds 8 MiB')
      if (typeof message.event === 'string') {
        if (!/^[\w.-]{1,80}$/.test(message.event)) throw new Error('invalid backend event')
        // The sender's owner supplies pluginId; payloads cannot impersonate shell/SSH events.
        pluginHost.sendEvent(pluginId, { type: 'backend.event', event: message.event, data: message.data })
        return
      }
      const pending = backend.pending.get(Number(message.id))
      if (!pending) return
      backend.pending.delete(Number(message.id)); clearTimeout(pending.timer); pending.release()
      if (message.ok === true) pending.resolve(message.data)
      else pending.reject(new Error(String(message.error || 'plugin backend request failed').slice(0, 4096)))
    } catch (error) { stop(backend, String(error)) }
  })
  child.postMessage({ type: 'init', pluginId, generation: scope.owner.generation, wcId: scope.owner.wcId })
  return backend
}

export function callPluginBackend(pluginId: string, method: unknown, args: unknown = []): Promise<unknown> {
  if (typeof method !== 'string' || !/^[A-Za-z][\w.-]{0,79}$/.test(method) || !Array.isArray(args)) throw new Error('invalid backend request')
  if (bytes(args) > 4 * 1024 * 1024) throw new Error('plugin backend request exceeds 4 MiB')
  const backend = backendFor(pluginId)
  if (backend.pending.size >= 32) throw new Error('too many pending backend requests')
  const id = ++sequence, release = backend.scope.acquireActivity(`backend:${method}`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => stop(backend, 'plugin backend request timed out'), 30_000)
    backend.pending.set(id, { resolve, reject, release, timer })
    try {
      backend.child.postMessage({ id, pluginId, method, args, proxy: { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY } })
    } catch (error) { backend.pending.delete(id); clearTimeout(timer); release(); reject(error) }
  })
}
