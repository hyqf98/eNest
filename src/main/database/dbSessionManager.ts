import type { HostDbConnectionConfig } from '@main/database/hostDbConfig'
import type { LocalFileHandle } from '@shared/types/local-files'
import { pickLocalFiles, pickLocalSaveFile, resolveLocalFileHandle } from '@main/plugin/localFiles'
/** Main-process DB facade. Permissions, secret resolution and native pickers stay
 * here; drivers, SQL, CSV and result conversion run in a per-runtime utility. */
import { utilityProcess, type UtilityProcess } from 'electron'
import { resolvePluginBackendEntry } from '@main/plugin/pluginBackend'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { registerPluginProcess } from '@main/plugin/pluginOwnedProcesses'
import { resolveSecret } from '@main/vault/secretVault'
import { logWarn } from '@main/logs/logService'
import type { DatabaseBackendApi as Api } from '@main/database/backendApi'
import type { DbConnectionConfig, DbSessionInfo } from '@shared/types/ssh-db'
import type { DbWorkbenchRequest } from '@shared/types/db-workbench'

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
  transactions: Map<string, () => void>
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

function attemptKill(service: Service): void {
  if (service.exited) return
  service.killAttempts++
  let accepted = false
  try { accepted = service.child.kill() } catch (error) { logWarn('db', `utility kill failed for ${service.pluginId}: ${String(error)}`) }
  // kill() is only a signal request. Keep ownership and PID until the exit event.
  if (service.spawned && !service.killTimer) {
    service.killTimer = setTimeout(() => {
      service.killTimer = undefined
      if (service.exited) return
      const pid = service.pid
      if (!pid || !Number.isInteger(pid) || pid <= 0 || service.child.pid !== pid) { logWarn('db', `utility termination unconfirmed for ${service.pluginId}; no spawned child pid`); return }
      try { process.kill(pid, 'SIGKILL') }
      catch (error) { logWarn('db', `utility force termination not confirmed for ${service.pluginId}: ${String(error)}`) }
    }, CANCEL_DEADLINE_MS)
    service.killTimer.unref()
  }
  if (!accepted && service.spawned) logWarn('db', `database utility did not accept termination for ${service.pluginId}; retaining ownership until exit`)
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
    for (const release of service.transactions.values()) service.retiringReleases.add(release)
    service.transactions.clear()
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
    await Promise.race([service.exitPromise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('database utility has not exited; reconnect is blocked until termination is confirmed')), Math.max(0, (service.exitDeadline || Date.now() + 1000) - Date.now())) })])
  } finally { if (timer) clearTimeout(timer) }
}

function serviceFor(pluginId: string): Service {
  const scope = requireScope(pluginId)
  const old = services.get(pluginId)
  if (old && old.scope === scope && !old.disposed) return old
  if (old) {
    terminate(old, 'database runtime replaced')
    if (!old.exited) throw new Error('Previous database utility is retiring; wait for its exit before reconnecting')
  }
  const child = utilityProcess.fork(resolvePluginBackendEntry(pluginId), [], {
    serviceName: `eNest DB ${pluginId} #${scope.owner.generation}`,
    stdio: 'ignore',
    execArgv: ['--max-old-space-size=256'],
    // Inherit proxy environment; do not copy credentials into the environment.
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' }
  })
  let resolveExit!: () => void
  const exitPromise = new Promise<void>(resolve => { resolveExit = resolve })
  const service: Service = { pluginId, scope, child, pending: new Map(), disposed: false, detach: () => {}, onAbort: () => {}, transactions: new Map(), connections: new Map(), exited: false, spawned: child.pid !== undefined, pid: child.pid, killAttempts: 0, exitPromise, resolveExit, retiringReleases: new Set() }
  services.set(pluginId, service)
  const unregister = registerPluginProcess({ pluginId, generation: scope.owner.generation, kind: 'backend', getPid: () => service.exited ? undefined : service.child.pid, stop: () => shutdown(service) })
  // Fatal utility errors still emit exit; do not drop a live/retiring PID early.
  child.once('error', () => terminate(service, 'database service failed; reconnect the database'))
  child.on('message', (message: { id?: number; ok?: boolean; data?: unknown; error?: string }) => {
    const pending = service.pending.get(Number(message?.id))
    if (!pending) return
    service.pending.delete(Number(message.id))
    clearTimeout(pending.timer)
    pending.release()
    if (!scope.isCurrent() || scope.signal.aborted) pending.reject(new Error('plugin runtime is closing'))
    else if (message.ok) pending.resolve(message.data)
    else pending.reject(new Error(message.error || 'database service failed'))
  })
  child.once('spawn', () => { service.spawned = true; service.pid = child.pid; if (service.disposed) { service.killAttempts = 0; attemptKill(service) } })
  child.once('exit', code => {
    service.exited = true
    unregister()
    if (!service.disposed) logWarn('db', `service exited for ${pluginId}: ${code}`)
    terminate(service, 'database service exited; reconnect the database', false)
  })
  // Abort stops database work immediately; the child gets a short opportunity to
  // close its drivers, then a real process kill bounds synchronous SQLite work.
  service.onAbort = () => { void shutdown(service).catch(error => logWarn('db', String(error))) }
  scope.signal.addEventListener('abort', service.onAbort, { once: true })
  service.detach = scope.addDisposer(() => shutdown(service))
  if (scope.signal.aborted) service.onAbort()
  return service
}

