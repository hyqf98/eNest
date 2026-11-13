import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  PERFORMANCE_CAPTURE_LIMITS, type PerformanceCaptureReport, type PerformanceCaptureSample,
  type PerformanceCaptureState, type PerformanceCaptureStopReason, type PerformanceCaptureMainEventLoop
} from '@shared/types/performanceCapture'

interface EventLoopObservation {
  read(): PerformanceCaptureMainEventLoop
  stop(): void
}

interface CaptureSession {
  state: PerformanceCaptureState
  metadata: PerformanceCaptureReport['metadata']
  samples: PerformanceCaptureSample[]
  startedMono: number
  timer?: ReturnType<typeof setTimeout>
  deadline?: ReturnType<typeof setTimeout>
  flight?: Promise<void>
  stopping?: Promise<PerformanceCaptureState>
  eventLoop?: EventLoopObservation
}

const DEFINITIONS = [
  'Memory processes are unique by PID per sample; shared processes are not added once per owner.',
  'memoryBytes uses the recorded per-process metric. RSS is not footprint/private memory; unknown values are null, not zero.',
  'CPU is 100 * delta(cumulativeCPUUsage seconds) / monotonic interval seconds; one logical core at full load is 100%.',
  'CPU covers only Electron-reported processes with the same creation identity in adjacent samples. Native children, exited and new processes may be unmeasured.',
  'mainEventLoop observes only the Electron main process. sampledAt/intervalMs end before asynchronous process sampling and are independent of the CPU interval.',
  'mainEventLoop.delayMs contains raw monitorEventLoopDelay histogram nanoseconds converted to milliseconds, at the recorded resolutionMs; the timer resolution is not subtracted. The histogram resets after each observation; zero sampleCount means null percentiles/max.',
  'mainEventLoop.eventLoopUtilization contains interval activeMs/idleMs and utilization from 0 to 1. It is event-loop occupancy, not CPU utilization or FPS; a missing valid utilization interval is null even if delay samples exist.',
  'Older v2 recordings omit mainEventLoop. A null observation means the monitor was unavailable after a capture failure; it never means zero delay. Observation stops immediately when capture stops, including shutdown.',
  'host.logicalTabs counts main-window shell tabs, including cold and hibernated placeholders. It does not equal live renderers.',
  'host.coldShellTabs counts installed-state shell placeholders without a runtime, hibernation record or in-flight open/close/reload/retire/transfer. host.lazyDetached counts restored independent windows not yet instantiated.',
  'host.live and host.hibernated span all plugin containers; host counters are not disjoint parts of logicalTabs. Shared PID memory is not exclusive plugin attribution.',
  'DevTools, focus, OS background load and collection overhead can affect results. This is not a frame-time/FPS, interaction-latency or leak test.',
  'Only this bounded user-started session is retained in memory. No command lines, URLs, titles, environment, file paths or payload contents are captured.'
]

export function emptyPerformanceCaptureState(): PerformanceCaptureState {
  return { status: 'idle', captureId: null, startedAt: null, stoppedAt: null, deadlineAt: null,
    sampleCount: 0, retainedBytes: 0, failedSamples: 0, stopReason: null, limits: PERFORMANCE_CAPTURE_LIMITS }
}

/** One explicit, bounded session; polling state never invokes a native sample. */
export class PerformanceCaptureRecorder {
  private session?: CaptureSession
  constructor(private readonly source: {
    metadata(): PerformanceCaptureReport['metadata']
    collect(sequence: number, startedMono: number, previous: PerformanceCaptureSample | null): Promise<PerformanceCaptureSample>
    observeEventLoop?(): EventLoopObservation
    log(message: string): void
  }) {}

  state(): PerformanceCaptureState { return structuredClone(this.session?.state ?? emptyPerformanceCaptureState()) }

  start(): PerformanceCaptureState {
    if (this.session?.state.status === 'running') return this.state()
    if (this.session?.state.status === 'stopping') throw new Error('Performance recording is stopping; try again shortly')
    const startedAt = Date.now()
    const session: CaptureSession = { state: { ...emptyPerformanceCaptureState(), status: 'running', captureId: randomUUID(), startedAt,
      deadlineAt: startedAt + PERFORMANCE_CAPTURE_LIMITS.durationMs }, samples: [], metadata: this.source.metadata(), startedMono: performance.now() }
    const previousSession = this.session
    try {
      session.eventLoop = this.source.observeEventLoop?.()
      this.session = session
      session.deadline = setTimeout(() => { void this.stop('time-limit') }, PERFORMANCE_CAPTURE_LIMITS.durationMs)
      session.deadline.unref?.()
      this.source.log(`start capture=${session.state.captureId} intervalMs=${PERFORMANCE_CAPTURE_LIMITS.intervalMs} durationMs=${PERFORMANCE_CAPTURE_LIMITS.durationMs}`)
      this.capture(session)
      return this.state()
    } catch (error) {
      if (session.timer) clearTimeout(session.timer)
      if (session.deadline) clearTimeout(session.deadline)
      this.stopEventLoop(session)
      this.session = previousSession
      throw error
    }
  }

