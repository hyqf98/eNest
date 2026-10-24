import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import type { FileStreamOpen, FileStreamResult } from '@shared/types/file-stream'

const MAX_FILE = 1024 * 1024 * 1024
const MAX_OWNER_BYTES = 4 * MAX_FILE
const MAX_CHUNK = 512 * 1024
const MAX_QUEUE = 8 * 1024 * 1024
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
const directory = (id: string): string => join(getAppPaths().data, 'plugin-files', createHash('sha256').update(id).digest('hex'))
function owner(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (deleting.has(pluginId) || !scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('File stream owner is closing')
  return scope
}
function current(output: Output): void {
  if (!output.scope.isCurrent() || output.scope.drainSignal.aborted || output.phase === 'closed') throw new Error('File stream owner is closing')
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
    await rm(output.part, { force: true })
  }).catch(() => {}).finally(() => { outputs.delete(output.id); output.release() })
  return output.cleanup
}
export async function openFileStream(pluginId: string, input: FileStreamOpen): Promise<{ streamId: string }> {
  const scope = owner(pluginId)
  if (!input || typeof input.extension !== 'string' || !/^[a-z0-9]{1,12}$/.test(input.extension)) throw new Error('Invalid private file extension')
  if (outputs.size >= 16 || [...outputs.values()].filter(value => value.scope.owner.pluginId === pluginId).length >= 2) throw new Error('File stream limit reached')
  const id = randomUUID(), dir = directory(pluginId)
  const output: Output = { id, scope, part: join(dir, `${id}.part`), path: join(dir, `${id}.${input.extension}`), phase: 'opening', sequence: 0, bytes: 0, queued: 0, pending: 0, tail: Promise.resolve(), release: () => {} }
  outputs.set(id, output)
  const releaseActivity = scope.acquireActivity('private file stream')
  const onAbort = (): void => { void abort(output) }
  const detach = scope.addDisposer(() => abort(output))
  scope.drainSignal.addEventListener('abort', onAbort, { once: true })
  let released = false
  output.release = () => { if (!released) { released = true; detach(); scope.drainSignal.removeEventListener('abort', onAbort); releaseActivity() } }
  output.tail = (async () => {
    await mkdir(dir, { recursive: true }); current(output); owner(pluginId)
    const files = await readdir(dir)
    if (files.length > 4096) throw new Error('Private output file count limit reached')
    let used = 0
    for (const name of files) {
      const path = join(dir, name)
      const activePartial = [...outputs.values()].some(value => value.part === path)
      // Only our UUID temp files are reclaimable after a crash; completed outputs are never rewritten.
      if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.part$/.test(name) && !activePartial) await rm(path, { force: true })
      else if (!activePartial) used += await stat(path).then(value => value.isFile() ? value.size : 0).catch(() => 0)
      current(output); owner(pluginId)
    }
    const reserved = [...outputs.values()].filter(value => value.scope.owner.pluginId === pluginId).length * MAX_FILE
    if (used + reserved > MAX_OWNER_BYTES) throw new Error('Private output storage limit reached')
    owner(pluginId)
    output.file = await open(output.part, 'wx')
    current(output); owner(pluginId)
    output.phase = 'writing'
  })()
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
  const work = output.tail.then(async () => {
      current(output)
      await output.file!.sync(); current(output)
      await output.file!.close(); output.file = undefined; current(output)
      await rename(output.part, output.path)
      try { current(output) } catch (error) { await rm(output.path, { force: true }); throw error }
      output.phase = 'closed'
      outputs.delete(output.id); output.release()
      return { id: output.id, path: output.path, size: output.bytes }
  })
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
export async function disposeFileStreams(): Promise<void> { await Promise.allSettled([...outputs.values()].map(abort)) }
export async function clearPluginFileStreams(pluginId: string): Promise<void> {
  const scope = getRuntimeScope(pluginId)
  if (scope?.isCurrent() && !scope.drainSignal.aborted) throw new Error('Close plugin runtime before deleting private outputs')
  if (deleting.has(pluginId)) throw new Error('Private output deletion already running')
  deleting.add(pluginId)
  try {
    await Promise.all([...outputs.values()].filter(output => output.scope.owner.pluginId === pluginId).map(abort))
    await rm(directory(pluginId), { recursive: true, force: true })
  } finally { deleting.delete(pluginId) }
}
export function getFileStreamDiagnostics() {
  return { streams: outputs.size, pendingWrites: [...outputs.values()].reduce((sum, output) => sum + output.pending, 0),
    queuedBytes: [...outputs.values()].reduce((sum, output) => sum + output.queued, 0) }
}