function shutdown(service: Service): Promise<void> {
  if (service.shutdownPromise) return service.shutdownPromise
  service.shutdownPromise = (async () => {
    if (service.exited) return
    if (!service.disposed) { try { await send(service, 'releaseDbSessions', [], CANCEL_DEADLINE_MS, false) } catch { /* bounded kill below */ } }
    terminate(service, 'database runtime closed')
    await waitForExit(service)
  })()
  return service.shutdownPromise
}

function transactionLease(service: Service, key: string, active: boolean): void {
  if (service.disposed || !service.scope.isCurrent() || service.scope.signal.aborted) return
  if (active && !service.transactions.has(key)) service.transactions.set(key, service.scope.acquireActivity(`db:transaction:${key}`))
  if (!active) { service.transactions.get(key)?.(); service.transactions.delete(key) }
}

function connected(service: Service, session: DbSessionInfo): void {
  if (service.disposed || services.get(service.pluginId) !== service || !service.scope.isCurrent() || service.scope.signal.aborted) throw new Error('plugin runtime is closing')
  // Replace the identity even for the same key: a late close/list response for
  // the previous connection must never release its successful replacement.
  const release = service.connections.get(session.sessionKey)?.release || service.scope.acquireActivity(`db:connection:${session.sessionKey}`)
  service.connections.set(session.sessionKey, { release })
  transactionLease(service, session.sessionKey, session.transactionActive === true)
}

function sessionSnapshot(service: Service) {
  return { connections: new Map(service.connections), transactions: new Map(service.transactions) }
}

function syncSessionLeases(service: Service, sessions: DbSessionInfo[], snapshot: ReturnType<typeof sessionSnapshot>): void {
  if (service.disposed || services.get(service.pluginId) !== service || !service.scope.isCurrent() || service.scope.signal.aborted) return
  const active = new Map(sessions.map(session => [session.sessionKey, session]))
  for (const [key, connection] of snapshot.connections) {
    if (service.connections.get(key) !== connection) continue
    if (!active.has(key)) { service.connections.delete(key); connection.release() }
  }
  for (const [key, release] of snapshot.transactions) {
    if (service.transactions.get(key) !== release) continue
    if (service.connections.has(key) && service.connections.get(key) !== snapshot.connections.get(key)) continue
    if (!active.get(key)?.transactionActive) { service.transactions.delete(key); release() }
  }
}

async function listSessions(service: Service, timeoutMs = 30_000, activity = true): Promise<DbSessionInfo[]> {
  const snapshot = sessionSnapshot(service)
  const sessions = await send(service, 'dbListSessions', [], timeoutMs, activity) as DbSessionInfo[]
  syncSessionLeases(service, sessions, snapshot)
  return sessions
}

