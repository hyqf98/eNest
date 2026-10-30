/** User-selected file handles; no arbitrary-path filesystem API is exposed to plugins. */
import { randomUUID } from 'node:crypto'
import { constants, existsSync, realpathSync, statSync } from 'node:fs'
import { lstat, open, realpath, readdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { app, dialog, nativeImage, shell } from 'electron'
import type { LocalFileHandle, LocalFilePickOptions } from '@shared/types/local-files'
import type { ClipboardFileInspection } from '@shared/types/plugin-tools'
import { pluginHost } from '@main/plugin/PluginHost'
import { acquireQuickInteraction } from '@main/window/createQuickWindow'
import { getAuxiliaryDialogParent } from '@main/window/pluginAuxiliaryWindows'
import { acquirePluginActivity } from '@main/plugin/activityRegistry'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { assertInteractive, assertInteractionEpoch, getInteractionEpoch, trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'

interface Grant { path: string; root: string; writable: boolean; temporary: boolean; pendingCreate?: boolean }
/** Internal native-backend lifetime guard; never accepted from renderer options. */
export interface LocalFileOperationControl { signal?: AbortSignal; assertCurrent?: () => void }
export type LocalFilePickerControl = LocalFileOperationControl
const grants = new Map<string, Map<string, Grant>>()
const exportsByPlugin = new Map<string, Map<string, { paths: string[]; icon: Electron.NativeImage; expiresAt: number }>>()
const activeDrags = new Map<string, () => void>()
const activePickers = new Map<string, Set<() => void>>()
const owners = new Map<string, symbol>()
const activeReads = new Map<symbol, number>()

function guardOwner(pluginId: string): () => void {
  const owner = owners.get(pluginId) ?? Symbol(pluginId)
  owners.set(pluginId, owner)
  return () => {
    if (owners.get(pluginId) !== owner) throw new Error('plugin file operation expired')
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function pickerGuard(pluginId: string, control: LocalFilePickerControl): () => void {
  const assertOwner = guardOwner(pluginId)
  return () => {
    assertOwner()
    if (control.signal?.aborted) throw new Error('file picker cancelled')
    control.assertCurrent?.()
  }
}

function waitForPicker<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  // Open/save dialogs have no cross-platform programmatic cancellation API.
  // Detach the operation immediately; a late native response must not mint a grant.
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('file picker cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export async function grantLocalFile(
  pluginId: string, path: string, options: { writable?: boolean; temporary?: boolean } = {}, assertCurrent?: () => void
): Promise<LocalFileHandle> {
  const assertOwner = guardOwner(pluginId)
  assertCurrent?.()
  if (!path || !isAbsolute(path)) throw new Error('an absolute selected path is required')
  const canonical = await realpath(path)
  const info = await stat(canonical)
  assertOwner()
  assertCurrent?.()
  if (!info.isFile() && !info.isDirectory()) throw new Error('unsupported file type')
  const id = randomUUID()
  const bag = grants.get(pluginId) ?? new Map<string, Grant>()
  if (bag.size >= 8192) throw new Error('local file handle limit reached; reopen the plugin')
  bag.set(id, { path: canonical, root: canonical, writable: options.writable ?? false, temporary: options.temporary ?? false })
  grants.set(pluginId, bag)
  return { id, name: basename(canonical), kind: info.isDirectory() ? 'directory' : 'file', size: info.size, displayPath: canonical }
}

export async function resolveLocalFileHandle(pluginId: string, id: string, access: 'read' | 'write' = 'read'): Promise<string> {
  const assertOwner = guardOwner(pluginId)
  const grant = grants.get(pluginId)?.get(id)
  if (!grant || (access === 'write' && !grant.writable)) throw new Error('invalid or expired local file handle')
  const canonical = grant.pendingCreate
    ? resolve(await realpath(dirname(grant.path)), basename(grant.path))
    : await realpath(grant.path)
  if (grant.pendingCreate) {
    const info = await lstat(canonical).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (info?.isSymbolicLink() || (info && !info.isFile())) throw new Error('selected target changed type')
  }
  assertOwner()
  // A selected path replaced by a symlink must not escape its original grant.
  if (!inside(grant.root, canonical)) throw new Error('selected path changed outside its granted scope')
  return canonical
}

/** Bounded content reads from an explicitly selected, runtime-owned file. */
export async function readLocalFile(pluginId: string, input: { handleId: string; encoding?: 'text' | 'dataUrl'; maxBytes?: number }): Promise<string> {
  const assertOwner = guardOwner(pluginId), owner = owners.get(pluginId)!
  const encoding = input.encoding ?? 'text'
  if (encoding !== 'text' && encoding !== 'dataUrl') throw new Error('unsupported file encoding')
  const limit = input.maxBytes ?? (encoding === 'text' ? 2 : 16) * 1024 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024) throw new Error('maxBytes must be between 1 and 32 MiB')
  if ((activeReads.get(owner) ?? 0) >= 2) throw new Error('local file read limit (2) reached')
  activeReads.set(owner, (activeReads.get(owner) ?? 0) + 1)
  const release = acquirePluginActivity(pluginId, `file-read:${randomUUID()}`, '读取已选择的文件')
  try {
    const path = await resolveLocalFileHandle(pluginId, input.handleId, 'read')
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > limit) throw new Error('selected file exceeds maxBytes or is not a regular file')
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        assertOwner()
        const block = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total))
        const { bytesRead } = await file.read(block, 0, block.length, null)
        if (!bytesRead) break
        total += bytesRead
        if (total > limit) throw new Error('selected file exceeds maxBytes')
        chunks.push(block.subarray(0, bytesRead))
      }
      assertOwner()
      const bytes = Buffer.concat(chunks)
      if (encoding === 'text') return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const prefix = bytes.subarray(0, 16)
      const mime = prefix.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : prefix[0] === 255 && prefix[1] === 216 ? 'image/jpeg'
        : prefix.toString('ascii', 0, 3) === 'GIF' ? 'image/gif'
        : prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
        : prefix.toString('ascii', 0, 2) === 'BM' ? 'image/bmp' : 'application/octet-stream'
      return `data:${mime};base64,${bytes.toString('base64')}`
    } finally { await file.close() }
  } finally {
    release()
    const count = (activeReads.get(owner) ?? 1) - 1
    if (count) activeReads.set(owner, count); else activeReads.delete(owner)
  }
}