  private stopEventLoop(session: CaptureSession): void {
    const observation = session.eventLoop
    session.eventLoop = undefined
    observation?.stop()
  }

  private capture(session: CaptureSession): void {
    if (session.state.status !== 'running' || session.flight) return
    session.flight = Promise.resolve().then(async () => {
      if (session.state.status !== 'running') return
      const mainEventLoop = session.eventLoop?.read() ?? null
      const sample = await this.source.collect(session.samples.length + 1, session.startedMono, session.samples.at(-1) ?? null)
      if (this.source.observeEventLoop) sample.mainEventLoop = mainEventLoop
      const bytes = Buffer.byteLength(JSON.stringify(sample))
      if (session.state.retainedBytes + bytes > PERFORMANCE_CAPTURE_LIMITS.maxBytes) { void this.stop('size-limit'); return }
      session.samples.push(sample)
      session.state.sampleCount = session.samples.length
      session.state.retainedBytes += bytes
      const cpu = sample.cpu.oneCorePercent === null ? 'unavailable' : sample.cpu.oneCorePercent.toFixed(2)
      this.source.log(`sample capture=${session.state.captureId} sequence=${sample.sequence} processes=${sample.memory.uniqueProcesses} measuredMiB=${(sample.memory.measuredBytes / 1048576).toFixed(1)} cpuOneCorePercent=${cpu} cpuUnmeasured=${sample.cpu.unavailableProcesses} logicalTabs=${sample.host.logicalTabs} live=${sample.host.live} hibernated=${sample.host.hibernated} coldShellTabs=${sample.host.coldShellTabs} lazyDetached=${sample.host.lazyDetached} backgrounds=${sample.counters.backgrounds ?? 0} auxiliaryWindows=${sample.counters.auxiliaryWindows ?? 0} fileStreams=${sample.counters.fileStreams ?? 0} devTools=${sample.windows.devTools} collectionMs=${sample.collectionMs.toFixed(1)}`)
      if (session.samples.length >= PERFORMANCE_CAPTURE_LIMITS.maxSamples) void this.stop('sample-limit')
    }).catch(() => {
      this.stopEventLoop(session)
      session.state.failedSamples++
      // Native errors can contain paths or command output. Keep diagnostics logs content-free.
      this.source.log(`sample-failed capture=${session.state.captureId} count=${session.state.failedSamples}`)
    }).finally(() => {
      session.flight = undefined
      if (session.state.status !== 'running') return
      session.timer = setTimeout(() => this.capture(session), PERFORMANCE_CAPTURE_LIMITS.intervalMs)
      session.timer.unref?.()
    })
  }

  stop(reason: PerformanceCaptureStopReason = 'manual'): Promise<PerformanceCaptureState> {
    const session = this.session
    if (!session || session.state.status === 'stopped') return Promise.resolve(this.state())
    if (session.stopping) return session.stopping
    session.state.status = 'stopping'
    session.state.stopReason = reason
    if (session.timer) clearTimeout(session.timer)
    if (session.deadline) clearTimeout(session.deadline)
    // Disable the observer synchronously: native collection may still be awaiting a reply at shutdown.
    this.stopEventLoop(session)
    session.stopping = Promise.resolve(session.flight).then(() => {
      session.state.status = 'stopped'
      session.state.stoppedAt = Date.now()
      this.source.log(`stop capture=${session.state.captureId} reason=${reason} samples=${session.state.sampleCount} bytes=${session.state.retainedBytes}`)
      return this.state()
    })
    return session.stopping
  }

  report(): PerformanceCaptureReport {
    const session = this.session
    if (!session || session.state.status !== 'stopped' || !session.samples.length) throw new Error('Stop a recording with at least one sample before exporting')
    return structuredClone({ schema: 'enest.performance.v2', metadata: session.metadata, definitions: DEFINITIONS, state: session.state, samples: session.samples })
  }
}
