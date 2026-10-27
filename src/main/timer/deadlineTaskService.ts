import { randomUUID } from 'node:crypto'
import { kvStore, runInTransaction } from '@main/db/sqliteService'
import { logWarn } from '@main/logs/logService'
import type { DeadlineTaskEvent, DeadlineTaskPlan, DeadlineTaskReceipt, DeadlineTaskSnapshot, DeadlineTaskStart, DeadlineTaskState } from '@shared/types/deadline-task'
import { migrateLegacyTimerPayloads } from './legacyTimerMigration'

const MAX_TASKS = 64
const MAX_OWNER_TASKS = 4
const MAX_RECEIPTS = 2000
const CHECKPOINT_MS = 30_000
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const active = new Map<string, { pluginId: string; task: DeadlineTaskState }>()
let timer: ReturnType<typeof setTimeout> | undefined
let checkpointAt = Date.now() + CHECKPOINT_MS
let initialized = false
let sink: (event: DeadlineTaskEvent) => void = () => {}
let enabled: (pluginId: string) => boolean = () => true
const clone = <T>(value: T): T => structuredClone(value)
const key = (pluginId: string, id: string): string => `${pluginId}\0${id}`

function database() {
  const db = kvStore.getDatabase()
  if (!db) throw new Error('Deadline storage unavailable')
  return db
}
function owner(pluginId: string): void {
  if (!initialized) throw new Error('Deadline service is not ready')
  if (typeof pluginId !== 'string' || !pluginId || pluginId.length > 200 || pluginId.includes('\0')) throw new Error('Invalid deadline owner')
}
function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error('Invalid deadline task ID')
  return value
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid deadline numeric value')
  return value
}
function jsonData(value: unknown, maxBytes: number): DeadlineTaskPlan['data'] {
  if (value === undefined) return undefined
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item) || typeof item === 'function' || typeof item === 'bigint') throw new Error('Invalid deadline data')
    return item
  })
  if (!json || Buffer.byteLength(json) > maxBytes) throw new Error('Deadline data quota exceeded')
  return JSON.parse(json)
}
function planOf(input: DeadlineTaskStart): DeadlineTaskPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid deadline plan')
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 64) throw new Error('Deadline steps limit exceeded')
  const plan: DeadlineTaskPlan = { id: taskId(input.id), repeat: input.repeat === true, autoAdvance: input.autoAdvance === true, data: jsonData(input.data, 2048),
    steps: input.steps.map(step => {
      if (!step || typeof step !== 'object') throw new Error('Invalid deadline step')
      const notification = step.notification
      if (notification && (typeof notification.title !== 'string' || !notification.title || notification.title.length > 100 || typeof notification.body !== 'string' || notification.body.length > 500)) throw new Error('Invalid deadline notification')
      return { id: taskId(step.id), durationMs: integer(step.durationMs, 1000, MAX_DURATION_MS), data: jsonData(step.data, 1024),
        ...(notification ? { notification: { title: notification.title, body: notification.body } } : {}) }
    }) }
  if (new Set(plan.steps.map(step => step.id)).size !== plan.steps.length) throw new Error('Duplicate deadline step ID')
  if (Buffer.byteLength(JSON.stringify(plan)) > 32 * 1024) throw new Error('Deadline plan quota exceeded')
  return plan
}
function remaining(task: DeadlineTaskState, now = Date.now()): number {
  return task.status === 'running' && task.deadline !== null ? Math.max(0, task.deadline - now) : task.remainingMs
}
function write(pluginId: string, task: DeadlineTaskState): void {
  const snapshot = { ...task, remainingMs: remaining(task) }
  database().prepare('INSERT INTO deadline_tasks (plugin_id, id, value) VALUES (?, ?, ?) ON CONFLICT(plugin_id, id) DO UPDATE SET value=excluded.value')
    .run(pluginId, task.id, JSON.stringify(snapshot))
}
function read(pluginId: string, id: string): DeadlineTaskState | null {
  const current = active.get(key(pluginId, id))?.task
  if (current) return clone(current)
  const row = database().prepare('SELECT value FROM deadline_tasks WHERE plugin_id=? AND id=?').get(pluginId, id) as { value: string } | undefined
  return row ? JSON.parse(row.value) : null
}
function publish(pluginId: string, task: DeadlineTaskState): void {
  if (task.status === 'running') {
    if (!active.size) checkpointAt = Date.now() + CHECKPOINT_MS
    active.set(key(pluginId, task.id), { pluginId, task })
  }
  else active.delete(key(pluginId, task.id))
  try { sink({ type: 'change', pluginId, taskId: task.id }) } catch { /* An observer cannot invalidate committed state. */ }
}
function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!initialized || !active.size) return
  const now = Date.now()
  const delay = Math.max(1, Math.min(checkpointAt - now, ...[...active.values()].map(({ task }) => (task.deadline ?? now) - now)))
  timer = setTimeout(() => {
    timer = undefined
    try { processDue(true) } catch { scheduleCheckpointRetry() }
  }, delay)
  timer.unref()
}
function scheduleCheckpointRetry(): void {
  if (!initialized || !active.size || timer) return
  timer = setTimeout(() => { timer = undefined; try { processDue(true) } catch { scheduleCheckpointRetry() } }, CHECKPOINT_MS)
  timer.unref()
}
function receipt(pluginId: string, task: DeadlineTaskState, outcome: DeadlineTaskReceipt['outcome'], now: number): void {
  if (task.startedAt === null) return
  const step = task.plan.steps[task.stepIndex]
  const row: DeadlineTaskReceipt = { id: randomUUID(), taskId: task.id, runId: task.runId, stepId: step.id,
    stepIndex: task.stepIndex, iteration: task.iteration, startedAt: task.startedAt, endedAt: now,
    elapsedMs: Math.max(0, step.durationMs - remaining(task, now)), outcome, data: task.plan.data, stepData: step.data }
  const db = database()
  db.prepare('INSERT INTO deadline_receipts (plugin_id, task_id, id, value) VALUES (?, ?, ?, ?)').run(pluginId, task.id, row.id, JSON.stringify(row))
  db.prepare('DELETE FROM deadline_receipts WHERE plugin_id=? AND task_id=? AND seq NOT IN (SELECT seq FROM deadline_receipts WHERE plugin_id=? AND task_id=? ORDER BY seq DESC LIMIT ?)')
    .run(pluginId, task.id, pluginId, task.id, MAX_RECEIPTS)
}
function advance(task: DeadlineTaskState, now: number, auto: boolean): void {
  task.stepIndex++
  if (task.stepIndex >= task.plan.steps.length) {
    if (!task.plan.repeat) { task.stepIndex--; task.status = 'completed'; task.remainingMs = 0; task.deadline = null; task.startedAt = null; return }
    task.stepIndex = 0; task.iteration++
  }
  task.remainingMs = task.plan.steps[task.stepIndex].durationMs
  task.status = auto ? 'running' : 'paused'
  task.startedAt = auto ? now : null
  task.deadline = auto ? now + task.remainingMs : null
}
function commit(pluginId: string, task: DeadlineTaskState, mutate: () => void): void {
  runInTransaction(database(), () => { mutate(); task.updatedAt = Date.now(); write(pluginId, task) })
  publish(pluginId, task)
}
function processDue(checkpoint = false): void {
  const now = Date.now()
  for (const { pluginId, task: current } of [...active.values()]) {
    const task = clone(current)
    if (!enabled(pluginId)) {
      commit(pluginId, task, () => { receipt(pluginId, task, 'cancelled', now); task.remainingMs = remaining(task, now); task.status = 'idle'; task.deadline = null; task.startedAt = null })
    } else if (task.deadline !== null && task.deadline <= now) {
      const notification = task.plan.steps[task.stepIndex].notification
      const auto = task.plan.autoAdvance === true && now - task.deadline <= 5000
      commit(pluginId, task, () => { receipt(pluginId, task, 'completed', now); advance(task, now, auto) })
      if (notification) try { sink({ type: 'notify', pluginId, taskId: task.id, ...notification }) } catch { /* Optional notification is independent. */ }
    } else if (checkpoint) write(pluginId, task)
  }
  if (checkpoint) checkpointAt = now + CHECKPOINT_MS
  schedule()
}

