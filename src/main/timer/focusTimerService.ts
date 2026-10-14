/** Timers survive plugin view disposal; app restart restores them paused. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAppPaths } from '@main/paths/pathsService'
import type {
  FocusTimerEvent,
  FocusTimerOptions,
  FocusTimerRecordPatch,
  FocusTimerSnapshot,
  FocusTimerState,
} from '@shared/types/focus-timer'

const DEFAULTS: FocusTimerOptions = {
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  autoStart: false,
  task: '',
  notify: true,
}
const timers = new Map<string, FocusTimerSnapshot>()
let sink: (event: FocusTimerEvent) => void = () => {}
let interval: ReturnType<typeof setInterval> | undefined
let saveQueue = Promise.resolve()
let lastTick = Date.now()
let lastSave = Date.now()
let ticking = false
let initialized = false
const clone = <T>(value: T): T => structuredClone(value)
const file = (): string => join(getAppPaths().data, 'focus-timers-v1.json')
const number = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
function options(raw: Partial<FocusTimerOptions> = {}): FocusTimerOptions {
  return {
    focusMin: number(raw.focusMin, 25, 1, 180),
    breakMin: number(raw.breakMin, 5, 1, 60),
    longBreakMin: number(raw.longBreakMin, 15, 1, 120),
    longBreakEvery: Math.round(number(raw.longBreakEvery, 4, 2, 12)),
    autoStart: raw.autoStart === true,
    task: typeof raw.task === 'string' ? raw.task.slice(0, 500) : '',
    notify: raw.notify !== false,
  }
}
function duration(state: FocusTimerState): number {
  return (
    state.options[
      state.phase === 'focus'
        ? 'focusMin'
        : state.phase === 'break'
          ? 'breakMin'
          : 'longBreakMin'
    ] * 60000
  )
}
function initial(): FocusTimerSnapshot {
  return {
    state: {
      status: 'idle',
      phase: 'focus',
      remainingMs: 25 * 60000,
      deadline: null,
      startedAt: null,
      cycle: 1,
      options: { ...DEFAULTS },
    },
    records: [],
  }
}
function entry(pluginId: string): FocusTimerSnapshot {
  if (!pluginId || pluginId.length > 200) throw new Error('无效插件 ID')
  let current = timers.get(pluginId)
  if (!current) {
    current = initial()
    timers.set(pluginId, current)
  }
  return current
}
function remaining(state: FocusTimerState, now = Date.now()): number {
  return state.status === 'running' && state.deadline !== null
    ? Math.max(0, state.deadline - now)
    : state.remainingMs
}
export function getFocusTimer(pluginId: string): FocusTimerSnapshot {
  const snapshot = clone(entry(pluginId))
  snapshot.state.remainingMs = remaining(snapshot.state)
  return snapshot
}
function emit(pluginId: string): void {
  try {
    sink({ type: 'change', pluginId, snapshot: getFocusTimer(pluginId) })
  } catch {
    /* subscriber failure cannot stop timers */
  }
}
function persist(): Promise<void> {
  const payload = JSON.stringify({
    version: 1,
    timers: Object.fromEntries(
      [...timers].map(([id]) => [id, getFocusTimer(id)]),
    ),
  })
  const target = file()
  const write = async (): Promise<void> => {
    await mkdir(getAppPaths().data, { recursive: true })
    await writeFile(target + '.tmp', payload, 'utf8')
    await rename(target + '.tmp', target)
  }
  saveQueue = saveQueue.catch(() => {}).then(write)
  return saveQueue
}
async function changed(pluginId: string): Promise<FocusTimerSnapshot> {
  emit(pluginId)
  await persist()
  return getFocusTimer(pluginId)
}
function appendRecord(
  snapshot: FocusTimerSnapshot,
  outcome: 'completed' | 'skipped' | 'stopped',
  now: number,
): void {
  const state = snapshot.state
  if (state.startedAt === null) return
  snapshot.records.unshift({
    id: randomUUID(),
    phase: state.phase,
    task: state.options.task,
    startedAt: state.startedAt,
    endedAt: now,
    durationMs: Math.max(0, duration(state) - remaining(state, now)),
    outcome,
    counted: outcome === 'completed' && state.phase === 'focus',
  })
  snapshot.records = snapshot.records.slice(0, 2000)
}
function advance(
  snapshot: FocusTimerSnapshot,
  now: number,
  autoStart: boolean,
): void {
  const s = snapshot.state
  if (s.phase === 'focus')
    s.phase = s.cycle % s.options.longBreakEvery === 0 ? 'longBreak' : 'break'
  else {
    s.phase = 'focus'
    s.cycle++
  }
  s.remainingMs = duration(s)
  s.startedAt = autoStart ? now : null
  s.deadline = autoStart ? now + s.remainingMs : null
  s.status = autoStart ? 'running' : 'paused'
}
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  const now = Date.now()
  const wokeFromSleep = now - lastTick > 5000
  lastTick = now
  let dirty = false
  let hasRunning = false
  try {
    for (const [id, snapshot] of timers) {
      const s = snapshot.state
      if (s.status !== 'running' || s.deadline === null) continue
      hasRunning = true
      if (s.deadline <= now) {
        const late = now - s.deadline > 5000
        const completedPhase = s.phase
        const shouldNotify = s.options.notify
        appendRecord(snapshot, 'completed', now)
        // Transition synchronously before awaiting persistence/notification: exactly once.
        advance(snapshot, now, s.options.autoStart && !wokeFromSleep && !late)
        dirty = true
        if (shouldNotify) {
          try {
            sink({
              type: 'notify',
              pluginId: id,
              title: '番茄钟',
              body:
                completedPhase === 'focus'
                  ? '本次专注已完成，休息一下。'
                  : '休息结束，可以开始下一次专注。',
            })
          } catch {
            /* notification failure leaves completed state intact */
          }
        }
      }
      emit(id)
    }
    if (dirty || (hasRunning && now - lastSave > 30000)) {
      await persist()
      lastSave = now
    }
  } finally {
    ticking = false
  }
}
export async function initFocusTimers(
  eventSink: (event: FocusTimerEvent) => void,
): Promise<void> {
  if (interval) clearInterval(interval)
  sink = eventSink
  initialized = false
  timers.clear()
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8'))
    if (
      parsed.version !== 1 ||
      !parsed.timers ||
      typeof parsed.timers !== 'object' ||
      Array.isArray(parsed.timers)
    )
      throw new Error('专注记录文件格式异常，已保留原文件')
    if (parsed.version === 1) {
      for (const [id, raw] of Object.entries(parsed.timers) as Array<
        [string, FocusTimerSnapshot]
      >) {
        if (!raw?.state || !Array.isArray(raw.records)) continue
        const s = raw.state
        const restored = initial()
        restored.state = {
          ...restored.state,
          phase: ['focus', 'break', 'longBreak'].includes(s.phase)
            ? s.phase
            : 'focus',
          options: options(s.options),
          status: s.status === 'idle' ? 'idle' : 'paused',
          remainingMs: number(s.remainingMs, 1500000, 0, 10800000),
          startedAt: typeof s.startedAt === 'number' ? s.startedAt : null,
          cycle: Math.round(number(s.cycle, 1, 1, 100000)),
          deadline: null,
        }
        restored.records = raw.records
          .filter(
            (r) =>
              r &&
              typeof r.id === 'string' &&
              Number.isFinite(r.durationMs) &&
              typeof r.task === 'string' &&
              Number.isFinite(r.endedAt),
          )
          .slice(0, 2000)
        timers.set(id, restored)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('读取专注计时记录失败', { cause: error })
  }
  initialized = true
  lastTick = Date.now()
  lastSave = Date.now()
  interval = setInterval(() => {
    return tick().catch(() => {})
  }, 1000)
  interval.unref()
  for (const id of timers.keys()) emit(id)
}
export async function startFocusTimer(
  pluginId: string,
  raw: Partial<FocusTimerOptions>,
): Promise<FocusTimerSnapshot> {
  if (!initialized) throw new Error('专注计时服务尚未就绪')
  const current = entry(pluginId)
  if (current.state.status !== 'idle')
    throw new Error('已有专注计时，请先停止或继续当前计时')
  const now = Date.now()
  current.state = {
    status: 'running',
    phase: 'focus',
    remainingMs: 0,
    deadline: null,
    startedAt: now,
    cycle: 1,
    options: options(raw),
  }
  current.state.remainingMs = duration(current.state)
  current.state.deadline = now + current.state.remainingMs
  return changed(pluginId)
}
export async function pauseFocusTimer(
  pluginId: string,
): Promise<FocusTimerSnapshot> {
  await tick()
  const s = entry(pluginId).state
  if (s.status === 'running') {
    s.remainingMs = remaining(s)
    s.deadline = null
    s.status = 'paused'
  }
  return changed(pluginId)
}
export async function resumeFocusTimer(
  pluginId: string,
): Promise<FocusTimerSnapshot> {
  const s = entry(pluginId).state
  if (s.status === 'paused') {
    const now = Date.now()
    s.status = 'running'
    s.startedAt ??= now
    s.deadline = now + s.remainingMs
  }
  return changed(pluginId)
}
export async function skipFocusTimer(
  pluginId: string,
): Promise<FocusTimerSnapshot> {
  const current = entry(pluginId)
  if (current.state.status !== 'idle') {
    const now = Date.now()
    appendRecord(current, 'skipped', now)
    advance(current, now, false)
  }
  return changed(pluginId)
}
export async function stopFocusTimer(
  pluginId: string,
): Promise<FocusTimerSnapshot> {
  if (!timers.has(pluginId)) return initial()
  const current = entry(pluginId)
  if (current.state.status !== 'idle')
    appendRecord(current, 'stopped', Date.now())
  current.state = {
    ...initial().state,
    options: current.state.options,
    remainingMs: current.state.options.focusMin * 60000,
  }
  return changed(pluginId)
}
export async function updateFocusTimerRecord(
  pluginId: string,
  recordId: string,
  patch: FocusTimerRecordPatch,
): Promise<FocusTimerSnapshot> {
  const current = entry(pluginId)
  const record = current.records.find((r) => r.id === recordId)
  if (!record) throw new Error('专注记录不存在')
  if (patch.deleted === true)
    current.records = current.records.filter((r) => r.id !== recordId)
  else {
    if (typeof patch.task === 'string') record.task = patch.task.slice(0, 500)
    if (patch.durationMs !== undefined) {
      if (
        !Number.isFinite(patch.durationMs) ||
        patch.durationMs < 0 ||
        patch.durationMs > 10800000
      )
        throw new Error('记录时长超出范围')
      record.durationMs = patch.durationMs
    }
    if (typeof patch.counted === 'boolean')
      record.counted =
        patch.counted &&
        record.phase === 'focus' &&
        record.outcome === 'completed'
  }
  return changed(pluginId)
}
export async function shutdownFocusTimers(): Promise<void> {
  if (!initialized) return
  if (interval) clearInterval(interval)
  interval = undefined
  for (const { state } of timers.values()) {
    if (state.status === 'running') {
      state.remainingMs = remaining(state)
      state.deadline = null
      state.status = 'paused'
    }
  }
  await persist()
}

/** Uninstallation removes timer records as well as stopping the active phase. */
export async function clearFocusTimer(pluginId: string): Promise<void> {
  timers.delete(pluginId)
  try {
    sink({ type: 'change', pluginId, snapshot: initial() })
  } catch {
    /* best effort */
  }
  if (initialized) await persist()
}
/** Signal/forced-exit fallback; no renderer or async shutdown is required. */
export function shutdownFocusTimersSync(): void {
  if (!initialized) return
  if (interval) clearInterval(interval)
  interval = undefined
  for (const { state } of timers.values()) {
    if (state.status === 'running') {
      state.remainingMs = remaining(state)
      state.deadline = null
      state.status = 'paused'
    }
  }
  mkdirSync(getAppPaths().data, { recursive: true })
  const target = file()
  writeFileSync(
    target + '.exit.tmp',
    JSON.stringify({ version: 1, timers: Object.fromEntries(timers) }),
    'utf8',
  )
  renameSync(target + '.exit.tmp', target)
}
