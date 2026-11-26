import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../../../src/main/launcher/fileSearchService.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)
const current = () => true
const query = { operation: 'query', query: 'report', scope: 'mixed' }

function fixture() {
  const base = resolve('virtual-file-search-fixture'), app = resolve(base, 'apps', 'report.app')
  const first = resolve(base, 'work', 'report.txt'), second = resolve(base, 'archive', 'report.txt')
  const state = { opened: [], queried: [], clears: 0, preferences: undefined, gate: undefined, generation: 0, inode: 1 }
  const adapters = {
    electron: { dialog: {}, shell: { openPath: async path => { state.opened.push(path); return '' }, showItemInFolder: path => state.opened.push(path) } },
    '@main/plugin/pluginInteractionPolicy': { trackNativeInteraction: promise => promise },
    '@main/settings/SettingsStore': { settingsStore: { getFileSearchSettings: () => state.preferences, commitFileSearch: prefs => { state.preferences = prefs } } },
    '@main/paths/pathsService': { getAppPathsGeneration: () => state.generation },
    './appScanner': { getCachedApps: () => ({ apps: [{ path: app }] }) },
    './fileNameProviders': {
      pathKey: path => path, localPath: isAbsolute, within: (root, path) => !relative(root, path).startsWith('..'),
      clearFileNameCache: () => state.clears++, acceptedRoot: async path => path,
      searchFileNames: async (_query, _prefs, signal) => { state.queried.push(signal); await state.gate; return { provider: 'fixture', paths: [app, first, first, second] } },
    },
    'node:fs/promises': { realpath: async path => path, lstat: async () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, ino: state.inode, dev: 1, birthtimeMs: 1, mode: 0o644 }) },
  }
  const api = {}
  Function('exports', 'require', code)(api, id => Object.hasOwn(adapters, id) ? adapters[id] : require(id))
  return { ...api, state, first, second }
}

test('disabled by default; switching off cancels a pending query even when switched on immediately', async () => {
  const { configureFileSearch, handleFileSearch, state } = fixture()
  assert.deepEqual(await handleFileSearch(8, query, current), { status: 'off' })
  assert.equal(state.queried.length, 0)
  await configureFileSearch({ operation: 'enable', value: true }, current)
  let release
  state.gate = new Promise(resolve => { release = resolve })
  const pending = handleFileSearch(8, query, current)
  await configureFileSearch({ operation: 'enable', value: false }, current)
  await configureFileSearch({ operation: 'enable', value: true }, current)
  assert.equal(state.queried[0].aborted, true)
  release(); assert.deepEqual(await pending, { status: 'stale' })
})

test('mixed search removes the same app target, preserves same names, and binds open to the current file identity', async () => {
  const { configureFileSearch, handleFileSearch, state, first, second, cancelFileSearch } = fixture()
  await configureFileSearch({ operation: 'enable', value: true }, current)
  const { items } = await handleFileSearch(8, query, current)
  assert.deepEqual(items.map(item => item.name), ['report.txt', 'report.txt'])
  assert.notEqual(items[0].parent, items[1].parent)
  const reveal = id => ({ operation: 'reveal', id })
  assert.equal((await handleFileSearch(8, reveal(first), current)).status, 'stale')
  assert.equal((await handleFileSearch(9, reveal(items[0].id), current)).status, 'stale')
  assert.equal((await handleFileSearch(8, reveal(items[1].id), current)).status, 'ready')
  assert.deepEqual(state.opened, [second])
  state.inode++
  assert.equal((await handleFileSearch(8, reveal(items[0].id), current)).status, 'stale')
  const replacement = await handleFileSearch(8, { ...query, scope: 'files' }, current)
  assert.equal(replacement.items.length, 3)
  assert.equal((await handleFileSearch(8, reveal(items[1].id), current)).status, 'stale')
  cancelFileSearch(8)
  assert.equal((await handleFileSearch(8, reveal(replacement.items[1].id), current)).status, 'stale')
})
