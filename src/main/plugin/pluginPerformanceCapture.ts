import { app, BaseWindow, dialog, webContents } from 'electron'
import { cpus, freemem, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { getPluginDiagnostics } from '@main/plugin/pluginDiagnostics'
import { getPluginMemoryDiagnosticSnapshot } from '@main/plugin/pluginMemoryMonitor'
import { getPluginOwnedProcesses } from '@main/plugin/pluginOwnedProcesses'
import { getMainWindow } from '@main/window/createShellWindow'
import { logInfo } from '@main/logs/logService'
import { PerformanceCaptureRecorder } from '@main/plugin/performanceCaptureRecorder'
import { trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import type { PerformanceCaptureExportResult, PerformanceCaptureProcess, PerformanceCaptureSample } from '@shared/types/performanceCapture'

const MAX_PROCESSES = 512
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }
function nullableNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null }
function id(value: string): string { return /^[a-zA-Z0-9._-]{1,180}$/.test(value) ? value : '[invalid-id]' }

async function collect(sequence: number, startedMono: number, previous: PerformanceCaptureSample | null): Promise<PerformanceCaptureSample> {
  const collectionStart = performance.now()
  const memory = await getPluginMemoryDiagnosticSnapshot()
  const diagnostics = getPluginDiagnostics()
  const sampledMono = performance.now()
  const elapsedMs = sampledMono - startedMono
  const intervalMs = previous ? elapsedMs - previous.elapsedMs : null
  const metrics = new Map(diagnostics.processes.map(value => [value.pid, value]))
  const owned = getPluginOwnedProcesses()
  const resources = diagnostics.resources.slice(0, MAX_PROCESSES).map(value => ({
    pluginId: id(value.pluginId), generation: number(value.generation), wcId: number(value.wcId), closing: Boolean(value.closing),
    activities: value.activities.length, resources: number(value.resources)
  }))
  const old = new Map(previous?.processes.map(value => [value.pid, value]) ?? [])
  const unique = new Map(memory.processes.map(value => [value.pid, value]))
  const processes: PerformanceCaptureProcess[] = [...unique.values()].slice(0, MAX_PROCESSES).map(value => {
    const metric = metrics.get(value.pid)
    const startedAt = value.startedAt ?? null
    const cpuIdentity = nullableNumber(metric?.creationTime)
    const before = old.get(value.pid)
    // Electron creationTime is the CPU source identity; never bridge a PID reuse or unknown start.
    const currentIdentityMatches = cpuIdentity !== null && startedAt !== null && Math.abs(cpuIdentity - startedAt) < 1100
    const cumulative = currentIdentityMatches ? nullableNumber(metric?.cpu.cumulativeCPUUsage) : null
    const sameProcess = before && cpuIdentity !== null && before.cpuStartedAt === cpuIdentity
    const cpuPercent = sameProcess && cumulative !== null && before.cpuCumulativeSeconds !== null && intervalMs !== null && intervalMs > 0 && cumulative >= before.cpuCumulativeSeconds
      ? (cumulative - before.cpuCumulativeSeconds) * 100_000 / intervalMs : null
    const owners = value.pluginIds.slice(0, 64).map(pluginId => {
      const generations = new Set([
        ...owned.filter(entry => entry.pid === value.pid && entry.pluginId === pluginId).map(entry => entry.generation),
        ...diagnostics.renderers.filter(entry => entry.pluginId === pluginId && (entry.pid === value.pid || entry.pids.includes(value.pid))).map(entry => entry.generation)
      ].map(nullableNumber).filter((generation): generation is number => generation !== null))
      // Frontend and background incarnations may share one plugin ID. Never label a
      // background PID with the foreground generation merely because the IDs match.
      return { pluginId: id(pluginId), generation: generations.size === 1 ? [...generations][0] : null }
    })
    return { pid: value.pid, startedAt, kind: value.kind, pluginIds: owners.map(owner => owner.pluginId), shared: Boolean(value.shared),
      memoryBytes: nullableNumber(value.memoryBytes), residentBytes: nullableNumber(value.residentBytes), metric: value.metric,
      electronType: metric?.type ?? null, cpuStartedAt: cpuIdentity, cpuCumulativeSeconds: cumulative, cpuOneCorePercent: cpuPercent, owners }
  })
  const currentPids = new Set(processes.map(value => value.pid))
  const measuredCpu = processes.filter(value => value.cpuOneCorePercent !== null)
  const windows = BaseWindow.getAllWindows().filter(window => !window.isDestroyed())
  return {
    sequence, sampledAt: Date.now(), elapsedMs, collectionMs: performance.now() - collectionStart,
    memorySampledAt: memory.sampledAt, memoryError: Boolean(memory.error), systemFreeMemoryBytes: freemem(), processes,
    processesTruncated: unique.size > MAX_PROCESSES,
    memory: { measuredBytes: processes.reduce((sum, value) => sum + (value.memoryBytes ?? 0), 0), unavailableProcesses: processes.filter(value => value.memoryBytes === null).length,
      uniqueProcesses: unique.size, metrics: [...new Set(processes.map(value => value.metric))] },
    cpu: { intervalMs, oneCorePercent: measuredCpu.length ? measuredCpu.reduce((sum, value) => sum + value.cpuOneCorePercent!, 0) : null,
      measuredProcesses: measuredCpu.length, unavailableProcesses: processes.length - measuredCpu.length,
      newProcesses: processes.filter(value => !old.has(value.pid) || old.get(value.pid)?.startedAt !== value.startedAt || old.get(value.pid)?.cpuStartedAt !== value.cpuStartedAt).length,
      exitedProcesses: [...old.values()].filter(value => !currentPids.has(value.pid) || processes.find(item => item.pid === value.pid)?.startedAt !== value.startedAt || processes.find(item => item.pid === value.pid)?.cpuStartedAt !== value.cpuStartedAt).length },
    host: { logicalTabs: diagnostics.host.logicalTabs, live: diagnostics.host.entries.length, hibernated: diagnostics.host.hibernated,
      coldShellTabs: diagnostics.host.coldShellTabs, lazyDetached: diagnostics.host.lazyDetached,
      opening: diagnostics.host.opening, closing: diagnostics.host.closing, retiring: diagnostics.host.retiring },
    plugins: diagnostics.host.entries.slice(0, MAX_PROCESSES).map(value => ({ pluginId: id(value.pluginId), generation: number(value.generation), wcId: number(value.wcId), state: String(value.state) })),
    resources,
    counters: { activities: diagnostics.resources.reduce((sum, value) => sum + value.activities.length, 0), resources: diagnostics.resources.reduce((sum, value) => sum + number(value.resources), 0),
      utilities: diagnostics.utilities.length, utilityPending: diagnostics.utilities.reduce((sum, value) => sum + number(value.pending), 0),
      backgrounds: diagnostics.backgrounds.length, backgroundPending: diagnostics.backgrounds.reduce((sum, value) => sum + number(value.pending), 0),
      auxiliaryWindows: number(diagnostics.auxiliary.windows), captureWindows: number(diagnostics.auxiliary.captureWindows), fileStreams: number(diagnostics.streams.streams), queuedFileBytes: number(diagnostics.streams.queuedBytes),
      sessionBytes: number(diagnostics.session.bytes), sessionResidentBytes: number(diagnostics.session.residentBytes), sessionPlugins: number(diagnostics.session.plugins),
      localCacheBytes: number(diagnostics.localStorage.cacheBytes), localDirtyBytes: number(diagnostics.localStorage.dirtyBytes), localDirtyKeys: number(diagnostics.localStorage.dirtyKeys), localPlugins: number(diagnostics.localStorage.plugins) },
    windows: { total: windows.length, focused: windows.filter(window => window.isFocused()).length, visible: windows.filter(window => window.isVisible()).length,
      devTools: webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.isDevToolsOpened()).length }
  }
}

