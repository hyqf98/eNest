/** JSON business checkpoints; never renderer heaps, sockets or transactions. */
import { kvStore } from '@main/db/sqliteService'

const PLUGIN_LIMIT = 8 * 1024 * 1024
const GLOBAL_LIMIT = 64 * 1024 * 1024
interface Bag { values: Map<string, string>; bytes: number; revision: number }
interface SnapshotIdentity { buildRevision: string; tabSessionId: string }
interface Snapshot extends SnapshotIdentity { formatVersion: 1; stateRevision: number; payload: Record<string, unknown> }
const stores = new Map<string, Bag>()
// Charges include hibernated checkpoints, even after releasing their resident values.
const charges = new Map<string, number>()
let totalBytes = 0

/** Reject values JSON would silently drop or alter (cycles, undefined, NaN, classes). */
export function serializeJson(value: unknown): string {
  const seen = new Set<object>()
  const visit = (v: unknown): void => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (typeof v !== 'object' || !v) throw new Error('storage requires finite JSON data')
    if (seen.has(v)) throw new Error('storage JSON contains a cycle')
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('storage requires plain JSON objects')
    seen.add(v)
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) visit(v[i]) }
    else {
      if (Object.getOwnPropertySymbols(v).length) throw new Error('storage requires string keys')
      for (const item of Object.values(v)) visit(item)
    }
    seen.delete(v)
  }
  visit(value)
  return JSON.stringify(value)
}
function bagOf(id: string): Bag {
  let bag = stores.get(id)
  if (!bag) { bag = { values: new Map(), bytes: 2, revision: 0 }; stores.set(id, bag); charge(id, 2) }
  return bag
}
function charge(id: string, bytes: number): void {
  totalBytes += bytes - (charges.get(id) ?? 0)
  charges.set(id, bytes)
}
function checkBudget(id: string, bytes: number): void {
  const old = charges.get(id) ?? 0
  const nextTotal = totalBytes - old + bytes
  if ((bytes > PLUGIN_LIMIT && bytes > old) || (nextTotal > GLOBAL_LIMIT && nextTotal > totalBytes)) throw new Error('session payload quota exceeded (8 MiB/plugin, 64 MiB/global)')
}
function itemBytes(key: string, json: string): number { return Buffer.byteLength(JSON.stringify(key)) + 1 + Buffer.byteLength(json) }
export function getSessionValue(id: string, key: string): unknown {
  const json = bagOf(id).values.get(key)
  return json === undefined ? undefined : JSON.parse(json)
}
export function setSessionValue(id: string, key: string, value: unknown): void {
  const json = serializeJson(value)
  const bag = bagOf(id)
  const old = bag.values.get(key)
  const bytes = bag.bytes + (old === undefined ? itemBytes(key, json) + (bag.values.size ? 1 : 0) : Buffer.byteLength(json) - Buffer.byteLength(old))
  checkBudget(id, bytes)
  bag.values.set(key, json); bag.bytes = bytes; bag.revision++
  charge(id, bytes)
}
export function removeSessionValue(id: string, key: string): void {
  const bag = bagOf(id), old = bag.values.get(key)
  if (old === undefined) return
  bag.bytes -= itemBytes(key, old) + (bag.values.size > 1 ? 1 : 0)
  bag.values.delete(key); bag.revision++; charge(id, bag.bytes)
}
/** Release runtime memory but keep the logical session's checkpoint budget. */
export function releaseSessionMemory(id: string): void { stores.delete(id) }
export function clearPluginSession(id: string): void {
  totalBytes -= charges.get(id) ?? 0
  charges.delete(id); stores.delete(id)
}
export function getSessionRevision(id: string): number { return stores.get(id)?.revision ?? 0 }
export function getSessionDiagnostics() { return { bytes: totalBytes, residentBytes: [...stores.values()].reduce((sum, bag) => sum + bag.bytes, 0), plugins: stores.size, pluginLimit: PLUGIN_LIMIT, globalLimit: GLOBAL_LIMIT } }

export function saveSessionSnapshot(id: string, identity: SnapshotIdentity): boolean {
  const db = kvStore.getDatabase()
  if (!db) return false
  const bag = stores.get(id)
  const revision = getSessionRevision(id)
  const snapshot: Snapshot = { buildRevision: identity.buildRevision, tabSessionId: identity.tabSessionId, formatVersion: 1, stateRevision: revision, payload: Object.fromEntries([...(bag?.values ?? [])].map(([key, json]) => [key, JSON.parse(json)])) }
  try {
    db.exec('CREATE TABLE IF NOT EXISTS plugin_session_snapshot (plugin_id TEXT PRIMARY KEY, json TEXT NOT NULL)')
    db.prepare('INSERT INTO plugin_session_snapshot (plugin_id, json) VALUES (?, ?) ON CONFLICT(plugin_id) DO UPDATE SET json = excluded.json').run(id, serializeJson(snapshot))
    return getSessionRevision(id) === revision
  } catch (error) {
    console.error('[enest] checkpoint save failed; runtime retained', id, error)
    return false
  }
}
export function loadSessionSnapshot(id: string, identity: SnapshotIdentity): boolean {
  const db = kvStore.getDatabase()
  if (!db) return false
  try {
    const row = db.prepare('SELECT json FROM plugin_session_snapshot WHERE plugin_id = ?').get(id) as { json: string } | undefined
    if (!row) return false
    const snapshot = JSON.parse(row.json) as Snapshot
    if (snapshot.formatVersion !== 1 || snapshot.buildRevision !== identity.buildRevision || snapshot.tabSessionId !== identity.tabSessionId) return false
    if (!snapshot.payload || Array.isArray(snapshot.payload) || typeof snapshot.payload !== 'object' || !Number.isSafeInteger(snapshot.stateRevision) || snapshot.stateRevision < 0) return false
    serializeJson(snapshot.payload)
    const values = new Map(Object.entries(snapshot.payload).map(([key, value]) => [key, serializeJson(value)]))
    const bytes = Buffer.byteLength(JSON.stringify(snapshot.payload))
    stores.set(id, { values, bytes, revision: snapshot.stateRevision })
    charge(id, bytes)
    return true
  } catch (error) { console.error('[enest] checkpoint restore failed', id, error); return false }
}
export function deleteSessionSnapshot(id: string): void {
  const db = kvStore.getDatabase()
  if (!db) return
  try {
    db.exec('CREATE TABLE IF NOT EXISTS plugin_session_snapshot (plugin_id TEXT PRIMARY KEY, json TEXT NOT NULL)')
    db.prepare('DELETE FROM plugin_session_snapshot WHERE plugin_id = ?').run(id)
  } catch (error) { console.error('[enest] checkpoint delete failed', id, error) }
}