export async function initDeadlineTasks(eventSink: (event: DeadlineTaskEvent) => void, isOwnerEnabled: (pluginId: string) => boolean = () => true): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = undefined; initialized = false; active.clear(); sink = eventSink; enabled = isOwnerEnabled
  const db = database()
  db.exec('CREATE TABLE IF NOT EXISTS deadline_tasks (plugin_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (plugin_id,id)); CREATE TABLE IF NOT EXISTS deadline_receipts (seq INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT NOT NULL, task_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS deadline_receipts_owner ON deadline_receipts(plugin_id,task_id,seq)')
  try { await migrateLegacyTimerPayloads() }
  catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid legacy JSON' : error instanceof Error ? error.message : 'unknown migration error'
    logWarn('timer', `legacy ownership migration deferred; original retained for retry on next startup: ${reason}`)
  }
  runInTransaction(db, () => {
    const rows = db.prepare('SELECT plugin_id, value FROM deadline_tasks').all() as Array<{ plugin_id: string; value: string }>
    for (const row of rows) {
      const task: DeadlineTaskState = JSON.parse(row.value)
      if (task.status === 'running') { task.status = 'paused'; task.deadline = null; write(row.plugin_id, task) }
    }
  })
  initialized = true
}
export function getDeadlineTask(pluginId: string, id: string): DeadlineTaskSnapshot {
  owner(pluginId); taskId(id); processDue()
  const task = read(pluginId, id)
  if (task) task.remainingMs = remaining(task)
  const rows = database().prepare('SELECT value FROM deadline_receipts WHERE plugin_id=? AND task_id=? ORDER BY seq DESC LIMIT ?').all(pluginId, id, MAX_RECEIPTS) as Array<{ value: string }>
  return { task, receipts: rows.map(row => JSON.parse(row.value)) }
}
export function startDeadlineTask(pluginId: string, input: DeadlineTaskStart): DeadlineTaskSnapshot {
  owner(pluginId)
  if (!enabled(pluginId)) throw new Error('Deadline owner is disabled')
  const plan = planOf(input), old = read(pluginId, plan.id)
  if (old && ['running', 'paused'].includes(old.status)) throw new Error('Deadline task is already active')
  const db = database()
  if (!old && ((db.prepare('SELECT count(*) AS count FROM deadline_tasks').get() as { count: number }).count >= MAX_TASKS ||
    (db.prepare('SELECT count(*) AS count FROM deadline_tasks WHERE plugin_id=?').get(pluginId) as { count: number }).count >= MAX_OWNER_TASKS)) throw new Error('Deadline task quota exceeded')
  const now = Date.now(), cursor = input.cursor
  const stepIndex = cursor ? integer(cursor.stepIndex, 0, plan.steps.length - 1) : 0
  const remainingMs = cursor ? integer(cursor.remainingMs, 0, plan.steps[stepIndex].durationMs) : plan.steps[stepIndex].durationMs
  const startedAt = cursor?.startedAt == null ? input.paused ? null : now : integer(cursor.startedAt, 1, now)
  const task: DeadlineTaskState = { id: plan.id, runId: randomUUID(), plan, status: input.paused ? 'paused' : 'running',
    stepIndex, iteration: cursor ? integer(cursor.iteration, 0, 1_000_000) : 0, remainingMs,
    deadline: input.paused ? null : now + remainingMs, startedAt, updatedAt: now }
  commit(pluginId, task, () => {}); schedule()
  return getDeadlineTask(pluginId, task.id)
}
function operate(pluginId: string, id: string, action: 'pause' | 'resume' | 'skip' | 'cancel'): DeadlineTaskSnapshot {
  owner(pluginId); taskId(id); processDue()
  const task = read(pluginId, id)
  if (!task) return { task: null, receipts: [] }
  if (action === 'resume' && !enabled(pluginId)) throw new Error('Deadline owner is disabled')
  const now = Date.now()
  commit(pluginId, task, () => {
    if (action === 'pause' && task.status === 'running') {
      task.remainingMs = remaining(task, now); task.status = 'paused'; task.deadline = null
    } else if (action === 'resume' && task.status === 'paused') {
      task.status = 'running'; task.startedAt ??= now; task.deadline = now + task.remainingMs
    } else if (['running', 'paused'].includes(task.status) && action === 'skip') {
      receipt(pluginId, task, 'skipped', now); advance(task, now, false)
    } else if (action === 'cancel' && ['running', 'paused'].includes(task.status)) {
      receipt(pluginId, task, 'cancelled', now); task.status = 'idle'; task.stepIndex = 0; task.iteration = 0
      task.remainingMs = task.plan.steps[0].durationMs; task.startedAt = null; task.deadline = null
    }
  })
  schedule(); return getDeadlineTask(pluginId, id)
}
export const pauseDeadlineTask = (pluginId: string, id: string): DeadlineTaskSnapshot => operate(pluginId, id, 'pause')
export const resumeDeadlineTask = (pluginId: string, id: string): DeadlineTaskSnapshot => operate(pluginId, id, 'resume')
export const skipDeadlineTask = (pluginId: string, id: string): DeadlineTaskSnapshot => operate(pluginId, id, 'skip')
export const cancelDeadlineTask = (pluginId: string, id: string): DeadlineTaskSnapshot => operate(pluginId, id, 'cancel')
export function cancelPluginDeadlineTasks(pluginId: string): void {
  if (!initialized) return
  owner(pluginId)
  const rows = database().prepare('SELECT id FROM deadline_tasks WHERE plugin_id=?').all(pluginId) as Array<{ id: string }>
  for (const row of rows) cancelDeadlineTask(pluginId, row.id)
}
export function clearPluginDeadlineTasks(pluginId: string): void {
  const db = database()
  runInTransaction(db, () => { db.prepare('DELETE FROM deadline_receipts WHERE plugin_id=?').run(pluginId); db.prepare('DELETE FROM deadline_tasks WHERE plugin_id=?').run(pluginId) })
  for (const [id, value] of active) if (value.pluginId === pluginId) active.delete(id)
  schedule()
}
export function shutdownDeadlineTasksSync(): void {
  if (!initialized) return
  if (timer) clearTimeout(timer)
  timer = undefined
  const paused = [...active.values()].map(({ pluginId, task }) => ({ pluginId, task: { ...task, remainingMs: remaining(task), deadline: null, status: 'paused' as const } }))
  runInTransaction(database(), () => { for (const { pluginId, task } of paused) write(pluginId, task) })
  active.clear(); initialized = false
}
export async function shutdownDeadlineTasks(): Promise<void> { shutdownDeadlineTasksSync() }
