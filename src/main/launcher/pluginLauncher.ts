import type { PluginEnterPayload, PluginLaunchTarget } from '@shared/types/plugin'
import type { QuickCommand, QuickEnterInput, QuickOpenRequest } from '@shared/types/quick'
import type { PluginActivationReason } from '@shared/types/pluginLaunch'
import { resolveQuickOpenCommand } from './commandIndex'
import { commandOutcome, invokePluginActivation } from './pluginActivation'
import { resolvePluginLaunchPresentation } from '@shared/pluginPresentation'
import { buildPluginTextInput } from '@shared/pluginTextInput'
import { capturePasteTarget } from '@main/clipboard/nativeClipboard'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import {
  acquireQuickInteraction, getQuickShowRevision, hideQuickWindow, isQuickVisible, prepareQuickWindowForPlugin
} from '@main/window/createQuickWindow'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { logWarn } from '@main/logs/logService'

export interface PluginLaunchRequest {
  pluginId: string
  mode?: PluginLaunchTarget
  source: 'shortcut' | 'quick' | 'workspace' | 'settings' | 'open-with'
  enter?: PluginEnterPayload
  /** Host-owned request validity; checked through preparation, before native presentation commits. */
  guard?: () => boolean
  /** Internal only: the feature dispatcher already resolved activation. */
  presentationOnly?: boolean
}

export interface PluginLaunchResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  presentation?: PluginLaunchTarget | 'none'
}

/** Native callers retain only the input delivered to this runtime incarnation. */
export interface PluginCommandResult extends PluginLaunchResult {
  input?: QuickEnterInput
  inputGeneration?: number
}

export interface ExecutePluginCommandOptions {
  source: PluginActivationReason
  defaultTarget: PluginLaunchTarget
  /** Explicit user destination, distinct from a surface's fallback preference. */
  target?: PluginLaunchTarget
  sessionId?: string
  query?: string
  input?: QuickEnterInput
  prepareInput?: () => Promise<QuickEnterInput | undefined>
  guard?: () => boolean
  signal?: AbortSignal
}

/** Static features, durable entries and live query capabilities share one native dispatcher. */
export async function executePluginCommand(command: QuickCommand, options: ExecutePluginCommandOptions): Promise<PluginCommandResult> {
  if (command.kind !== 'plugin' || !command.pluginId) return { ok: false, error: 'Invalid plugin command' }
  const reference: QuickOpenRequest = { kind: 'plugin', pluginId: command.pluginId, code: command.code, type: command.type,
    entryId: command.entryId, buildRevision: command.buildRevision, indexRevision: command.indexRevision,
    providerToken: command.providerToken, query: options.query }
  const sourceCurrent = () => !options.signal?.aborted && options.guard?.() !== false
  const releaseFocus = options.source === 'quick' ? acquireQuickInteraction() : () => {}
  try {
    const selected = resolveQuickOpenCommand(reference, options.sessionId)
    if (!sourceCurrent() || !selected) return { ok: false, cancelled: true, error: 'Launch entry is no longer available' }
    const pluginId = command.pluginId, buildRevision = pluginRegistry.getBuildRevision(pluginId)
    let preparedScope: PluginRuntimeScope | undefined
    const current = () => sourceCurrent() && pluginRegistry.isEnabled(pluginId) && pluginRegistry.getBuildRevision(pluginId) === buildRevision
      && !!resolveQuickOpenCommand(reference, options.sessionId)
      && (!preparedScope || preparedScope.isCurrent() && !preparedScope.isClosing && getRuntimeScope(pluginId) === preparedScope)
    const manifest = pluginRegistry.getManifest(pluginId)
    const activation = manifest?.features?.find(feature => feature.code === selected.code)?.activation
    const queryInput = buildPluginTextInput(options.query, selected.aliases ?? [], selected.textInput)
    const enter: PluginEnterPayload = { code: selected.code, type: selected.type,
      ...(selected.payload !== undefined ? { payload: selected.payload } : options.query ? { payload: options.query.slice(0, 4096), type: selected.type ?? 'text' } : {}) }
    // Only a declared text entry can consume its alias. Indexed/provider payloads remain opaque.
    if (queryInput?.query?.trigger) enter.payload = queryInput.text
    const mergeInput = (input: QuickEnterInput | undefined) => queryInput ? { ...input, ...queryInput } : input
    enter.input = mergeInput(options.input)
    if (activation || manifest?.activation || options.prepareInput || enter.input) {
      preparedScope = (await pluginHost.ensureRunningForActivation(pluginId, 'command', options.signal)).scope
      if (!current()) return { ok: false, cancelled: true }
    }
    if (options.prepareInput) {
      enter.input = mergeInput(await options.prepareInput())
      if (!current()) return { ok: false, cancelled: true }
    }
    let target = activation?.type === 'view' ? activation.target : undefined
    target ??= options.target ?? (options.source === 'quick' ? undefined : options.defaultTarget)
    if (activation?.type === 'command') {
      const outcome = commandOutcome(await invokePluginActivation(pluginId, 'command', { ...enter, entryId: selected.entryId,
        reason: options.source, guard: current, signal: options.signal }))
      if (!current()) return { ok: false, cancelled: true }
      if (outcome.type === 'done') {
        if (options.source === 'quick') hideQuickWindow('plugin-command')
        return { ok: true, presentation: 'none' }
      }
      target = outcome.target
    }
    if (activation || manifest?.activation) {
      await invokePluginActivation(pluginId, 'prepare-view', { ...enter, entryId: selected.entryId,
        reason: options.source, guard: current, signal: options.signal })
      if (!current()) return { ok: false, cancelled: true }
    }
    const result = await launchPlugin({ pluginId, source: options.source === 'workspace' ? 'workspace'
      : options.source === 'settings' || options.source === 'shortcut' || options.source === 'open-with' ? options.source : 'quick',
      enter, mode: target, guard: current, presentationOnly: true })
    const scope = getRuntimeScope(pluginId)
    return result.ok && enter.input && scope?.isCurrent() && !scope.isClosing && (!preparedScope || scope === preparedScope)
      ? { ...result, input: enter.input, inputGeneration: scope.owner.generation } : result
  } catch (error) {
    return { ok: false, ...(sourceCurrent() ? {} : { cancelled: true }), error: error instanceof Error ? error.message : String(error) }
  } finally { releaseFocus() }
}

