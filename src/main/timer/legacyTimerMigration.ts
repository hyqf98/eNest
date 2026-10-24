import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'
import { kvStore, runInTransaction } from '@main/db/sqliteService'

const SOURCE = 'focus-timers-v1'
const KEY = `_enest_migration.${SOURCE}`
const CHUNK_CHARS = 32 * 1024
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

async function readLegacyPayload(): Promise<string | null> {
  const path = join(getAppPaths().data, `${SOURCE}.json`)
  let initial: Awaited<ReturnType<typeof lstat>>
  try { initial = await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (initial.isSymbolicLink() || !initial.isFile()) throw new Error('Legacy timer payload must be a regular file; original retained')
  if (initial.size > MAX_PAYLOAD_BYTES) throw new Error('Legacy timer payload exceeds migration limit; original retained')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > MAX_PAYLOAD_BYTES || before.dev !== initial.dev || before.ino !== initial.ino
      || before.size !== initial.size || before.mtimeMs !== initial.mtimeMs || before.ctimeMs !== initial.ctimeMs) throw new Error('Legacy timer payload changed while opening; original retained')
    const bytes = Buffer.allocUnsafe(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat(), current = await lstat(path)
    if (offset !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || !current.isFile()
      || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
      || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new Error('Legacy timer payload changed while reading; original retained')
    return bytes.subarray(0, offset).toString('utf8')
  } finally { await file.close() }
}

/** One-way ownership migration only: the plugin, not the shell, interprets this opaque payload. */
export async function migrateLegacyTimerPayloads(): Promise<void> {
  const db = kvStore.getDatabase()
  if (!db) throw new Error('Deadline storage unavailable')
  if (kvStore.kvGet(`migration:${SOURCE}`)) return
  const content = await readLegacyPayload()
  if (content === null) return
  const raw = JSON.parse(content)
  if (raw?.version !== 1 || !raw.timers || typeof raw.timers !== 'object' || Array.isArray(raw.timers)) {
    throw new Error('Invalid legacy timer container; original retained')
  }
  db.exec('CREATE TABLE IF NOT EXISTS plugin_storage (plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (plugin_id, key))')
  const put = db.prepare('INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin_id, key) DO NOTHING')
  runInTransaction(db, () => {
    for (const [pluginId, payload] of Object.entries(raw.timers)) {
      if (!pluginId || pluginId.length > 200 || pluginId.includes('\0')) throw new Error('Invalid legacy payload owner')
      const json = JSON.stringify(payload)
      if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('Legacy owner payload exceeds migration limit; original retained')
      const chunks = Math.ceil(json.length / CHUNK_CHARS)
      for (let i = 0; i < chunks; i++) put.run(pluginId, `${KEY}.${i}`, JSON.stringify(json.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)))
      put.run(pluginId, KEY, JSON.stringify({ version: 1, chunks }))
    }
    kvStore.kvSet(`migration:${SOURCE}`, JSON.stringify({ at: Date.now() }))
  })
  // Retain the original file as a user-data backup. The transaction marker prevents reimport after uninstall.
}
