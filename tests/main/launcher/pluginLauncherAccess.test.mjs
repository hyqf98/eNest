import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../../../src/main/launcher/pluginLauncherAccess.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })

function fixture() {
  const state = { gesture: false, granted: true, interactive: true, epoch: 0, root: 1, confirm: async () => ({ response: 1 }), raised: [] }
  const scopes = new Map(), saved = new Map(), parent = { isDestroyed: () => false }
  function runtime(owner) {
    if (!scopes.has(owner)) scopes.set(owner, { scope: { isCurrent: () => true, isClosing: false, signal: new AbortController().signal }, documentEpoch: 1 })
    return scopes.get(owner)
  }
  const adapters = {
    electron: { dialog: { showMessageBox: (...args) => state.confirm(...args) } },
    '@main/db/sqliteService': { kvGet: key => saved.get(key), kvSet: (key, value) => saved.set(key, value) },
    '@main/paths/pathsService': { getAppPathsGeneration: () => state.root },
    '@main/plugin/PluginHost': { pluginHost: {
      getMcpRuntime: runtime, getContainerWindow: () => parent, isPluginVisible: () => true, acquireWindowInteraction: () => () => {},
      consumeLauncherInput() { const value = state.gesture; state.gesture = false; return value },
      showExistingWorkspace(owner) { state.raised.push(owner); return true },
    } },
    '@main/plugin/PermissionService': { permissionService: { isGranted: () => state.granted } },
    '@main/plugin/PluginRegistry': { pluginRegistry: { get: () => ({ name: 'Fixture' }) } },
    '@main/plugin/pluginInteractionPolicy': { getInteractionEpoch: () => state.epoch, hasNativeInteraction: () => false,
      isNonInteractive: () => !state.interactive, onDocumentRetired: () => () => {}, trackNativeInteraction: promise => promise },
    '@main/settings/SettingsStore': { settingsStore: { getLocale: () => 'en-US' } },
    './appScanner': {}, './appLauncher': {}, './catalogIcons': {}, './pluginLauncher': {},
  }
  const api = {}
  Function('exports', 'require', outputText)(api, id => Object.hasOwn(adapters, id) ? adapters[id] : require(id))
  const prepare = (method, owner = 'owner') => api.prepareLauncherCall(owner, `launcher.${method}`)
  return { state, saved, runtime, prepare }
}

test('a session can raise only its own workspace; it cannot pick more targets or cross document, root or permission boundaries', async () => {
  const { state, prepare, runtime } = fixture()
  assert.throws(() => prepare('authorizeSession'))
  state.gesture = true
  assert.equal(await prepare('authorizeSession')([]), true)
  assert.equal(await prepare('showWorkspace')([]), true)
  assert.deepEqual(state.raised, ['owner'])
  assert.throws(() => prepare('showWorkspace', 'other'))
  assert.throws(() => prepare('pickTarget'))
  state.granted = false
  assert.throws(() => prepare('showQuick'))
  state.granted = true; state.interactive = false
  assert.throws(() => prepare('showQuick'))
  state.interactive = true; state.root++
  assert.throws(() => prepare('showQuick'))
  state.root--; runtime('owner').documentEpoch++
  assert.throws(() => prepare('showQuick'))
})

test('ending a session while native consent is open cannot reauthorize it on the late response', async () => {
  const { state, prepare } = fixture()
  let confirm
  state.confirm = () => new Promise(resolve => { confirm = resolve })
  state.gesture = true
  const pending = prepare('authorizeSession')([])
  await prepare('endSession')([])
  confirm({ response: 1 })
  assert.equal(await pending, false)
  assert.throws(() => prepare('showWorkspace'))
  assert.deepEqual(state.raised, [])
})

test('a target belonging to another plugin cannot be launched or forgotten by its opaque ID', async () => {
  const { state, saved, prepare } = fixture()
  const otherPins = JSON.stringify([{ id: 'chosen-in-other-workspace', kind: 'app', key: '/fixture/Example.app' }])
  saved.set('launcher.pinned:other', otherPins)
  state.gesture = true
  assert.equal(await prepare('activateTarget')(['chosen-in-other-workspace']), false)
  state.gesture = true
  await prepare('forgetTarget')(['chosen-in-other-workspace'])
  assert.equal(saved.get('launcher.pinned:other'), otherPins)
})
