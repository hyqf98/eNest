/** Persistent main-process focus timer. Durations are milliseconds in snapshots. */
export interface FocusTimerOptions {
  focusMin: number
  breakMin: number
  longBreakMin: number
  longBreakEvery: number
  autoStart: boolean
  task: string
  notify: boolean
}
export type FocusTimerPhase = 'focus' | 'break' | 'longBreak'
export interface FocusTimerState {
  status: 'idle' | 'running' | 'paused'
  phase: FocusTimerPhase
  remainingMs: number
  deadline: number | null
  startedAt: number | null
  cycle: number
  options: FocusTimerOptions
}
export interface FocusTimerRecord {
  id: string
  phase: FocusTimerPhase
  task: string
  startedAt: number
  endedAt: number
  durationMs: number
  outcome: 'completed' | 'skipped' | 'stopped'
  counted: boolean
}
export interface FocusTimerSnapshot {
  state: FocusTimerState
  records: FocusTimerRecord[]
}
export interface FocusTimerRecordPatch {
  task?: string
  durationMs?: number
  counted?: boolean
  deleted?: boolean
}
export type FocusTimerEvent =
  | { type: 'change'; pluginId: string; snapshot: FocusTimerSnapshot }
  | { type: 'notify'; pluginId: string; title: string; body: string }
