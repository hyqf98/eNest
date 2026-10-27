import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { constants, lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import type { PluginAsset, PluginAssetGetResult, PluginAssetMime, PluginAssetPutInput, PluginAssetPutResult, PluginBlob } from '@shared/types/storage'
import { syncDirectory } from './pluginStorageIO'

const MAX_BYTES = 32 * 1024 * 1024
const OWNER_BYTES = 1024 * 1024 * 1024
const MAX_ASSETS = 10_000
const META_BYTES = 4096
const MIME_EXT: Record<PluginAssetMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const EXT_MIME: Record<string, PluginAssetMime> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const UUID = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}'
const LEGACY_ID = new RegExp(`^${UUID}$`)
const DATA_FILE = new RegExp(`^\\.asset-${UUID}\\.blob$`)
const TEMP_FILE = new RegExp(`^\\.meta-${UUID}\\.tmp$`)
const queues = new Map<string, { tail: Promise<unknown>; pending: number; writes: number }>()
const clearing = new Map<string, Promise<void>>()
interface StoredAsset { meta: PluginAsset; file: string; metadata: string; legacy: boolean }
interface AssetRecord extends PluginAsset { file?: string }

function current(scope: PluginRuntimeScope): void {
  if (!scope.isCurrent() || scope.signal.aborted || clearing.has(scope.owner.pluginId)) throw new Error('Private image storage owner is retired')
}
function owner(pluginId: string): PluginRuntimeScope {
  const scope = getRuntimeScope(pluginId)
  if (!scope || scope.isClosing) throw new Error('Private image storage owner is retired')
  current(scope)
  return scope
}
function owned<T>(scope: PluginRuntimeScope, write: boolean, run: () => Promise<T>): Promise<T> {
  current(scope)
  const pluginId = scope.owner.pluginId
  const queue = queues.get(pluginId) ?? { tail: Promise.resolve(), pending: 0, writes: 0 }
  if (queue.pending >= 16 || write && queue.writes >= 2) throw new Error('Private image storage queue is full')
  const release = scope.acquireActivity(write ? 'saving private image' : 'reading private image')
  queue.pending++
  if (write) queue.writes++
  queues.set(pluginId, queue)
  const task = queue.tail.catch(() => {}).then(() => { current(scope); return run() }).finally(() => {
    release()
    if (write) queue.writes--
    if (--queue.pending === 0 && queues.get(pluginId) === queue) queues.delete(pluginId)
  })
  queue.tail = task
  return task
}
function validId(value: unknown): string {
  if (typeof value !== 'string' || value.includes('..') || value.length > 133
    || !LEGACY_ID.test(value) && !/^[a-z0-9][a-z0-9._-]{0,127}\.(png|jpg|webp|gif)$/.test(value)) throw new Error('Invalid private image ID')
  return value
}
function putId(value: unknown, mime: PluginAssetMime): string {
  if (value === undefined) return `${randomUUID().replaceAll('-', '')}.${MIME_EXT[mime]}`
  if (typeof value !== 'string' || value.includes('..') || !/^[a-z0-9][a-z0-9._-]{0,132}$/.test(value)) throw new Error('Invalid private image ID')
  if (LEGACY_ID.test(value)) return value
  const ext = /\.(png|jpg|webp|gif)$/.exec(value)?.[1]
  if (ext && EXT_MIME[ext] !== mime) throw new Error('Private image ID and MIME type differ')
  return validId(ext ? value : `${value}.${MIME_EXT[mime]}`)
}
function mime(value: unknown): PluginAssetMime {
  if (typeof value !== 'string' || !Object.hasOwn(MIME_EXT, value)) throw new Error('Only PNG, JPEG, WebP and GIF images are supported')
  return value as PluginAssetMime
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }

