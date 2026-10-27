export interface BackgroundResource {
  setPaused(paused: boolean): void
  dispose(): void
}

const HIDDEN_RETENTION_MS = 10_000

/** One surface owns one resource; a hidden surface may retain it briefly, never run it. */
export function retainBackgroundResource(
  create: () => BackgroundResource,
  { paused = false, retainMs = HIDDEN_RETENTION_MS }: { paused?: boolean; retainMs?: number } = {},
): BackgroundResource {
  let resource: BackgroundResource | undefined
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let retainedUntil = 0
  let disposed = false
  let externallyPaused = paused
  const release = () => {
    clearTimeout(releaseTimer)
    releaseTimer = undefined
    retainedUntil = 0
    resource?.dispose()
    resource = undefined
  }
  const sync = () => {
    if (disposed) return
    if (externallyPaused || document.hidden) {
      resource?.setPaused(true)
      if (resource && releaseTimer === undefined) {
        if (retainMs <= 0) release()
        else {
          const delay = Math.min(HIDDEN_RETENTION_MS, retainMs)
          retainedUntil = performance.now() + delay
          releaseTimer = setTimeout(release, delay)
        }
      }
      return
    }
    // Chromium can throttle hidden timers; an overdue lease must not be revived.
    if (retainedUntil && performance.now() >= retainedUntil) release()
    clearTimeout(releaseTimer)
    releaseTimer = undefined
    retainedUntil = 0
    resource ??= create()
    resource.setPaused(false)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('pagehide', dispose)
    release()
  }
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('pagehide', dispose)
  sync()
  return { setPaused(value) { externallyPaused = value; sync() }, dispose }
}