export async function pickLocalFiles(pluginId: string, options: LocalFilePickOptions = {}, control: LocalFilePickerControl = {}): Promise<LocalFileHandle[]> {
  assertInteractive(pluginId)
  const assertOwner = pickerGuard(pluginId, control)
  assertOwner()
  const kind = options.kind ?? 'file'
  if (options.access !== undefined && !['read', 'write'].includes(options.access)) throw new Error('invalid file access')
  if (!['file', 'directory', 'any'].includes(kind)) throw new Error('invalid selection kind')
  const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = kind === 'directory' ? ['openDirectory'] : kind === 'any' ? ['openFile', 'openDirectory'] : ['openFile']
  if (options.multiple) properties.push('multiSelections')
  const releaseWindow = pluginHost.acquireWindowInteraction(pluginId)
  const releaseFocus = acquireQuickInteraction()
  const releaseActivity = acquirePluginActivity(pluginId, `picker:${randomUUID()}`, '本地文件选择')
  const pickers = activePickers.get(pluginId) ?? new Set<() => void>()
  activePickers.set(pluginId, pickers)
  let active = true
  const release = () => {
    if (!active) return
    active = false
    pickers.delete(release)
    if (activePickers.get(pluginId) === pickers && !pickers.size) activePickers.delete(pluginId)
    releaseWindow()
    releaseFocus()
    releaseActivity()
  }
  pickers.add(release)
  const created: string[] = []
  const rollback = (): void => { for (const id of created) grants.get(pluginId)?.delete(id) }
  const abort = (): void => { rollback(); release() }
  control.signal?.addEventListener('abort', abort, { once: true })
  try {
    assertOwner()
    const container = pluginHost.getContainerWindow(pluginId)
    const parent = getAuxiliaryDialogParent(pluginId) ?? (container?.isVisible() ? container : undefined)
    assertInteractive(pluginId)
    const nativeResult = trackNativeInteraction(parent ? dialog.showOpenDialog(parent, { properties, title: options.access === 'write' ? '选择允许插件修改的文件或目录' : '选择允许插件读取的文件或目录' }) : dialog.showOpenDialog({ properties, title: options.access === 'write' ? '选择允许插件修改的文件或目录' : '选择允许插件读取的文件或目录' }))
    const result = await waitForPicker(nativeResult, control.signal)
    assertOwner()
    if (result.canceled) return []
    const results = await Promise.allSettled(result.filePaths.map(async path => {
      const handle = await grantLocalFile(pluginId, path, { writable: options.access === 'write' }, assertOwner)
      created.push(handle.id)
      try { assertOwner(); return handle }
      catch (error) { grants.get(pluginId)?.delete(handle.id); throw error }
    }))
    assertOwner()
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return results.map(result => (result as PromiseFulfilledResult<LocalFileHandle>).value)
  } catch (error) {
    rollback()
    throw error
  } finally { control.signal?.removeEventListener('abort', abort); release() }
}

