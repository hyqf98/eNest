import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { PerformanceCaptureMainEventLoop } from '@shared/types/performanceCapture'

const RESOLUTION_MS = 20
const finiteNonnegative = (value: number): boolean => Number.isFinite(value) && value >= 0
const milliseconds = (nanoseconds: number): number | null => finiteNonnegative(nanoseconds) ? nanoseconds / 1_000_000 : null

/** No histogram or timer exists until an explicit capture session starts. */
export function startMainEventLoopCapture(): { read(): PerformanceCaptureMainEventLoop; stop(): void } {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  let stopped = false
  try {
    let previousMono = performance.now()
    let previousUtilization = performance.eventLoopUtilization()
    histogram.enable()
    return {
      read() {
        if (stopped) throw new Error('Event loop observation has stopped')
        const sampledMono = performance.now()
        const currentUtilization = performance.eventLoopUtilization()
        const delta = performance.eventLoopUtilization(currentUtilization, previousUtilization)
        const sampleCount = histogram.count
        const validUtilization = finiteNonnegative(delta.active) && finiteNonnegative(delta.idle)
          && delta.active + delta.idle > 0 && finiteNonnegative(delta.utilization) && delta.utilization <= 1
        const observation: PerformanceCaptureMainEventLoop = {
          sampledAt: Date.now(), intervalMs: Math.max(0, sampledMono - previousMono), resolutionMs: RESOLUTION_MS, sampleCount,
          delayMs: sampleCount > 0
            ? { p50: milliseconds(histogram.percentile(50)), p95: milliseconds(histogram.percentile(95)), max: milliseconds(histogram.max) }
            : { p50: null, p95: null, max: null },
          eventLoopUtilization: validUtilization ? { activeMs: delta.active, idleMs: delta.idle, utilization: delta.utilization } : null
        }
        histogram.reset()
        previousMono = sampledMono
        previousUtilization = currentUtilization
        return observation
      },
      stop() {
        if (stopped) return
        stopped = true
        histogram.disable()
        histogram.reset()
      }
    }
  } catch (error) {
    histogram.disable()
    throw error
  }
}