// Both old directories remain readable. A single owner queue and quota cover both formats.
async function directory(pluginId: string, legacy: boolean, create = false, scope?: PluginRuntimeScope): Promise<string | null> {
  scope && current(scope)
  const data = await realpath(getAppPaths().data)
  const base = join(data, legacy ? 'plugin-attachments' : 'plugin-assets')
  const hash = createHash('sha256').update(pluginId).digest('hex')
  const paths = legacy ? [base, join(base, hash)] : [base, join(base, hash), join(base, hash, 'files')]
  for (const path of paths) {
    scope && current(scope)
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    let info: Stats
    try { info = await lstat(path) } catch (error) { if (missing(error)) return null; throw error }
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path) throw new Error('Private image directory is not canonical')
  }
  scope && current(scope)
  return paths[paths.length - 1]
}
async function fileInfo(file: string, scope: PluginRuntimeScope): Promise<Stats | null> {
  current(scope)
  try {
    const info = await lstat(file)
    current(scope)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Private image file is not canonical')
    return info
  } catch (error) { if (missing(error)) return null; throw error }
}
async function readBounded(file: string, maximum: number, scope: PluginRuntimeScope): Promise<Buffer | null> {
  if (!await fileInfo(file, scope)) return null
  let handle: FileHandle
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) { if (missing(error)) return null; throw error }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('Private image file exceeds its read budget')
    const buffer = Buffer.allocUnsafe(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      current(scope)
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    current(scope)
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Private image changed during read')
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}
function parseMeta(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid private image metadata')
  return value as Record<string, unknown>
}
async function assetRecord(dir: string, id: string, scope: PluginRuntimeScope): Promise<StoredAsset | null> {
  const metadata = join(dir, `${id}.meta.json`)
  const raw = await readBounded(metadata, META_BYTES, scope)
  const record = raw ? parseMeta(raw) as unknown as AssetRecord : undefined
  if (record && (record.assetId !== id || typeof record.name !== 'string' || record.name.length > 128
    || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_BYTES
    || !Number.isFinite(record.createdAt) || record.createdAt < 0 || record.file !== undefined && (typeof record.file !== 'string' || !DATA_FILE.test(record.file)))) throw new Error('Invalid private image metadata')
  const file = join(dir, record?.file ?? id)
  const info = await fileInfo(file, scope)
  if (!info) return null
  const type = mime(record?.mime ?? EXT_MIME[id.split('.').pop() ?? ''])
  if (info.size > MAX_BYTES || record?.file && info.size !== record.bytes) throw new Error('Private image metadata does not match its content')
  return { meta: { assetId: id, name: record?.name ?? id, mime: type, bytes: info.size, createdAt: record?.createdAt ?? info.mtimeMs }, file, metadata, legacy: false }
}
async function attachmentRecord(dir: string, id: string, scope: PluginRuntimeScope): Promise<StoredAsset | null> {
  const file = join(dir, `${id}.blob`), metadata = join(dir, `${id}.json`)
  const raw = await readBounded(metadata, META_BYTES, scope)
  const info = await fileInfo(file, scope)
  if (!raw || !info) return null
  const record = parseMeta(raw)
  if (info.size > MAX_BYTES) throw new Error('Private image file exceeds its read budget')
  return { meta: { assetId: id, name: id, mime: mime(record.mime), bytes: info.size, createdAt: info.mtimeMs }, file, metadata, legacy: true }
}
async function findAsset(scope: PluginRuntimeScope, id: string): Promise<StoredAsset | null> {
  const dir = await directory(scope.owner.pluginId, false, false, scope)
  const asset = dir ? await assetRecord(dir, id, scope) : null
  if (asset || !LEGACY_ID.test(id)) return asset
  const legacy = await directory(scope.owner.pluginId, true, false, scope)
  return legacy ? attachmentRecord(legacy, id, scope) : null
}
async function inventory(scope: PluginRuntimeScope, cleanOrphans: boolean): Promise<{ items: StoredAsset[]; bytes: number }> {
  const items = new Map<string, StoredAsset>()
  let bytes = 0
  for (const legacy of [false, true]) {
    const dir = await directory(scope.owner.pluginId, legacy, false, scope)
    if (!dir) continue
    const names = await readdir(dir)
    current(scope)
    if (names.length > MAX_ASSETS * 4) throw new Error('Private image directory contains too many files')
    const ids = new Set<string>()
    for (const name of names) {
      if (legacy) { if (name.endsWith('.blob') && LEGACY_ID.test(name.slice(0, -5))) ids.add(name.slice(0, -5)); continue }
      const id = name.endsWith('.meta.json') ? name.slice(0, -10) : name
      try { ids.add(validId(id)) } catch { /* Internal generations and unrelated files are not public IDs. */ }
    }
    const liveFiles = new Set<string>()
    let metadataHealthy = true
    for (const id of ids) {
      try {
        const record = legacy ? await attachmentRecord(dir, id, scope) : await assetRecord(dir, id, scope)
        if (!record) throw new Error('Private image record is incomplete')
        liveFiles.add(record.file)
        if (!items.has(id)) items.set(id, record)
      } catch {
        current(scope)
        metadataHealthy = false
        // Keep a deletable row instead of letting one damaged sidecar lock the entire library.
        if (!items.has(id)) items.set(id, {
          meta: { assetId: id, name: id, mime: 'application/octet-stream', bytes: 0, createdAt: 0 },
          file: join(dir, legacy ? `${id}.blob` : id), metadata: join(dir, legacy ? `${id}.json` : `${id}.meta.json`), legacy
        })
      }
    }
    for (const name of names) {
      current(scope)
      const path = join(dir, name)
      if (!legacy && cleanOrphans && (TEMP_FILE.test(name) || metadataHealthy && DATA_FILE.test(name) && !liveFiles.has(path))) {
        await rm(path, { force: true })
        continue
      }
      const info = await fileInfo(path, scope)
      if (info && !name.endsWith('.json')) bytes += info.size
    }
  }
  return { items: [...items.values()], bytes }
}
async function commitRecord(dir: string, record: AssetRecord, scope: PluginRuntimeScope, committed: () => void): Promise<void> {
  const temporary = join(dir, `.meta-${randomUUID()}.tmp`)
  try {
    current(scope)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(record), { signal: scope.signal }); await handle.sync() }
    finally { await handle.close() }
    current(scope)
    await rename(temporary, join(dir, `${record.assetId}.meta.json`))
    committed()
    try { await syncDirectory(dir) }
    catch (error) { throw new Error('Private image was committed but its durability is uncertain; read the asset before retrying', { cause: error }) }
  } finally { await rm(temporary, { force: true }) }
}

