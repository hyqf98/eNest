import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const js = ts.transpileModule(readFileSync(new URL('./dshUpgradeService.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function fixture(t, previous = 'stable') {
  const root = mkdtempSync(join(tmpdir(), 'enest-dsh-health-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let active = previous
  const fetches = [], events = []
  const mocks = {
    electron: { net: { fetch: async url => { fetches.push(url); return { ok: true, json: async () => url.includes('registry.npmjs') ? {} : [] } } } },
    '@main/plugin/PluginHost': { pluginHost: { sendEvent: (_id, event) => events.push(event) } },
    '@main/logs/logService': { logWarn() {} },
    '@main/dsh/dshRuntimeStore': {
      dshDataDirs: () => ({ runtimeDir: root, dshHome: join(root, 'home') }),
      runtimeBinAt: directory => existsSync(join(directory, 'bin.js')) ? join(directory, 'bin.js') : null,
      getActiveMarker: () => active,
      setActiveMarker: version => { active = version },
      clearActiveMarker: () => { active = null }
    },
    '@main/dsh/dshProfileService': {},
    '@main/dsh/dshRuntimeService': {}
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return { api: module.exports, active: () => active, fetches, events,
    runtime(version, script) { mkdirSync(join(root, version)); writeFileSync(join(root, version, 'bin.js'), script) }
  }
}

test('DSH activation executes the selected runtime --version and rejects a broken entrypoint', async t => {
  const f = fixture(t)
  f.runtime('good', "if (process.argv[2] !== '--version') process.exit(2); console.log('fixture version')")
  await f.api.activateRuntimeVersion('fixture', 'good')
  assert.equal(f.active(), 'good')
  f.runtime('broken', "throw new Error('synthetic broken runtime')")
  await assert.rejects(f.api.activateRuntimeVersion('fixture', 'broken'), /健康检查失败/)
  assert.equal(f.active(), 'good')
})

test('DSH failed activation restores the absence of an active marker', async t => {
  const f = fixture(t, null)
  f.runtime('broken', 'process.exit(1)')
  await assert.rejects(f.api.activateRuntimeVersion('fixture', 'broken'), /健康检查失败/)
  assert.equal(f.active(), null)
})

test('DSH release discovery uses Electron session networking for both remote sources', async t => {
  const f = fixture(t)
  assert.deepEqual(await f.api.listRemoteVersions('fixture'), [])
  assert.equal(f.fetches.length, 2)
  assert.ok(f.fetches.some(url => url.includes('api.github.com')))
  assert.ok(f.fetches.some(url => url.includes('registry.npmjs.org')))
})
