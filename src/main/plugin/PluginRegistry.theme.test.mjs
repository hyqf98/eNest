import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url), pluginId = 'com.test.theme'
function fixture() {
  const rows = new Map(), packs = new Map(), events = []
  const control = { block: null }
  const mocks = {
    electron: { app: {} },
    '@shared/types/plugin': {}, '@shared/constants': {}, '@main/paths/pathsService': {},
    '@main/plugin/PluginInstaller': {}, '@main/plugin/marketClient': {},
    '@main/plugin/pluginEnabledStore': {}, '@main/plugin/PermissionService': { permissionService: { cancelFor() {} } },
    '@main/contrib/ContributionRegistry': { contributionRegistry: {
      listSlot: () => [...rows.values()],
      registerManifestContributes(id, contributes) {
        this.unregisterBySource(id)
        for (const pack of contributes?.themePacks ?? []) rows.set(id + ':' + pack.id, { id: pack.id, source: id, data: pack })
      },
      unregisterBySource(id) { for (const [key, row] of rows) if (row.source === id) rows.delete(key) }
    } },
    '@main/theme/themePacks': { themePackRegistry: {
      get: id => packs.get(id),
      async registerPlugin(pack, source) { packs.set(pack.id, { ...pack, source }); if (control.block) { const pending = control.block; control.block = null; await pending } },
      async remove(id) { return packs.delete(id) },
      async removeBySource(id) { const removed = []; for (const [key, pack] of packs) if (pack.source === id) { packs.delete(key); removed.push(key) }; return removed }
    } },
    '@main/window/createShellWindow': { sendShellEvent: event => events.push(event) },
    '@main/logs/logService': { logWarn() {}, logInfo() {} }, './pluginInstallTasks': {},
    '@main/plugin/marketMetadata': {},
    './catalogResources': {}
  }
  const js = ts.transpileModule(readFileSync(new URL('./PluginRegistry.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  const registry = new module.exports.PluginRegistry()
  const manifest = ids => ({ id: pluginId, contributes: { themePacks: ids.map(id => ({ id, name: id, tokens: { '--accent': '#fff' } })) } })
  return { registry, control, packs, events, sync: (ids, enabled = true) => registry.syncContributes(manifest(ids), enabled), settle: () => registry.themeTasks.get(pluginId) }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('disable drains pending theme registration before removing every source pack', async () => {
  const f = fixture(); let release
  f.control.block = new Promise(resolve => { release = resolve })
  f.sync(['first', 'second']); await flush()
  assert.equal(f.packs.has('first'), true)
  f.sync([], false)
  release(); await f.settle()
  assert.deepEqual([...f.packs.keys()], [])
  assert.equal(f.events.length, 1)
})

test('manifest updates retire removed declared packs and retain runtime-only packs', async () => {
  const f = fixture()
  f.sync(['old', 'retained']); await f.settle()
  f.packs.set('runtime-only', { id: 'runtime-only', source: pluginId })
  f.sync(['new', 'retained']); await f.settle()
  assert.deepEqual([...f.packs.keys()].sort(), ['new', 'retained', 'runtime-only'])
})

test('rapid superseding theme manifests do not strand an earlier partially registered pack', async () => {
  const f = fixture(); let release
  f.control.block = new Promise(resolve => { release = resolve })
  f.sync(['first', 'second']); await flush()
  f.sync(['intermediate'])
  f.sync(['latest'])
  release(); await f.settle()
  assert.deepEqual([...f.packs.keys()], ['latest'])
  assert.equal(f.events.length, 1)
})
