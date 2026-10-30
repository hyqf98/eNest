import type { PluginLaunchIndexEntry, PluginLaunchIndexState } from '@shared/types/pluginLaunch'
import { kvStore, runInDurableTransaction } from '@main/db/sqliteService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logWarn } from '@main/logs/logService'

interface IndexRecord extends PluginLaunchIndexState { buildRevision: string; entries: PluginLaunchIndexEntry[] }
const PREFIX = '__enest.launch-index.v1.'
const MAX_ENTRIES = 12_000
const MAX_TOTAL_ENTRIES = 30_000
const MAX_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const records = new Map<string, IndexRecord>()
const listeners = new Set<() => void>()
const dirtyListeners = new Set<() => void>()
let revision = 0, initialized = false
let registryRevision = -1
const keyFor = (pluginId: string) => PREFIX + Buffer.from(pluginId).toString('base64url')

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || required && !value.trim()) throw new Error('Invalid launch index text')
  return value.trim()
}

function privatePayload(value: unknown): unknown {
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 256 || depth > 8) throw new Error('Launch payload structure limit')
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype && !Array.isArray(item)) throw new Error('Launch payload must be plain JSON')
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid launch payload key')
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > 4096) throw new Error('Launch payload exceeds 4 KiB')
  return JSON.parse(json)
}

function normalize(pluginId: string, value: unknown): PluginLaunchIndexEntry[] {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error('Launch index entry limit exceeded')
  const codes = new Set(pluginRegistry.getManifest(pluginId)?.features?.map(feature => feature.code))
  const ids = new Set<string>()
  const entries = value.map((item: PluginLaunchIndexEntry) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid launch index entry')
    const id = text(item.id, 160, true), code = text(item.code, 256, true)
    if (ids.has(id) || !codes.has(code)) throw new Error('Duplicate entry or undeclared feature')
    ids.add(id)
    if (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.length > 32)) throw new Error('Invalid launch aliases')
    const title = text(item.title, 256, true)
    return { id, code, title, aliases: [...new Set((item.aliases ?? []).map(alias => text(alias, 256, true)))],
      ...(item.subtitle !== undefined ? { subtitle: text(item.subtitle, 512) } : {}),
      ...(item.payload !== undefined ? { payload: privatePayload(item.payload) } : {}) }
  })
  if (Buffer.byteLength(JSON.stringify(entries)) > MAX_BYTES) throw new Error('Launch index exceeds 4 MiB')
  return entries
}

function changed(): void {
  revision++
  for (const listener of listeners) { try { listener() } catch (error) { logWarn('launch-index', String(error)) } }
  sendShellEvent({ type: 'launch-directory-changed', revision: String(revision) })
}
function notifyDirty(): void { for (const listener of dirtyListeners) { try { listener() } catch (error) { logWarn('launch-index', String(error)) } } }
function write(pluginId: string, record: IndexRecord): void {
  const db = kvStore.getDatabase()
  if (!db) throw new Error('Launch index storage is unavailable')
  runInDurableTransaction(db, () => kvStore.kvSet(keyFor(pluginId), JSON.stringify(record)))
  records.set(pluginId, record)
  changed()
}

/** Called at startup/registry changes, never once per keystroke. */
export function initializeLaunchIndex(): void {
  if (!initialized) {
    initialized = true
    pluginRegistry.onInstalledChanged(initializeLaunchIndex)
  }
  const next = pluginRegistry.getInstalledRevision()
  if (registryRevision === next) return
  registryRevision = next
  const installed = pluginRegistry.getInstalledDescriptors()
  const ids = new Set(installed.filter(item => item.manifest.activation?.indexSync).map(item => item.id))
  for (const id of records.keys()) if (!ids.has(id)) {
    records.delete(id)
    try { kvStore.kvDelete(keyFor(id)) } catch (error) { logWarn('launch-index', String(error)) }
  }
  let totalEntries = 0, totalBytes = 0
  for (const record of records.values()) { totalEntries += record.entries.length; totalBytes += Buffer.byteLength(JSON.stringify(record.entries)) }
  for (const item of installed) {
    if (!item.manifest.activation?.indexSync) continue
    const current = records.get(item.id)
    if (current) continue
    let record: IndexRecord | undefined
    try {
      const raw = kvStore.kvGet(keyFor(item.id))
      if (raw && Buffer.byteLength(raw) <= MAX_BYTES + 4096) {
        const stored = JSON.parse(raw) as IndexRecord
        if (Number.isSafeInteger(stored.revision) && stored.revision >= 0 && typeof stored.buildRevision === 'string' && typeof stored.dirty === 'boolean') {
          const entries = normalize(item.id, stored.entries), bytes = Buffer.byteLength(JSON.stringify(entries))
          if (totalEntries + entries.length <= MAX_TOTAL_ENTRIES && totalBytes + bytes <= MAX_TOTAL_BYTES) {
            record = { revision: stored.revision, dirty: stored.dirty, buildRevision: stored.buildRevision, entries }
            totalEntries += entries.length; totalBytes += bytes
          }
        }
      }
    } catch (error) { logWarn('launch-index', `load ${item.id}: ${String(error)}`) }
    records.set(item.id, record ?? { revision: 0, dirty: true, buildRevision: '', entries: [] })
  }
  changed()
  notifyDirty()
}

