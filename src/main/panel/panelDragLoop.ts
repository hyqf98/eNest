import { performance } from 'node:perf_hooks'

const FRAME_INTERVAL_MS = 16
const HEARTBEAT_TIMEOUT_MS = 30_000
export const PANEL_DRAG_FEEDBACK_INTERVAL_MS = 32

/** Native geometry runs independently of renderer pointer events and IPC delivery. */
export class PanelDragLoop {
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastHeartbeat = performance.now()
  private stopped = false

  constructor(private readonly callbacks: {
    current(): boolean
    tick(now: number): void
    cancel(error?: unknown): void
  }) {}

  start(): void {
    if (this.stopped || this.timer) return
    this.run()
  }

  heartbeat(): void {
    if (!this.stopped) this.lastHeartbeat = performance.now()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private run(): void {
    this.timer = undefined
    if (this.stopped) return
    const now = performance.now()
    let current: boolean
    try { current = this.callbacks.current() }
    catch (error) {
      this.stop()
      this.callbacks.cancel(error)
      return
    }
    if (!current || now - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      this.stop()
      this.callbacks.cancel()
      return
    }
    try { this.callbacks.tick(now) }
    catch (error) {
      this.stop()
      this.callbacks.cancel(error)
      return
    }
    if (this.stopped) return
    this.timer = setTimeout(() => this.run(), FRAME_INTERVAL_MS)
    this.timer.unref?.()
  }
}
