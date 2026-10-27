import { randomUUID } from 'node:crypto'
import { writeFile, rename, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog } from 'electron'
import { acquireQuickInteraction } from '@main/window/createQuickWindow'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { assertInteractive, trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'

export { putPluginBlob, getPluginBlob, removePluginBlob, clearPluginAssets as clearPluginBlobs } from './pluginAssets'

function owner(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing) throw new Error('plugin runtime is closing or stale')
  return scope
}
function current(scope: PluginRuntimeScope): void { if (!scope.isCurrent() || scope.signal.aborted) throw new Error('plugin runtime is closing or stale') }
function decode(dataUrl: string, max = 32 * 1024 * 1024): { data: Buffer; mime: string } {
  if (typeof dataUrl !== 'string' || dataUrl.length > max * 1.5) throw new Error('文件超过大小上限')
  const match = /^data:([\w.+/-]+)(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!match) throw new Error('无效的文件数据')
  const data = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  if (data.length > max) throw new Error('文件超过大小上限')
  return { data, mime: match[1] }
}
interface SaveInput { defaultName?: string; filename?: string; content?: string; dataUrl?: string }
const saving = new Set<string>()
export async function savePluginFile(pluginId: string, input: SaveInput): Promise<{ ok: boolean; path: string } | null> {
  const scope = owner(pluginId)
  assertInteractive(scope)
  if (saving.has(pluginId)) throw new Error('已有保存对话框，请先完成或取消')
  if (String(input?.dataUrl ?? input?.content ?? '').length > 96 * 1024 * 1024) throw new Error('导出文件超过 64 MB')
  let payload: SaveInput | null = { ...input }
  // Release the IPC argument before awaiting a native dialog that may outlive its owner.
  input = {}
  const releaseWindow = pluginHost.acquireWindowInteraction(pluginId)
  saving.add(pluginId)
  const releaseFocus = acquireQuickInteraction(), releaseActivity = scope.acquireActivity('saving file')
  let rejectAbort: (reason: Error) => void = () => {}
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => { payload = null; releaseWindow(); releaseFocus(); releaseActivity(); rejectAbort(new Error('保存已取消：插件已关闭')) }
  scope.signal.addEventListener('abort', abort, { once: true })
  try {
    const options = { defaultPath: basename(payload.defaultName || payload.filename || 'export.txt') }
    const win = pluginHost.getContainerWindow(pluginId)
    assertInteractive(scope)
    const nativeResult = trackNativeInteraction(win && !win.isDestroyed() ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options))
    const picked = await Promise.race([nativeResult, aborted])
    current(scope)
    if (picked.canceled || !picked.filePath || !payload) return null
    const data = payload.dataUrl !== undefined ? decode(payload.dataUrl, 64 * 1024 * 1024).data : Buffer.from(String(payload.content ?? ''), 'utf8')
    payload = null
    if (data.length > 64 * 1024 * 1024) throw new Error('导出文件超过 64 MB')
    const temporary = `${picked.filePath}.${randomUUID()}.tmp`
    try { await writeFile(temporary, data, { signal: scope.signal }); current(scope); await rename(temporary, picked.filePath) }
    catch (error) { await rm(temporary, { force: true }); throw error }
    return { ok: true, path: picked.filePath }
  } finally { payload = null; scope.signal.removeEventListener('abort', abort); saving.delete(pluginId); releaseWindow(); releaseFocus(); releaseActivity() }
}
