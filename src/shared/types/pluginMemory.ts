export interface PluginMemoryMonitorSettings {
  enabled: boolean
  alertsEnabled: boolean
  warningThresholdMiB: number
}

export const DEFAULT_PLUGIN_MEMORY_MONITOR: Readonly<PluginMemoryMonitorSettings> = {
  enabled: true,
  alertsEnabled: true,
  warningThresholdMiB: 512
}

export function normalizePluginMemoryMonitor(value?: Partial<PluginMemoryMonitorSettings> | null): PluginMemoryMonitorSettings {
  const threshold = value?.warningThresholdMiB
  return {
    enabled: value?.enabled !== false,
    alertsEnabled: value?.alertsEnabled !== false,
    warningThresholdMiB: typeof threshold === 'number' && Number.isFinite(threshold)
      ? Math.max(128, Math.min(8192, Math.round(threshold)))
      : DEFAULT_PLUGIN_MEMORY_MONITOR.warningThresholdMiB
  }
}

export type PluginMemoryStatus = 'idle' | 'running' | 'closing'
export type PluginMemoryAlert = 'normal' | 'warning' | 'critical' | 'unavailable'
export type PluginProcessKind = 'renderer' | 'backend' | 'development' | 'runtime'

export interface PluginMemoryProcess {
  pid: number
  /** Unix milliseconds; null when unavailable. Used to distinguish a reused PID. */
  startedAt?: number | null
  kind: PluginProcessKind | 'host'
  pluginIds: string[]
  shared: boolean
  memoryBytes: number | null
  residentBytes: number | null
  metric: 'footprint' | 'private' | 'resident-swap' | 'resident' | 'unavailable'
}

export interface PluginMemoryEntry {
  pluginId: string
  name: string
  status: PluginMemoryStatus
  canClose: boolean
  /** Shared processes are reported separately, never divided or counted as exclusive. */
  memoryBytes: number | null
  sharedMemoryBytes: number | null
  peakMemoryBytes: number
  processCount: number
  unmeasuredProcessCount: number
  alert: PluginMemoryAlert
  processes: PluginMemoryProcess[]
}

export interface PluginMemorySnapshot {
  sampledAt: number | null
  intervalMs: number
  settings: PluginMemoryMonitorSettings
  totalMemoryBytes: number | null
  hostMemoryBytes: number | null
  sharedMemoryBytes: number | null
  unavailableProcessCount: number
  plugins: PluginMemoryEntry[]
  processes: PluginMemoryProcess[]
  error?: string
}
