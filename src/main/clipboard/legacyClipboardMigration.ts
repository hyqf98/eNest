import { constants } from 'node:fs'
import { open, lstat, mkdir, rename, rm, readdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import type { PluginBackgroundLegacyDocument } from '@shared/types/pluginBackground'

const OWNER = 'com.github.eNest.clipboard'
export const LEGACY_CLIPBOARD_SOURCE = 'clipboard-history-v1'
const MAX_DOCUMENT = 16 * 1024 * 1024
const MAX_BLOB = 8 * 1024 * 1024
let verifiedSource: { token: string; size: number; mtimeMs: number; ino: number; dev: number } | null = null

function allowed(pluginId: string, source: string): void {
  if (pluginId !== OWNER || source !== LEGACY_CLIPBOARD_SOURCE) throw new Error('Legacy source is not owned by this plugin')
}

async function readRegular(file: string, limit: number): Promise<Buffer | null> {
  let handle
  try {
    const before = await lstat(file)
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('Legacy source must be a regular file')
    if (before.size > limit) throw new Error('Legacy source exceeds transfer limit; original retained')
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const opened = await handle.stat()
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Legacy source changed while opening')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.length > limit || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('Legacy source changed while reading')
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  } finally { await handle?.close() }
}

const documentFile = (): string => join(getAppPaths().data, 'clipboard-history.json')
const markerDir = (): string => join(getAppPaths().data, 'legacy-migrations')
const markerFile = (): string => join(markerDir(), `${LEGACY_CLIPBOARD_SOURCE}.json`)
const tokenFor = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function verifySource(token: string, fresh = false): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid legacy source identity')
  const identity = await lstat(documentFile())
  if (identity.isSymbolicLink() || !identity.isFile()) throw new Error('Legacy source must be a regular file')
  if (!fresh && verifiedSource?.token === token && identity.size === verifiedSource.size && identity.mtimeMs === verifiedSource.mtimeMs &&
      identity.ino === verifiedSource.ino && identity.dev === verifiedSource.dev) return
  const bytes = await readRegular(documentFile(), MAX_DOCUMENT)
  if (!bytes || tokenFor(bytes) !== token) throw new Error('Legacy clipboard source changed; original retained')
  verifiedSource = { token, size: identity.size, mtimeMs: identity.mtimeMs, ino: identity.ino, dev: identity.dev }
}

/** Fixed one-way migration adapter. It never parses, filters, or rewrites clipboard history records. */
export async function readLegacyClipboardDocument(pluginId: string, source: string): Promise<PluginBackgroundLegacyDocument | null> {
  allowed(pluginId, source)
  if (await readRegular(markerFile(), 4096)) return null
  const document = await readRegular(documentFile(), MAX_DOCUMENT)
  if (!document) return null
  const token = tokenFor(document)
  await verifySource(token)
  return { token, document: document.toString('utf8') }
}

/** The generic private store may grandfather only this host-verified fixed-source import budget. */
export async function getLegacyClipboardImportBudget(pluginId: string, source: string, token: string): Promise<{ bytes: number; files: number }> {
  allowed(pluginId, source)
  await verifySource(token)
  const dir = join(getAppPaths().data, 'clipboard-blobs')
  let names: string[]
  try {
    const directory = await lstat(dir)
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('Legacy attachments directory must not be a symlink')
    names = await readdir(dir)
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, files: 0 }; throw error }
  if (names.length > 50000) throw new Error('Legacy attachment inventory exceeds migration budget; original retained')
  let bytes = 0, files = 0
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]{1,200}\.png$/.test(name)) continue
    const item = await lstat(join(dir, name))
    if (item.isSymbolicLink() || !item.isFile() || item.size > MAX_BLOB) throw new Error('Invalid legacy attachment inventory; original retained')
    bytes += item.size; files++
  }
  return { bytes, files }
}

export async function getLegacyClipboardBlob(pluginId: string, source: string, token: string, name: string): Promise<{ dataUrl: string; bytes: number } | null> {
  allowed(pluginId, source)
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(name) || name === '.' || name === '..') throw new Error('Invalid legacy attachment name')
  await verifySource(token)
  const dir = join(getAppPaths().data, 'clipboard-blobs')
  try {
    const directory = await lstat(dir)
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('Legacy attachments directory must not be a symlink')
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const bytes = await readRegular(join(dir, name), MAX_BLOB)
  if (!bytes) return null
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Legacy attachment is not a PNG; original retained')
  return { dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, bytes: bytes.length }
}

export async function commitLegacyClipboardMigration(pluginId: string, source: string, token: string, assertCurrent: () => void = () => {}): Promise<void> {
  allowed(pluginId, source)
  assertCurrent()
  await verifySource(token, true)
  assertCurrent()
  await mkdir(markerDir(), { recursive: true })
  const directory = await lstat(markerDir())
  assertCurrent()
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('Legacy migration directory must not be a symlink')
  const existing = await readRegular(markerFile(), 4096)
  assertCurrent()
  const content = JSON.stringify({ version: 1, source, token })
  if (existing) {
    if (existing.toString('utf8') !== content) throw new Error('Legacy migration marker belongs to another source revision')
    return
  }
  const temporary = join(markerDir(), `.${LEGACY_CLIPBOARD_SOURCE}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    assertCurrent()
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    assertCurrent()
    await handle.close(); handle = undefined
    assertCurrent()
    await rename(temporary, markerFile())
  } finally { await handle?.close(); await rm(temporary, { force: true }) }
  // Original index, v1 backup, and blobs remain intact. The marker prevents an uninstall from resurrecting them.
}
