import type { PluginEnterPayload, PluginLaunchMode } from '@shared/types/plugin'
import { capturePasteTarget } from '@main/clipboard/nativeClipboard'
import { pluginHost } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import {
  getQuickShowRevision, hideQuickWindow, isQuickVisible, prepareQuickWindowForPlugin
} from '@main/window/createQuickWindow'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { logWarn } from '@main/logs/logService'

export interface PluginLaunchRequest {
  pluginId: string
  mode?: PluginLaunchMode
  source: 'shortcut' | 'quick' | 'settings' | 'open-with'
  enter?: PluginEnterPayload
}

export interface PluginLaunchResult {
  ok: boolean
  error?: string
  cancelled?: boolean
}

let intentRevision = 0
let lastRequest: { key: string; at: number; pending: boolean; promise: Promise<PluginLaunchResult>; revision: number; canReuse: () => boolean } | undefined
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
  const pluginId = String(request.pluginId ?? '').trim()
  const summary = pluginRegistry.get(pluginId)
  if (!pluginId || !summary?.installed || summary.enabled === false) {
    return Promise.resolve({ ok: false, error: '插件未安装或已停用' })
  }
  if (request.mode !== undefined && request.mode !== 'quick' && request.mode !== 'shell') {
    return Promise.resolve({ ok: false, error: '无效的启动方式' })
  }
  const configured = settingsStore.getPluginLaunchConfig(pluginId)?.mode
  const mode: PluginLaunchMode = request.mode ?? (configured === 'shell' ? 'shell' : 'quick')
  const key = `${request.source}:${pluginId}:${mode}`
  const now = Date.now()
  if (!request.enter && lastRequest?.key === key && lastRequest.revision === intentRevision
    && lastRequest.canReuse()
    && (lastRequest.pending || request.source === 'shortcut' && now - lastRequest.at < REPEAT_DELAY)) {
    lastRequest.at = now
    return lastRequest.promise
  }

  const revision = ++intentRevision
  const quickRevision = getQuickShowRevision()
  const placementRevision = pluginHost.getPlacementRevision(pluginId)
  const shellWindow = mode === 'shell' ? getMainWindow() : null
  let windowDismissed = false
  let succeeded = false
  let reusableQuickRevision = quickRevision
  let reusablePlacementRevision = placementRevision
  const dismiss = () => { windowDismissed = true }
  shellWindow?.on?.('hide', dismiss)
  shellWindow?.on?.('closed', dismiss)
  // Search retains its established independent-window behavior. Explicit bindings
  // and the settings launch button always honor the chosen destination.
  const detachedSearch = request.source === 'quick' && pluginHost.getPlacement(pluginId).kind === 'detached'
  const current = () => !windowDismissed && revision === intentRevision && pluginHost.getPlacementRevision(pluginId) === placementRevision
    && (mode !== 'quick' || detachedSearch || getQuickShowRevision() === quickRevision)
  const operation = {
    key, at: now, pending: true, revision, promise: Promise.resolve<PluginLaunchResult>({ ok: false }),
    canReuse: () => !windowDismissed && (operation.pending || succeeded)
      && pluginHost.getPlacementRevision(pluginId) === reusablePlacementRevision
      && (mode !== 'quick' || getQuickShowRevision() === reusableQuickRevision)
      && (operation.pending || mode !== 'shell' || shellWindow?.isVisible?.() !== false)
  }
  operation.promise = (async (): Promise<PluginLaunchResult> => {
    try {
      if (detachedSearch) {
        await pluginHost.openPlugin(pluginId, request.enter, { guard: current })
      } else {
        if (mode === 'quick') {
          const prepared = await Promise.all([
            isQuickVisible() ? Promise.resolve() : captureOriginalTarget(quickRevision),
            prepareQuickWindowForPlugin(current)
          ])
          if (!current()) return { ok: false, cancelled: true }
          if (!prepared[1]) throw new Error('快捷小窗暂时无法打开，请重试')
        }
        if (!current()) return { ok: false, cancelled: true }
        await pluginHost.launchPluginIn(pluginId, mode, request.enter, current)
      }
      if (windowDismissed || revision !== intentRevision) return { ok: false, cancelled: true }
      if (mode === 'shell' || detachedSearch) {
        hideQuickWindow('plugin-launch')
        if (!detachedSearch) {
          const win = getMainWindow()
          if (win && !win.isDestroyed()) {
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
          }
        }
      }
      succeeded = true
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (windowDismissed || revision !== intentRevision || /plugin (?:launch|opening|restoration) cancelled/.test(message)
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
