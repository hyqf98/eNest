import type { PluginMemoryProcess } from '@shared/types/pluginMemory'

export const PERFORMANCE_CAPTURE_LIMITS = { intervalMs: 5000, durationMs: 10 * 60_000, maxSamples: 121, maxBytes: 4 * 1024 * 1024 } as const
export type PerformanceCaptureStopReason = 'manual' | 'time-limit' | 'sample-limit' | 'size-limit' | 'shutdown'

export interface PerformanceCaptureState {
  status: 'idle' | 'running' | 'stopping' | 'stopped' | 'unavailable'
  captureId: string | null
  startedAt: number | null
  stoppedAt: number | null
  deadlineAt: number | null
  sampleCount: number
  retainedBytes: number
  failedSamples: number
  stopReason: PerformanceCaptureStopReason | null
  limits: typeof PERFORMANCE_CAPTURE_LIMITS
}

export interface PerformanceCaptureProcess extends PluginMemoryProcess {
  startedAt: number | null
  electronType: string | null
  cpuStartedAt: number | null
  cpuCumulativeSeconds: number | null
  cpuOneCorePercent: number | null
  owners: Array<{ pluginId: string; generation: number | null }>
}

export interface PerformanceCaptureMainEventLoop {
  /** End of this observation interval, taken before the asynchronous process sample. */
  sampledAt: number
  /** Monotonic elapsed milliseconds since observation started or the previous observation. */
  intervalMs: number
  /** Requested monitorEventLoopDelay timer resolution, in milliseconds. */
  resolutionMs: number
  sampleCount: number
  /** Raw histogram nanoseconds converted to milliseconds; null when the interval has no samples. */
  delayMs: { p50: number | null; p95: number | null; max: number | null }
  /** Interval event-loop active/idle time in milliseconds and utilization in [0, 1], not process CPU. */
  eventLoopUtilization: { activeMs: number; idleMs: number; utilization: number } | null
}

export interface PerformanceCaptureSample {
  sequence: number
  sampledAt: number
  elapsedMs: number
  collectionMs: number
  memorySampledAt: number | null
  memoryError: boolean
  systemFreeMemoryBytes: number
  processes: PerformanceCaptureProcess[]
  processesTruncated: boolean
  memory: { measuredBytes: number; unavailableProcesses: number; uniqueProcesses: number; metrics: PluginMemoryProcess['metric'][] }
  cpu: { intervalMs: number | null; oneCorePercent: number | null; measuredProcesses: number; unavailableProcesses: number; newProcesses: number; exitedProcesses: number }
  /** Older v2 recordings omit this field; null means observation was unavailable in this session. */
  mainEventLoop?: PerformanceCaptureMainEventLoop | null
  host: { logicalTabs: number; live: number; hibernated: number; coldShellTabs: number; lazyDetached: number; opening: number; closing: number; retiring: number }
  plugins: Array<{ pluginId: string; generation: number; wcId: number; state: string }>
  resources: Array<{ pluginId: string; generation: number; wcId: number; closing: boolean; activities: number; resources: number }>
  counters: { activities: number; resources: number; utilities: number; utilityPending: number; sessionBytes: number; sessionResidentBytes: number; sessionPlugins: number; localCacheBytes: number; localDirtyBytes: number; localDirtyKeys: number; localPlugins: number;
    /** Added in 0.2.3. Older v2 recordings may omit these native resource counters. */
    backgrounds?: number; backgroundPending?: number; auxiliaryWindows?: number; captureWindows?: number; fileStreams?: number; queuedFileBytes?: number }
  windows: { total: number; focused: number; visible: number; devTools: number }
}

export interface PerformanceCaptureReport {
  schema: 'enest.performance.v2'
  metadata: { platform: string; arch: string; osRelease: string; appVersion: string; electronVersion: string; chromiumVersion: string; nodeVersion: string; logicalCpuCount: number; totalMemoryBytes: number }
  definitions: string[]
  state: PerformanceCaptureState
  samples: PerformanceCaptureSample[]
}

export interface PerformanceCaptureExportResult { exported: boolean; sampleCount: number }