const recorder = new PerformanceCaptureRecorder({
  collect,
  metadata: () => ({ platform: process.platform, arch: process.arch, osRelease: release(), appVersion: app.getVersion(), electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome, nodeVersion: process.versions.node, logicalCpuCount: cpus().length, totalMemoryBytes: totalmem() }),
  log: message => logInfo('performance-capture', message)
})
app.once('will-quit', () => { void recorder.stop('shutdown') })
export const startPerformanceCapture = () => recorder.start()
export const getPerformanceCaptureState = () => recorder.state()
export const stopPerformanceCapture = () => recorder.stop()

let exporting = false
export async function exportPerformanceCapture(): Promise<PerformanceCaptureExportResult> {
  if (exporting) throw new Error('Performance export is already open')
  exporting = true
  try {
    await recorder.stop()
    const report = recorder.report()
    const options = { title: 'Export eNest performance recording', defaultPath: `eNest-performance-${new Date(report.state.startedAt!).toISOString().replace(/[:.]/g, '-')}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }] }
    const window = getMainWindow()
    const result = await trackNativeInteraction(window && !window.isDestroyed() ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
    if (result.canceled || !result.filePath) return { exported: false, sampleCount: report.samples.length }
    try { await writeFile(result.filePath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 }) }
    catch { throw new Error('Could not write the performance recording; choose a writable location') }
    logInfo('performance-capture', `export capture=${report.state.captureId} samples=${report.samples.length}`)
    return { exported: true, sampleCount: report.samples.length }
  } finally { exporting = false }
}
