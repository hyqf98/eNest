/** Main-process MW (middleware console) facade. Permissions, secret resolution and
 * event forwarding stay here; drivers and business work run in a per-runtime utility. */
import { utilityProcess, type UtilityProcess } from 'electron'
import { resolvePluginBackendEntry } from '@main/plugin/pluginBackend'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { resolveSecret } from '@main/vault/secretVault'
import { logWarn } from '@main/logs/logService'
import { pluginHost } from '@main/plugin/PluginHost'
import type { PluginEventPayload } from '@shared/types/ipc'
import type { MwConnectionConfig, MwSessionInfo, MwWorkbenchRequest } from '@shared/types/mw-workbench'
import type { MiddlewareBackendApi as Api } from '@main/middleware/backendApi'

const CANCEL_DEADLINE_MS = 250
const MAX_PENDING = 32
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  release: () => void
}
interface ConnectionLease { release: () => void }
interface Service {
  pluginId: string
  scope: PluginRuntimeScope
  child: UtilityProcess
  pending: Map<number, Pending>
  disposed: boolean
  detach: () => void
  onAbort: () => void
  connections: Map<string, ConnectionLease>
  shutdownPromise?: Promise<void>
  exited: boolean
  spawned: boolean
  pid?: number
  exitDeadline?: number
  killAttempts: number
  killTimer?: ReturnType<typeof setTimeout>
  exitPromise: Promise<void>
  resolveExit: () => void
  retiringReleases: Set<() => void>
}
const services = new Map<string, Service>()
let requestSequence = 0

function requireScope(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope || !scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  return scope
}

/** 向插件 webContents 转发 mw.data / mw.error（Host 公开访问器；找不到视图时静默丢弃） */
function emitToPlugin(pluginId: string, payload: PluginEventPayload): void {
  pluginHost.sendEvent(pluginId, payload)
}

function attemptKill(service: Service): void {
  if (service.exited) return
  service.killAttempts++
  let accepted = false
  try { accepted = service.child.kill() } catch (error) { logWarn('mw', `utility kill failed for ${service.pluginId}: ${String(error)}`) }
  // kill() is only a signal request. Keep ownership and PID until the exit event.
  if (service.spawned && !service.killTimer) {
    service.killTimer = setTimeout(() => {
      service.killTimer = undefined
      if (service.exited) return
      const pid = service.pid
      if (!pid || !Number.isInteger(pid) || pid <= 0) { logWarn('mw', `utility termination unconfirmed for ${service.pluginId}; no spawned child pid`); return }
      try { process.kill(pid, 'SIGKILL') }
      catch (error) { logWarn('mw', `utility force termination not confirmed for ${service.pluginId}: ${String(error)}`) }
    }, CANCEL_DEADLINE_MS)
  }
  if (!accepted && service.spawned) logWarn('mw', `middleware utility did not accept termination for ${service.pluginId}; retaining ownership until exit`)
}

function terminate(service: Service, reason: string, kill = true): void {
  if (!service.disposed) {
    service.disposed = true
    service.exitDeadline = Date.now() + 1000
    service.scope.signal.removeEventListener('abort', service.onAbort)
    for (const pending of service.pending.values()) {
      clearTimeout(pending.timer)
      service.retiringReleases.add(pending.release)
      pending.reject(new Error(reason))
    }
    service.pending.clear()
    for (const connection of service.connections.values()) service.retiringReleases.add(connection.release)
    service.connections.clear()
  }
  if (service.exited) {
    if (service.killTimer) clearTimeout(service.killTimer)
    if (services.get(service.pluginId) === service) services.delete(service.pluginId)
    service.pid = undefined
    service.detach()
    for (const release of service.retiringReleases) release()
    service.retiringReleases.clear()
    service.resolveExit()
  } else if (kill) attemptKill(service)
}

async function waitForExit(service: Service): Promise<void> {
  if (service.exited) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([service.exitPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('middleware utility has not exited; reconnect is blocked until termination is confirmed')), Math.max(0, (service.exitDeadline || Date.now() + 1000) - Date.now())) })])
  } finally { if (timer) clearTimeout(timer) }
}

