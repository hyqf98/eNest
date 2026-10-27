import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { pluginHost } from '@main/plugin/PluginHost'
import { bindQuickInputHost, clearQuickInput, configureQuickInput, escapeQuickInput } from '@main/plugin/quickInputService'
import { savePluginFile } from '@main/plugin/pluginFiles'
import { getPluginBlob, putPluginBlob, removePluginBlob, putPluginAsset, listPluginAssets, getPluginAsset, removePluginAsset } from '@main/plugin/pluginAssets'
import { listPluginStoredFiles, getPluginStoredFile, removePluginStoredFile, exportPluginStoredFile } from '@main/plugin/pluginFileStreams'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { hideQuickWindow, showQuickWindow, getQuickShowRevision } from '@main/window/createQuickWindow'
import { nativeCapabilities, requestNativePermission, pasteToOriginal, type PasteOwner } from '@main/clipboard/nativeClipboard'
import { inspectGrantedFilePaths, localFilesFromDrop, revealLocalFile } from '@main/plugin/localFiles'
import { resolvePluginPath } from '@main/plugin/pluginPathResolve'
import { readQuickEnterInput } from '@main/launcher/quickInputContext'
import { startDeadlineTask, getDeadlineTask, pauseDeadlineTask, resumeDeadlineTask, skipDeadlineTask, cancelDeadlineTask } from '@main/timer/deadlineTaskService'
import type { PluginPathResolveInput, PluginPermission } from '@shared/types/plugin'
import type { QuickInputConfig } from '@shared/types/plugin-tools'
import type { DeadlineTaskStart } from '@shared/types/deadline-task'
import type { PluginStoredFileReadOptions, PluginStoredFileExportOptions } from '@shared/types/file-stream'
import { assertInteractive, assertInteractionEpoch, getInteractionEpoch, trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'

export const PLUGIN_TOOL_PERMISSIONS: Record<string, PluginPermission | null> = {
  'quickInput.configure': null, 'quickInput.release': null, 'quickInput.escape': null, 'quickInput.readContext': null, 'ui.openSettings': null,
  'storage.blobs.put': 'storage.local', 'storage.blobs.get': 'storage.local', 'storage.blobs.remove': 'storage.local',
  'storage.assets.put': 'storage.local', 'storage.assets.list': 'storage.local', 'storage.assets.get': 'storage.local', 'storage.assets.remove': 'storage.local', 'storage.assets.delete': 'storage.local',
  'storage.files.list': 'storage.local', 'storage.files.get': 'storage.local', 'storage.files.remove': 'storage.local', 'storage.files.export': 'fs.write',
  'shell.saveFile': 'fs.write', 'shell.saveTextFile': 'fs.write',
  'shell.resolvePath': null,
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
  assertInteractive(pluginId)
  const interactionEpoch = getInteractionEpoch(scope!)
  const placementRevision = pluginHost.getPlacementRevision(pluginId)
  let revision = getQuickShowRevision(), hidden = false
  const runtimeCurrent = () => {
    assertInteractionEpoch(scope!, interactionEpoch)
    assertInteractive(scope!)
    return !!scope?.isCurrent() && !scope.isClosing && pluginHost.getPlacementRevision(pluginId) === placementRevision
  }
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
    case 'quickInput.escape': assertInteractive(pluginId); return escapeQuickInput(pluginId)
    case 'quickInput.readContext': {
      // 仅返回本实例当前 runtime 代次最近一次 Quick 打开注入的输入上下文。
      const scope = getRuntimeScope(pluginId)
      if (!scope?.isCurrent() || scope.isClosing) return null
      return readQuickEnterInput(pluginId, scope.owner.generation)
    }
    case 'ui.openSettings': {
      assertInteractive(pluginId)
      hideQuickWindow('plugin-settings'); pluginHost.hideAllViews()
      const win = getMainWindow(); if (win && !win.isDestroyed()) { win.show(); win.focus() }
      sendShellEvent({ type: 'plugin-open-settings', pluginId }); return true
    }
    case 'storage.blobs.put': return putPluginBlob(pluginId, first)
    case 'storage.blobs.get': return getPluginBlob(pluginId, String(args[0] ?? ''))
    case 'storage.blobs.remove': return removePluginBlob(pluginId, String(args[0] ?? ''))
    case 'storage.assets.put': return putPluginAsset(pluginId, first)
    case 'storage.assets.list': return listPluginAssets(pluginId)
    case 'storage.assets.get': return getPluginAsset(pluginId, String(args[0] ?? ''))
    case 'storage.assets.remove':
    case 'storage.assets.delete': return removePluginAsset(pluginId, String(args[0] ?? ''))
    case 'storage.files.list': return listPluginStoredFiles(pluginId, first)
    case 'storage.files.get': return getPluginStoredFile(pluginId, String(args[0] ?? ''), args[1] as PluginStoredFileReadOptions | undefined)
    case 'storage.files.remove': return removePluginStoredFile(pluginId, String(args[0] ?? ''))
    case 'storage.files.export': return exportPluginStoredFile(pluginId, String(args[0] ?? ''), args[1] as PluginStoredFileExportOptions | undefined)
    case 'shell.saveFile': case 'shell.saveTextFile': return savePluginFile(pluginId, first)
    case 'shell.resolvePath': return resolvePluginPath(pluginId, first as PluginPathResolveInput)
    case 'clipboard.capabilities': return nativeCapabilities()
    case 'clipboard.requestPermission': assertInteractive(pluginId); return trackNativeInteraction(requestNativePermission())
    case 'clipboard.paste': assertInteractive(pluginId); return pasteToOriginal(getRuntimeScope(pluginId)?.signal, pasteOwner(pluginId))
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
