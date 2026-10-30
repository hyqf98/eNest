import { randomUUID } from 'node:crypto'
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { PluginActivationDispatch, PluginActivationReason, PluginActivationResult, PluginCommandOutcome } from '@shared/types/pluginLaunch'
import type { PluginEnterPayload } from '@shared/types/plugin'
import { pluginHost, type McpRuntime } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { assertSurfaceSender } from '@main/ipc/ipcSecurity'
import { isPluginPageUrl } from '@main/plugin/pluginSessionPolicy'
import { acquirePluginActivity } from '@main/plugin/activityRegistry'
import { acquireActivation, grantAuxiliaryInteraction, retireInteractionEpoch, setActivationContext, hasNonInteractiveLease, getHostRpcCount, isIndexSyncActivation } from '@main/plugin/pluginInteractionPolicy'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginSettingsBridge } from '@main/settings/PluginSettingsBridge'
import { acquireQuickInteraction } from '@main/window/createQuickWindow'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'
import { logWarn } from '@main/logs/logService'
import { initializeLaunchIndex, getLaunchIndexState, replaceLaunchIndex, onLaunchIndexDirty } from './launchIndex'

interface Registration { runtime: McpRuntime; id: string; handlers: Set<string> }
interface Job {
  id: string; pluginId: string; kind: PluginActivationDispatch['kind']; controller: AbortController
  runtime?: McpRuntime; registration?: Registration; cancelled: boolean; dispatched: boolean; settled: boolean
  release(): void; releaseActivation(): void; resolve(value: unknown): void; reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>; detach(): void
  settledListeners: Set<() => void>
}
const registrations = new Map<string, Registration>()
const jobs = new Map<string, Job>()
const ready = new Map<string, Set<() => void>>()
const stoppedResidents = new Map<string, { buildRevision: string; disabled: boolean }>()
const residentDesired = new Map<string, { buildRevision: string; enabled: boolean }>()
const residentSettingChanges = new Map<string, number>()
let settingRevision = 0
const synchronizedAttempts = new Map<string, { key: string; count: number }>()
const settingMutations = new Set<string>()
let registered = false, stopping = false, pumping = false, pumpRequested = false
let pumpTimer: ReturnType<typeof setTimeout> | undefined
const same = (a: McpRuntime, b: McpRuntime | null) => !!b && a.scope === b.scope && a.documentEpoch === b.documentEpoch && a.buildRevision === b.buildRevision
function identity(event: IpcMainEvent | IpcMainInvokeEvent): { pluginId: string; runtime: McpRuntime } {
  const pluginId = pluginHost.getPluginIdByWebContentsId(event.sender.id)
  if (!pluginId || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame
    || !isPluginPageUrl(event.senderFrame.url, pluginId, pluginRegistry.get(pluginId)?.devUrl)) throw new Error('Unauthorized activation sender')
  const runtime = pluginHost.getMcpRuntime(pluginId)
  if (!runtime || runtime.contents !== event.sender) throw new Error('Retired activation sender')
  return { pluginId, runtime }
}
function finish(job: Job, error?: Error, value?: unknown): void {
  if (job.settled) return
  job.settled = true
  if (job.timer) clearTimeout(job.timer)
  job.detach(); job.release(); job.releaseActivation()
  if (jobs.get(job.pluginId) === job) jobs.delete(job.pluginId)
  for (const listener of job.settledListeners) listener()
  job.settledListeners.clear()
  if (!job.cancelled) { if (error) job.reject(error); else job.resolve(value) }
  if (!pumping) schedulePump()
}
function cancel(job: Job, reason: string): void {
  if (job.cancelled || job.settled) return
  job.cancelled = true
  if (job.timer) clearTimeout(job.timer)
  job.controller.abort(new Error(reason))
  job.detach(); job.release()
  job.reject(new Error(reason))
  if (job.runtime) retireInteractionEpoch(job.runtime.scope)
  if (job.dispatched && job.runtime && job.registration && !job.runtime.contents.isDestroyed()) {
    job.runtime.contents.send(IpcChannels.PluginActivationCancel, { requestId: job.id, registrationId: job.registration.id })
  } else finish(job)
  // A dispatched handler owns its slot until its actual ACK or runtime retirement.
}
function waitReady(pluginId: string, runtime: McpRuntime, signal: AbortSignal): Promise<Registration> {
  return new Promise((resolve, reject) => {
    const callbacks = ready.get(pluginId) ?? new Set<() => void>()
    const clean = () => { callbacks.delete(check); if (!callbacks.size) ready.delete(pluginId); signal.removeEventListener('abort', abort) }
    const abort = () => { clean(); reject(signal.reason ?? new Error('Activation cancelled')) }
    const check = () => {
      if (signal.aborted) return abort()
      if (!same(runtime, pluginHost.getMcpRuntime(pluginId))) { clean(); reject(new Error('Activation runtime replaced')); return }
      const registration = registrations.get(pluginId)
      if (registration && same(runtime, registration.runtime)) { clean(); resolve(registration) }
    }
    callbacks.add(check); ready.set(pluginId, callbacks)
    signal.addEventListener('abort', abort, { once: true }); check()
  })
}