function serviceFor(pluginId: string): Service {
  const scope = requireScope(pluginId)
  const old = services.get(pluginId)
  if (old && old.scope === scope && !old.disposed) return old
  if (old) {
    terminate(old, 'middleware runtime replaced')
    if (!old.exited) throw new Error('Previous middleware utility is retiring; wait for its exit before reconnecting')
  }
  const child = utilityProcess.fork(resolvePluginBackendEntry(pluginId), [], {
    serviceName: `eNest MW ${pluginId} #${scope.owner.generation}`,
    stdio: 'ignore',
    execArgv: ['--max-old-space-size=256'],
    // Inherit proxy environment; do not copy credentials into the environment.
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' }
  })
  let resolveExit!: () => void
  const exitPromise = new Promise<void>(resolve => { resolveExit = resolve })
  const service: Service = { pluginId, scope, child, pending: new Map(), disposed: false, detach: () => {}, onAbort: () => {}, connections: new Map(), exited: false, spawned: child.pid !== undefined, pid: child.pid, killAttempts: 0, exitPromise, resolveExit, retiringReleases: new Set() }
  services.set(pluginId, service)
  child.on('message', (message: { id?: number; event?: string; pluginId?: string; payload?: Record<string, unknown>; ok?: boolean; data?: unknown; error?: string }) => {
    // 事件推送分支：mwUtility 透传的 mw.data / mw.error 直接转发给插件 WebContents
    if (typeof message?.event === 'string' && (message.event === 'mw.data' || message.event === 'mw.error')) {
      if (message.pluginId !== pluginId || !scope.isCurrent() || scope.signal.aborted || service.disposed) return
      const payload = message.payload ?? {}
      if (message.event === 'mw.data') {
        emitToPlugin(message.pluginId, { type: 'mw.data', sessionKey: String(payload.sessionKey ?? ''), tailId: String(payload.tailId ?? ''), message: payload.message as never })
      } else {
        emitToPlugin(message.pluginId, { type: 'mw.error', sessionKey: payload.sessionKey === undefined ? undefined : String(payload.sessionKey), tailId: payload.tailId === undefined ? undefined : String(payload.tailId), error: String(payload.error ?? 'middleware error') })
      }
      return
    }
    const pending = service.pending.get(Number(message?.id))
    if (!pending) return
    service.pending.delete(Number(message.id))
    clearTimeout(pending.timer)
    pending.release()
    if (!scope.isCurrent() || scope.signal.aborted) pending.reject(new Error('plugin runtime is closing'))
    else if (message.ok) pending.resolve(message.data)
    else pending.reject(new Error(message.error || 'middleware service failed'))
  })
  child.once('spawn', () => { service.spawned = true; service.pid = child.pid; if (service.disposed) { service.killAttempts = 0; attemptKill(service) } })
  child.once('exit', code => {
    service.exited = true
    if (!service.disposed) logWarn('mw', `service exited for ${pluginId}: ${code}`)
    terminate(service, 'middleware service exited; reconnect the middleware', false)
  })
  // Abort stops middleware work immediately; the child gets a short opportunity to
  // close its drivers, then a real process kill bounds synchronous work.
  service.onAbort = () => { void shutdown(service).catch(error => logWarn('mw', String(error))) }
  scope.signal.addEventListener('abort', service.onAbort, { once: true })
  service.detach = scope.addDisposer(() => shutdown(service))
  return service
}

function shutdown(service: Service): Promise<void> {
  if (service.shutdownPromise) return service.shutdownPromise
  service.shutdownPromise = (async () => {
    if (service.exited) return
    if (!service.disposed) { try { await send(service, 'releaseMwSessions', [], CANCEL_DEADLINE_MS, false) } catch { /* bounded kill below */ } }
    terminate(service, 'middleware runtime closed')
    await waitForExit(service)
  })()
  return service.shutdownPromise
}

function connected(service: Service, session: MwSessionInfo): void {
  if (service.disposed || services.get(service.pluginId) !== service || !service.scope.isCurrent() || service.scope.signal.aborted) throw new Error('plugin runtime is closing')
  // Replace the identity even for the same key: a late close/list response for
  // the previous connection must never release its successful replacement.
  const release = service.connections.get(session.sessionKey)?.release || service.scope.acquireActivity(`mw:connection:${session.sessionKey}`)
  service.connections.set(session.sessionKey, { release })
}

function sessionSnapshot(service: Service) {
  return { connections: new Map(service.connections) }
}

function syncSessionLeases(service: Service, sessions: MwSessionInfo[], snapshot: ReturnType<typeof sessionSnapshot>): void {
  if (service.disposed || services.get(service.pluginId) !== service || !service.scope.isCurrent() || service.scope.signal.aborted) return
  const active = new Set(sessions.map(session => session.sessionKey))
  for (const [key, connection] of snapshot.connections) {
    if (service.connections.get(key) !== connection) continue
    if (!active.has(key)) { service.connections.delete(key); connection.release() }
  }
}

