import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { pluginDataDir as root } from './pluginPrivatePaths'

export interface PrivateDocumentOwner {
  readonly pluginId: string
  readonly signal: AbortSignal
  current(): boolean
}

const DOCUMENT_LIMIT = 16 * 1024 * 1024
const BLOB_LIMIT = 32 * 1024 * 1024
const BASE_QUOTA = 200 * 1024 * 1024
const MAX_FILES = 20_000
const queues = new Map<string, { tail: Promise<unknown>; pending: number }>()
const inventories = new Map<string, { bytes: number; count: number }>()
const clearing = new Set<string>()
const clearTasks = new Map<string, Promise<void>>()
interface MigrationAllowances { version: 1; sources: Record<string, { token: string; bytes: number }> }

function assertOwner(owner: PrivateDocumentOwner): void {
  if (owner.signal.aborted || !owner.current() || clearing.has(owner.pluginId)) throw new Error('Private storage owner is retired')
}
function key(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('Invalid private storage key')
  return value
}
async function directory(owner: PrivateDocumentOwner, kind: 'documents' | 'blobs'): Promise<string> {
  assertOwner(owner)
  const base = root(owner.pluginId), result = join(base, kind)
  const dataRoot = await realpath(getAppPaths().data)
  for (const path of [join(base, '..'), base, result]) {
    assertOwner(owner)
    await mkdir(path, { recursive: true })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Private storage directory is not canonical')
  }
  const canonical = await realpath(result)
  assertOwner(owner)
  if (canonical !== join(root(owner.pluginId, dataRoot), kind)) throw new Error('Private storage directory is not canonical')
  return result
}
async function readBounded(path: string, maximum: number, owner: PrivateDocumentOwner): Promise<Buffer | null> {
  assertOwner(owner)
  let file: Awaited<ReturnType<typeof open>>
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Private storage file is not canonical')
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maximum) throw new Error('Private file exceeds its budget')
    const target = Buffer.allocUnsafe(Math.min(maximum + 1, before.size + 1))
    let offset = 0
    while (offset < target.length) {
      assertOwner(owner)
      const { bytesRead } = await file.read(target, offset, target.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const bytes = target.subarray(0, offset)
    const after = await file.stat()
    assertOwner(owner)
    if (bytes.length !== before.size || bytes.length > maximum || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Private file changed during read')
    return bytes
  } finally { await file.close() }
}
function mutation<T>(owner: PrivateDocumentOwner, run: () => Promise<T>): Promise<T> {
  assertOwner(owner)
  const queue = queues.get(owner.pluginId) ?? { tail: Promise.resolve(), pending: 0 }
  if (queue.pending >= 8) throw new Error('Private storage write queue is full')
  queue.pending++
  queues.set(owner.pluginId, queue)
  const task = queue.tail.catch(() => {}).then(() => { assertOwner(owner); return run() }).finally(() => {
    if (--queue.pending === 0 && queues.get(owner.pluginId) === queue) queues.delete(owner.pluginId)
  })
  queue.tail = task
  return task
}
async function replace(path: string, bytes: Buffer, owner: PrivateDocumentOwner): Promise<void> {
  assertOwner(owner)
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(bytes, { signal: owner.signal })
    await file.sync()
    assertOwner(owner)
    await file.close()
    assertOwner(owner)
    await rename(temporary, path)
    if (process.platform !== 'win32') {
      const parent = await open(join(path, '..'), constants.O_RDONLY)
      try { await parent.sync() } finally { await parent.close() }
    }
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  } finally { await rm(temporary, { force: true }) }
}

async function allowances(owner: PrivateDocumentOwner): Promise<MigrationAllowances> {
  await directory(owner, 'documents')
  const bytes = await readBounded(join(root(owner.pluginId), 'migration-allowances.json'), 16 * 1024, owner)
  if (!bytes) return { version: 1, sources: {} }
  const value = JSON.parse(bytes.toString('utf8')) as MigrationAllowances
  if (value.version !== 1 || !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)
    || Object.keys(value.sources).length > 32 || Object.entries(value.sources).some(([source, item]) =>
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source) || !item || !/^[a-f0-9]{64}$/.test(item.token)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 1024 ** 4)) throw new Error('Invalid private migration allowance')
  return value
}