let intentRevision = 0
let lastRequest: { key: string; at: number; pending: boolean; promise: Promise<PluginLaunchResult>; revision: number; guard?: () => boolean; canReuse: () => boolean } | undefined
let captureFlight: { revision: number; promise: Promise<void> } | undefined
const REPEAT_DELAY = 260

function captureOriginalTarget(revision: number): Promise<void> {
  if (captureFlight?.revision === revision) return captureFlight.promise
  const flight = { revision, promise: capturePasteTarget() }
  captureFlight = flight
  void flight.promise.finally(() => { if (captureFlight === flight) captureFlight = undefined }).catch(() => {})
  return flight.promise
}

/** One foreground intent, one reusable runtime; shortcut launches never enter the search list. */
export function launchPlugin(request: PluginLaunchRequest): Promise<PluginLaunchResult> {
  if (!request.presentationOnly) {
    const manifest = pluginRegistry.getManifest(request.pluginId)
    const feature = manifest?.features?.find(feature => feature.code === request.enter?.code)
    if (manifest?.activation || feature?.activation) return (async () => {
      const releaseFocus = request.source === 'quick' ? acquireQuickInteraction() : () => {}
      try {
        const build = pluginRegistry.getBuildRevision(request.pluginId)
        const current = () => request.guard?.() !== false && pluginRegistry.isEnabled(request.pluginId) && pluginRegistry.getBuildRevision(request.pluginId) === build
        let mode = feature?.activation?.type === 'view' ? feature.activation.target ?? request.mode : request.mode
        if (feature?.activation?.type === 'command') {
          const outcome = commandOutcome(await invokePluginActivation(request.pluginId, 'command', { ...request.enter, reason: request.source, guard: current }))
          if (!current()) return { ok: false, cancelled: true }
          if (outcome.type === 'done') {
            if (request.source === 'quick') hideQuickWindow('plugin-command')
            return { ok: true, presentation: 'none' as const }
          }
          mode = outcome.target
        }
        await invokePluginActivation(request.pluginId, 'prepare-view', { ...request.enter, reason: request.source, guard: current })
        if (!current()) return { ok: false, cancelled: true }
        return await launchPlugin({ ...request, mode, guard: current, presentationOnly: true })
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      finally { releaseFocus() }
    })()
  }
  const requestGuard = request.guard
  const sourceCurrent = (): boolean => {
    try { return requestGuard?.() !== false }
    catch { return false }
  }
  if (!sourceCurrent()) return Promise.resolve({ ok: false, cancelled: true })
  const pluginId = String(request.pluginId ?? '').trim()
  const summary = pluginRegistry.get(pluginId)
  if (!pluginId || !summary?.installed || summary.enabled === false) {
    return Promise.resolve({ ok: false, error: '插件未安装或已停用' })
  }
  if (request.mode !== undefined && request.mode !== 'quick' && request.mode !== 'shell') {
    return Promise.resolve({ ok: false, error: '无效的启动方式' })
  }
  const configured = settingsStore.getPluginLaunchConfig(pluginId)?.mode
  const requested: PluginLaunchTarget = request.mode ?? (configured === 'shell' ? 'shell' : 'quick')
  const { target, layoutMode } = resolvePluginLaunchPresentation(pluginRegistry.getManifest(pluginId)?.views, requested)
  if (layoutMode !== requested) logWarn('plugin-launch', `${pluginId}: layout ${requested} not adapted, falling back to ${layoutMode} in ${target}`)
  const placement = pluginHost.getPlacement(pluginId)
  // Ordinary search focuses resident surfaces. Explicit destinations still move the View.
  const residentSearch = request.source === 'quick' && request.mode === undefined
    && (placement.kind === 'detached' || placement.kind === 'panel')
  const key = `${request.source}:${pluginId}:${residentSearch ? 'resident' : target}:${layoutMode}`
  const now = Date.now()
  if (!request.enter && lastRequest?.key === key && lastRequest.revision === intentRevision
    && lastRequest.guard === requestGuard
    && lastRequest.canReuse()
    && (lastRequest.pending || request.source === 'shortcut' && now - lastRequest.at < REPEAT_DELAY)) {
    lastRequest.at = now
    return lastRequest.promise
  }

  const revision = ++intentRevision
  const quickRevision = getQuickShowRevision()
  const placementRevision = pluginHost.getPlacementRevision(pluginId)
  const shellWindow = !residentSearch && target === 'shell' ? getMainWindow() : null
  let windowDismissed = false
  let succeeded = false
  let reusableQuickRevision = quickRevision
  let reusablePlacementRevision = placementRevision
  const dismiss = () => { windowDismissed = true }
  shellWindow?.on?.('hide', dismiss)
  shellWindow?.on?.('closed', dismiss)
  const current = () => sourceCurrent() && !windowDismissed && revision === intentRevision && pluginHost.getPlacementRevision(pluginId) === placementRevision
    && (target !== 'quick' || residentSearch || getQuickShowRevision() === quickRevision)
  const operation = {
    key, at: now, pending: true, revision, guard: requestGuard, promise: Promise.resolve<PluginLaunchResult>({ ok: false }),
    canReuse: () => sourceCurrent() && !windowDismissed && (operation.pending || succeeded)
      && pluginHost.getPlacementRevision(pluginId) === reusablePlacementRevision
      && (target !== 'quick' || residentSearch || getQuickShowRevision() === reusableQuickRevision)
      && (operation.pending || target !== 'shell' || residentSearch || shellWindow?.isVisible?.() !== false)
  }
  operation.promise = (async (): Promise<PluginLaunchResult> => {
    try {
      if (residentSearch) {
        await pluginHost.openPlugin(pluginId, request.enter, { guard: current })
      } else {
        if (target === 'quick') {
          const prepared = await Promise.all([
            isQuickVisible() ? Promise.resolve() : captureOriginalTarget(quickRevision),
            prepareQuickWindowForPlugin(current)
          ])
          if (!current()) return { ok: false, cancelled: true }
          if (!prepared[1]) throw new Error('快捷小窗暂时无法打开，请重试')
        }
        if (!current()) return { ok: false, cancelled: true }
        await pluginHost.launchPluginIn(pluginId, target, request.enter, current, layoutMode)
      }
      // A committed launch may deliberately deactivate its source (for example Workspace).
      // The external guard governs preparation, not a post-commit visibility observation.
      if (windowDismissed || revision !== intentRevision) return { ok: false, cancelled: true }
      if (target === 'shell' || residentSearch) {
        hideQuickWindow('plugin-launch')
        if (residentSearch) {
          pluginHost.focusPlugin(pluginId)
        } else {
          const win = getMainWindow()
          if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
          }
        }
      }
      succeeded = true
      return { ok: true, presentation: residentSearch ? 'none' : target }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!sourceCurrent() || windowDismissed || revision !== intentRevision || /plugin (?:launch|opening|restoration) cancelled/.test(message)
        || /preparation was cancelled/.test(message) && getQuickShowRevision() !== quickRevision) return { ok: false, cancelled: true }
      logWarn('plugin-launch', `${pluginId}: ${message}`)
      // A blocked launch does not mean the already-running plugin crashed.
      if (request.source === 'shortcut') sendShellEvent({ type: 'plugin-toast', pluginId, message, toastType: 'warn' })
      return { ok: false, error: message }
    } finally {
      operation.pending = false
      if (succeeded) {
        reusableQuickRevision = getQuickShowRevision()
        reusablePlacementRevision = pluginHost.getPlacementRevision(pluginId)
      }
      shellWindow?.removeListener?.('hide', dismiss)
      shellWindow?.removeListener?.('closed', dismiss)
    }
  })()
  lastRequest = operation
  return operation.promise
}