async function listSessions(service: Service, timeoutMs = 30_000, activity = true): Promise<MwSessionInfo[]> {
  const snapshot = sessionSnapshot(service)
  const sessions = await send(service, 'mwListSessions', [], timeoutMs, activity) as MwSessionInfo[]
  syncSessionLeases(service, sessions, snapshot)
  return sessions
}

function send(service: Service, method: string, args: unknown[], timeoutMs = 30_000, activity = true): Promise<unknown> {
  if (service.disposed) return Promise.reject(new Error('middleware service closed'))
  if (service.pending.size >= MAX_PENDING && activity) return Promise.reject(new Error('too many pending middleware operations'))
  const id = ++requestSequence
  const release = activity ? service.scope.acquireActivity(`mw:${method}`) : () => {}
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      terminate(service, 'middleware operation timed out; service reset, reconnect the middleware')
    }, timeoutMs)
    service.pending.set(id, { resolve: resolveResult, reject, timer, release })
    try {
      // The current proxy environment is forwarded, including changes made since fork.
      service.child.postMessage({ id, method, pluginId: service.pluginId, args,
        proxy: { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY } })
    } catch (error) {
      service.pending.delete(id)
      clearTimeout(timer)
      release()
      reject(error as Error)
    }
  })
}

function rpc<T>(pluginId: string, method: string, args: unknown[], timeoutMs?: number): Promise<T> {
  return serviceRpc(serviceFor(pluginId), method, args, timeoutMs)
}

function serviceRpc<T>(service: Service, method: string, args: unknown[], timeoutMs?: number): Promise<T> {
  // Bounded IPC payload.
  if (Buffer.byteLength(JSON.stringify(args, (_, value) => typeof value === 'bigint' ? value.toString() : value)) > MAX_REQUEST_BYTES) return Promise.reject(new Error('middleware request exceeds 4 MiB'))
  return send(service, method, args, timeoutMs) as Promise<T>
}

function withPassword(pluginId: string, config: MwConnectionConfig): MwConnectionConfig {
  return { ...config, secretRef: undefined,
    ephemeralSecret: config.ephemeralSecret || (config.secretRef ? resolveSecret(pluginId, config.secretRef) ?? undefined : undefined) }
}

export const mwOpen: Api['mwOpen'] = async (pluginId, input) => {
  const scope = requireScope(pluginId)
  const release = scope.acquireActivity('mw:open')
  try {
    const config = withPassword(pluginId, input.config)
    if (scope.signal.aborted || !scope.isCurrent()) throw new Error('plugin runtime is closing')
    const service = serviceFor(pluginId)
    const session = await serviceRpc<MwSessionInfo>(service, 'mwOpen', [{ ...input, config }])
    connected(service, session)
    return session
  } finally { release() }
}
export const mwTest: Api['mwTest'] = async (pluginId, config) => {
  const resolved = withPassword(pluginId, config)
  return rpc(pluginId, 'mwTest', [resolved], 15_000)
}
export const mwClose: Api['mwClose'] = async (pluginId, key) => {
  const service = services.get(pluginId)
  if (!service) return true
  const connection = service.connections.get(key)
  try {
    const result = await send(service, 'mwClose', [key], CANCEL_DEADLINE_MS, false)
    if (connection && service.connections.get(key) === connection) { service.connections.delete(key); connection.release() }
    return result as boolean
  }
  catch (error) { terminate(service, 'middleware close failed; reconnect'); await waitForExit(service); throw error }
}
export function mwListSessions(pluginId: string): Promise<MwSessionInfo[]> {
  const service = services.get(pluginId)
  return service ? listSessions(service) : Promise.resolve([])
}

/** Optional generation prevents a late old-runtime release closing its successor. */
export async function releaseMwSessions(pluginId: string, generation?: number): Promise<void> {
  const service = services.get(pluginId)
  if (service && (generation === undefined || service.scope.owner.generation === generation)) await shutdown(service)
}

/** Workbench uses the same per-runtime utility; test/open 用更短的超时上限。 */
export async function mwWorkbenchRpc(pluginId: string, request: MwWorkbenchRequest): Promise<unknown> {
  if (request.action === 'test') return mwTest(pluginId, request.input.config)
  if (request.action === 'session.open') return mwOpen(pluginId, request.input)
  return rpc<Record<string, unknown>>(pluginId, 'mwWorkbenchService', [request], request.action === 'session.close' ? 15_000 : 30_000)
}

/** Main-only diagnostics; a retiring utility stays visible until its actual exit event. */
export function getMwUtilityDiagnostics() {
  return [...services.values()].map(service => ({ ...service.scope.owner, pid: service.pid, state: service.disposed ? 'retiring' as const : 'running' as const, spawned: service.spawned, pending: service.pending.size, heldReleases: service.retiringReleases.size }))
}