export interface ActivationOptions extends PluginEnterPayload {
  reason: PluginActivationReason
  entryId?: string
  enabled?: boolean
  guard?: () => boolean
  signal?: AbortSignal
  /** Host only: a verified settings action, never an automatic reconciliation or plugin message. */
  interactive?: boolean
  onDispatch?: () => void
}
/** No placement changes occur here. Only a validated view result may be committed by the launcher. */
export function invokePluginActivation(pluginId: string, kind: PluginActivationDispatch['kind'], options: ActivationOptions): Promise<unknown> {
  if (stopping || jobs.has(pluginId) || jobs.size >= 4) return Promise.reject(new Error('Plugin activation is busy'))
  if (options.signal?.aborted || options.guard?.() === false) return Promise.reject(new Error('Plugin activation cancelled'))
  const existing = getRuntimeScope(pluginId)
  // Never turn a live UI's concurrent save queue into a global read-only context.
  if (kind === 'index-sync' && existing && !isIndexSyncActivation(existing)) return Promise.reject(new Error('Index synchronization requires a dedicated hidden activation'))
  return new Promise((resolve, reject) => {
    const releaseActivity = acquirePluginActivity(pluginId, `activation:${randomUUID()}`, 'Plugin feature activation')
    let releaseInteraction = () => {}
    const job: Job = { id: randomUUID(), pluginId, kind, controller: new AbortController(), cancelled: false, dispatched: false, settled: false,
      resolve, reject, release: () => { releaseActivity(); releaseInteraction() }, releaseActivation: () => {}, detach: () => {}, settledListeners: new Set() }
    jobs.set(pluginId, job)
    const abort = () => cancel(job, 'Plugin activation cancelled')
    options.signal?.addEventListener('abort', abort, { once: true })
    job.detach = () => options.signal?.removeEventListener('abort', abort)
    job.timer = setTimeout(() => cancel(job, 'Plugin activation readiness timed out'), 15_000)
    job.timer.unref?.()
    void (async () => {
      try {
        const resident = options.reason === 'resident-restore' || options.reason === 'resident-setting'
        const context = kind === 'index-sync' ? 'index-sync' : resident ? 'resident' : 'command'
        const runtime = await pluginHost.ensureRunningForActivation(pluginId, context, job.controller.signal)
        job.runtime = runtime
        if (kind === 'index-sync' && !isIndexSyncActivation(runtime.scope)) throw new Error('Index synchronization context changed')
        const registration = await waitReady(pluginId, runtime, job.controller.signal)
        job.registration = registration
        if (job.cancelled || options.guard?.() === false || !same(runtime, pluginHost.getMcpRuntime(pluginId))) throw new Error('Plugin activation retired')
        // Do not interrupt an in-flight native dialog or a non-interactive MCP job.
        if (hasNonInteractiveLease(runtime.scope) || kind !== 'index-sync' && getHostRpcCount(runtime.scope)) throw new Error('Plugin has pending native requests')
        if (!registration.handlers.has(kind)) {
          if (kind === 'prepare-view') { setActivationContext(runtime.scope, context); finish(job); return }
          throw new Error(`Plugin has no ${kind} handler`)
        }
        job.releaseActivation = acquireActivation(runtime.scope, job.controller.signal)
        if (kind !== 'index-sync') {
          setActivationContext(runtime.scope, context)
          if (resident) pluginHost.setResidentLease(pluginId, options.enabled !== false)
          if (!resident || options.interactive === true) releaseInteraction = grantAuxiliaryInteraction(runtime.scope, 60_000)
        }
        if (job.timer) clearTimeout(job.timer)
        const duration = kind === 'index-sync' ? 15_000 : 60_000
        job.timer = setTimeout(() => cancel(job, 'Plugin activation timed out'), duration)
        job.timer.unref?.()
        job.dispatched = true
        options.onDispatch?.()
        runtime.contents.send(IpcChannels.PluginActivationDispatch, {
          requestId: job.id, registrationId: registration.id, kind, reason: options.reason, deadlineAt: Date.now() + duration,
          code: options.code, type: options.type, payload: options.payload, input: options.input, entryId: options.entryId, enabled: options.enabled
        } satisfies PluginActivationDispatch)
      } catch (error) { finish(job, error instanceof Error ? error : new Error(String(error))) }
    })()
  })
}

