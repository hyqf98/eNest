import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../../', import.meta.url)
const SOURCE = 'focus-timers-v1'
const OWNER = 'fixture.generic-timer'
const plan = { id: 'reminder', steps: [{ id: 'wait', durationMs: 60000 }], paused: true }

function load(path, imports) {
  const code = ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(imports, name)) return imports[name]
    if (name.startsWith('node:')) return require(name)
    throw new Error(`Unexpected dependency: ${name}`)
  }, module, module.exports)
  return module.exports
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'enest-deadline-migration-'))
  const path = join(directory, `${SOURCE}.json`), warnings = []
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const kvStore = {
    getDatabase: () => db,
    kvGet: key => db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value,
    kvSet: (key, value) => db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES (?,?)').run(key, value)
  }
  const storage = { kvStore, runInTransaction(database, run) {
    database.exec('BEGIN')
    try { const value = run(); database.exec('COMMIT'); return value }
    catch (error) { database.exec('ROLLBACK'); throw error }
  } }
  const migration = load('src/main/timer/legacyTimerMigration.ts', {
    '@main/db/sqliteService': storage,
    '@main/paths/pathsService': { getAppPaths: () => ({ data: directory }) }
  })
  const service = load('src/main/timer/deadlineTaskService.ts', {
    '@main/db/sqliteService': storage,
    '@main/logs/logService': { logWarn: (source, message) => warnings.push({ source, message }) },
    './legacyTimerMigration': migration
  })
  t.after(async () => {
    service.shutdownDeadlineTasksSync()
    db.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { service, kvStore, db, path, warnings }
}

test('malformed legacy data does not disable new generic deadlines or expose its contents in logs', async t => {
  const f = await fixture(t), original = 'not-json private legacy content'
  await writeFile(f.path, original)
  await f.service.initDeadlineTasks(() => {})
  assert.equal(f.service.startDeadlineTask(OWNER, plan).task.status, 'paused')
  assert.equal(f.service.getDeadlineTask(OWNER, plan.id).task.id, plan.id)
  assert.equal(await readFile(f.path, 'utf8'), original)
  assert.equal(f.kvStore.kvGet(`migration:${SOURCE}`), undefined)
  assert.equal(f.warnings.length, 1)
  assert.equal(f.warnings[0].source, 'timer')
  assert.match(f.warnings[0].message, /deferred; original retained for retry/)
  assert.match(f.warnings[0].message, /invalid legacy JSON/)
  assert.equal(f.warnings[0].message.includes('private legacy content'), false)
})

test('failed legacy ownership transactions remain unmarked and retry on the next initialization', async t => {
  const f = await fixture(t), payload = { state: { custom: true }, records: [] }
  const original = JSON.stringify({ version: 1, timers: { 'fixture.legacy': payload, 'invalid\0owner': payload } })
  await writeFile(f.path, original)
  await f.service.initDeadlineTasks(() => {})
  f.service.startDeadlineTask(OWNER, plan)
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM plugin_storage').get().count, 0)
  assert.equal(f.kvStore.kvGet(`migration:${SOURCE}`), undefined)
  assert.equal(await readFile(f.path, 'utf8'), original)
  assert.match(f.warnings[0].message, /Invalid legacy payload owner/)

  const repaired = JSON.stringify({ version: 1, timers: { 'fixture.legacy': payload } })
  await writeFile(f.path, repaired)
  await f.service.initDeadlineTasks(() => {})
  assert.ok(f.kvStore.kvGet(`migration:${SOURCE}`))
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM plugin_storage WHERE plugin_id=?').get('fixture.legacy').count, 2)
  assert.equal(f.service.getDeadlineTask(OWNER, plan.id).task.status, 'paused')
  assert.equal(await readFile(f.path, 'utf8'), repaired)
  assert.equal(f.warnings.length, 1)
})

test('generic storage initialization failures still reject instead of being hidden as migration errors', async t => {
  const f = await fixture(t)
  f.kvStore.getDatabase = () => null
  await assert.rejects(f.service.initDeadlineTasks(() => {}), /Deadline storage unavailable/)
  assert.throws(() => f.service.getDeadlineTask(OWNER, plan.id), /not ready/)
  assert.equal(f.warnings.length, 0)
})
