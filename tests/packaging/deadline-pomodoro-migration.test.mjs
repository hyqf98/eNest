import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import ts from 'typescript'
import { createPlan, createPomodoroController } from '../../eNest_plugin/plugins/pomodoro/src/timer/pomodoro.js'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const OWNER = 'com.github.eNest.pomodoro'
const compiled = new Map()
function load(path, adapters, globals = {}) {
  if (!compiled.has(path)) compiled.set(path, ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
  const module = { exports: {} }, names = Object.keys(globals)
  new Function('require', 'module', 'exports', ...names, compiled.get(path))(name => {
    if (Object.hasOwn(adapters, name)) return adapters[name]
    if (name.startsWith('node:')) return require(name)
    throw Error(`Unexpected dependency: ${name}`)
  }, module, module.exports, ...Object.values(globals))
  return module.exports
}
async function fixture(t, legacy) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE plugin_storage (plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key))')
  let now = 1_000_000, nextId = 0, allowed = true, failWrite = false
  const timers = new Map(), events = [], listeners = new Set()
  class Clock extends Date { static now() { return now } }
  const kvStore = { getDatabase: () => db, kvGet: key => db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value,
    kvSet: (key, value) => db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES (?,?)').run(key, value) }
  const storage = { kvStore, runInTransaction(db, fn) { db.exec('BEGIN'); try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { db.exec('ROLLBACK'); throw error } } }
  const globals = { Date: Clock, setTimeout(callback, delay) { const timer = { id: ++nextId, due: now + delay, callback, unref() {} }; timers.set(timer.id, timer); return timer }, clearTimeout(timer) { if (timer) timers.delete(timer.id) } }
  const migration = load('src/main/timer/legacyTimerMigration.ts', {
    '@main/db/sqliteService': storage, '@main/paths/pathsService': { getAppPaths: () => ({ data: '/fixture' }) },
    'node:fs/promises': { async readFile() { if (legacy === undefined) throw Object.assign(Error('missing'), { code: 'ENOENT' }); return JSON.stringify(legacy) } },
  }, globals)
  const service = load('src/main/timer/deadlineTaskService.ts', { '@main/db/sqliteService': storage, './legacyTimerMigration': migration,
    '@main/logs/logService': { logWarn() {} } }, globals)
  const sink = event => { events.push(event); if (event.type === 'change') for (const listener of listeners) listener({ taskId: event.taskId }) }
  await service.initDeadlineTasks(sink, () => allowed)
  const api = { deadlineTasks: { start: async input => service.startDeadlineTask(OWNER, input), get: async id => service.getDeadlineTask(OWNER, id),
    pause: async id => service.pauseDeadlineTask(OWNER, id), resume: async id => service.resumeDeadlineTask(OWNER, id),
    skip: async id => service.skipDeadlineTask(OWNER, id), cancel: async id => service.cancelDeadlineTask(OWNER, id),
    onChange(callback) { listeners.add(callback); return () => listeners.delete(callback) } },
    storage: { async get(key) { const row = db.prepare('SELECT value FROM plugin_storage WHERE plugin_id=? AND key=?').get(OWNER, key); return row ? JSON.parse(row.value) : null },
      async set(key, value) { if (failWrite) { failWrite = false; throw Error('disk fixture failure') } db.prepare('INSERT OR REPLACE INTO plugin_storage(plugin_id,key,value) VALUES (?,?,?)').run(OWNER, key, JSON.stringify(value)); return true } } }
  const controller = createPomodoroController(api)
  t.after(() => { service.shutdownDeadlineTasksSync(); db.close() })
  return { service, controller, api, events, timers, db, listeners, now: () => now,
    advance(ms) { now += ms; for (let i = 0; i < 20; i++) { const due = [...timers.values()].find(timer => timer.due <= now); if (!due) return; timers.delete(due.id); due.callback() } throw Error('unbounded timer loop') },
    disable() { allowed = false }, failStorage() { failWrite = true },
    restart: async () => { service.shutdownDeadlineTasksSync(); await service.initDeadlineTasks(sink, () => allowed) },
    reinitialize: async () => { await service.initDeadlineTasks(sink, () => allowed) },
  }
}

