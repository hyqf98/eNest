import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { pluginHost } from '@main/plugin/PluginHost'
import { bindQuickInputHost, clearQuickInput, configureQuickInput, escapeQuickInput } from '@main/plugin/quickInputService'
import { getPluginBlob, putPluginBlob, removePluginBlob, savePluginFile } from '@main/plugin/pluginFiles'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { hideQuickWindow, showQuickWindow, getQuickShowRevision } from '@main/window/createQuickWindow'
import { nativeCapabilities, requestNativePermission, pasteToOriginal, type PasteOwner } from '@main/clipboard/nativeClipboard'
import { inspectGrantedFilePaths, localFilesFromDrop, revealLocalFile } from '@main/plugin/localFiles'
import { startDeadlineTask, getDeadlineTask, pauseDeadlineTask, resumeDeadlineTask, skipDeadlineTask, cancelDeadlineTask } from '@main/timer/deadlineTaskService'
import type { PluginPermission } from '@shared/types/plugin'
import type { QuickInputConfig } from '@shared/types/plugin-tools'
import type { DeadlineTaskStart } from '@shared/types/deadline-task'

export const PLUGIN_TOOL_PERMISSIONS: Record<string, PluginPermission | null> = {
  'quickInput.configure': null, 'quickInput.release': null, 'quickInput.escape': null, 'ui.openSettings': null,
  'storage.blobs.put': 'storage.local', 'storage.blobs.get': 'storage.local', 'storage.blobs.remove': 'storage.local',
  'shell.saveFile': 'fs.write', 'shell.saveTextFile': 'fs.write',
  'clipboard.capabilities': null, 'clipboard.requestPermission': 'clipboard.paste',
  'clipboard.paste': 'clipboard.paste', 'clipboard.inspectFiles': null, 'clipboard.revealFile': null,
  'deadlineTasks.start': 'timer.background', 'deadlineTasks.get': null, 'deadlineTasks.pause': 'timer.background',
  'deadlineTasks.resume': 'timer.background', 'deadlineTasks.skip': 'timer.background', 'deadlineTasks.cancel': 'timer.background'
}
let bound = false
export function bindPluginTools(): void {
  if (bound) return
  bound = true
  bindQuickInputHost({
    current: () => pluginHost.getQuickPlugin(),
    owns: id => pluginHost.isQuickInputOwner(id),
    detached: id => pluginHost.getPlacement(id).kind === 'detached',
    publish: (id, event) => pluginHost.sendSurfaceEvent(id, event),
    focus: id => { pluginHost.focusPlugin(id) },
    send: (id, event) => pluginHost.sendEvent(id, event),
    dismiss: id => pluginHost.dismissQuickPlugin(id)
  })
}
function pasteOwner(pluginId: string): PasteOwner {
  const scope = getRuntimeScope(pluginId), container = pluginHost.getPlacement(pluginId).kind
  const placementRevision = pluginHost.getPlacementRevision(pluginId)
  let revision = getQuickShowRevision(), hidden = false
  const runtimeCurrent = () => !!scope?.isCurrent() && !scope.isClosing && pluginHost.getPlacementRevision(pluginId) === placementRevision
  const isCurrent = () => runtimeCurrent() && (container !== 'quick' || getQuickShowRevision() === revision && (hidden ? !pluginHost.getQuickPlugin() : pluginHost.getQuickPlugin() === pluginId))
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
    case 'clipboard.paste': return pasteToOriginal(getRuntimeScope(pluginId)?.signal, pasteOwner(pluginId))
    case 'clipboard.inspectFiles': return inspectGrantedFilePaths(pluginId, first)
    case 'clipboard.revealFile': {
      const scope = getRuntimeScope(pluginId)
      const handles = await localFilesFromDrop(pluginId, [String(args[0] ?? '')])
      if (!scope?.isCurrent() || scope.isClosing) throw new Error('plugin runtime is closing or stale')
      return handles[0] ? revealLocalFile(pluginId, handles[0].id) : false
    }
    case 'deadlineTasks.get': return getDeadlineTask(pluginId, String(args[0] ?? ''))
    case 'deadlineTasks.start': return startDeadlineTask(pluginId, first as DeadlineTaskStart)
    case 'deadlineTasks.pause': return pauseDeadlineTask(pluginId, String(args[0] ?? ''))
    case 'deadlineTasks.resume': return resumeDeadlineTask(pluginId, String(args[0] ?? ''))
    case 'deadlineTasks.skip': return skipDeadlineTask(pluginId, String(args[0] ?? ''))
    case 'deadlineTasks.cancel': return cancelDeadlineTask(pluginId, String(args[0] ?? ''))
    default: throw new Error('Unknown plugin tool method')
  }
}