export function commandOutcome(value: unknown): PluginCommandOutcome {
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'done') return { type: 'done' }
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'view') {
    const target = (value as { target?: unknown }).target
    if (target === 'shell' || target === 'quick') return { type: 'view', target }
  }
  throw new Error('Invalid plugin command outcome')
}

function desiredResident(pluginId: string): { enabled: boolean; code: string } | null {
  const manifest = pluginRegistry.getManifest(pluginId), declaration = manifest?.activation?.resident
  if (!declaration || !isPluginSettingKey(declaration.setting) || !pluginRegistry.isEnabled(pluginId)) return null
  const field = manifest.contributes?.settings?.flatMap(section => section.items).find(item => item.key === declaration.setting && ['switch', 'boolean', 'bool'].includes(item.type))
  if (!field || manifest.features?.find(feature => feature.code === declaration.code)?.activation?.type !== 'command') return null
  const settings = settingsStore.getPluginSettings(pluginId)
  const enabled = Object.hasOwn(settings, declaration.setting) ? settings[declaration.setting] === true : field.default === true
  return { enabled, code: declaration.code }
}

function awaitSettlement(job: Job | undefined): Promise<void> {
  if (!job || job.settled) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); job.settledListeners.delete(finish); resolve() }
    const timer = setTimeout(finish, 2000)
    timer.unref?.()
    job.settledListeners.add(finish)
  })
}

