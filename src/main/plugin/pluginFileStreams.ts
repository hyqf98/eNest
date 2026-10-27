import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { getAppPaths } from '@main/paths/pathsService'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import type { FileStreamOpen, FileStreamResult, PluginStoredFile, PluginStoredFileChunk, PluginStoredFilePage, PluginStoredFileListOptions, PluginStoredFileReadOptions, PluginStoredFileExportOptions, PluginStoredFileExportResult } from '@shared/types/file-stream'
import { syncDirectory } from './pluginStorageIO'

const MAX_FILE = 1024 * 1024 * 1024
const MAX_OWNER_BYTES = 4 * MAX_FILE
const MAX_CHUNK = 512 * 1024
const MAX_QUEUE = 8 * 1024 * 1024
const MAX_FILES = 4096
const MAX_DIRECTORY_ENTRIES = 8192
const MAX_LOOKUP_ENTRIES = 262144
const MAX_LOOKUP_MS = 5000
const UUID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
const OUTPUT_ID = new RegExp(`^${UUID}$`)
const OUTPUT_NAME = new RegExp(`^(${UUID})\\.([a-z0-9]{1,12})$`)
const PARTIAL_NAME = new RegExp(`^${UUID}\\.part$`)
interface Output {
  id: string
  scope: PluginRuntimeScope
  part: string
  path: string
  file?: FileHandle
  phase: 'opening' | 'writing' | 'finishing' | 'closed'
  sequence: number
  bytes: number
  queued: number
  pending: number
  tail: Promise<unknown>
  release: () => void
  result?: Promise<FileStreamResult>
  cleanup?: Promise<void>
}
const outputs = new Map<string, Output>()
const deleting = new Set<string>()
const storedQueues = new Map<string, { pending: number; tail: Promise<unknown> }>()
let storedPending = 0
function owner(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (deleting.has(pluginId) || !scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('File stream owner is closing')
  return scope
}
function current(output: Output): void {
  if (deleting.has(output.scope.owner.pluginId) || !output.scope.isCurrent() || output.scope.drainSignal.aborted || output.phase === 'closed') throw new Error('File stream owner is closing')
}
function currentStored(scope: PluginRuntimeScope): void {
  if (deleting.has(scope.owner.pluginId) || !scope.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('Private output owner is closing')
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function validId(id: unknown): string {
  if (typeof id !== 'string' || !OUTPUT_ID.test(id)) throw new Error('Invalid private output ID')
  return id
}
async function directory(pluginId: string, create: boolean, check: () => void): Promise<string | null> {
  check()
  const root = await realpath(getAppPaths().data)
  const base = join(root, 'plugin-files'), dir = join(base, createHash('sha256').update(pluginId).digest('hex'))
  for (const path of [base, dir]) {
    check()
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) throw new Error('Private output directory is not canonical')
  }
  check()
  return dir
}
async function namesIn(dir: string, check: () => void): Promise<string[]> {
  const names: string[] = []
  const handle = await opendir(dir)
  for await (const entry of handle) {
    check()
    if (names.length >= MAX_DIRECTORY_ENTRIES) throw new Error('Private output directory entry limit reached')
    names.push(entry.name)
  }
  check()
  return names
}
function storedTask<T>(scope: PluginRuntimeScope, run: () => Promise<T>, check = (): void => currentStored(scope), stream = false): Promise<T> {
  check()
  const pluginId = scope.owner.pluginId, queue = storedQueues.get(pluginId) ?? { pending: 0, tail: Promise.resolve() }
  // The separately bounded active streams retain a place to open/finish even when reads fill the public queue.
  if (!stream && (queue.pending >= 16 || storedPending >= 64)) throw new Error('Private output operation queue is full')
  const release = stream ? (): void => {} : scope.acquireActivity('private output operation')
  queue.pending++; storedPending++; storedQueues.set(pluginId, queue)
  const task = queue.tail.catch(() => {}).then(() => { check(); return run() }).finally(() => {
    release(); storedPending--
    if (--queue.pending === 0 && storedQueues.get(pluginId) === queue) storedQueues.delete(pluginId)
  })
  queue.tail = task
  return task
}
function owned(pluginId: string, id: string): Output {
  const scope = getRuntimeScope(pluginId), output = outputs.get(id)
  if (!output || output.scope !== scope) throw new Error('File stream not owned by this runtime')
  current(output)
  return output
}
function abort(output: Output): Promise<void> {
  if (output.cleanup) return output.cleanup
  if (output.phase === 'closed') return Promise.resolve()
  output.phase = 'closed'
  output.cleanup = output.tail.catch(() => {}).then(async () => {
    await output.file?.close().catch(() => {})
    output.file = undefined
    if (output.part) await rm(output.part, { force: true })
  }).catch(() => {}).finally(() => { outputs.delete(output.id); output.release() })
  return output.cleanup
}
export async function openFileStream(pluginId: string, input: FileStreamOpen): Promise<{ streamId: string }> {
  const scope = owner(pluginId)
  if (!input || typeof input.extension !== 'string' || !/^[a-z0-9]{1,12}$/.test(input.extension) || input.extension === 'part') throw new Error('Invalid private file extension')
  if (outputs.size >= 16 || [...outputs.values()].filter(value => value.scope.owner.pluginId === pluginId).length >= 2) throw new Error('File stream limit reached')
  const id = randomUUID()
  const output: Output = { id, scope, part: '', path: '', phase: 'opening', sequence: 0, bytes: 0, queued: 0, pending: 0, tail: Promise.resolve(), release: () => {} }
  outputs.set(id, output)
  const releaseActivity = scope.acquireActivity('private file stream')
  const onAbort = (): void => { void abort(output) }
  const detach = scope.addDisposer(() => abort(output))
  scope.drainSignal.addEventListener('abort', onAbort, { once: true })
  let released = false
  output.release = () => { if (!released) { released = true; detach(); scope.drainSignal.removeEventListener('abort', onAbort); releaseActivity() } }
  const check = (): void => { current(output); owner(pluginId) }
  output.tail = storedTask(scope, async () => {
    const dir = (await directory(pluginId, true, check))!
    output.part = join(dir, `${id}.part`); output.path = join(dir, `${id}.${input.extension}`)
    const files = await namesIn(dir, check)
    let completed = 0
    let used = 0
    for (const name of files) {
      const path = join(dir, name)
      const activePartial = [...outputs.values()].some(value => value.part === path)
      // Only our UUID temp files are reclaimable after a crash; completed outputs are never rewritten.
      const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error })
      if (info?.isSymbolicLink() || info && !info.isFile()) throw new Error('Private output entry is not a regular file')
      if (PARTIAL_NAME.test(name) && !activePartial) await rm(path, { force: true })
      else if (!activePartial && info) { used += info.size; completed++ }
      current(output); owner(pluginId)
    }
    const activeCount = [...outputs.values()].filter(value => value.scope.owner.pluginId === pluginId).length
    if (completed + activeCount > MAX_FILES) throw new Error('Private output file count limit reached')
    const reserved = activeCount * MAX_FILE
    if (used + reserved > MAX_OWNER_BYTES) throw new Error('Private output storage limit reached')
    owner(pluginId)
    output.file = await open(output.part, 'wx', 0o600)
    current(output); owner(pluginId)
    output.phase = 'writing'
  }, check, true)
  try { await output.tail; current(output); return { streamId: id } }
  catch (error) { await abort(output); throw error }
}
export async function writeFileStream(pluginId: string, id: string, sequence: number, bytes: ArrayBuffer): Promise<void> {
  const output = owned(pluginId, id)
  if (output.phase !== 'writing' || !Number.isSafeInteger(sequence) || sequence !== output.sequence) throw new Error('File stream sequence invalid')
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_CHUNK || !bytes.byteLength) throw new Error('File stream chunk exceeds 512 KiB')
  if (output.pending >= 16 || output.queued + bytes.byteLength > MAX_QUEUE || output.bytes + bytes.byteLength > MAX_FILE) throw new Error('File stream byte limit reached')
  output.sequence++
  output.pending++
  output.queued += bytes.byteLength
  output.bytes += bytes.byteLength
  let buffer: Buffer | undefined = Buffer.from(bytes)
  const length = bytes.byteLength
  const task = output.tail.then(async () => {
    current(output)
    let offset = 0
    while (buffer && offset < buffer.length) {
      current(output)
      const written = await output.file!.write(buffer, offset, buffer.length - offset, null)
      if (!written.bytesWritten) throw new Error('Private file write made no progress')
      offset += written.bytesWritten
    }
    current(output)
  }).finally(() => { buffer = undefined; output.queued -= length; output.pending-- })
  output.tail = task
  try { await task } catch (error) { void abort(output); throw error }
}
export function finishFileStream(pluginId: string, id: string): Promise<FileStreamResult> {
  const output = owned(pluginId, id)
  if (output.result) return output.result
  if (output.phase !== 'writing') return Promise.reject(new Error('File stream not writable'))
  output.phase = 'finishing'
  const work = output.tail.then(() => storedTask(output.scope, async () => {
      current(output)
      await output.file!.sync(); current(output)
      await output.file!.close(); output.file = undefined; current(output)
      await rename(output.part, output.path)
      // Rename publishes the output; a late close or durability failure must not delete it.
      try {
        try { await syncDirectory(dirname(output.path)) }
        catch (error) { throw new Error(`Private output ${output.id} was committed but its durability is uncertain; inspect storage.files before retrying`, { cause: error }) }
        try { current(output) }
        catch (error) { throw new Error(`Private output ${output.id} was committed but its owner is closing; inspect storage.files before retrying`, { cause: error }) }
        return { id: output.id, path: output.path, size: output.bytes }
      } finally {
        output.phase = 'closed'
        outputs.delete(output.id); output.release()
      }
  }, () => current(output), true))
  output.tail = work
  output.result = work.catch(async error => { await abort(output); throw error })
  return output.result
}
export function abortFileStream(pluginId: string, id: string): Promise<boolean> {
  const scope = getRuntimeScope(pluginId), output = outputs.get(id)
  if (!output) return Promise.resolve(false)
  if (output.scope !== scope) return Promise.reject(new Error('File stream not owned by this runtime'))
  return abort(output).then(() => true)
}

