/** Compatibility transport only: SSH protocols and sessions are owned by plugin backends. */
import { utilityProcess, type UtilityProcess } from 'electron'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { resolvePluginBackendEntry } from '@main/plugin/pluginBackend'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { registerPluginProcess } from '@main/plugin/pluginOwnedProcesses'
import { acquirePluginActivity } from '@main/plugin/activityRegistry'
import { authorizePluginPermission } from '@main/plugin/PluginPermissions'
import { resolveLocalFileHandle, resolveLocalDirectoryTarget, createLocalExport, pickLocalFiles } from '@main/plugin/localFiles'
import { getPluginStorageValue, setPluginStorageValue } from '@main/db/pluginStorage'
import { resolveSecret } from '@main/vault/secretVault'
import { pluginHost } from '@main/plugin/PluginHost'
import { logInfo, logWarn } from '@main/logs/logService'
import type { PluginEventPayload } from '@shared/types/ipc'
import type { LocalFilePickOptions } from '@shared/types/local-files'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; release: () => void; timer: ReturnType<typeof setTimeout> }
interface Service {
  pluginId: string; scope: PluginRuntimeScope; child: UtilityProcess; sequence: number; closing: boolean
  pending: Map<number, Pending>; activities: Map<string, () => void>; exports: Set<string>; hostCalls: Set<number>
  detach?: () => void; onAbort?: () => void; killTimer?: ReturnType<typeof setTimeout>; forceKillTimer?: ReturnType<typeof setTimeout>
  exited: boolean; exit: Promise<void>; resolveExit: () => void; retiringReleases: Set<() => void>
}
const services = new Map<string, Service>()
const validEvents = new Set(['ssh.data', 'ssh.exit', 'ssh.error', 'ssh.auth', 'ssh.metrics', 'ssh.transfer'])
function current(service: Service): boolean { return !service.closing && services.get(service.pluginId) === service && service.scope.isCurrent() && !service.scope.signal.aborted }
function assertCurrent(service: Service): void { if (!current(service)) throw new Error('Plugin backend is closing') }
function replyToBackend(service: Service, message: unknown): void {
  if (!current(service)) return
  try { service.child.postMessage(message) }
  catch { close(service, 'Plugin backend channel closed') }
}
function string(value: unknown, max = 4096): string { if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('Invalid host call argument'); return value }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
function event(service: Service, value: unknown): void {
  assertCurrent(service)
  if (!value || typeof value !== 'object' || !validEvents.has(String((value as { type?: unknown }).type))) throw new Error('Invalid backend event')
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new Error('Backend event too large')
  pluginHost.sendEvent(service.pluginId, value as PluginEventPayload)
}
async function hostCall(service: Service, method: string, args: unknown[]): Promise<unknown> {
  assertCurrent(service)
  const id = service.pluginId
  switch (method) {
    case 'secret.resolve': return resolveSecret(id, string(args[0], 512))
    case 'permission.authorize':
      if (args[0] !== 'ssh.agent') throw new Error('Unsupported backend permission request')
      await authorizePluginPermission(id, 'ssh.agent', string(args[1], 512)); assertCurrent(service); return true
    case 'files.resolve':
      if (args[1] !== 'read' && args[1] !== 'write') throw new Error('Invalid file access')
      return resolveLocalFileHandle(id, string(args[0], 512), args[1])
    case 'files.directoryTarget': return resolveLocalDirectoryTarget(id, string(args[0], 512), string(args[1], 255))
    case 'files.pick': {
      const input = args[0] == null ? {} : args[0]
      if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid file picker options')
      const options = input as LocalFilePickOptions
      if (options.kind !== undefined && !['file', 'directory', 'any'].includes(options.kind) || options.access !== undefined && !['read', 'write'].includes(options.access) || options.multiple !== undefined && typeof options.multiple !== 'boolean') throw new Error('Invalid file picker options')
      return pickLocalFiles(id, options)
    }
    case 'files.exportDirectory': {
      if (service.exports.size >= 128) throw new Error('Export directory limit reached')
      const directory = await mkdtemp(join(tmpdir(), 'enest-backend-export-'))
      if (!current(service)) { await rm(directory, { recursive: true, force: true }); throw new Error('Plugin backend is closing') }
      const canonical = await realpath(directory)
      service.exports.add(canonical)
      const timer = setTimeout(() => { service.exports.delete(canonical); void rm(directory, { recursive: true, force: true }).catch(() => {}) }, 60 * 60 * 1000)
      timer.unref()
      return directory
    }
    case 'files.export': {
      if (!Array.isArray(args[0]) || !args[0].length || args[0].length > 1000) throw new Error('Invalid export paths')
      const paths = await Promise.all(args[0].map(path => realpath(string(path))))
      if (paths.some(path => ![...service.exports].some(root => inside(root, path)))) throw new Error('Export path is outside the backend export directory')
      assertCurrent(service); return createLocalExport(id, paths)
    }
    case 'storage.get': return getPluginStorageValue(id, string(args[0], 1024))
    case 'storage.set': setPluginStorageValue(id, string(args[0], 1024), args[1]); return true
    case 'event': event(service, args[0]); return true
    case 'log': {
      if (args[0] !== 'info' && args[0] !== 'warn') throw new Error('Invalid log level')
      const source = string(args[1], 64), message = string(args[2], 16384)
      ;(args[0] === 'info' ? logInfo : logWarn)(`plugin:${id}:${source}`, message); return true
    }
    case 'activity.acquire': {
      const token = string(args[0], 128), key = string(args[1], 4096), reason = string(args[2], 160)
      if (service.activities.has(token)) return true
      if (service.activities.size >= 256) throw new Error('Backend activity limit reached')
      const releaseScope = service.scope.acquireActivity(reason), releaseActivity = acquirePluginActivity(id, `backend:${key}`, reason)
      service.activities.set(token, () => { releaseScope(); releaseActivity() }); return true
    }
    case 'activity.release': {
      const token = string(args[0], 128); service.activities.get(token)?.(); service.activities.delete(token); return true
    }
    default: throw new Error('Unsupported backend host call')
  }
}
function attemptKill(service: Service): void {
  if (service.exited) return
  try { service.child.kill() } catch { /* retry if spawn is still pending */ }
  const pid = service.child.pid
  if (!pid || service.forceKillTimer) return
  service.forceKillTimer = setTimeout(() => {
    if (!service.exited && service.child.pid === pid) { try { process.kill(pid, 'SIGKILL') } catch { /* exit owns cleanup */ } }
  }, 250)
  service.forceKillTimer.unref()
}
function close(service: Service, reason: string, exited = false): void {
  if (exited) service.exited = true
  if (!service.closing) {
    service.closing = true
    if (service.onAbort) service.scope.signal.removeEventListener('abort', service.onAbort)
    for (const pending of service.pending.values()) { clearTimeout(pending.timer); service.retiringReleases.add(pending.release); pending.reject(new Error(reason)) }
    service.pending.clear()
    for (const release of service.activities.values()) service.retiringReleases.add(release)
    service.activities.clear()
    if (!service.exited) {
      try { service.child.postMessage({ type: 'dispose' }) } catch { /* bounded termination below */ }
      service.killTimer = setTimeout(() => { service.killTimer = undefined; attemptKill(service) }, 200)
      service.killTimer.unref()
    }
  }
  if (service.exited) {
    if (service.killTimer) clearTimeout(service.killTimer)
    if (service.forceKillTimer) clearTimeout(service.forceKillTimer)
    if (services.get(service.pluginId) === service) services.delete(service.pluginId)
    service.detach?.()
    for (const release of service.retiringReleases) release()
    service.retiringReleases.clear()
    service.resolveExit()
  }
}
async function waitForExit(service: Service): Promise<void> {
  if (service.exited) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([service.exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSH backend exit not confirmed')), 1200) })]) }
  finally { if (timer) clearTimeout(timer) }
}
async function shutdown(service: Service): Promise<void> {
  close(service, 'Plugin runtime closed')
  await waitForExit(service)
}
function getService(pluginId: string): Service {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.signal.aborted) throw new Error('Plugin runtime is closing')
  const old = services.get(pluginId)
  if (old && old.scope === scope && current(old)) return old
  if (old) {
    close(old, 'Plugin runtime replaced')
    if (!old.exited) throw new Error('Previous SSH backend is still retiring; wait for its exit before reconnecting')
  }
  const entry = resolvePluginBackendEntry(pluginId)
  const child = utilityProcess.fork(entry, [], { serviceName: `eNest backend: ${pluginId}`, stdio: 'pipe' })
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const service: Service = { pluginId, scope, child, exit, resolveExit, exited: false, retiringReleases: new Set(), sequence: 0, closing: false, pending: new Map(), activities: new Map(), exports: new Set(), hostCalls: new Set() }
  services.set(pluginId, service)
  const unregister = registerPluginProcess({ pluginId, generation: scope.owner.generation, kind: 'backend', getPid: () => service.exited ? undefined : child.pid, stop: () => shutdown(service) })
  service.onAbort = () => close(service, 'Plugin runtime is closing')
  scope.signal.addEventListener('abort', service.onAbort, { once: true })
  service.detach = scope.addDisposer(() => shutdown(service))
  child.once('spawn', () => { if (service.closing || scope.signal.aborted) attemptKill(service) })
  child.once('error', () => close(service, 'SSH backend failed'))
  child.stderr?.on('data', bytes => { logWarn(`plugin:${pluginId}`, String(bytes).slice(0, 16384)) })
  child.stdout?.on('data', () => {})
  child.on('exit', code => {
    const unexpected = current(service)
    close(service, `Plugin backend exited (${code})`, true)
    unregister()
    if (unexpected) pluginHost.sendEvent(pluginId, { type: 'ssh.error', message: `SSH 后端已退出（${code}），请重新连接` })
  })
  child.on('message', (message: unknown) => {
    if (!current(service) || !message || typeof message !== 'object') return
    const data = message as { hostEvent?: string; hostCall?: number; id?: number; method?: string; args?: unknown[]; ok?: boolean; data?: unknown; error?: string }
    if (data.hostEvent === 'event') { try { event(service, data.args?.[0]) } catch (error) { logWarn('backend', String(error)) }; return }
    if (Number.isSafeInteger(data.hostCall)) {
      const id = data.hostCall!
      if (service.hostCalls.has(id)) return
      if (service.hostCalls.size >= 256) { replyToBackend(service, { hostResult: id, ok: false, error: 'Host request limit reached' }); return }
      service.hostCalls.add(id)
      void hostCall(service, String(data.method), Array.isArray(data.args) ? data.args : []).then(
        result => replyToBackend(service, { hostResult: id, ok: true, data: result }),
        error => replyToBackend(service, { hostResult: id, ok: false, error: error instanceof Error ? error.message : String(error) })
      ).finally(() => service.hostCalls.delete(id))
      return
    }
    const pending = service.pending.get(data.id!)
    if (!pending) return
    service.pending.delete(data.id!); clearTimeout(pending.timer); pending.release()
    if (data.ok) pending.resolve(data.data); else pending.reject(new Error(data.error || 'SSH backend operation failed'))
  })
  if (scope.signal.aborted) service.onAbort()
  replyToBackend(service, { type: 'init', pluginId, generation: scope.owner.generation, wcId: scope.owner.wcId })
  assertCurrent(service)
  return service
}
export function callSshBackend<T>(pluginId: string, method: string, args: unknown[]): Promise<T> {
  try {
    const service = getService(pluginId)
    if (service.pending.size >= 256) throw new Error('SSH backend request limit reached')
    const id = ++service.sequence
    const release = service.scope.acquireActivity(`backend:${method}`)
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = method === 'ssh.connect' ? 1_200_000 : ['ssh.sftp.download', 'ssh.sftp.upload'].includes(method) ? 24 * 60 * 60 * 1000 : 180_000
      const timer = setTimeout(() => { close(service, 'SSH backend operation timed out') }, timeoutMs)
      service.pending.set(id, { resolve: value => resolve(value as T), reject, release, timer })
      try { service.child.postMessage({ id, pluginId, method, args }) }
      catch (error) { service.pending.delete(id); clearTimeout(timer); release(); reject(error) }
    })
  } catch (error) { return Promise.reject(error) }
}
export async function releaseSshBackend(pluginId: string, generation?: number): Promise<void> {
  const service = services.get(pluginId)
  if (service && (generation === undefined || service.scope.owner.generation === generation)) await shutdown(service)
}
