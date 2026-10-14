/**
 * pluginStorage — 插件 storage.local 持久化（SQLite 版）
 * 职责：把原先散落的 ~/.eNest/data/plugin-storage/{id}.json 整文件 JSON 迁入
 *      共享 enest.db 的 plugin_storage 表，提供同步 KV API。
 * 设计：
 *  - 单键惰性读取；可重读的 clean JSON 缓存按32MiB全局/4MiB插件淘汰；
 *  - 写合并：set/remove 先改缓存，50ms 定时器把脏键合并为一次批量事务落库
 *    （prepare 语句复用），避免高频 set 逐条触发磁盘写；
 *  - 一次性迁移：init 时发现旧 {id}.json 存在则导入并把文件改名为
 *    {id}.json.migrated（保留现场，主线程后续可统一清理）。
 * 被 pluginHandlers（storage.*）、PluginUninstaller（卸载清理）引用。
 * 关键依赖：kvStore（同库连接复用）、pathsService（旧 JSON 位置）。
 */
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { kvStore, runInTransaction } from '@main/db/sqliteService'
import { serializeJson } from '@main/plugin/PluginSessionStore'
import { pluginStorageDir } from '@main/paths/pathsService'

/** 旧 JSON 迁移后的完整后缀（保留现场，卸载时一并清理） */
const MIGRATED_SUFFIX = '.json.migrated'

/** 写合并窗口：脏键先入缓存，定时器批量落库 */
const FLUSH_DELAY_MS = 50

/** 每插件 key 数上限 */
const MAX_KEYS_PER_PLUGIN = 1000
/** 单值序列化后的 UTF-8 字节上限（512 KiB）。 */
const MAX_VALUE_BYTES = 512 * 1024
const MAX_KEY_BYTES = 1024
const PLUGIN_DIRTY_BYTES = 8 * 1024 * 1024
const GLOBAL_DIRTY_BYTES = 64 * 1024 * 1024

interface CachedValue { pluginId: string; key: string; json: string; bytes: number }
const cache = new Map<string, CachedValue>()
const dirty = new Map<string, CachedValue | null>()
const dirtyPluginBytes = new Map<string, number>()
let dirtyBytes = 0
const pluginBytes = new Map<string, number>()
let cacheBytes = 0
let hits = 0, misses = 0, evictions = 0
let lastFlushError: string | null = null
const GLOBAL_CACHE_BYTES = 32 * 1024 * 1024
const PLUGIN_CACHE_BYTES = 4 * 1024 * 1024
function composite(id: string, key: string): string {
  if (id.includes('\0') || key.includes('\0')) throw new Error('invalid storage key')
  return `${id}\0${key}`
}
function evict(key: string): void {
  const item = cache.get(key)
  if (!item) return
  cache.delete(key); cacheBytes -= item.bytes
  const bytes = (pluginBytes.get(item.pluginId) ?? 0) - item.bytes
  if (bytes) pluginBytes.set(item.pluginId, bytes)
  else pluginBytes.delete(item.pluginId)
}
function remember(item: CachedValue): void {
  const key = composite(item.pluginId, item.key)
  evict(key); cache.set(key, item); cacheBytes += item.bytes
  pluginBytes.set(item.pluginId, (pluginBytes.get(item.pluginId) ?? 0) + item.bytes)
  for (const [candidate, value] of cache) {
    if (cacheBytes <= GLOBAL_CACHE_BYTES && (pluginBytes.get(item.pluginId) ?? 0) <= PLUGIN_CACHE_BYTES) break
    if (cacheBytes > GLOBAL_CACHE_BYTES || value.pluginId === item.pluginId) { evict(candidate); evictions++ }
  }
}
export function getStorageDiagnostics() { return { cacheBytes, dirtyKeys: dirty.size, dirtyBytes, pluginDirtyLimit: PLUGIN_DIRTY_BYTES, globalDirtyLimit: GLOBAL_DIRTY_BYTES, maxKeyBytes: MAX_KEY_BYTES, hits, misses, evictions, plugins: pluginBytes.size, lastFlushError } }