/** Trusted native settings only. A successful return means both the command and durable setting committed. */
export async function setResidentSettingFromUser(
  event: IpcMainInvokeEvent, pluginId: string, key: string, value: unknown,
  options: { guard?: () => boolean; signal?: AbortSignal } = {}
): Promise<boolean> {
  const declaration = pluginRegistry.getManifest(pluginId)?.activation?.resident
  if (declaration?.setting !== key) return false
  assertSurfaceSender(event, IpcChannels.ShellSetPluginSetting)
  const previous = desiredResident(pluginId), frame = event.senderFrame
  if (!previous || !frame || typeof value !== 'boolean' || !pluginSettingsBridge.isWritableKey(pluginId, key)) throw new Error('Invalid resident setting')
  if (settingMutations.has(pluginId)) throw new Error('Resident setting is busy')
  const build = pluginRegistry.getBuildRevision(pluginId), sourceUrl = frame.url
  const fingerprint = () => {
    const settings = settingsStore.getPluginSettings(pluginId)
    return JSON.stringify([Object.hasOwn(settings, key), settings[key]])
  }
  const oldValue = fingerprint(), controller = new AbortController()
  let runtime: McpRuntime | undefined, dispatched = false, committed = false, committing = false, activationJob: Job | undefined
  let compensation: AbortController | undefined
  let releaseActivity = () => {}
  const releaseFocus = acquireQuickInteraction()
  const abort = () => controller.abort(new Error('Settings source retired or changed'))
  const navigate = (details: { isMainFrame: boolean }) => { if (details.isMainFrame) abort() }
  const ownerCurrent = () => pluginRegistry.isEnabled(pluginId) && pluginRegistry.getBuildRevision(pluginId) === build
    && (!runtime || same(runtime, pluginHost.getMcpRuntime(pluginId)))
  const current = () => {
    try {
      return !controller.signal.aborted && !event.sender.isDestroyed() && !frame.detached && event.sender.mainFrame === frame
        && frame.url === sourceUrl && ownerCurrent() && fingerprint() === oldValue
        && pluginSettingsBridge.isWritableKey(pluginId, key) && options.guard?.() !== false
    } catch { return false }
  }
  const requireCurrent = () => { if (!current()) { abort(); throw new Error('Settings source or value changed before commit') } }
  const offSettings = settingsStore.onPluginSettingChanged((id, changedKey) => {
    if (!committing && id === pluginId && changedKey === key && fingerprint() !== oldValue) { abort(); compensation?.abort() }
  })
  const offRegistry = pluginRegistry.onInstalledChanged(() => { if (!ownerCurrent()) { abort(); compensation?.abort() } })
  const offRuntime = pluginHost.onMcpRuntimeRetired(id => { if (id === pluginId && runtime) { abort(); compensation?.abort() } })
  event.sender.once('destroyed', abort)
  event.sender.on('render-process-gone', abort)
  event.sender.on('did-start-navigation', navigate)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  settingMutations.add(pluginId)
  try {
    requireCurrent()
    runtime = await pluginHost.ensureRunningForActivation(pluginId, 'resident', controller.signal)
    releaseActivity = runtime.scope.acquireActivity('Trusted resident setting mutation')
    requireCurrent()
    const pending = invokePluginActivation(pluginId, 'command', { reason: 'resident-setting', code: declaration.code, enabled: value,
      interactive: true, signal: controller.signal, guard: current, onDispatch: () => { dispatched = true } })
    activationJob = jobs.get(pluginId)
    const outcome = commandOutcome(await pending)
    if (outcome.type !== 'done') throw new Error('Resident setting must finish without presenting a primary view')
    requireCurrent()
    committing = true
    await settingsStore.setPluginSetting(pluginId, key, value)
    committed = true
    residentDesired.set(pluginId, { buildRevision: build, enabled: value })
    residentSettingChanges.delete(pluginId)
    stoppedResidents.delete(pluginId)
    return true
  } catch (error) {
    committing = false
    if (dispatched && !committed) {
      // Do not overwrite a newer setting, restart a retired runtime, or fake a cancellation ACK.
      await awaitSettlement(activationJob)
      const rollbackCurrent = () => !!runtime && ownerCurrent() && fingerprint() === oldValue
      if (rollbackCurrent()) {
        try {
          compensation = new AbortController()
          const outcome = commandOutcome(await invokePluginActivation(pluginId, 'command', { reason: 'resident-setting', code: declaration.code,
            enabled: previous.enabled, guard: rollbackCurrent, signal: compensation.signal }))
          if (outcome.type !== 'done') throw new Error('Resident compensation did not settle')
          if (rollbackCurrent()) residentDesired.set(pluginId, { buildRevision: build, enabled: previous.enabled })
        } catch (rollbackError) {
          logWarn('activation', `resident setting compensation ${pluginId}: ${String(rollbackError)}`)
          throw new Error(`${error instanceof Error ? error.message : String(error)}; resident state recovery was not confirmed`)
        }
      }
    }
    throw error
  } finally {
    settingMutations.delete(pluginId)
    offSettings(); offRegistry(); offRuntime()
    event.sender.removeListener('destroyed', abort)
    event.sender.removeListener('render-process-gone', abort)
    event.sender.removeListener('did-start-navigation', navigate)
    options.signal?.removeEventListener('abort', abort)
    releaseActivity(); releaseFocus()
    schedulePump()
  }
}

function schedulePump(delay = 100): void {
  if (pumping) { pumpRequested = true; return }
  if (stopping || pumpTimer) return
  pumpTimer = setTimeout(() => { pumpTimer = undefined; void pump() }, delay)
  pumpTimer.unref?.()
}
async function pump(): Promise<void> {
  if (pumping || stopping) return
  pumping = true
  let retry = false
  try {
    for (const descriptor of pluginRegistry.getInstalledDescriptors()) {
      if (stopping || !descriptor.enabled || jobs.has(descriptor.id) || settingMutations.has(descriptor.id)) continue
      const id = descriptor.id, resident = desiredResident(id)
      const reconciled = residentDesired.get(id)
      if (resident && stoppedResidents.get(id)?.buildRevision !== descriptor.buildRevision
        && (reconciled?.buildRevision !== descriptor.buildRevision || reconciled.enabled !== resident.enabled)) {
        const settingChange = residentSettingChanges.get(id)
        try {
          if (resident.enabled || getRuntimeScope(id)) {
            const outcome = commandOutcome(await invokePluginActivation(id, 'command', { reason: settingChange === undefined ? 'resident-restore' : 'resident-setting', code: resident.code, enabled: resident.enabled }))
            if (outcome.type !== 'done') throw new Error('Resident restoration cannot present a primary view')
          }
          residentDesired.set(id, { buildRevision: descriptor.buildRevision, enabled: resident.enabled })
          pluginHost.setResidentLease(id, resident.enabled)
        } catch (error) {
          logWarn('activation', `resident ${id}: ${String(error)}`)
          residentDesired.set(id, { buildRevision: descriptor.buildRevision, enabled: resident.enabled })
          pluginHost.setResidentLease(id, false)
        } finally {
          if (residentSettingChanges.get(id) === settingChange) residentSettingChanges.delete(id)
        }
      }
      const scope = getRuntimeScope(id)
      if (scope && !isIndexSyncActivation(scope)) continue
      if (!descriptor.manifest.activation?.indexSync || !getLaunchIndexState(id).dirty) continue
      const state = getLaunchIndexState(id), key = `${descriptor.buildRevision}:${state.revision}`
      const attempts = synchronizedAttempts.get(id)
      const count = attempts?.key === key ? attempts.count : 0
      if (count >= 3 || jobs.has(id)) continue
      synchronizedAttempts.set(id, { key, count: count + 1 })
      try {
        const entries = await invokePluginActivation(id, 'index-sync', { reason: 'index-sync' })
        if (pluginRegistry.getBuildRevision(id) !== descriptor.buildRevision) throw new Error('Plugin changed during index synchronization')
        replaceLaunchIndex(id, entries, state.revision)
      } catch (error) { logWarn('launch-index', `sync ${id}: ${String(error)}`); retry ||= count < 2 }
    }
  } finally {
    pumping = false
    if (retry || pumpRequested) { pumpRequested = false; schedulePump(retry ? 5000 : 100) }
  }
}