/** Never expose this function as a plugin capability. Only a fixed-source host adapter supplies the verified budget. */
export function grantPrivateMigrationBudget(owner: PrivateDocumentOwner, source: string, token: string, bytes: number): Promise<void> {
  key(source)
  if (!/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1024 ** 4) throw new Error('Invalid verified migration budget')
  return mutation(owner, async () => {
    const value = await allowances(owner)
    const old = value.sources[source]
    if (old?.token === token && old.bytes >= bytes) return
    if (!old && Object.keys(value.sources).length >= 32) throw new Error('Private migration source quota exceeded')
    value.sources[source] = { token, bytes: Math.max(old?.bytes ?? 0, bytes) }
    await replace(join(root(owner.pluginId), 'migration-allowances.json'), Buffer.from(JSON.stringify(value)), owner)
  })
}
export async function readPrivateDocument(owner: PrivateDocumentOwner, name: string): Promise<unknown | null> {
  await queues.get(owner.pluginId)?.tail.catch(() => {})
  const bytes = await readBounded(join(await directory(owner, 'documents'), `${key(name)}.json`), DOCUMENT_LIMIT, owner)
  return bytes ? JSON.parse(bytes.toString('utf8')) : null
}
export function writePrivateDocument(owner: PrivateDocumentOwner, name: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > DOCUMENT_LIMIT) throw new Error('Private document exceeds 16 MiB')
  const safe = key(name)
  return mutation(owner, async () => {
    const dir = await directory(owner, 'documents'), files = await readdir(dir)
    if (files.length >= 128 && !files.includes(`${safe}.json`)) throw new Error('Private document count exceeded')
    await replace(join(dir, `${safe}.json`), Buffer.from(encoded), owner)
  })
}
export async function getPrivateBlob(owner: PrivateDocumentOwner, id: string): Promise<{ dataUrl: string; bytes: number } | null> {
  await queues.get(owner.pluginId)?.tail.catch(() => {})
  const safe = key(id), dir = await directory(owner, 'blobs')
  const meta = await readBounded(join(dir, `${safe}.json`), 1024, owner)
  if (!meta) return null
  const { mime } = JSON.parse(meta.toString('utf8')) as { mime: unknown }
  if (typeof mime !== 'string' || !/^image\/(png|jpeg|webp)$/.test(mime)) throw new Error('Invalid private blob type')
  const bytes = await readBounded(join(dir, `${safe}.blob`), BLOB_LIMIT, owner)
  if (!bytes) throw new Error('Private blob data is missing')
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length }
}
export function putPrivateBlob(owner: PrivateDocumentOwner, input: { id?: string; dataUrl: string }): Promise<{ id: string; bytes: number }> {
  if (typeof input?.dataUrl !== 'string' || input.dataUrl.length > BLOB_LIMIT * 1.4) throw new Error('Private blob exceeds 32 MiB')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(input.dataUrl)
  if (!match) throw new Error('Invalid private image blob')
  let bytes: Buffer | null = Buffer.from(match[2], 'base64')
  if (bytes.length > BLOB_LIMIT) throw new Error('Private blob exceeds 32 MiB')
  const id = key(input.id ?? randomUUID()), mime = match[1]
  return mutation(owner, async () => {
    let newPath: string | undefined
    try {
      const dir = await directory(owner, 'blobs'), path = join(dir, id)
      const existing = await readBounded(`${path}.blob`, BLOB_LIMIT, owner)
      if (existing) {
        if (!existing.equals(bytes!)) throw new Error('Stable private blob ID already has different content')
        const meta = await readBounded(`${path}.json`, 1024, owner)
        if (!meta) await replace(`${path}.json`, Buffer.from(JSON.stringify({ mime, bytes: bytes!.length })), owner)
        else if (JSON.parse(meta.toString('utf8')).mime !== mime) throw new Error('Stable private blob type differs')
        return { id, bytes: bytes!.length }
      }
      const inventoryKey = root(owner.pluginId)
      let inventory = inventories.get(inventoryKey)
      if (!inventory) {
        const names = (await readdir(dir)).filter(name => name.endsWith('.blob'))
        if (names.length > MAX_FILES) throw new Error('Private blob count exceeded')
        let total = 0
        for (const name of names) {
          const info = await lstat(join(dir, name))
          assertOwner(owner)
          if (info.isSymbolicLink() || !info.isFile()) throw new Error('Private blob inventory is not canonical')
          total += info.size
        }
        inventory = { bytes: total, count: names.length }
        inventories.set(inventoryKey, inventory)
      }
      if (inventory.count >= MAX_FILES) throw new Error('Private blob count exceeded')
      const migration = Object.values((await allowances(owner)).sources).reduce((sum, source) => sum + source.bytes, 0)
      assertOwner(owner)
      if (inventory.bytes + bytes!.length > BASE_QUOTA + migration) throw new Error('Private blob storage quota exceeded')
      newPath = path
      await replace(`${path}.blob`, bytes!, owner)
      await replace(`${path}.json`, Buffer.from(JSON.stringify({ mime, bytes: bytes!.length })), owner)
      inventory.bytes += bytes!.length
      inventory.count++
      return { id, bytes: bytes!.length }
    } catch (error) {
      inventories.delete(root(owner.pluginId))
      if (newPath) await Promise.allSettled([rm(`${newPath}.blob`, { force: true }), rm(`${newPath}.json`, { force: true })])
      throw error
    }
    finally { bytes = null }
  })
}
export function removePrivateBlob(owner: PrivateDocumentOwner, id: string): Promise<boolean> {
  const safe = key(id)
  return mutation(owner, async () => {
    const dir = await directory(owner, 'blobs')
    assertOwner(owner)
    await rm(join(dir, `${safe}.json`), { force: true })
    assertOwner(owner)
    await rm(join(dir, `${safe}.blob`), { force: true })
    inventories.delete(root(owner.pluginId))
    return true
  })
}
export function clearPrivateDocuments(pluginId: string): Promise<void> {
  const existing = clearTasks.get(pluginId)
  if (existing) return existing
  clearing.add(pluginId)
  const task = (async () => {
    await queues.get(pluginId)?.tail.catch(() => {})
    await rm(root(pluginId), { recursive: true, force: true })
    inventories.delete(root(pluginId))
  })().finally(() => { clearing.delete(pluginId); clearTasks.delete(pluginId) })
  clearTasks.set(pluginId, task)
  return task
}