export function putPluginAsset(pluginId: string, input: PluginAssetPutInput): Promise<PluginAssetPutResult> {
  const scope = owner(pluginId)
  if (!input || typeof input !== 'object') throw new Error('Invalid private image input')
  const isDataUrl = typeof input.dataUrl === 'string'
  if (isDataUrl ? input.bytes !== undefined || input.mime !== undefined : !(input.bytes instanceof ArrayBuffer) || input.dataUrl !== undefined) throw new Error('Provide either bytes and MIME or a data URL')
  let type: PluginAssetMime
  let held: string | ArrayBuffer | null
  if (isDataUrl) {
    if (input.dataUrl!.length > Math.ceil(MAX_BYTES / 3) * 4 + 64) throw new Error('Private image exceeds 32 MiB')
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(input.dataUrl!)
    if (!match) throw new Error('Invalid private image data URL')
    type = mime(match[1]); held = match[2]
  } else {
    if (!input.bytes!.byteLength || input.bytes!.byteLength > MAX_BYTES) throw new Error('Private image exceeds 32 MiB')
    type = mime(input.mime); held = input.bytes!
  }
  const id = putId(input.assetId, type)
  const label = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 128) : undefined
  const abort = (): void => { held = null }
  scope.signal.addEventListener('abort', abort, { once: true })
  let task: Promise<PluginAssetPutResult>
  try {
    task = owned(scope, true, async () => {
      const data = typeof held === 'string' ? Buffer.from(held, 'base64') : Buffer.from(held!)
      if (typeof held === 'string' && data.toString('base64') !== held || !data.length || data.length > MAX_BYTES) throw new Error('Invalid private image bytes')
      held = null
      const dir = (await directory(pluginId, false, true, scope))!
      const existing = await findAsset(scope, id)
      const usage = await inventory(scope, true)
      if (!existing && usage.items.length >= MAX_ASSETS) throw new Error('Private image count exceeds 10000')
      const delta = data.length - (existing?.meta.bytes ?? 0)
      if (delta > 0 && usage.bytes + delta > OWNER_BYTES) throw new Error('Private images exceed the shared 1 GiB quota')
      const filename = `.asset-${randomUUID()}.blob`, file = join(dir, filename)
      let committed = false
      try {
        current(scope)
        const handle = await open(file, 'wx', 0o600)
        try { await handle.writeFile(data, { signal: scope.signal }); await handle.sync() }
        finally { await handle.close() }
        await syncDirectory(dir)
        const meta: PluginAsset = { assetId: id, name: label ?? existing?.meta.name ?? id, mime: type, bytes: data.length, createdAt: existing?.meta.createdAt ?? Date.now() }
        await commitRecord(dir, { ...meta, file: filename }, scope, () => { committed = true })
        // The pointer is the commit point. A pre-commit failure preserves the previous image.
        if (existing && existing.file !== file) {
          await rm(existing.file, { force: true }).catch(() => {})
          if (existing.legacy) await rm(existing.metadata, { force: true }).catch(() => {})
        }
        current(scope)
        return { ...meta, path: file }
      } finally { if (!committed) await rm(file, { force: true }) }
    })
  } catch (error) { held = null; scope.signal.removeEventListener('abort', abort); throw error }
  return task.finally(() => { held = null; scope.signal.removeEventListener('abort', abort) })
}
export function listPluginAssets(pluginId: string): Promise<PluginAsset[]> {
  const scope = owner(pluginId)
  return owned(scope, false, async () => (await inventory(scope, false)).items.map(item => item.meta).sort((a, b) => b.createdAt - a.createdAt || a.assetId.localeCompare(b.assetId)))
}
export function getPluginAsset(pluginId: string, assetId: string): Promise<PluginAssetGetResult | null> {
  const scope = owner(pluginId), id = validId(assetId)
  return owned(scope, false, async () => {
    const record = await findAsset(scope, id)
    if (!record) return null
    const data = await readBounded(record.file, MAX_BYTES, scope)
    if (!data) return null
    return { dataUrl: `data:${record.meta.mime};base64,${data.toString('base64')}`, mime: record.meta.mime, bytes: data.length }
  })
}
export function removePluginAsset(pluginId: string, assetId: string): Promise<boolean> {
  const scope = owner(pluginId), id = validId(assetId)
  return owned(scope, true, async () => {
    // Remove both representations if a prior compatibility overwrite left an old copy.
    for (const legacy of [false, true]) {
      if (legacy && !LEGACY_ID.test(id)) continue
      const dir = await directory(pluginId, legacy, false, scope)
      if (!dir) continue
      const metadata = join(dir, legacy ? `${id}.json` : `${id}.meta.json`)
      let generation: string | undefined
      if (!legacy) {
        try {
          const raw = await readBounded(metadata, META_BYTES, scope)
          const file = raw && parseMeta(raw).file
          if (typeof file === 'string' && DATA_FILE.test(file)) generation = file
        } catch { current(scope) }
      }
      for (const file of [join(dir, legacy ? `${id}.blob` : id), metadata, ...(generation ? [join(dir, generation)] : [])]) {
        current(scope)
        const info = await lstat(file).catch(error => { if (missing(error)) return null; throw error })
        if (info?.isDirectory()) throw new Error('Private image entry is not a file')
        current(scope)
        // unlink also removes a corrupt symlink itself; it never follows the link target.
        await rm(file, { force: true })
      }
      await syncDirectory(dir)
    }
    // Cleanup is best-effort; a large or damaged neighbouring entry cannot block deletion by ID.
    await inventory(scope, true).catch(() => {})
    current(scope)
    return true
  })
}
/** @deprecated Compatibility alias for storage.assets.remove. */
export const deletePluginAsset = removePluginAsset

export function putPluginBlob(pluginId: string, input: { dataUrl: string; name?: string }): Promise<PluginBlob> {
  return putPluginAsset(pluginId, { dataUrl: input?.dataUrl, name: input?.name }).then(value => ({ id: value.assetId, bytes: value.bytes }))
}
export function getPluginBlob(pluginId: string, id: string): Promise<{ dataUrl: string; bytes: number } | null> {
  return getPluginAsset(pluginId, id).then(value => value && ({ dataUrl: value.dataUrl, bytes: value.bytes }))
}
export const removePluginBlob = removePluginAsset

export function clearPluginAssets(pluginId: string): Promise<void> {
  const pending = clearing.get(pluginId)
  if (pending) return pending
  const scope = getRuntimeScope(pluginId)
  if (scope?.isCurrent() && !scope.signal.aborted) throw new Error('Close the plugin runtime before clearing private images')
  const task = (async () => {
    await queues.get(pluginId)?.tail.catch(() => {})
    for (const legacy of [false, true]) {
      const dir = await directory(pluginId, legacy)
      if (dir) await rm(legacy ? dir : join(dir, '..'), { recursive: true, force: true })
    }
  })().finally(() => { clearing.delete(pluginId) })
  clearing.set(pluginId, task)
  return task
}