/** A save picker grants exactly one new or existing destination, never its siblings. */
export async function pickLocalSaveFile(pluginId: string, options: { defaultName?: string } = {}, control: LocalFilePickerControl = {}): Promise<LocalFileHandle | null> {
  assertInteractive(pluginId)
  if (options.defaultName !== undefined && (typeof options.defaultName !== 'string' || options.defaultName.length > 255 || options.defaultName.includes('\0'))) {
    throw new Error('invalid default file name')
  }
  const suggestedName = options.defaultName ? basename(options.defaultName) : undefined
  if (suggestedName !== undefined && (!suggestedName || suggestedName === '.' || suggestedName === '..')) {
    throw new Error('invalid default file name')
  }
  const assertOwner = pickerGuard(pluginId, control)
  const container = pluginHost.getContainerWindow(pluginId)
  const parent = getAuxiliaryDialogParent(pluginId) ?? (container?.isVisible() ? container : undefined)
  assertOwner()
  const releaseWindow = pluginHost.acquireWindowInteraction(pluginId)
  const releaseActivity = acquirePluginActivity(pluginId, `picker:${randomUUID()}`, '选择文件保存位置')
  const releaseFocus = acquireQuickInteraction()
  const pickers = activePickers.get(pluginId) ?? new Set<() => void>()
  activePickers.set(pluginId, pickers)
  let active = true
  const release = (): void => {
    if (!active) return
    active = false; pickers.delete(release)
    if (activePickers.get(pluginId) === pickers && !pickers.size) activePickers.delete(pluginId)
    releaseWindow(); releaseFocus(); releaseActivity()
  }
  pickers.add(release)
  control.signal?.addEventListener('abort', release, { once: true })
  try {
    assertOwner()
    const input = {
      title: '选择允许插件写入的文件',
      ...(suggestedName ? { defaultPath: suggestedName } : {})
    }
    assertInteractive(pluginId)
    const nativeResult = trackNativeInteraction(parent ? dialog.showSaveDialog(parent, input) : dialog.showSaveDialog(input))
    const answer = await waitForPicker(nativeResult, control.signal)
    assertOwner()
    if (answer.canceled || !answer.filePath) return null
    const path = resolve(await realpath(dirname(answer.filePath)), basename(answer.filePath))
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (info?.isSymbolicLink() || (info && !info.isFile())) throw new Error('only regular file targets are supported')
    assertOwner()
    const id = randomUUID(), bag = grants.get(pluginId) ?? new Map<string, Grant>()
    if (bag.size >= 8192) throw new Error('local file handle limit reached; reopen the plugin')
    bag.set(id, { path, root: path, writable: true, temporary: false, pendingCreate: !info })
    grants.set(pluginId, bag)
    return { id, name: basename(path), kind: 'file', size: info?.size ?? 0, displayPath: path }
  } finally { control.signal?.removeEventListener('abort', release); release() }
}

/** Resolve a child target without following an existing symlink out of a chosen directory. */
export async function resolveLocalDirectoryTarget(pluginId: string, handleId: string, name: string): Promise<string> {
  const assertOwner = guardOwner(pluginId)
  const directory = await resolveLocalFileHandle(pluginId, handleId, 'write')
  if (!(await stat(directory)).isDirectory() || basename(name) !== name || !name || name === '.' || name === '..') throw new Error('invalid download destination')
  const target = resolve(directory, name)
  const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (info?.isSymbolicLink() || (info && !info.isFile())) throw new Error('download target is not a regular file')
  assertOwner()
  return target
}

