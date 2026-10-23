import { app, webContents } from 'electron'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { pluginHost } from '@main/plugin/PluginHost'
import { homeSurfaceManager } from '@main/home/HomeSurfaceManager'
import { getPluginOwnedProcesses } from '@main/plugin/pluginOwnedProcesses'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { sampleProcessMemory } from '@main/plugin/pluginProcessMemory'
import { getMainWindow } from '@main/window/createShellWindow'
import { showNotification } from '@main/window/notificationOverlay'
import { logWarn } from '@main/logs/logService'
import { normalizePluginMemoryMonitor, type PluginMemoryEntry, type PluginMemoryProcess, type PluginMemorySnapshot, type PluginProcessKind } from '@shared/types/pluginMemory'

const INTERVAL_MS = 5000
const ALERT_COOLDOWN_MS = 5 * 60_000
const MiB = 1024 * 1024
interface Ownership { pluginId: string; kind: PluginProcessKind; identity: string }
interface History { signature: string; peak: number; firstHighAt: number; lastAlert: number; level: PluginMemoryEntry['alert'] }
const history = new Map<string, History>()
const trackedDescendants = new Map<number, { startedAt: number; owners: Ownership[] }>()
const noticeOwner = {}
let timer: ReturnType<typeof setTimeout> | undefined
let flight: Promise<void> | undefined
let active = false
let epoch = 0
let lastErrorAt = 0
let snapshot: PluginMemorySnapshot = emptySnapshot()

function preferences() { return settingsStore.getPluginMemoryMonitorSettings() }
function emptySnapshot(): PluginMemorySnapshot {
  return { sampledAt: null, intervalMs: INTERVAL_MS, settings: normalizePluginMemoryMonitor(), totalMemoryBytes: null,
    hostMemoryBytes: null, sharedMemoryBytes: null, unavailableProcessCount: 0, plugins: [], processes: [] }
}
function sumKnown(processes: PluginMemoryProcess[]): number | null {
  return processes.some(item => item.memoryBytes === null) ? null : processes.reduce((sum, item) => sum + item.memoryBytes!, 0)
}

function rootsForSample(): Map<number, Ownership[]> {
  const roots = new Map<number, Ownership[]>()
  const add = (pid: number, owner: Ownership) => {
    if (!Number.isInteger(pid) || pid <= 0) return
    const owners = roots.get(pid) ?? []
    if (!owners.some(item => item.pluginId === owner.pluginId && item.kind === owner.kind)) owners.push(owner)
    roots.set(pid, owners)
  }
  for (const owner of [...pluginHost.getMemoryOwners(), ...homeSurfaceManager.getMemoryOwners()]) {
    const wc = webContents.fromId(owner.wcId)
    if (!wc || wc.isDestroyed()) continue
    try {
      add(wc.getOSProcessId(), { pluginId: owner.pluginId, kind: 'renderer', identity: `wc:${owner.wcId}` })
      for (const frame of wc.mainFrame.framesInSubtree) add(frame.osProcessId, { pluginId: owner.pluginId, kind: 'renderer', identity: `wc:${owner.wcId}` })
      const tools = wc.devToolsWebContents
      if (tools && !tools.isDestroyed()) add(tools.getOSProcessId(), { pluginId: owner.pluginId, kind: 'renderer', identity: `wc:${owner.wcId}` })
    } catch { /* Navigation may detach a frame during this sample. */ }
  }
  for (const child of getPluginOwnedProcesses()) add(child.pid, { pluginId: child.pluginId, kind: child.kind, identity: `${child.kind}:${child.generation ?? 'dev'}:${child.pid}` })
  return roots
}

function alert(entry: PluginMemoryEntry, record: History, now: number): void {
  if (entry.alert !== 'warning' && entry.alert !== 'critical') return
  if (entry.status === 'closing' || (entry.alert !== 'critical' && now - record.firstHighAt < INTERVAL_MS * 2)) return
  if (record.lastAlert && now - record.lastAlert < ALERT_COOLDOWN_MS && !(entry.alert === 'critical' && record.level !== 'critical')) return
  const bytes = (entry.memoryBytes ?? 0) + (entry.sharedMemoryBytes ?? 0)
  const en = settingsStore.getLocale() === 'en-US'
  const amount = bytes >= 1024 * MiB ? `${(bytes / (1024 * MiB)).toFixed(1)} GiB` : `${Math.round(bytes / MiB)} MiB`
  const shared = entry.sharedMemoryBytes ? (en ? ' (includes a shared process; attribution is not exclusive)' : '（含共享进程，不能全部归属于该插件）') : ''
  const action = entry.canClose ? (en ? 'close the plugin to release its resources.' : '关闭插件释放资源。')
    : (en ? 'switch themes to release its workspace.' : '切换主题释放首页资源。')
  const body = en ? `${entry.name} is using ${amount}${shared}. Open Settings > General to inspect it, or ${action}`
    : `${entry.name} 当前占用 ${amount}${shared}。可到“设置 → 通用”查看详情，或${action}`
  logWarn('plugin-memory', `${entry.pluginId}: ${amount}, ${entry.alert}, pids=${entry.processes.map(item => item.pid).join(',')}`)
  try {
    showNotification(getMainWindow(), { title: en ? 'High plugin memory usage' : '插件内存占用异常', body,
      level: entry.alert === 'critical' ? 'error' : 'warn', duration: 12000 }, { owner: noticeOwner, source: 'eNest' })
    record.lastAlert = now
    record.level = entry.alert
  } catch { /* A later sample retries when the shell notification surface is available. */ }
}

