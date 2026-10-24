export type DeadlineTaskData = null | boolean | number | string | DeadlineTaskData[] | { [key: string]: DeadlineTaskData }
export interface DeadlineTaskStep {
  id: string
  durationMs: number
  data?: DeadlineTaskData
  notification?: { title: string; body: string }
}
export interface DeadlineTaskPlan {
  id: string
  steps: DeadlineTaskStep[]
  repeat?: boolean
  autoAdvance?: boolean
  data?: DeadlineTaskData
}
/** A bounded cursor also permits a plugin to import its own paused legacy state. */
export interface DeadlineTaskStart extends DeadlineTaskPlan {
  paused?: boolean
  cursor?: { stepIndex: number; iteration: number; remainingMs: number; startedAt?: number | null }
}
export interface DeadlineTaskState {
  id: string
  runId: string
  plan: DeadlineTaskPlan
  status: 'idle' | 'running' | 'paused' | 'completed'
  stepIndex: number
  iteration: number
  remainingMs: number
  deadline: number | null
  startedAt: number | null
  updatedAt: number
}
/** Execution receipts are immutable; their business meaning/edit history belongs to the plugin. */
export interface DeadlineTaskReceipt {
  id: string
  taskId: string
  runId: string
  stepId: string
  stepIndex: number
  iteration: number
  startedAt: number
  endedAt: number
  elapsedMs: number
  outcome: 'completed' | 'skipped' | 'cancelled'
  data?: DeadlineTaskData
  stepData?: DeadlineTaskData
}
export interface DeadlineTaskSnapshot {
  task: DeadlineTaskState | null
  receipts: DeadlineTaskReceipt[]
}
export type DeadlineTaskEvent =
  | { type: 'change'; pluginId: string; taskId: string }
  | { type: 'notify'; pluginId: string; taskId: string; title: string; body: string }