export async function localFilesFromDrop(pluginId: string, paths: string[]): Promise<LocalFileHandle[]> {
  assertInteractive(pluginId)
  if (!Array.isArray(paths) || paths.length > 20 || paths.some((path) => typeof path !== 'string' || !isAbsolute(path))) throw new Error('invalid dropped files')
  const assertOwner = guardOwner(pluginId)
  const parent = pluginHost.getContainerWindow(pluginId)
  if (!parent || parent.isDestroyed()) throw new Error('plugin window unavailable')
  const releaseWindow = pluginHost.acquireWindowInteraction(pluginId)
  const releaseFocus = acquireQuickInteraction()
  try {
    assertInteractive(pluginId)
    const answer = await trackNativeInteraction(dialog.showMessageBox(parent, { type: 'question', message: '允许插件读取这些拖入的文件？', detail: paths.slice(0, 20).join('\n'), buttons: ['取消', '允许读取'], defaultId: 0, cancelId: 0 }))
    assertOwner()
    if (answer.response !== 1) return []
    return Promise.all([...new Set(paths)].map((path) => grantLocalFile(pluginId, path, { writable: false })))
  } finally { releaseWindow(); releaseFocus() }
}

function dirnameOf(path: string): string {
  const parent = resolve(path, '..')
  return parent === path ? path : parent
}

export async function listLocalFiles(pluginId: string, input: { handleId: string; relativePath?: string }): Promise<{ directory: LocalFileHandle; entries: LocalFileHandle[] }> {
  const assertOwner = guardOwner(pluginId)
  const base = await resolveLocalFileHandle(pluginId, input.handleId)
  assertOwner()
  const parentGrant = grants.get(pluginId)!.get(input.handleId)!
  const path = await realpath(resolve(base, input.relativePath ?? '.'))
  if (!inside(parentGrant.root, path)) throw new Error('directory is outside selected scope')
  const dirInfo = await stat(path)
  if (!dirInfo.isDirectory()) throw new Error('not a directory')
  const names = await readdir(path)
  const entries: LocalFileHandle[] = []
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    assertOwner()
    const child = resolve(path, name)
    try {
      const info = await lstat(child)
      assertOwner()
      // Do not silently traverse links out of the user's selected directory.
      if (info.isSymbolicLink()) continue
      const handle = await grantLocalFile(pluginId, child, parentGrant)
      grants.get(pluginId)!.get(handle.id)!.root = parentGrant.root
      entries.push(handle)
    } catch { /* disappeared or unreadable: another entry remains usable */ }
  }
  assertOwner()
  const directory = await grantLocalFile(pluginId, path, parentGrant)
  grants.get(pluginId)!.get(directory.id)!.root = parentGrant.root
  return { directory, entries }
}

export async function revealLocalFile(pluginId: string, handleId: string): Promise<boolean> {
  assertInteractive(pluginId)
  const scope = getRuntimeScope(pluginId)!, epoch = getInteractionEpoch(scope)
  const path = await resolveLocalFileHandle(pluginId, handleId)
  assertInteractionEpoch(scope, epoch)
  assertInteractive(scope)
  shell.showItemInFolder(path)
  return true
}

