type StartupPhase = 'appearance-hydrated' | 'splash-mounted' | 'workspace-prepared' | 'splash-done'

const recorded = new Set<StartupPhase>()

/** Development diagnostics use this document's monotonic navigation clock, not the main clock. */
export function markStartupPhase(phase: StartupPhase): void {
  if (!import.meta.env.DEV || recorded.has(phase)) return
  recorded.add(phase)
  const mark = performance.mark(`enest:startup:${phase}`)
  console.info(`[startup:renderer] ${phase} navigation+${mark.startTime.toFixed(1)}ms`)
}
