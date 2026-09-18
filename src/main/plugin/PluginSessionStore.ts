/**
 * PluginSessionStore — 插件会话态 KV 存储
 * 职责：为每个插件维护一份主进程内存 Map，实现 storage.session.* 语义。
 * 生命周期：随应用进程存在；插件 closePlugin 时清空对应 bag，不落盘。
 * 快照：为「后台插件休眠」铺路——saveSessionSnapshot 可把 bag 序列化进
 *      enest.db 的 plugin_session_snapshot 表，loadSessionSnapshot 读回，
 *      deleteSessionSnapshot 清除。本次仅暴露 API，调用方后续接线。
 * 被 pluginHandlers（读写分发）与 PluginHost（销毁清理）引用。
 * 关键依赖：kvStore（快照表所在库连接）。
 */
import { kvStore } from '@main/db/sqliteService'

/** 插件会话态 KV：主进程内存，随插件销毁 / 应用退出清空，不落盘 */
const sessionStores = new Map<string, Map<string, unknown>>()

/** 获取（或惰性创建）指定插件的会话态 bag */
export function sessionBag(pluginId: string): Map<string, unknown> {
  let bag = sessionStores.get(pluginId)
  if (!bag) {
    bag = new Map()
    sessionStores.set(pluginId, bag)
  }
  return bag
}

/**
 * 清空指定插件的会话态存储（PluginHost.closePlugin 时调用）。
 * 会话数据不跨「关闭 Tab」保留，与 storage.local 的持久语义区分。
 */
export function clearPluginSession(pluginId: string): void {
  sessionStores.delete(pluginId)
}

/** 确保快照表存在（幂等；库不可用时静默跳过） */
function ensureSnapshotTable(db: NonNullable<ReturnType<typeof kvStore.getDatabase>>): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS plugin_session_snapshot (' +
      'plugin_id TEXT PRIMARY KEY, json TEXT NOT NULL)'
  )
}

/** 把指定插件当前 session bag 序列化存入快照表；空 bag 也写入（表示空快照） */
export function saveSessionSnapshot(pluginId: string): void {
  const db = kvStore.getDatabase()
  if (!db) return
  try {
    ensureSnapshotTable(db)
    const bag = sessionStores.get(pluginId)
    const json = JSON.stringify(bag ? Object.fromEntries(bag) : {})
    db.prepare(
      'INSERT INTO plugin_session_snapshot (plugin_id, json) VALUES (?, ?) ' +
        'ON CONFLICT(plugin_id) DO UPDATE SET json = excluded.json'
    ).run(pluginId, json)
  } catch (err) {
    console.error('[enest] session snapshot save failed', pluginId, err)
  }
}

/** 读取该插件的会话快照；不存在 / 损坏 / 库不可用时返回 null */
export function loadSessionSnapshot(pluginId: string): Record<string, unknown> | null {
  const db = kvStore.getDatabase()
  if (!db) return null
  try {
    const row = db
      .prepare('SELECT json FROM plugin_session_snapshot WHERE plugin_id = ?')
      .get(pluginId) as { json: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.json) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    console.error('[enest] session snapshot load failed', pluginId, err)
    return null
  }
}

/** 删除该插件的会话快照（卸载时清理） */
export function deleteSessionSnapshot(pluginId: string): void {
  const db = kvStore.getDatabase()
  if (!db) return
  try {
    db.prepare('DELETE FROM plugin_session_snapshot WHERE plugin_id = ?').run(pluginId)
  } catch (err) {
    console.error('[enest] session snapshot delete failed', pluginId, err)
  }
}
