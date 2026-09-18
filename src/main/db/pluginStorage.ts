/**
 * pluginStorage — 插件 storage.local 持久化（SQLite 版）
 * 职责：把原先散落的 ~/eNest/data/plugin-storage/{id}.json 整文件 JSON 迁入
 *      共享 enest.db 的 plugin_storage 表，提供同步 KV API。
 * 设计：
 *  - 读路径全内存：pluginId → key → value 的二级 Map 缓存，零 SQL；
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
import { pluginStorageDir } from '@main/paths/pathsService'

/** 旧 JSON 迁移后的完整后缀（保留现场，卸载时一并清理） */
const MIGRATED_SUFFIX = '.json.migrated'

/** 写合并窗口：脏键先入缓存，定时器批量落库 */
const FLUSH_DELAY_MS = 50

/** pluginId → key → value（JSON 反序列化后的原值） */
const cache = new Map<string, Map<string, unknown>>()

/** 脏键集合：`${pluginId}\u0000${key}` → 'set' | 'remove'（整包 clear 立即执行，不走队列） */
const dirty = new Map<string, 'set' | 'remove'>()

let flushTimer: NodeJS.Timeout | null = null
let initialized = false

/** prepare 语句复用：随库连接创建一次（kvStore 生命周期内只有一份） */
interface StorageStatements {
  upsert: StatementSync
  remove: StatementSync
  clear: StatementSync
  selectAll: StatementSync
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
    selectAll: db.prepare('SELECT key, value FROM plugin_storage WHERE plugin_id = ?')
  }
  cachedStatements = { db, stmts }
  return stmts
}

/** 拆 `${pluginId}\u0000${key}` 复合键（pluginId/key 理论不含 \u0000） */
function splitComposite(k: string): [string, string] {
  const i = k.indexOf('\u0000')
  return [k.slice(0, i), k.slice(i + 1)]
}

function markDirty(pluginId: string, key: string, op: 'set' | 'remove'): void {
  dirty.set(`${pluginId}\u0000${key}`, op)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushDirty(false)
  }, FLUSH_DELAY_MS)
}

/** 把当前脏键合并为一次事务写入 */
function flushDirty(force: boolean): void {
  const db = kvStore.getDatabase()
  if (!db) {
    // backend='none' 兜底：无库时只留内存态（与旧 JSON 读写失败降级一致）
    if (!force) return
    dirty.clear()
    return
  }
  if (dirty.size === 0) return
  const { upsert, remove } = statementsFor(db)
  const entries = [...dirty.entries()]
  dirty.clear()
  try {
    runInTransaction(db, () => {
      for (const [composite, op] of entries) {
        const [pluginId, key] = splitComposite(composite)
        const value = cache.get(pluginId)?.get(key)
        if (op === 'remove' || value === undefined) {
          remove.run(pluginId, key)
        } else {
          upsert.run(pluginId, key, JSON.stringify(value))
        }
      }
    })
  } catch (err) {
    console.error('[enest] plugin_storage flush failed', err)
  }
}

/** 读取（或惰性加载）某插件的整包缓存；库不可用时退化为空 bag 仅内存态 */
function bagOf(pluginId: string, loadFromDb = true): Map<string, unknown> {
  let bag = cache.get(pluginId)
  if (bag) return bag
  bag = new Map()
  cache.set(pluginId, bag)
  const db = kvStore.getDatabase()
  if (loadFromDb && db) {
    try {
      const rows = statementsFor(db).selectAll.all(pluginId) as Array<{
        key: string
        value: string
      }>
      for (const row of rows) {
        try {
          bag.set(row.key, JSON.parse(row.value))
        } catch {
          // 损坏值跳过，等价于不存在
        }
      }
    } catch (err) {
      console.error('[enest] plugin_storage load failed', pluginId, err)
    }
  }
  return bag
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

/** 旧 ~/eNest/data/plugin-storage/{id}.json 导入库并改名 {id}.json.migrated */
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

/** 读单个键（缓存命中路径零 SQL）；未初始化时降级为内存态 */
export function getPluginStorageValue(pluginId: string, key: string): unknown {
  return bagOf(pluginId).get(key)
}

/** 写单个键：先改缓存，50ms 合并落库 */
export function setPluginStorageValue(pluginId: string, key: string, value: unknown): void {
  bagOf(pluginId).set(key, value)
  markDirty(pluginId, key, 'set')
}

/** 删单个键：先改缓存，50ms 合并落库 */
export function removePluginStorageValue(pluginId: string, key: string): void {
  bagOf(pluginId).delete(key)
  markDirty(pluginId, key, 'remove')
}

/** 清空某插件全部 storage（storage.clear 与卸载共用）：清缓存 + 立即清库 */
export function clearPluginStorage(pluginId: string): void {
  cache.delete(pluginId)
  for (const composite of [...dirty.keys()]) {
    if (splitComposite(composite)[0] === pluginId) dirty.delete(composite)
  }
  const db = kvStore.getDatabase()
  if (db) {
    try {
      statementsFor(db).clear.run(pluginId)
    } catch (err) {
      console.error('[enest] plugin_storage clear failed', pluginId, err)
    }
  }
}

/** 立即落盘全部脏键（应用退出前在 will-quit 调用；主线程负责接线） */
export function flushAll(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushDirty(true)
}