/** Guessed paths must not become a filesystem-existence oracle. */
export async function inspectGrantedFilePaths(pluginId: string, paths: string[]): Promise<ClipboardFileInspection[]> {
  if (!Array.isArray(paths) || paths.length > 10000 || paths.some(path => typeof path !== 'string' || path.length > 32768 || path.includes('\0'))) throw new Error('invalid file paths')
  const assertOwner = guardOwner(pluginId)
  const known = new Map([...grants.get(pluginId)?.entries() ?? []].map(([id, grant]) => [grant.path, id]))
  const results: ClipboardFileInspection[] = []
  for (const path of paths) {
    assertOwner()
    const id = known.get(path)
    if (!id) { results.push({ path, exists: null }); continue }
    try {
      const target = await resolveLocalFileHandle(pluginId, id)
      const info = await stat(target)
      assertOwner()
      results.push({ path, exists: true, directory: info.isDirectory() })
    } catch (error) {
      assertOwner()
      results.push({ path, exists: (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null })
    }
  }
  return results
}

// —— fs.rename / fs.renameBatch（fs.rename 权限；仅同目录改名，句柄白名单内）——

/** 合法新文件名：1–255 字符；禁路径分隔符 / 盘符冒号 / 控制字符 / 点开头与纯点 */
const INVALID_NEW_NAME = /[\\/:*?"<>|\u0000-\u001f]/

export function validateNewName(newName: string): string {
  const name = String(newName ?? '').trim()
  if (!name || name.length > 255) throw new Error('文件名需为 1–255 个字符')
  if (INVALID_NEW_NAME.test(name)) throw new Error('文件名不能包含 \\ / : * ? " < > | 或控制字符')
  if (name === '.' || name === '..' || name.startsWith('.')) throw new Error('文件名不能以点开头')
  if (/^[a-zA-Z]:/.test(name)) throw new Error('文件名不能包含盘符')
  if (name.toLowerCase() === 'con' || name.toLowerCase() === 'nul' || name.toLowerCase() === 'aux') {
    throw new Error('该名称由系统保留')
  }
  return name
}

export interface RenameResult {
  handleId: string
  oldName: string
  newName: string
}

export interface RenameBatchItemResult extends RenameResult {
  ok: boolean
  error?: string
}

/**
 * 同目录改名：newName 仅是文件名（不含路径），重命名结果仍落在句柄原目录内。
 * 目标已存在时拒绝（node rename 在 POSIX 会静默覆盖，必须先 existsSync 探测）。
 * 改名成功后句柄自身指向新路径，后续 reveal / 文件读取继续可用。
 */
export async function renameLocalFile(pluginId: string, handleId: string, newName: string): Promise<RenameResult> {
  const assertOwner = guardOwner(pluginId)
  const validName = validateNewName(newName)
  const grant = grants.get(pluginId)?.get(handleId)
  if (!grant) throw new Error('文件句柄已失效（文件可能已被移动或删除），请重新拖入')
  const oldPath = await resolveLocalFileHandle(pluginId, handleId)
  assertOwner()
  const oldName = basename(oldPath)
  if (oldName === validName) return { handleId, oldName, newName: validName }
  const target = resolve(oldPath, '..', validName)
  // 同目录校验：newName 已禁分隔符（validateNewName），dirname 相等即目标必在原目录；
  // grant.root 为文件本体（pick/drop 路径）或父目录（list 派生路径），两种形态都放行
  if (dirname(target) !== dirname(oldPath)) {
    throw new Error('仅支持同目录改名')
  }
  if (existsSync(target)) throw new Error(`目标名称已存在：${validName}`)
  try {
    await rename(oldPath, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error('文件句柄已失效（文件可能已被移动或删除），请重新拖入')
    throw error
  }
  assertOwner()
  // 句柄跟随新路径（后续 reveal / 分享继续指向该文件）
  grants.get(pluginId)!.get(handleId)!.path = target
  if (grant.root === oldPath) grants.get(pluginId)!.get(handleId)!.root = target
  return { handleId, oldName, newName: validName }
}

/**
 * 批量改名：每项 { handleId, newName }，全部走同一白名单与防御校验；
 * confirmed !== true 时拒绝执行（危险操作二次确认）。单项失败不回滚其余，
 * 结果逐项返回 ok/error。
 */
export async function renameLocalFiles(
  pluginId: string,
  input: { items: Array<{ handleId: string; newName: string }>; confirmed?: boolean }
): Promise<{ results: RenameBatchItemResult[]; succeeded: number; failed: number }> {
  const items = Array.isArray(input?.items) ? input.items : []
  if (items.length < 1 || items.length > 1000) throw new Error('批量改名需 1–1000 项')
  if (input?.confirmed !== true) throw new Error('批量改名需要二次确认（confirmed: true）')
  const results: RenameBatchItemResult[] = []
  let succeeded = 0
  let failed = 0
  // 预检：批内目标名冲突（同一目录下两个句柄改成同名会互相覆盖）
  const targets = new Map<string, string>()
  for (const item of items) {
    const handleId = String(item?.handleId ?? '')
    const grant = grants.get(pluginId)?.get(handleId)
    const dir = grant ? dirnameOf(grant.path) : ''
    if (dir) {
      const key = `${dir}\u0000${String(item?.newName ?? '').trim().toLowerCase()}`
      if (targets.has(key) && targets.get(key) !== handleId) {
        throw new Error(`批量目标名冲突：${String(item?.newName ?? '')}`)
      }
      targets.set(key, handleId)
    }
  }
  for (const item of items) {
    const handleId = String(item?.handleId ?? '')
    try {
      const result = await renameLocalFile(pluginId, handleId, String(item?.newName ?? ''))
      results.push({ ...result, ok: true })
      succeeded++
    } catch (error) {
      results.push({ handleId, oldName: basename(grants.get(pluginId)?.get(handleId)?.path ?? '') || '', newName: String(item?.newName ?? ''), ok: false, error: (error as Error).message })
      failed++
    }
  }
  return { results, succeeded, failed }
}

export async function createLocalExport(pluginId: string, paths: string[], control: LocalFileOperationControl = {}): Promise<{ exportId: string }> {
  const assertOwner = guardOwner(pluginId)
  const assertCurrent = (): void => {
    assertOwner()
    if (control.signal?.aborted) throw new Error('file export cancelled')
    control.assertCurrent?.()
  }
  assertCurrent()
  if (!paths.length || paths.length > 1000) throw new Error('select between 1 and 1000 files to drag')
  const canonical = await Promise.all(paths.map(async (path) => {
    const value = await realpath(path)
    await stat(value)
    return value
  }))
  assertCurrent()
  let icon = await app.getFileIcon(canonical[0], { size: 'small' }).catch(() => nativeImage.createEmpty())
  assertCurrent()
  // Commit against the current bag only after all awaits, so parallel exports cannot replace it.
  const bag = exportsByPlugin.get(pluginId) ?? new Map()
  for (const [id, record] of bag) if (record.expiresAt < Date.now()) bag.delete(id)
  if (bag.size >= 128) throw new Error('local file export limit reached; reopen the plugin')
  const exportId = randomUUID()
  if (icon.isEmpty()) icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
  bag.set(exportId, { paths: canonical, icon, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
  exportsByPlugin.set(pluginId, bag)
  return { exportId }
}

export async function prepareLocalDrag(pluginId: string, handleIds: string[]): Promise<{ exportId: string }> {
  return createLocalExport(pluginId, await Promise.all(handleIds.map((id) => resolveLocalFileHandle(pluginId, id))))
}

export function startLocalDrag(pluginId: string, exportId: string): boolean {
  assertInteractive(pluginId)
  const item = exportsByPlugin.get(pluginId)?.get(exportId)
  if (!item || item.expiresAt < Date.now()) throw new Error('drag files are not prepared; prepare them again')
  const wc = pluginHost.getWebContents(pluginId)
  if (!wc || wc.isDestroyed()) throw new Error('plugin is closed')
  for (const path of item.paths) {
    if (realpathSync(path) !== path) throw new Error('prepared drag file changed; prepare it again')
    const info = statSync(path)
    if (!info.isFile() && !info.isDirectory()) throw new Error('prepared drag file no longer exists')
  }
  endLocalDrag(pluginId)
  const releaseWindow = pluginHost.acquireWindowInteraction(pluginId)
  const releaseFocus = acquireQuickInteraction()
  const releaseActivity = acquirePluginActivity(pluginId, `drag:${exportId}`, '原生文件拖出')
  const timer = setTimeout(() => endLocalDrag(pluginId), 60_000)
  timer.unref()
  activeDrags.set(pluginId, () => { clearTimeout(timer); releaseWindow(); releaseFocus(); releaseActivity() })
  // All asynchronous preparation precedes the user's drag gesture.
  try { wc.startDrag({ file: item.paths[0], files: item.paths, icon: item.icon }); return true }
  catch (error) { endLocalDrag(pluginId); throw error }
}

export function endLocalDrag(pluginId: string): boolean {
  activeDrags.get(pluginId)?.()
  activeDrags.delete(pluginId)
  return true
}

export function releaseLocalFiles(pluginId: string): void {
  owners.delete(pluginId)
  for (const release of activePickers.get(pluginId) ?? []) release()
  activePickers.delete(pluginId)
  endLocalDrag(pluginId)
  grants.delete(pluginId)
  exportsByPlugin.delete(pluginId)
}