async function collect(sampleEpoch: number): Promise<void> {
  let settings = preferences()
  if (!settings.enabled) { history.clear(); trackedDescendants.clear(); snapshot = { ...emptySnapshot(), settings }; return }
  const roots = rootsForSample()
  const runtimeGenerations = new Map([...roots.values()].flat().map(owner => [owner.pluginId, getRuntimeScope(owner.pluginId)?.owner.generation]))
  const metrics = app.getAppMetrics()
  const samples = await sampleProcessMemory([...new Set([...roots.keys(), ...trackedDescendants.keys(), ...metrics.map(item => item.pid)])])
  if (!active || sampleEpoch !== epoch) return
  settings = preferences()
  if (!settings.enabled) { history.clear(); trackedDescendants.clear(); snapshot = { ...emptySnapshot(), settings }; return }
  const currentRoots = rootsForSample()
  // Do not reattribute a late sample to a plugin instance that closed while the OS was sampling.
  for (const [pid, owners] of roots) roots.set(pid, owners.filter(owner => currentRoots.get(pid)?.some(current => current.pluginId === owner.pluginId && current.identity === owner.identity)))
  const byPid = new Map(samples.map(item => [item.pid, item]))
  const metricByPid = new Map(metrics.map(item => [item.pid, item]))
  const stalePids = new Set<number>()
  for (const row of samples) {
    if (row.startedAt || row.memoryBytes !== null) continue
    try { process.kill(row.pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') stalePids.add(row.pid) }
  }
  for (const [pid, tracked] of trackedDescendants) {
    const current = byPid.get(pid)
    if (!current?.startedAt || current.startedAt !== tracked.startedAt) {
      trackedDescendants.delete(pid)
      continue
    }
    if (!roots.get(pid)?.length) roots.set(pid, tracked.owners)
  }
  const ownershipFor = (pid: number): Ownership[] => {
    let current = pid
    const visited = new Set<number>()
    while (current > 0 && !visited.has(current)) {
      visited.add(current)
      const owners = roots.get(current)
      if (owners?.length) return owners
      if (current === process.pid) return []
      const child = byPid.get(current)
      const parent = child && byPid.get(child.parentPid)
      if (child?.startedAt && parent?.startedAt && child.startedAt < parent.startedAt) return []
      current = child?.parentPid ?? 0
    }
    return []
  }
  const hostSharedPids = new Set<number>()
  const pluginContents = new Set([...pluginHost.getMemoryOwners(), ...homeSurfaceManager.getMemoryOwners()].map(owner => owner.wcId))
  for (const wc of webContents.getAllWebContents()) {
    if (pluginContents.has(wc.id) || wc.isDestroyed()) continue
    try { for (const frame of wc.mainFrame.framesInSubtree) hostSharedPids.add(frame.osProcessId) } catch { /* detached frame */ }
  }
  const processes: PluginMemoryProcess[] = []
  for (const pid of new Set([...metricByPid.keys(), ...byPid.keys(), ...roots.keys()])) {
    if (stalePids.has(pid)) continue
    const owners = ownershipFor(pid)
    const metric = metricByPid.get(pid)
    if (!owners.length && !metric) continue
    const sample = byPid.get(pid)
    if (owners.length && sample?.startedAt && !currentRoots.has(pid)) trackedDescendants.set(pid, { startedAt: sample.startedAt, owners })
    const fallback = metric?.memory.workingSetSize
    const sameMetricProcess = !sample?.startedAt || !metric?.creationTime || Math.abs(sample.startedAt - metric.creationTime) < 1100
    const residentFallback = sameMetricProcess && Number.isFinite(fallback) && fallback! >= 0 ? fallback! * 1024 : null
    const memoryBytes = sample?.memoryBytes ?? residentFallback
    const residentBytes = sample?.residentBytes ?? residentFallback
    const pluginIds = [...new Set(owners.map(item => item.pluginId))].sort()
    processes.push({ pid, kind: owners[0]?.kind ?? 'host', pluginIds, shared: pluginIds.length > 1 || (pluginIds.length > 0 && hostSharedPids.has(pid)),
      memoryBytes, residentBytes, metric: sample?.memoryBytes != null ? sample.metric : memoryBytes !== null ? 'resident' : 'unavailable' })
  }
  const now = Date.now()
  const runtimeOwners = [...pluginHost.getMemoryOwners(), ...homeSurfaceManager.getMemoryOwners()]
  const ids = new Set([...runtimeOwners.map(owner => owner.pluginId), ...processes.flatMap(item => item.pluginIds)])
  const plugins: PluginMemoryEntry[] = [...ids].map(pluginId => {
    const owned = processes.filter(item => item.pluginIds.includes(pluginId))
    const exclusive = owned.filter(item => !item.shared), shared = owned.filter(item => item.shared)
    const memoryBytes = sumKnown(exclusive), sharedMemoryBytes = sumKnown(shared)
    const status = pluginHost.isClosing(pluginId) ? 'closing' as const
      : owned.length || runtimeOwners.some(owner => owner.pluginId === pluginId) ? 'running' as const : 'idle' as const
    const generation = runtimeGenerations.get(pluginId)
    const signature = generation === undefined
      ? owned.map(item => `${item.pid}:${byPid.get(item.pid)?.startedAt ?? metricByPid.get(item.pid)?.creationTime ?? 0}`).sort().join('|')
      : `runtime:${generation}`
    const old = history.get(pluginId)
    const record: History = old?.signature === signature ? old : {
      signature, peak: old?.peak ?? 0, firstHighAt: old?.firstHighAt ?? 0, lastAlert: old?.lastAlert ?? 0, level: old?.level ?? 'normal'
    }
    const measured = owned.reduce((total, item) => total + (item.memoryBytes ?? 0), 0)
    const threshold = settings.warningThresholdMiB * MiB
    const alertLevel = measured >= Math.max(threshold * 2, 1024 * MiB) ? 'critical' as const
      : measured >= threshold ? 'warning' as const : owned.some(item => item.memoryBytes === null) ? 'unavailable' as const : 'normal' as const
    record.peak = Math.max(record.peak, measured)
    record.firstHighAt = alertLevel === 'warning' || alertLevel === 'critical' ? record.firstHighAt || now : 0
    if (alertLevel === 'normal') record.level = 'normal'
    const entry: PluginMemoryEntry = { pluginId, name: pluginRegistry.get(pluginId)?.name ?? pluginId, status,
      canClose: !homeSurfaceManager.getMemoryOwners().some(owner => owner.pluginId === pluginId), memoryBytes, sharedMemoryBytes,
      peakMemoryBytes: record.peak, processCount: owned.length, unmeasuredProcessCount: owned.filter(item => item.memoryBytes === null).length,
      alert: alertLevel, processes: owned }
    if (settings.alertsEnabled) alert(entry, record, now)
    history.set(pluginId, record)
    return entry
  }).sort((left, right) => (right.memoryBytes ?? 0) + (right.sharedMemoryBytes ?? 0) - (left.memoryBytes ?? 0) - (left.sharedMemoryBytes ?? 0) || left.name.localeCompare(right.name))
  for (const id of history.keys()) if (!ids.has(id)) history.delete(id)
  snapshot = { sampledAt: now, intervalMs: INTERVAL_MS, settings, totalMemoryBytes: sumKnown(processes.filter(item => item.pluginIds.length > 0)),
    hostMemoryBytes: sumKnown(processes.filter(item => item.pluginIds.length === 0)), sharedMemoryBytes: sumKnown(processes.filter(item => item.shared)),
    unavailableProcessCount: processes.filter(item => item.memoryBytes === null).length, plugins, processes }
}

async function sample(): Promise<void> {
  if (flight) return flight
  const sampleEpoch = epoch
  flight = collect(sampleEpoch).catch(error => {
    if (!active || sampleEpoch !== epoch) return
    snapshot = { ...snapshot, settings: preferences(), error: String(error).slice(0, 300) }
    if (Date.now() - lastErrorAt > 60_000) { lastErrorAt = Date.now(); logWarn('plugin-memory', `sampling failed: ${String(error)}`) }
  }).finally(() => { flight = undefined })
  return flight
}
function schedule(): void {
  if (!active) return
  timer = setTimeout(() => { void sample().finally(schedule) }, INTERVAL_MS)
  timer.unref?.()
}
export function startPluginMemoryMonitor(): void {
  if (active) return
  active = true; epoch++
  void sample().finally(schedule)
}
export function stopPluginMemoryMonitor(): void {
  active = false; epoch++
  if (timer) clearTimeout(timer)
  timer = undefined; history.clear(); trackedDescendants.clear()
}
export async function refreshPluginMemoryAfterClose(): Promise<void> {
  if (flight) await flight
  if (active) await sample()
}

export async function getPluginMemorySnapshot(force = false): Promise<PluginMemorySnapshot> {
  const settings = preferences()
  if (active && (force || !snapshot.sampledAt || Date.now() - snapshot.sampledAt >= INTERVAL_MS || settings.enabled !== snapshot.settings.enabled)) await sample()
  return structuredClone({ ...snapshot, settings })
}