/** Count keys and tombstones too: failed disks must not permit unbounded retained IPC data. */
function dirtySize(key: string, item: CachedValue | null): number {
  return Buffer.byteLength(key) + (item ? Buffer.byteLength(item.json) : 0) + 32
}
function deleteDirty(key: string): void {
  if (!dirty.has(key)) return
  const bytes = dirtySize(key, dirty.get(key)!)
  const [id] = splitComposite(key)
  dirtyBytes -= bytes
  const remaining = (dirtyPluginBytes.get(id) ?? 0) - bytes
  if (remaining) dirtyPluginBytes.set(id, remaining)
  else dirtyPluginBytes.delete(id)
  dirty.delete(key)
}
function retainDirty(key: string, item: CachedValue | null): void {
  const [id] = splitComposite(key)
  const previous = dirty.has(key) ? dirtySize(key, dirty.get(key)!) : 0
  const bytes = dirtySize(key, item)
  const delta = bytes - previous
  if (delta > 0 && (dirtyBytes + delta > GLOBAL_DIRTY_BYTES || (dirtyPluginBytes.get(id) ?? 0) + delta > PLUGIN_DIRTY_BYTES)) {
    throw new Error('pending storage quota exceeded (8 MiB/plugin, 64 MiB/global); flush or retry after persistence recovers')
  }
  dirty.set(key, item)
  dirtyBytes += delta
  dirtyPluginBytes.set(id, (dirtyPluginBytes.get(id) ?? 0) + delta)
}
function validateWriteKey(key: string): void {
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new Error('storage key quota exceeded (1024 UTF-8 bytes)')
}

let flushTimer: NodeJS.Timeout | null = null
let initialized = false

/** prepare 语句复用：随库连接创建一次（kvStore 生命周期内只有一份） */
interface StorageStatements {
  upsert: StatementSync
  remove: StatementSync
  clear: StatementSync
  selectOne: StatementSync
  selectKeys: StatementSync
}
let cachedStatements: { db: DatabaseSync; stmts: StorageStatements } | null = null

function statementsFor(db: DatabaseSync): StorageStatements {
  if (cachedStatements && cachedStatements.db === db) return cachedStatements.stmts
  const stmts: StorageStatements = {
    upsert: db.prepare(
      'INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?, ?, ?) ' +
        'ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value'
    ),
    remove: db.prepare('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?'),
    clear: db.prepare('DELETE FROM plugin_storage WHERE plugin_id = ?'),
    selectOne: db.prepare('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?'),
    selectKeys: db.prepare('SELECT key FROM plugin_storage WHERE plugin_id = ?')
  }
  cachedStatements = { db, stmts }
  return stmts
}

/** 拆 `${pluginId}\u0000${key}` 复合键（pluginId/key 理论不含 \u0000） */
function splitComposite(k: string): [string, string] {
  const i = k.indexOf('\u0000')
  return [k.slice(0, i), k.slice(i + 1)]
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; flushDirty() }, FLUSH_DELAY_MS)
}

/** Pending writes stay owned until the whole transaction commits. */
function flushDirty(): boolean {
  if (!dirty.size) return true
  const db = kvStore.getDatabase()
  if (!db) { lastFlushError = 'storage backend unavailable'; console.error('[enest] storage backend unavailable; pending writes retained'); return false }
  const entries = [...dirty]
  try {
    const { upsert, remove } = statementsFor(db)
    runInTransaction(db, () => {
      for (const [key, value] of entries) {
        const [id, storageKey] = splitComposite(key)
        if (value) upsert.run(id, storageKey, value.json)
        else remove.run(id, storageKey)
      }
    })
    for (const [key, value] of entries) {
      if (dirty.get(key) !== value) continue
      deleteDirty(key)
      if (value) remember(value)
    }
    lastFlushError = null
    return true
  } catch (error) { lastFlushError = String(error); console.error('[enest] storage flush failed; pending writes retained', error); return false }
}

/**
 * 初始化：建表 + 一次性迁移旧 JSON。
 * 由 pluginHandlers 注册前调用一次（重复调用安全，只做一次迁移扫描）。
 */
