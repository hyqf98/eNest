import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const js = ts.transpileModule(readFileSync(new URL('./hardwareAcceleration.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'enest-gpu-preference-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let disabled = false
  const mocks = {
    electron: { app: { disableHardwareAcceleration() { disabled = true } } },
    '@main/paths/pathsService': {
      defaultDataRoot: () => root,
      getDefaultSettingsPath: () => join(root, 'settings.json'),
      getAppPaths: dataRoot => ({ database: join(dataRoot, 'data', 'enest.db') })
    }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return {
    root, api: module.exports, disabled: () => disabled,
    anchor: value => writeFileSync(join(root, 'settings.json'), JSON.stringify(value)),
    database(dataRoot, value) {
      mkdirSync(join(dataRoot, 'data'), { recursive: true })
      const db = new DatabaseSync(join(dataRoot, 'data', 'enest.db'))
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.prepare('INSERT INTO settings VALUES (?, ?)').run('app', JSON.stringify(value))
      db.close()
    }
  }
}

test('GPU preference reads SQLite before ready even when no anchor exists, without creating a database', t => {
  const f = fixture(t)
  assert.equal(f.api.readHardwareAccelPreferenceSync(), true)
  assert.equal(existsSync(join(f.root, 'data', 'enest.db')), false)
  f.database(f.root, { general: { hardwareAcceleration: false } })
  assert.equal(f.api.applyHardwareAccelerationBeforeReady(), false)
  assert.equal(f.disabled(), true)
})

test('GPU preference follows dataRoot anchor and gives persisted SQLite settings priority', t => {
  const f = fixture(t), custom = join(f.root, 'custom')
  f.database(f.root, { general: { hardwareAcceleration: true } })
  f.database(custom, { general: { hardwareAcceleration: false } })
  f.anchor({ general: { dataRoot: custom, hardwareAcceleration: true } })
  assert.equal(f.api.readHardwareAccelPreferenceSync(), false)
})

test('GPU preference supports legacy files and unavailable/corrupt SQLite fallback', t => {
  const f = fixture(t)
  f.anchor({ general: { hardwareAcceleration: false } })
  assert.equal(f.api.readHardwareAccelPreferenceSync(), false)
  mkdirSync(join(f.root, 'data'))
  writeFileSync(join(f.root, 'data', 'enest.db'), 'not a database')
  assert.equal(f.api.readHardwareAccelPreferenceSync(), false)
  writeFileSync(join(f.root, 'settings.json'), '{broken')
  assert.equal(f.api.readHardwareAccelPreferenceSync(), true)
})
