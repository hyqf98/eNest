/** Local source plans survive instance closes; only actual opens prepare their runtime entries. */
import type { DevServerEnsureOptions } from './devServerManager'
import { resolveDevPluginEntry, type InspectedDevSource, type ResolvedDevEntry } from './devPluginEntry'

export interface DevSourceRegistration {
  readonly source: InspectedDevSource
  readonly signature: string
}
interface Preparation {
  registration: DevSourceRegistration
  controller: AbortController
  promise: Promise<ResolvedDevEntry>
  isCurrent: () => boolean
}

const registrations = new Map<string, DevSourceRegistration>()
const preparing = new Map<string, Preparation>()
let stopping = false

function cancelledError(): Error {
  return Object.assign(new Error('开发插件启动已取消'), { name: 'AbortError' })
}

export function registerDevPluginSource(source: InspectedDevSource, replace = false): DevSourceRegistration {
  if (stopping) throw cancelledError()
  const signature = JSON.stringify(source)
  const previous = registrations.get(source.manifest.id)
  if (!replace && previous?.signature === signature) return previous
  cancelDevPluginPreparation(source.manifest.id)
  const registration = { source, signature }
  registrations.set(source.manifest.id, registration)
  return registration
}

export function getDevPluginSource(pluginId: string): DevSourceRegistration | undefined {
  return registrations.get(pluginId)
}

export function isDevPluginSourceCurrent(pluginId: string, registration: DevSourceRegistration): boolean {
  return !stopping && registrations.get(pluginId) === registration
}

/** Same-source requests share preparation, including connection checks and build fallback. */
export function prepareRegisteredDevPlugin(pluginId: string, request: DevServerEnsureOptions = {}): Promise<ResolvedDevEntry> {
  const registration = registrations.get(pluginId)
  if (!registration || stopping || request.signal?.aborted || request.isCurrent?.() === false) return Promise.reject(cancelledError())
  const current = preparing.get(pluginId)
  if (current) {
    if (current.registration === registration && current.isCurrent()) return current.promise
    current.controller.abort()
    return current.promise.catch(() => undefined).then(() => {
      if (!isDevPluginSourceCurrent(pluginId, registration)) throw cancelledError()
      return prepareRegisteredDevPlugin(pluginId, request)
    })
  }
  const controller = new AbortController()
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
  const isCurrent = () => !signal.aborted && isDevPluginSourceCurrent(pluginId, registration) && request.isCurrent?.() !== false
  const operation: Preparation = { registration, controller, isCurrent, promise: Promise.resolve(null as never) }
  operation.promise = Promise.resolve().then(async () => {
    if (!isCurrent()) throw cancelledError()
    const { source } = registration
    const resolved = await resolveDevPluginEntry(source.sourcePath, source.options, { ...request, signal, isCurrent, inspection: source })
    if (!isCurrent()) throw cancelledError()
    return resolved
  }).finally(() => { if (preparing.get(pluginId) === operation) preparing.delete(pluginId) })
  preparing.set(pluginId, operation)
  return operation.promise
}

/** Cancels an in-flight request without forgetting its source or stopping a ready HMR server. */
export function cancelDevPluginPreparation(pluginId: string): void {
  preparing.get(pluginId)?.controller.abort()
}

export function forgetDevPluginSource(pluginId: string): void {
  cancelDevPluginPreparation(pluginId)
  registrations.delete(pluginId)
}

export function disposeDevPluginPreparations(): void {
  stopping = true
  for (const pluginId of preparing.keys()) cancelDevPluginPreparation(pluginId)
}