export function initPluginStorage(): void {
  if (initialized) return
  initialized = true
  const db = kvStore.getDatabase()
  if (!db) return
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS plugin_storage (' +
        'plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ' +
        'PRIMARY KEY (plugin_id, key))'
    )
    migrateLegacyJson(db)
  } catch (err) {
    console.error('[enest] plugin_storage init failed', err)
  }
}

/** 旧 ~/.eNest/data/plugin-storage/{id}.json 导入库并改名 {id}.json.migrated */
function migrateLegacyJson(db: DatabaseSync): void {
  const dir = pluginStorageDir()
  if (!existsSync(dir)) return
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const pluginId = file.slice(0, -'.json'.length)
    if (!pluginId) continue
    const src = join(dir, file)
    try {
      const raw = JSON.parse(readFileSafe(src))
      if (raw && typeof raw === 'object') {
        const { upsert } = statementsFor(db)
        const entries = Object.entries(raw as Record<string, unknown>).map(
          ([key, value]): [string, string] => [key, JSON.stringify(value)]
        )
        if (entries.length > 0) {
          runInTransaction(db, () => {
            for (const [key, value] of entries) upsert.run(pluginId, key, value)
          })
        }
      }
      // 导入后改名保留现场（即使 bag 为空也改名，避免重复扫描）
      renameSync(src, join(dir, pluginId + MIGRATED_SUFFIX))
    } catch (err) {
      console.error('[enest] plugin_storage migrate failed', pluginId, err)
    }
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/** Read just the requested key; clean cache values are safe to evict. */
export function getPluginStorageValue(pluginId: string, key: string): unknown {
  const id = composite(pluginId, key)
  if (dirty.has(id)) { const item = dirty.get(id); return item ? JSON.parse(item.json) : undefined }
  const cached = cache.get(id)
  if (cached) { hits++; cache.delete(id); cache.set(id, cached); return JSON.parse(cached.json) }
  misses++
  const db = kvStore.getDatabase()
  if (!db) return undefined
  const row = statementsFor(db).selectOne.get(pluginId, key) as { value: string } | undefined
  if (!row) return undefined
  const value = JSON.parse(row.value)
  remember({ pluginId, key, json: row.value, bytes: Buffer.byteLength(row.value) + Buffer.byteLength(key) })
  return value
}
export function setPluginStorageValue(pluginId: string, key: string, value: unknown): void {
  const id = composite(pluginId, key)
  validateWriteKey(key)
  const json = serializeJson(value)
  const bytes = Buffer.byteLength(json)
  if (bytes > MAX_VALUE_BYTES) throw new Error('storage quota exceeded')
  const db = kvStore.getDatabase()
  const keys = new Set(db ? (statementsFor(db).selectKeys.all(pluginId) as {key: string}[]).map((row) => row.key) : [])
  for (const [compositeKey, pending] of dirty) {
    const [pid, itemKey] = splitComposite(compositeKey)
    if (pid === pluginId) { if (pending) keys.add(itemKey); else keys.delete(itemKey) }
  }
  if (!keys.has(key) && keys.size >= MAX_KEYS_PER_PLUGIN) throw new Error('storage quota exceeded')
  retainDirty(id, { pluginId, key, json, bytes: bytes + Buffer.byteLength(key) })
  evict(id)
  scheduleFlush()
}
export function removePluginStorageValue(pluginId: string, key: string): void {
  const id = composite(pluginId, key)
  validateWriteKey(key)
  retainDirty(id, null)
  evict(id)
  scheduleFlush()
}
export function clearPluginStorage(pluginId: string): void {
  const db = kvStore.getDatabase()
  if (!db) throw new Error('storage backend unavailable')
  // Failed deletes leave both dirty data and cached values intact.
  statementsFor(db).clear.run(pluginId)
  for (const [key, item] of cache) if (item.pluginId === pluginId) evict(key)
  for (const key of dirty.keys()) if (splitComposite(key)[0] === pluginId) deleteDirty(key)
}
export function flushAll(): boolean {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  return flushDirty()
}
export function releasePluginStorage(pluginId: string): boolean {
  const saved = flushAll()
  for (const [key, item] of cache) if (item.pluginId === pluginId) evict(key)
  return saved
}
