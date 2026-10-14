import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { pluginHost } from '@main/plugin/PluginHost'
import { bindQuickInputHost, clearQuickInput, configureQuickInput, escapeQuickInput } from '@main/plugin/quickInputService'
import { getPluginBlob, putPluginBlob, removePluginBlob, savePluginFile } from '@main/plugin/pluginFiles'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { hideQuickWindow, showQuickWindow, getQuickShowRevision } from '@main/window/createQuickWindow'
import { nativeCapabilities, requestNativePermission, type PasteOwner } from '@main/clipboard/nativeClipboard'
import { queryHistory, copyHistoryEntry, pasteHistoryEntry, revealHistoryFile, onClipboardHistoryChange } from '@main/clipboard/clipboardHistory'
import { startFocusTimer, getFocusTimer, pauseFocusTimer, resumeFocusTimer, skipFocusTimer, stopFocusTimer, updateFocusTimerRecord } from '@main/timer/focusTimerService'
import type { PluginPermission } from '@shared/types/plugin'
import type { QuickInputConfig, ClipboardQuery } from '@shared/types/plugin-tools'
import type { FocusTimerOptions, FocusTimerRecordPatch } from '@shared/types/focus-timer'

export const PLUGIN_TOOL_PERMISSIONS: Record<string, PluginPermission | null> = {
  'quickInput.configure': null, 'quickInput.release': null, 'quickInput.escape': null, 'ui.openSettings': null,
  'storage.blobs.put': 'storage.local', 'storage.blobs.get': 'storage.local', 'storage.blobs.remove': 'storage.local',
  'shell.saveFile': 'fs.write', 'shell.saveTextFile': 'fs.write',
  'clipboard.capabilities': null, 'clipboard.requestPermission': 'clipboard.paste',
  'clipboard.history.query': 'clipboard.history', 'clipboard.history.copy': 'clipboard.history',
  'clipboard.history.paste': 'clipboard.paste', 'clipboard.history.reveal': 'clipboard.history',
  'focusTimer.start': 'timer.background', 'focusTimer.get': null, 'focusTimer.pause': 'timer.background',
  'focusTimer.resume': 'timer.background', 'focusTimer.skip': 'timer.background', 'focusTimer.stop': 'timer.background',
  'focusTimer.updateRecord': 'timer.background'
}
let bound = false
export function bindPluginTools(): void {
  if (bound) return
  bound = true
  bindQuickInputHost({ current: () => pluginHost.getQuickPlugin(), send: (id, event) => pluginHost.sendEvent(id, event), dismiss: id => pluginHost.dismissQuickPlugin(id) })
  onClipboardHistoryChange(() => pluginHost.broadcastEvent({ type: 'clipboard-history-change' }))
}
function pasteOwner(pluginId: string): PasteOwner {
  const scope = getRuntimeScope(pluginId), container = pluginHost.getContainer(pluginId)
  let revision = getQuickShowRevision(), hidden = false
  const runtimeCurrent = () => !!scope?.isCurrent() && !scope.isClosing && pluginHost.getContainer(pluginId) === container
  const isCurrent = () => runtimeCurrent() && getQuickShowRevision() === revision && (container !== 'quick' || (hidden ? !pluginHost.getQuickPlugin() : pluginHost.getQuickPlugin() === pluginId))
  return {
    isCurrent,
    beforePaste() {
      if (container !== 'quick' || !isCurrent()) return
      hideQuickWindow('clipboard-paste'); hidden = true; revision = getQuickShowRevision()
      return async () => {
        if (!isCurrent()) return
        const canRestore = () => runtimeCurrent() && !pluginHost.getQuickPlugin()
        if (await showQuickWindow(canRestore) && canRestore()) await pluginHost.openPlugin(pluginId, undefined, { container: 'quick' })
      }
    }
  }
}
export async function dispatchPluginTool(pluginId: string, method: string, args: unknown[]): Promise<unknown> {
  const first = args[0] as never
  switch (method) {
    case 'quickInput.configure': return configureQuickInput(pluginId, first as QuickInputConfig)
    case 'quickInput.release': clearQuickInput(pluginId); return true
    case 'quickInput.escape': return escapeQuickInput(pluginId)
    case 'ui.openSettings': {
      hideQuickWindow('plugin-settings'); pluginHost.hideAllViews()
      const win = getMainWindow(); if (win && !win.isDestroyed()) { win.show(); win.focus() }
      sendShellEvent({ type: 'plugin-open-settings', pluginId }); return true
    }
    case 'storage.blobs.put': return putPluginBlob(pluginId, first)
    case 'storage.blobs.get': return getPluginBlob(pluginId, String(args[0] ?? ''))
    case 'storage.blobs.remove': return removePluginBlob(pluginId, String(args[0] ?? ''))
    case 'shell.saveFile': case 'shell.saveTextFile': return savePluginFile(pluginId, first)
    case 'clipboard.capabilities': return nativeCapabilities()
    case 'clipboard.requestPermission': return requestNativePermission()
    case 'clipboard.history.query': return queryHistory(first as ClipboardQuery)
    case 'clipboard.history.copy': return copyHistoryEntry(String(args[0] ?? ''), args[1] as { paths?: boolean; plainText?: boolean }, getRuntimeScope(pluginId)?.signal)
    case 'clipboard.history.paste': return pasteHistoryEntry(String(args[0] ?? ''), getRuntimeScope(pluginId)?.signal, pasteOwner(pluginId))
    case 'clipboard.history.reveal': return revealHistoryFile(String(args[0] ?? ''), Number(args[1]) || 0)
    case 'focusTimer.get': return getFocusTimer(pluginId)
    case 'focusTimer.start': return startFocusTimer(pluginId, first as Partial<FocusTimerOptions>)
    case 'focusTimer.pause': return pauseFocusTimer(pluginId)
    case 'focusTimer.resume': return resumeFocusTimer(pluginId)
    case 'focusTimer.skip': return skipFocusTimer(pluginId)
    case 'focusTimer.stop': return stopFocusTimer(pluginId)
    case 'focusTimer.updateRecord': return updateFocusTimerRecord(pluginId, String(args[0] ?? ''), args[1] as FocusTimerRecordPatch)
    default: throw new Error('Unknown plugin tool method')
  }
}