test('pomodoro owns 25/5/15 defaults and emits a generic long-break sequence', async t => {
  const f = await fixture(t), plan = createPlan({})
  assert.deepEqual(plan.steps.map(step => step.durationMs / 60000), [25, 5, 25, 5, 25, 5, 25, 15])
  assert.equal(plan.repeat, true)
  assert.equal(plan.autoAdvance, false)
  assert.equal((await f.controller.get()).state.remainingMs, 25 * 60000)
  assert.equal(f.timers.size, 0, 'idle must not keep a one-second interval or any scheduler')
  await f.controller.start({ focusMin: 1, breakMin: 1, longBreakMin: 2, longBreakEvery: 2, autoStart: true })
  for (const phase of ['break', 'focus', 'longBreak']) { f.advance(60000); assert.equal((await f.controller.get()).state.phase, phase) }
  assert.equal((await f.controller.get()).state.cycle, 2)
  f.advance(120000)
  const result = await f.controller.get()
  assert.equal(result.state.phase, 'focus'); assert.equal(result.state.cycle, 3)
  assert.equal(result.records.filter(record => record.counted).length, 2)
})

test('deadline ownership survives renderer unsubscribe and an unopened plugin can finish', async t => {
  const f = await fixture(t), pushes = []
  const off = f.controller.onChange(value => pushes.push(value))
  await f.controller.start({ focusMin: 1, notify: true })
  await f.controller.flush(); off()
  const count = pushes.length
  f.advance(60000)
  assert.equal(pushes.length, count)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.timers.size, 0, 'paused next step must release the scheduler')
  assert.equal(f.events.filter(event => event.type === 'notify').length, 1)
  const reopened = createPomodoroController(f.api)
  const result = await reopened.get()
  assert.equal(result.state.status, 'paused'); assert.equal(result.state.phase, 'break')
  assert.equal(result.records[0].outcome, 'completed')
})

test('restart and long sleep pause rather than running a catch-up loop', async t => {
  const f = await fixture(t)
  await f.controller.start({ focusMin: 1, autoStart: true })
  f.advance(10000)
  await f.restart()
  let result = await f.controller.get()
  assert.equal(result.state.status, 'paused'); assert.equal(result.state.remainingMs, 50000)
  assert.equal(f.timers.size, 0)
  await f.controller.resume()
  f.advance(600000)
  result = await f.controller.get()
  assert.equal(result.state.status, 'paused'); assert.equal(result.state.phase, 'break')
  assert.equal(result.records.length, 1)
  assert.equal(f.timers.size, 0)
})

test('active checkpoints persist without one-second wakeups or reads deferring the checkpoint', async t => {
  const f = await fixture(t)
  await f.controller.start({ focusMin: 25 })
  assert.equal([...f.timers.values()][0].due - f.now(), 30000)
  for (let i = 0; i < 3; i++) { f.advance(10000); f.service.getDeadlineTask(OWNER, 'pomodoro') }
  const stored = JSON.parse(f.db.prepare('SELECT value FROM deadline_tasks WHERE plugin_id=?').get(OWNER).value)
  assert.equal(stored.remainingMs, 24.5 * 60000)
  assert.equal(f.events.filter(event => event.type === 'change').length, 1, 'checkpoints do not stream renderer ticks')
  await f.reinitialize()
  assert.equal((await f.controller.get()).state.status, 'paused')
  assert.equal((await f.controller.get()).state.remainingMs, 24.5 * 60000)
})

test('opaque legacy data is owned by its plugin and interpreted once by pomodoro', async t => {
  const legacy = { version: 1, timers: { [OWNER]: { state: { status: 'running', phase: 'longBreak', cycle: 4,
    remainingMs: 120000, startedAt: 900000, options: { task: 'Legacy task' } },
    records: [{ id: 'old-1', phase: 'focus', task: 'Old record', startedAt: 1, endedAt: 2, durationMs: 25000, outcome: 'completed', counted: true }] },
    'other.plugin': { opaque: ['not a pomodoro payload'] } } }
  const f = await fixture(t, legacy)
  assert.equal(f.timers.size, 0)
  const ownRaw = await f.api.storage.get('_enest_migration.focus-timers-v1.0')
  assert.deepEqual(JSON.parse(ownRaw), legacy.timers[OWNER])
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM plugin_storage WHERE plugin_id=?').get('other.plugin').n, 2)
  let result = await f.controller.get()
  assert.equal(result.state.phase, 'longBreak'); assert.equal(result.state.status, 'paused')
  assert.equal(result.state.cycle, 4); assert.equal(result.state.remainingMs, 120000)
  assert.equal(result.records[0].task, 'Old record')
  result = await createPomodoroController(f.api).get()
  assert.equal(result.records.length, 1)
  f.service.clearPluginDeadlineTasks(OWNER)
  f.db.prepare('DELETE FROM plugin_storage WHERE plugin_id=?').run(OWNER)
  await f.reinitialize()
  assert.equal(await f.api.storage.get('_enest_migration.focus-timers-v1'), null, 'global migration marker prevents reinstall resurrecting removed data')
})