interface StoredFile { meta: PluginStoredFile; path: string; info: Stats }
function metadata(id: string, extension: string, info: Stats): PluginStoredFile {
  return { id, extension, size: info.size, createdAt: info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs }
}
async function storedInfo(scope: PluginRuntimeScope, dir: string, name: string): Promise<StoredFile | null> {
  const match = OUTPUT_NAME.exec(name)
  if (!match || match[2] === 'part') return null
  if (outputs.get(match[1])?.scope.owner.pluginId === scope.owner.pluginId) return null
  const path = join(dir, name)
  const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error })
  currentStored(scope)
  if (!info) return null
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Private output entry is not a regular file')
  return { meta: metadata(match[1], match[2], info), path, info }
}
async function locateStored(scope: PluginRuntimeScope, id: string): Promise<{ dir: string; name: string } | null> {
  if (outputs.get(id)?.scope.owner.pluginId === scope.owner.pluginId) throw new Error('Private output is not finished')
  const check = (): void => currentStored(scope), dir = await directory(scope.owner.pluginId, false, check)
  if (!dir) return null
  // Known IDs remain recoverable above the listing limit without retaining the whole directory.
  const started = performance.now(), handle = await opendir(dir)
  let scanned = 0, name: string | undefined
  for await (const entry of handle) {
    check()
    if (++scanned > MAX_LOOKUP_ENTRIES || performance.now() - started > MAX_LOOKUP_MS) throw new Error('Private output lookup scan limit reached')
    if (!entry.name.startsWith(`${id}.`) || PARTIAL_NAME.test(entry.name) || !OUTPUT_NAME.test(entry.name)) continue
    if (name) throw new Error('Private output ID is ambiguous')
    name = entry.name
  }
  check()
  if (performance.now() - started > MAX_LOOKUP_MS) throw new Error('Private output lookup scan limit reached')
  return name ? { dir, name } : null
}
async function findStored(scope: PluginRuntimeScope, id: string): Promise<StoredFile | null> {
  const found = await locateStored(scope, id)
  return found ? storedInfo(scope, found.dir, found.name) : null
}
function unchanged(before: Stats, after: Stats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}
async function openStored(scope: PluginRuntimeScope, record: StoredFile): Promise<FileHandle> {
  currentStored(scope)
  const handle = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    currentStored(scope)
    if (!unchanged(record.info, info) || info.size > MAX_FILE) throw new Error('Private output changed or exceeds the 1 GiB read limit')
    return handle
  } catch (error) { await handle.close(); throw error }
}
function validateOptions(options: unknown): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid private output options')
}
export function listPluginStoredFiles(pluginId: string, options: PluginStoredFileListOptions = {}): Promise<PluginStoredFilePage> {
  const scope = owner(pluginId)
  validateOptions(options)
  const cursor = options.cursor === undefined ? undefined : validId(options.cursor), limit = options.limit === undefined ? 100 : options.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Private output page limit must be 1..200')
  return storedTask(scope, async () => {
    const check = (): void => currentStored(scope), dir = await directory(pluginId, false, check)
    if (!dir) return { items: [], nextCursor: null }
    const names = (await namesIn(dir, check)).filter(name => {
      const match = OUTPUT_NAME.exec(name)
      return match && match[2] !== 'part' && (!cursor || match[1] > cursor)
    }).sort()
    const items: PluginStoredFile[] = [], seen = new Set<string>()
    for (const name of names) {
      const record = await storedInfo(scope, dir, name)
      if (!record) continue
      if (seen.has(record.meta.id)) throw new Error('Private output ID is ambiguous')
      seen.add(record.meta.id); items.push(record.meta)
      if (items.length > limit) break
    }
    const more = items.length > limit
    if (more) items.pop()
    return { items, nextCursor: more ? items[items.length - 1].id : null }
  })
}
export function getPluginStoredFile(pluginId: string, id: string, options: PluginStoredFileReadOptions = {}): Promise<PluginStoredFileChunk | null> {
  const scope = owner(pluginId), fileId = validId(id)
  validateOptions(options)
  const offset = options.offset === undefined ? 0 : options.offset, length = options.length === undefined ? MAX_CHUNK : options.length
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK) throw new Error('Private output read requires a nonnegative safe offset and length 1..524288')
  return storedTask(scope, async () => {
    const record = await findStored(scope, fileId)
    if (!record) return null
    const handle = await openStored(scope, record)
    try {
      const bytes = new ArrayBuffer(Math.min(length, Math.max(0, record.info.size - offset)))
      const buffer = Buffer.from(bytes)
      let read = 0
      while (read < buffer.length) {
        currentStored(scope)
        const result = await handle.read(buffer, read, buffer.length - read, offset + read)
        if (!result.bytesRead) throw new Error('Private output changed during read')
        read += result.bytesRead
      }
      if (!unchanged(record.info, await handle.stat())) throw new Error('Private output changed during read')
      currentStored(scope)
      return { file: record.meta, offset, bytes, nextOffset: offset + read < record.info.size ? offset + read : null }
    } finally { await handle.close() }
  })
}
export function removePluginStoredFile(pluginId: string, id: string): Promise<boolean> {
  const scope = owner(pluginId), fileId = validId(id)
  return storedTask(scope, async () => {
    const found = await locateStored(scope, fileId)
    if (!found) return false
    const path = join(found.dir, found.name)
    const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error })
    if (!info) return false
    if (info.isDirectory()) throw new Error('Private output entry is not a file')
    currentStored(scope)
    // A damaged symlink may be removed, never followed to its target.
    await rm(path)
    await syncDirectory(found.dir)
    currentStored(scope)
    return true
  })
}
export function exportPluginStoredFile(pluginId: string, id: string, options: PluginStoredFileExportOptions = {}): Promise<PluginStoredFileExportResult | null> {
  const scope = owner(pluginId), fileId = validId(id)
  validateOptions(options)
  if (options.defaultName !== undefined && (typeof options.defaultName !== 'string' || options.defaultName.length > 255 || options.defaultName.includes('\0'))) throw new Error('Invalid private output export name')
  return storedTask(scope, async () => {
    const { pickLocalSaveFile, resolveLocalFileHandle } = await import('@main/plugin/localFiles')
    const { assertInteractive } = await import('@main/plugin/pluginInteractionPolicy')
    const check = (): void => { currentStored(scope); assertInteractive(scope) }
    check()
    const record = await findStored(scope, fileId)
    if (!record) throw new Error('Private output not found')
    const source = await openStored(scope, record)
    try {
      const selected = await pickLocalSaveFile(pluginId, { defaultName: options.defaultName ?? `${fileId}.${record.meta.extension}` }, { signal: scope.signal, assertCurrent: check })
      check()
      if (!selected) return null
      const target = await resolveLocalFileHandle(pluginId, selected.id, 'write')
      check()
      const temporary = join(dirname(target), `.enest-export-${randomUUID()}.tmp`)
      let committed = false
      try {
        const destination = await open(temporary, 'wx', 0o600)
        try {
          const buffer = Buffer.allocUnsafe(MAX_CHUNK)
          let offset = 0
          while (offset < record.info.size) {
            check()
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, record.info.size - offset), offset)
            if (!bytesRead) throw new Error('Private output changed during export')
            let written = 0
            while (written < bytesRead) {
              check()
              const result = await destination.write(buffer, written, bytesRead - written, offset + written)
              if (!result.bytesWritten) throw new Error('Private output export made no progress')
              written += result.bytesWritten
            }
            offset += bytesRead
          }
          if (!unchanged(record.info, await source.stat())) throw new Error('Private output changed during export')
          await destination.sync()
        } finally { await destination.close() }
        check()
        if (await resolveLocalFileHandle(pluginId, selected.id, 'write') !== target) throw new Error('Export destination changed')
        check()
        await rename(temporary, target)
        committed = true
        try { await syncDirectory(dirname(target)) }
        catch (error) { throw new Error('Export was committed but its durability is uncertain; check the selected file before retrying', { cause: error }) }
        try { check() }
        catch (error) { throw new Error('Export was committed but its owner is closing or no longer interactive; check the selected file before retrying', { cause: error }) }
        return { ok: true, path: target, size: record.info.size }
      } finally { if (!committed) await rm(temporary, { force: true }) }
    } finally { await source.close() }
  })
}
export async function disposeFileStreams(): Promise<void> {
  await Promise.allSettled([...outputs.values()].map(abort))
  await Promise.allSettled([...storedQueues.values()].map(queue => queue.tail))
}
export async function clearPluginFileStreams(pluginId: string): Promise<void> {
  const scope = getRuntimeScope(pluginId)
  if (scope?.isCurrent() && !scope.drainSignal.aborted) throw new Error('Close plugin runtime before deleting private outputs')
  if (deleting.has(pluginId)) throw new Error('Private output deletion already running')
  deleting.add(pluginId)
  try {
    await Promise.all([...outputs.values()].filter(output => output.scope.owner.pluginId === pluginId).map(abort))
    await storedQueues.get(pluginId)?.tail.catch(() => {})
    const dir = await directory(pluginId, false, () => {})
    if (dir) await rm(dir, { recursive: true, force: true })
  } finally { deleting.delete(pluginId) }
}
export function getFileStreamDiagnostics() {
  return { streams: outputs.size, pendingWrites: [...outputs.values()].reduce((sum, output) => sum + output.pending, 0),
    queuedBytes: [...outputs.values()].reduce((sum, output) => sum + output.queued, 0) }
}