function owner(pluginId: string): void {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing || !pluginRegistry.isEnabled(pluginId)) throw new Error('Launch index owner is retired')
  if (!pluginRegistry.getManifest(pluginId)?.activation?.indexSync) throw new Error('Launch index is undeclared')
}
export function getLaunchIndexState(pluginId: string): PluginLaunchIndexState {
  const record = records.get(pluginId)
  return { revision: record?.revision ?? 0, dirty: !record || record.dirty || record.buildRevision !== pluginRegistry.getBuildRevision(pluginId) }
}
export function replaceLaunchIndex(pluginId: string, value: unknown, expectedRevision?: number): { revision: number } {
  owner(pluginId)
  const state = getLaunchIndexState(pluginId)
  if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new Error('Launch index revision changed during synchronization')
  const entries = normalize(pluginId, value)
  let total = entries.length, totalBytes = Buffer.byteLength(JSON.stringify(entries))
  for (const [source, record] of records) if (source !== pluginId) { total += record.entries.length; totalBytes += Buffer.byteLength(JSON.stringify(record.entries)) }
  if (total > MAX_TOTAL_ENTRIES) throw new Error('Launch index total entry budget exceeded')
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Launch index total byte budget exceeded')
  const previous = records.get(pluginId), buildRevision = pluginRegistry.getBuildRevision(pluginId)
  if (previous?.buildRevision === buildRevision && !previous.dirty && JSON.stringify(previous.entries) === JSON.stringify(entries)) return { revision: previous.revision }
  const next = { revision: state.revision + 1, dirty: false, buildRevision, entries }
  write(pluginId, next)
  return { revision: next.revision }
}
export function markLaunchIndexDirty(pluginId: string): void {
  owner(pluginId)
  const previous = records.get(pluginId) ?? { revision: 0, buildRevision: '', dirty: true, entries: [] }
  write(pluginId, { ...previous, revision: previous.revision + 1, dirty: true })
  notifyDirty()
}
export function getLaunchIndexRevision(): number { return revision }
export function onLaunchIndexChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function onLaunchIndexDirty(listener: () => void): () => void { dirtyListeners.add(listener); return () => { dirtyListeners.delete(listener) } }
export function launchIndexEntries(): Array<{ pluginId: string; buildRevision: string; indexRevision: number; entry: PluginLaunchIndexEntry }> {
  const result: ReturnType<typeof launchIndexEntries> = []
  for (const item of pluginRegistry.getInstalledDescriptors()) {
    const record = records.get(item.id)
    if (!item.enabled || !item.manifest.activation?.indexSync || !record || record.dirty || record.buildRevision !== item.buildRevision) continue
    for (const entry of record.entries) result.push({ pluginId: item.id, buildRevision: item.buildRevision, indexRevision: record.revision, entry })
  }
  return result
}
export function resolveLaunchIndexEntry(pluginId: string, entryId: string, buildRevision?: string, indexRevision?: number): PluginLaunchIndexEntry | null {
  const record = records.get(pluginId)
  if (!pluginRegistry.isEnabled(pluginId) || !pluginRegistry.getManifest(pluginId)?.activation?.indexSync || !record || record.dirty || record.buildRevision !== pluginRegistry.getBuildRevision(pluginId)
    || buildRevision !== record.buildRevision || indexRevision !== record.revision) return null
  return record.entries.find(entry => entry.id === entryId) ?? null
}
