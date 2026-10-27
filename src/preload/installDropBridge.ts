import { ipcRenderer, webUtils } from 'electron'
import * as IpcChannels from '@shared/types/ipc'

interface NativeFileDrag {
  isTrusted: boolean
  dataTransfer?: { types: ArrayLike<string>; items: ArrayLike<{ type: string }>; files: ArrayLike<File>; dropEffect: string }
  preventDefault(): void
  stopImmediatePropagation(): void
}
const events = globalThis as unknown as { addEventListener?: (name: string, callback: (event: NativeFileDrag) => void, capture?: boolean) => void }

/** This bridge stays in the isolated preload world; plugins cannot submit arbitrary paths. */
export function bindNativeInstallDrop(packagesOnly = false): void {
  if (process.isMainFrame === false) return
  let depth = 0
  let heartbeat = 0
  const isFiles = (event: NativeFileDrag) => event.isTrusted && Array.from(event.dataTransfer?.types ?? []).includes('Files')
  const hasUnclassifiedType = (event: NativeFileDrag) => Array.from(event.dataTransfer?.items ?? [])
    .some(item => !item.type || /^application\/octet-stream$/i.test(item.type))
  const update = (active: boolean) => ipcRenderer.send(IpcChannels.InstallDropState, active)
  events.addEventListener?.('dragenter', event => {
    if (!isFiles(event)) return
    // File names are protected until drop. Only explicit ZIP types show the target;
    // unknown and generic binary files stay with the editor until their paths can be checked.
    if (packagesOnly && !Array.from(event.dataTransfer?.items ?? []).some(item => /^(?:application\/(?:zip|x-zip|x-zip-compressed)|multipart\/x-zip)$/i.test(item.type))) return
    event.preventDefault()
    if (++depth === 1) update(true)
  }, true)
  events.addEventListener?.('dragover', event => {
    if (!isFiles(event)) return
    if (packagesOnly && depth === 0) {
      // Allow a drop for unknown/generic binary files (including .enestplugin) without
      // stopping the editor's own handlers or covering it with an install target.
      if (hasUnclassifiedType(event)) event.preventDefault()
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    if (Date.now() - heartbeat > 250) { heartbeat = Date.now(); update(true) }
  }, true)
  events.addEventListener?.('dragleave', event => {
    if (!isFiles(event) || depth === 0) return
    if (--depth <= 0) { depth = 0; update(false) }
  }, true)
  events.addEventListener?.('drop', event => {
    if (!isFiles(event)) return
    const paths = Array.from(event.dataTransfer?.files ?? []).slice(0, 16).map(file => {
      try { return webUtils.getPathForFile(file) } catch { return '' }
    }).filter(path => path && (!packagesOnly || /\.(zip|enestplugin)$/i.test(path)))
    depth = 0
    update(false)
    if (packagesOnly && !paths.length) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (paths.length) ipcRenderer.send(IpcChannels.InstallDropFiles, paths)
  }, true)
  events.addEventListener?.('blur', () => { depth = 0; update(false) })
}
