import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile, rename, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { dialog } from 'electron'
import { getAppPaths } from '@main/paths/pathsService'
import { acquireQuickInteraction } from '@main/window/createQuickWindow'
import { pluginHost } from '@main/plugin/PluginHost'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'

const queues = new Map<string, { tail: Promise<unknown>; count: number }>()
const blobDir = (id: string) => join(getAppPaths().data, 'plugin-attachments', createHash('sha256').update(id).digest('hex'))
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
const validateId = (id: string) => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的附件标识'); return id }
export function putPluginBlob(pluginId: string, input: { dataUrl: string }): Promise<{ id: string; bytes: number }> {
  const scope = owner(pluginId)
  if (typeof input?.dataUrl !== 'string' || input.dataUrl.length > 48 * 1024 * 1024) throw new Error('文件超过大小上限')
  const queue = queues.get(pluginId) ?? { tail: Promise.resolve(), count: 0 }
  if (queue.count >= 2) throw new Error('附件正在保存，请稍后重试')
  queue.count++; queues.set(pluginId, queue)
  let source: string | null = input.dataUrl
  const abort = () => { source = null }
  scope.signal.addEventListener('abort', abort, { once: true })
  const release = scope.acquireActivity('saving attachment')
  const task = queue.tail.catch(() => {}).then(async () => {
    current(scope)
    const { data, mime } = decode(source!); source = null
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('附件仅支持 PNG、JPEG 和 WebP')
    const dir = blobDir(pluginId)
    await mkdir(dir, { recursive: true })
    const files = await readdir(dir)
    const sizes = await Promise.all(files.map(file => stat(join(dir, file)).then(s => s.size).catch(() => 0)))
    current(scope)
    if (sizes.reduce((a, b) => a + b, 0) + data.length > 200 * 1024 * 1024) throw new Error('附件已达到 200 MB，请清理历史')
    const id = randomUUID(), file = join(dir, id)
    try {
      await writeFile(`${file}.blob`, data, { signal: scope.signal }); current(scope)
      await writeFile(`${file}.json`, JSON.stringify({ mime, bytes: data.length }), { signal: scope.signal }); current(scope)
      return { id, bytes: data.length }
    } catch (error) {
      await Promise.all([rm(`${file}.blob`, { force: true }), rm(`${file}.json`, { force: true })]); throw error
    }
  }).finally(() => {
    source = null; scope.signal.removeEventListener('abort', abort); release()
    queue.count--; if (!queue.count && queues.get(pluginId) === queue) queues.delete(pluginId)
  })
  queue.tail = task
  return task
}
export async function getPluginBlob(pluginId: string, id: string): Promise<{ dataUrl: string; bytes: number } | null> {
  const scope = owner(pluginId), file = join(blobDir(pluginId), validateId(id))
  try {
    const meta = JSON.parse(await readFile(`${file}.json`, { encoding: 'utf8', signal: scope.signal }))
    const data = await readFile(`${file}.blob`, { signal: scope.signal }); current(scope)
    return { dataUrl: `data:${meta.mime};base64,${data.toString('base64')}`, bytes: data.length }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export async function removePluginBlob(pluginId: string, id: string): Promise<boolean> {
  owner(pluginId)
  const file = join(blobDir(pluginId), validateId(id))
  await Promise.all([rm(`${file}.json`, { force: true }), rm(`${file}.blob`, { force: true })])
  return true
}
export async function clearPluginBlobs(pluginId: string): Promise<void> {
  await queues.get(pluginId)?.tail.catch(() => {})
  await rm(blobDir(pluginId), { recursive: true, force: true }); queues.delete(pluginId)
}
interface SaveInput { defaultName?: string; filename?: string; content?: string; dataUrl?: string }
const saving = new Set<string>()
export async function savePluginFile(pluginId: string, input: SaveInput): Promise<{ ok: boolean; path: string } | null> {
  const scope = owner(pluginId)
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
    const picked = await Promise.race([win && !win.isDestroyed() ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options), aborted])
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