test('plugin journal edits/deletions persist without mutating generic receipts', async t => {
  const f = await fixture(t)
  await f.controller.start({ focusMin: 1, task: 'Original' }); f.advance(60000)
  let result = await f.controller.get(), id = result.records[0].id
  result = await f.controller.updateRecord(id, { task: 'Edited', durationMs: 30000, counted: false })
  assert.equal(result.records[0].task, 'Edited')
  assert.equal(f.service.getDeadlineTask(OWNER, 'pomodoro').receipts[0].data.options.task, 'Original')
  result = await createPomodoroController(f.api).get()
  assert.equal(result.records[0].durationMs, 30000); assert.equal(result.records[0].counted, false)
  await f.controller.updateRecord(id, { deleted: true })
  assert.equal((await createPomodoroController(f.api).get()).records.length, 0)
  assert.equal(f.service.getDeadlineTask(OWNER, 'pomodoro').receipts.length, 1)
})

test('failed journal writes retain the committed bank instead of acknowledging lost edits', async t => {
  const f = await fixture(t)
  await f.controller.start({ focusMin: 1, task: 'Original' }); f.advance(60000)
  const result = await f.controller.get(), id = result.records[0].id
  f.failStorage()
  await assert.rejects(f.controller.updateRecord(id, { task: 'Must not commit' }), /disk fixture failure/)
  assert.equal((await createPomodoroController(f.api).get()).records[0].task, 'Original')
})

test('generic tasks enforce ownership, bounded plans and disable/uninstall cleanup', async t => {
  const f = await fixture(t), plan = { id: 'generic', steps: [{ id: 'wait', durationMs: 60000 }] }
  f.service.startDeadlineTask('owner.a', plan)
  assert.equal(f.service.getDeadlineTask('owner.b', 'generic').task, null)
  f.service.cancelDeadlineTask('owner.b', 'generic')
  assert.equal(f.service.getDeadlineTask('owner.a', 'generic').task.status, 'running')
  assert.throws(() => f.service.startDeadlineTask('owner.a', { ...plan, id: 'invalid', steps: [{ id: 'wait', durationMs: 1 }] }), /numeric/)
  assert.throws(() => f.service.startDeadlineTask('owner.a', { ...plan, id: 'invalid', data: 'x'.repeat(2049) }), /quota/)
  for (let i = 0; i < 3; i++) f.service.startDeadlineTask('owner.a', { ...plan, id: `more-${i}` })
  assert.throws(() => f.service.startDeadlineTask('owner.a', { ...plan, id: 'fifth' }), /quota/)
  f.disable(); f.advance(30000)
  assert.equal(f.timers.size, 0)
  assert.equal(f.service.getDeadlineTask('owner.a', 'generic').task.status, 'idle')
  f.service.clearPluginDeadlineTasks('owner.a')
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM deadline_tasks').get().n, 0)
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM deadline_receipts').get().n, 0)
})

test('shell timer sources contain no pomodoro phase, defaults, history edits, or interval scheduler', () => {
  const service = read('src/main/timer/deadlineTaskService.ts')
  assert.doesNotMatch(service, /focusMin|breakMin|longBreak|counted|updateRecord|setInterval|FocusTimer/)
  assert.doesNotMatch(read('src/shared/types/deadline-task.ts'), /FocusTimer|focusMin|breakMin|longBreak|counted/)
  assert.doesNotMatch(read('eNest_plugin/plugins/pomodoro/src/jsx/App.jsx'), /api\??\.focusTimer/)
  const manifest = JSON.parse(read('eNest_plugin/plugins/pomodoro/plugin.json'))
  assert.equal(manifest.backend, undefined)
  assert.ok(!manifest.permissions.includes('backend.node'))
})