function send(service: Service, method: string, args: unknown[], timeoutMs = 30_000, activity = true): Promise<unknown> {
  if (service.disposed) return Promise.reject(new Error('database service closed'))
  if (service.pending.size >= MAX_PENDING && activity) return Promise.reject(new Error('too many pending database operations'))
  const id = ++requestSequence
  const release = activity ? service.scope.acquireActivity(`db:${method}`) : () => {}
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      terminate(service, method === 'dbCancel' ? 'database cancelled; service reset, reconnect the database' : 'database operation timed out; service reset, reconnect the database')
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
  // Bounded IPC payload; large CSV imports use a picker-authorized file path.
  if (Buffer.byteLength(JSON.stringify(args, (_, value) => typeof value === 'bigint' ? value.toString() : value)) > MAX_REQUEST_BYTES) return Promise.reject(new Error('database request exceeds 4 MiB; use a file import'))
  return send(service, method, args, timeoutMs) as Promise<T>
}

async function withPassword(pluginId: string, config: DbConnectionConfig): Promise<HostDbConnectionConfig> {
  if ('filePath' in config || 'sqlitePath' in config || config.options?.file) throw new Error('raw database paths are not supported; select fileHandleId')
  const readOnly = config.readOnly === true || config.options?.readOnly === true
  const resolved: HostDbConnectionConfig = { ...config, readOnly, options: { ...config.options, readOnly }, secretRef: undefined,
    ephemeralSecret: config.ephemeralSecret || (config.secretRef ? resolveSecret(pluginId, config.secretRef) ?? undefined : undefined) }
  if (config.driver === 'sqlite' || config.driver === 'duckdb') {
    if (config.database === ':memory:' && !config.fileHandleId) resolved.filePath = ':memory:'
    else {
      if (!config.fileHandleId) throw new Error('fileHandleId is required for a local database')
      resolved.filePath = await resolveLocalFileHandle(pluginId, config.fileHandleId, readOnly ? 'read' : 'write')
    }
  }
  return resolved
}

export const dbOpen: Api['dbOpen'] = async (pluginId, input) => {
  const scope = requireScope(pluginId)
  const release = scope.acquireActivity('db:open')
  try {
    const wrapped = 'config' in input
    const config = await withPassword(pluginId, wrapped ? input.config : input)
    if (scope.signal.aborted || !scope.isCurrent()) throw new Error('plugin runtime is closing')
    const service = serviceFor(pluginId)
    const session = await serviceRpc<DbSessionInfo>(service, 'dbOpen', [wrapped ? { ...input, config } : config])
    connected(service, session)
    return session
  } finally { release() }
}
export const dbTest: Api['dbTest'] = async (pluginId, config) => {
  const scope = requireScope(pluginId)
  const resolved = await withPassword(pluginId, config)
  if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  return rpc(pluginId, 'dbTest', [resolved], 15_000)
}
export const dbClose: Api['dbClose'] = async (pluginId, key) => {
  const service = services.get(pluginId)
  if (!service) return true
  const connection = service.connections.get(key), transaction = service.transactions.get(key)
  try {
    const result = await send(service, 'dbClose', [key], CANCEL_DEADLINE_MS, false)
    if (connection && service.connections.get(key) === connection) { service.connections.delete(key); connection.release() }
    if (transaction && service.transactions.get(key) === transaction && (!service.connections.has(key) || service.connections.get(key) === connection)) { service.transactions.delete(key); transaction() }
    return result as boolean
  }
  catch (error) { terminate(service, 'database close failed; reconnect'); await waitForExit(service); throw error }
}
export function dbListSessions(pluginId: string): Promise<DbSessionInfo[]> {
  const service = services.get(pluginId)
  return service ? listSessions(service) : Promise.resolve([])
}
export const dbExecute: Api['dbExecute'] = async (pluginId, input) => {
  const service = serviceFor(pluginId)
  const result = await rpc<Awaited<ReturnType<Api['dbExecute']>>>(pluginId, 'dbExecute', [input], Math.max(250, Math.min(600000, Number(input.timeoutMs) || 30000)) + 500)
  transactionLease(service, input.sessionKey, result.transactionActive === true)
  return result
}
export const dbExplain: Api['dbExplain'] = (pluginId, input) => rpc(pluginId, 'dbExplain', [input])
export const dbCancel: Api['dbCancel'] = async (pluginId, key) => {
  const service = services.get(pluginId)
  if (!service) return true
  // Cancellation may preserve a native connection or close it. Reconcile with
  // the actual session list; an unresponsive SQLite worker is killed at 250ms.
  try {
    await send(service, 'dbCancel', [key], CANCEL_DEADLINE_MS, false)
    await listSessions(service, CANCEL_DEADLINE_MS, false)
    return true
  }
  catch (error) { terminate(service, 'database cancellation failed; service reset'); await waitForExit(service); throw error }
}
export const dbApplyChanges: Api['dbApplyChanges'] = (pluginId, input) => rpc(pluginId, 'dbApplyChanges', [input])
export const dbSchemaTree: Api['dbSchemaTree'] = (pluginId, input) => rpc(pluginId, 'dbSchemaTree', [input])
export const dbSchemaDescribe: Api['dbSchemaDescribe'] = (pluginId, input) => rpc(pluginId, 'dbSchemaDescribe', [input])
export const dbSchemaDdl: Api['dbSchemaDdl'] = (pluginId, input) => rpc(pluginId, 'dbSchemaDdl', [input])
export const dbCompletion: Api['dbCompletion'] = (pluginId, input) => rpc(pluginId, 'dbCompletion', [input])
export const dbDialectsList: Api['dbDialectsList'] = (pluginId) => rpc(pluginId, 'dbDialectsList', [])
export const dbImportPreview: Api['dbImportPreview'] = async (pluginId, input) => {
  const scope = requireScope(pluginId)
  if ('filePath' in input) throw new Error('raw import paths are not supported; select fileHandleId')
  const filePath = input.fileHandleId ? await resolveLocalFileHandle(pluginId, input.fileHandleId, 'read') : undefined
  if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  return rpc(pluginId, 'dbImportPreview', [{ ...input, filePath }])
}
export const dbImportRun: Api['dbImportRun'] = async (pluginId, input) => {
  const scope = requireScope(pluginId)
  if ('filePath' in input) throw new Error('raw import paths are not supported; select fileHandleId')
  const filePath = input.fileHandleId ? await resolveLocalFileHandle(pluginId, input.fileHandleId, 'read') : undefined
  if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing')
  return rpc(pluginId, 'dbImportRun', [{ ...input, filePath }], 600_000)
}

