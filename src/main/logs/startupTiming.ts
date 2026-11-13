import { performance } from 'node:perf_hooks'
import { logInfo } from './logService'

type StartupPhase =
  | 'app-ready'
  | 'registry-metadata-ready'
  | 'dev-registrations-ready'
  | 'shell-window-created'
  | 'shell-did-finish-load'
  | 'shell-window-shown'
  | 'home-load-start'
  | 'home-did-finish-load'
  | 'home-ready'
  | 'home-route-ack'
  | 'home-visible'

let startedAt: number | undefined
let completed = false
const recorded = new Set<StartupPhase>()

/** First boot milestones only; native visibility does not assert that pixels have painted. */
export function markStartupPhase(phase: StartupPhase, detail?: string): void {
  if (completed || recorded.has(phase)) return
  const now = performance.now()
  if (phase === 'app-ready') startedAt = now
  if (startedAt === undefined) return
  recorded.add(phase)
  logInfo('startup', `${phase} app-ready+${(now - startedAt).toFixed(1)}ms${detail ? ` ${detail}` : ''}`)
  if (phase === 'home-visible') completed = true
}
