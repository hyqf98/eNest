import { kvStore, runInDurableTransaction } from '@main/db/sqliteService'
import { readPortableStorage, restorePortableStorage, validatePortableStorage, type PortableStorage } from '@main/db/pluginStorage'
import { logWarn } from '@main/logs/logService'
import { SYNC_SNAPSHOT_LIMIT } from '@shared/types/githubSync'
import { isPackageId } from './packageIdentity'
import { pluginHost } from './PluginHost'
import { pluginRegistry } from './PluginRegistry'
import { applyPortableFiles, readPortableFiles, validatePortableFiles, type PortableFile } from './portablePluginFiles'
import { resetPrivateDocumentInventory } from './pluginPrivateDocuments'

export interface PluginSnapshot { format: 'enest.plugin-data/v1'; pluginId: string; storage: PortableStorage; files: PortableFile[] }

export function encodeSnapshot(snapshot: PluginSnapshot): Buffer {
  const bytes = Buffer.from(JSON.stringify(snapshot))
  if (bytes.length > SYNC_SNAPSHOT_LIMIT) throw new Error('插件快照超过 16 MiB，未传输部分数据')
  return bytes
}
export function decodeSnapshot(bytes: Buffer, pluginId: string): PluginSnapshot {
  if (bytes.length > SYNC_SNAPSHOT_LIMIT) throw new Error('云端快照过大')
  const parsed = JSON.parse(bytes.toString('utf8'))
  if (parsed?.format !== 'enest.plugin-data/v1' || parsed.pluginId !== pluginId) throw new Error('快照的格式或插件归属不匹配')
  const snapshot: PluginSnapshot = { format: parsed.format, pluginId, storage: validatePortableStorage(parsed.storage), files: validatePortableFiles(parsed.files) }
  if (!encodeSnapshot(snapshot).equals(bytes)) throw new Error('快照包含不支持的字段或格式')
  return snapshot
}
export async function readSnapshot(pluginId: string, check: () => void): Promise<PluginSnapshot> {
  check()
  const storage = readPortableStorage(pluginId, SYNC_SNAPSHOT_LIMIT)
  const files = await readPortableFiles(pluginId, check, SYNC_SNAPSHOT_LIMIT - Buffer.byteLength(JSON.stringify(storage)))
  check()
  return { format: 'enest.plugin-data/v1', pluginId, storage, files }
}

function journal() {
  const db = kvStore.getDatabase()
  if (!db) throw new Error('本机数据库不可用')
  db.exec('CREATE TABLE IF NOT EXISTS plugin_sync_recovery (plugin_id TEXT PRIMARY KEY, before_files TEXT NOT NULL, after_files TEXT NOT NULL)')
  return db
}
const quarantined = new Map<string, () => void>()
function quarantine(id: string) {
  if (!quarantined.has(id)) quarantined.set(id, pluginHost.blockPlugin(id, 'plugin data recovery'))
}
async function rollback(pluginId: string, previous: PortableFile[], next: PortableFile[]) {
  const db = journal()
  await applyPortableFiles(pluginId, next, previous, () => {})
  runInDurableTransaction(db, () => db.prepare('DELETE FROM plugin_sync_recovery WHERE plugin_id=?').run(pluginId))
  resetPrivateDocumentInventory(pluginId)
}
export async function recoverPluginSync(): Promise<void> {
  const db = journal()
  for (const { plugin_id } of db.prepare('SELECT plugin_id FROM plugin_sync_recovery').all()) {
    if (!isPackageId(plugin_id)) continue
    quarantine(plugin_id)
    try {
      if (!pluginRegistry.getInstalledDescriptors().some(item => item.id === plugin_id)) continue
      const row = db.prepare('SELECT before_files,after_files FROM plugin_sync_recovery WHERE plugin_id=?').get(plugin_id)!
      await rollback(plugin_id, validatePortableFiles(JSON.parse(String(row.before_files))), validatePortableFiles(JSON.parse(String(row.after_files))))
      quarantined.get(plugin_id)?.(); quarantined.delete(plugin_id)
    } catch { logWarn('github-sync', `Pending local recovery for ${plugin_id}; plugin remains blocked`) }
  }
}
export async function restoreSnapshot(previous: PluginSnapshot, next: PluginSnapshot, check: () => void): Promise<void> {
  const id = previous.pluginId, db = journal()
  if (id !== next.pluginId || quarantined.has(id) || db.prepare('SELECT 1 FROM plugin_sync_recovery WHERE plugin_id=?').get(id)) throw new Error('插件归属不符或有尚未完成的本机恢复')
  check()
  const beforeFiles = JSON.stringify(previous.files), afterFiles = JSON.stringify(next.files)
  if (beforeFiles === afterFiles) { restorePortableStorage(id, next.storage, () => {}); return }
  runInDurableTransaction(db, () => db.prepare('INSERT INTO plugin_sync_recovery VALUES (?,?,?)').run(id, beforeFiles, afterFiles))
  try {
    await applyPortableFiles(id, previous.files, next.files, check)
    check()
    restorePortableStorage(id, next.storage, () => db.prepare('DELETE FROM plugin_sync_recovery WHERE plugin_id=?').run(id))
    resetPrivateDocumentInventory(id)
  } catch (error) {
    try { await rollback(id, previous.files, next.files) }
    catch { quarantine(id); throw new Error('本机恢复中断，已保留恢复记录并暂停插件；请重新启动 eNest。') }
    throw error
  }
}