export async function dbPickSqliteFile(pluginId: string, options?: { createIfMissing?: boolean; readOnly?: boolean }): Promise<LocalFileHandle | null> {
  if (options?.createIfMissing) return pickLocalSaveFile(pluginId, { defaultName: 'database.sqlite' })
  return (await pickLocalFiles(pluginId, { kind: 'file', access: options?.readOnly ? 'read' : 'write' }))[0] ?? null
}
export async function dbPickImportFile(pluginId: string): Promise<LocalFileHandle | null> { return (await pickLocalFiles(pluginId, { kind: 'file', access: 'read' }))[0] ?? null }

/** Optional generation prevents a late old-runtime release closing its successor. */
export async function releaseDbSessions(pluginId: string, generation?: number): Promise<void> {
  const service = services.get(pluginId)
  if (service && (generation === undefined || service.scope.owner.generation === generation)) await shutdown(service)
}

/** Workbench uses the same per-runtime utility, including cancellation and transactions. */
export async function dbWorkbenchRpc(pluginId: string, request: DbWorkbenchRequest): Promise<unknown> {
  if (request.action === 'test') return dbTest(pluginId, request.input)
  if (request.action === 'cancel') return dbCancel(pluginId, request.input)
  const service = serviceFor(pluginId)
  const result = await rpc<Record<string, unknown>>(pluginId, 'dbWorkbenchService', [request], request.action === 'execute' ? Math.max(250, Math.min(600000, request.input.timeoutMs || 30000)) + 500 : 60000)
  if (request.action === 'transaction') transactionLease(service, request.input.sessionKey, result.active === true)
  else if (request.action === 'execute') transactionLease(service, request.input.sessionKey, result.transactionActive === true)
  return result
}

/** Main-only diagnostics; a retiring utility stays visible until its actual exit event. */
export function getDbUtilityDiagnostics() {
  return [...services.values()].map(service => ({ ...service.scope.owner, pid: service.pid, state: service.disposed ? 'retiring' as const : 'running' as const, spawned: service.spawned, pending: service.pending.size, heldReleases: service.retiringReleases.size }))
}