export function registerPluginActivationHandlers(): void {
  if (registered) return
  registered = true
  initializeLaunchIndex()
  ipcMain.handle(IpcChannels.PluginActivationRegister, (event, input: unknown) => {
    const { pluginId, runtime } = identity(event)
    if (!Array.isArray(input) || input.length > 3 || input.some(value => !['command', 'index-sync', 'prepare-view'].includes(value))) throw new Error('Invalid activation registration')
    const previous = registrations.get(pluginId)
    if (previous && same(previous.runtime, runtime)) throw new Error('Activation handlers already registered')
    const registration = { runtime, id: randomUUID(), handlers: new Set<string>(input) }
    registrations.set(pluginId, registration)
    for (const listener of ready.get(pluginId) ?? []) listener()
    schedulePump()
    return { registrationId: registration.id }
  })
  ipcMain.on(IpcChannels.PluginActivationResult, (event, result: PluginActivationResult) => {
    try {
      const { pluginId, runtime } = identity(event), job = jobs.get(pluginId)
      if (!job || !result || typeof result.ok !== 'boolean' || job.id !== result.requestId || job.registration?.id !== result.registrationId
        || !job.runtime || !same(job.runtime, runtime)) return
      if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024 + 4096) throw new Error('Activation response budget exceeded')
      finish(job, result.ok ? undefined : new Error(String(result.error ?? 'Plugin activation failed').slice(0, 512)), result.value)
    } catch (error) { logWarn('activation', String(error)) }
  })
  pluginHost.onMcpRuntimeRetired((pluginId, reason) => {
    registrations.delete(pluginId)
    const job = jobs.get(pluginId)
    if (job) { cancel(job, 'Plugin runtime retired'); finish(job) }
    for (const listener of ready.get(pluginId) ?? []) listener()
    if (reason.startsWith('close:')) stoppedResidents.set(pluginId, { buildRevision: pluginRegistry.getBuildRevision(pluginId), disabled: !pluginRegistry.isEnabled(pluginId) })
    schedulePump()
  })
  onLaunchIndexDirty(() => schedulePump())
  pluginRegistry.onInstalledChanged(() => {
    for (const [id, state] of residentDesired) if (!pluginRegistry.isEnabled(id) || pluginRegistry.getBuildRevision(id) !== state.buildRevision) residentDesired.delete(id)
    for (const [id, state] of stoppedResidents) {
      if (!pluginRegistry.isEnabled(id)) state.disabled = true
      else if (state.disabled || pluginRegistry.getBuildRevision(id) !== state.buildRevision) stoppedResidents.delete(id)
    }
    schedulePump(1000)
  })
  settingsStore.onPluginSettingChanged((pluginId, key) => {
    if (pluginRegistry.getManifest(pluginId)?.activation?.resident?.setting !== key) return
    stoppedResidents.delete(pluginId); residentDesired.delete(pluginId); residentSettingChanges.set(pluginId, ++settingRevision); schedulePump()
  })
  app.once('before-quit', () => {
    stopping = true
    if (pumpTimer) clearTimeout(pumpTimer)
    for (const job of jobs.values()) cancel(job, 'Application shutdown')
  })
  schedulePump(2000)
}
