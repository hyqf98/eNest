import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('./modalSurface.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const channels = { ModalOpen: 'modal:open', ModalReady: 'modal:ready', ModalRespond: 'modal:respond', ModalState: 'modal:state' }
const confirmation = { kind: 'confirm', options: { title: 'Confirm', message: 'Continue?', confirmLabel: 'Continue' } }
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  let nextId = 0
  const state = {
    windows: [], views: [], handlers: new Map(), listeners: new Map(), trusted: new Map(), timers: new Map(),
    appearance: { revision: 1 }, update: { status: 'idle' }, focused: null, sink: null, released: 0, raised: 0,
    downloads: 0, checks: 0, installs: 0, external: [], saveCalls: [], saveResult: { timedOut: false }, loadError: null
  }
  class Contents extends EventEmitter {
    constructor() { super(); this.id = ++nextId; this.destroyed = false; this.messages = []; this.focusCount = 0 }
    isDestroyed() { return this.destroyed }
    loadURL(url) { this.url = url; return state.loadError ? Promise.reject(state.loadError) : Promise.resolve() }
    send(channel, value) { this.messages.push({ channel, value: structuredClone(value) }) }
    focus() { this.focusCount += 1; state.focused = this }
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class View {
    constructor() { this.children = []; this.visible = true }
    getVisible() { return this.visible }
    setVisible(value) { this.visible = value }
    addChildView(view) { this.children.push(view) }
    removeChildView(view) { this.children = this.children.filter(child => child !== view) }
  }
  class ContentsView extends View {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); state.views.push(this) }
    setBounds(bounds) { this.bounds = bounds }
    setBackgroundColor(color) { this.backgroundColor = color }
  }
  class Window extends EventEmitter {
    static getAllWindows() { return state.windows }
    constructor() { super(); this.id = ++nextId; this.contentView = new View(); this.destroyed = false; this.visible = true; state.windows.push(this) }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    getContentBounds() { return { x: 15, y: 25, width: 1024, height: 768 } }
  }
  const win = new Window()
  const ownerView = new ContentsView()
  win.contentView.addChildView(ownerView)
  const owner = ownerView.webContents
  state.focused = owner
  const mocks = {
    electron: {
      app: { getAppPath: () => '/application' }, BaseWindow: Window, WebContentsView: ContentsView,
      webContents: { getFocusedWebContents: () => state.focused }, shell: { openExternal: async url => { state.external.push(url) } }
    },
    '@shared/constants': { SHELL_PARTITION: 'persist:test-shell' },
    '@shared/types/ipc': { IpcChannels: channels },
    '@main/ipc/ipcSecurity': {
      handleShellIpc: (channel, handler) => state.handlers.set(channel, handler),
      onShellIpc: (channel, handler) => state.listeners.set(channel, handler),
      registerTrustedSurface: (wc, role, target) => state.trusted.set(wc.id, { role, target }),
      revokeTrustedSurface: wc => state.trusted.delete(wc.id)
    },
    '@main/theme/appearanceService': { getAppearance: () => state.appearance },
    '@main/settings/SettingsStore': { settingsStore: { getAll: () => ({ general: { locale: 'en-US' } }) } },
    '@main/plugin/PluginHost': { pluginHost: {
      getDirtySnapshot: () => [{ pluginId: 'com.github.eNest.test', name: 'Test', dirty: true }],
      requestSaveAll: async reason => { state.saveCalls.push(reason); return state.saveResult }
    } },
    '@main/update/updateService': {
      getUpdateState: () => state.update,
      downloadUpdate: async () => { state.downloads += 1 },
      checkForUpdates: async () => { state.checks += 1 },
      quitAndInstallUpdate: async () => { state.installs += 1; return { status: 'idle' } }
    },
    './createShellWindow': { resolvePreload: file => `/preload/${file}`, setModalEventSink: sink => { state.sink = sink } },
    './transientViews': {
      registerTransientView: (_win, view, priority) => { view.priority = priority; return () => { state.released += 1 } },
      raiseTransientViews: () => { state.raised += 1 }
    }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', source)(
    name => mocks[name] ?? require(name), module, module.exports,
    (callback, delay) => { const id = ++nextId; state.timers.set(id, { callback, delay }); return id },
    id => state.timers.delete(id)
  )
  module.exports.registerModalSurfaceHandlers()
  const ready = view => state.listeners.get(channels.ModalReady)({ sender: view.webContents })
  const respond = (view, id, action) => state.listeners.get(channels.ModalRespond)({ sender: view.webContents }, id, action)
  return { ...module.exports, state, win, ownerView, owner, View, Window, Contents, ContentsView, ready, respond, latest: () => state.views.at(-1) }
}

test('native modal rejects unattached owners and validates confirmation payloads before creating a view', async () => {
  const api = fixture()
  assert.equal(await api.openNativeModal(new api.Contents(), confirmation), false)
  const count = api.state.views.length
  for (const options of [null, [], { ...confirmation.options, danger: 'true' }, { ...confirmation.options, title: '' }, { ...confirmation.options, message: 'bad\u0000text' }, { ...confirmation.options, unsafe: true }]) {
    assert.throws(() => api.openNativeModal(api.owner, { kind: 'confirm', options }), /Invalid confirmation/)
  }
  assert.equal(api.state.views.length, count)
  assert.throws(() => api.state.handlers.get(channels.ModalOpen)({ sender: api.owner }, { kind: 'unknown' }), /Invalid modal request/)
  assert.equal(api.state.timers.size, 0)
})

test('native modal stays hidden until its own ready handshake and accepts only its own current response', async () => {
  const api = fixture()
  const result = api.openNativeModal(api.owner, confirmation)
  const view = api.latest()
  assert.deepEqual(view.options.webPreferences, { preload: '/preload/modalPreload.cjs', sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:test-shell' })
  assert.equal(view.priority, 300)
  assert.equal(view.visible, false)
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1024, height: 768 })
  assert.equal(view.webContents.focusCount, 0)
  assert.equal(api.state.trusted.get(view.webContents.id).role, 'modal')
  assert.match(view.webContents.url, /modal-overlay\.html$/)
  assert.equal(await api.openNativeModal(api.owner, confirmation), false)
  api.state.listeners.get(channels.ModalReady)({ sender: api.owner })
  assert.equal(view.visible, false)
  api.ready(view)
  assert.equal(view.visible, true)
  assert.equal(api.state.timers.size, 0)
  assert.equal(view.webContents.focusCount, 1)
  const first = view.webContents.messages.at(-1).value
  assert.equal(first.locale, 'en-US')
  assert.equal(first.kind, 'confirm')
  assert.equal(first.options.danger, false)
  api.ready(view)
  assert.equal(view.webContents.focusCount, 1)
  api.state.appearance = { revision: 2 }
  api.state.sink({ type: 'appearance-changed' })
  assert.equal(view.webContents.messages.at(-1).value.appearance.revision, 2)
  api.state.listeners.get(channels.ModalRespond)({ sender: api.owner }, first.id, 'confirm')
  api.respond(view, first.id + 1, 'confirm')
  api.respond(view, first.id, 'unknown')
  assert.equal(view.webContents.isDestroyed(), false)
  api.respond(view, first.id, 'confirm')
  assert.equal(await result, true)
  assert.equal(view.webContents.isDestroyed(), true)
  assert.equal(api.win.contentView.children.includes(view), false)
  assert.equal(api.state.trusted.size, 0)
  assert.equal(api.state.released, 1)
  assert.equal(api.owner.focusCount, 1)
  assert.equal(api.owner.listenerCount('destroyed'), 0)
  assert.equal(api.win.listenerCount('resize'), 0)
  assert.equal(api.win.listenerCount('closed'), 0)
})

test('load failure, deadline, owner/window teardown and renderer crash cancel native modals exactly once', async () => {
  for (const reason of ['load', 'deadline', 'owner', 'window', 'crash']) {
    const api = fixture()
    if (reason === 'load') api.state.loadError = new Error('load failed')
    const result = api.openNativeModal(api.owner, confirmation)
    const view = api.latest()
    if (reason === 'deadline') {
      const timer = [...api.state.timers.values()][0]
      assert.equal(timer.delay, 8000)
      timer.callback()
    } else if (reason === 'owner') api.owner.close()
    else if (reason === 'window') { api.win.destroyed = true; api.win.emit('closed') }
    else if (reason === 'crash') view.webContents.emit('render-process-gone')
    assert.equal(await result, false, reason)
    assert.equal(api.state.released, 1, reason)
    assert.equal(api.state.timers.size, 0, reason)
    assert.equal(api.state.trusted.size, 0, reason)
    assert.equal(view.webContents.isDestroyed(), true, reason)
    api.respond(view, 1, 'confirm')
    assert.equal(api.state.released, 1, reason)
  }
})

test('focus restoration skips a hidden previous native surface and never focuses a hidden owner', async () => {
  for (const ownerVisible of [true, false]) {
    const api = fixture()
    const parent = new api.View()
    const previous = new api.ContentsView()
    parent.addChildView(previous)
    api.win.contentView.addChildView(parent)
    api.state.focused = previous.webContents
    const result = api.openNativeModal(api.owner, confirmation)
    const view = api.latest()
    api.ready(view)
    parent.setVisible(false)
    api.ownerView.setVisible(ownerVisible)
    api.respond(view, view.webContents.messages.at(-1).value.id, 'cancel')
    assert.equal(await result, false)
    assert.equal(previous.webContents.focusCount, 0)
    assert.equal(api.owner.focusCount, ownerVisible ? 1 : 0)
  }
})

test('update install awaits plugin saves, prevents duplicate actions and ignores a retired modal', async () => {
  const api = fixture()
  api.state.update = { status: 'downloaded' }
  let saved
  api.state.saveResult = new Promise(resolve => { saved = resolve })
  const result = api.openNativeModal(api.owner, { kind: 'update' })
  const view = api.latest()
  api.ready(view)
  const id = view.webContents.messages.at(-1).value.id
  api.respond(view, id, 'install')
  api.respond(view, id, 'install')
  assert.equal(view.webContents.messages.at(-1).value.saving, true)
  assert.deepEqual(api.state.saveCalls, ['update'])
  assert.equal(api.state.installs, 0)
  api.owner.close()
  assert.equal(await result, false)
  saved({ timedOut: false })
  await flush()
  assert.equal(api.state.installs, 0)
  assert.equal(api.state.trusted.size, 0)
})

test('update save failures stay in the same native modal and status gates update actions', async () => {
  const api = fixture()
  api.state.update = { status: 'downloaded' }
  api.state.saveResult = { timedOut: true }
  const result = api.openNativeModal(api.owner, { kind: 'update' })
  const view = api.latest()
  api.ready(view)
  const id = view.webContents.messages.at(-1).value.id
  api.respond(view, id, 'install')
  await flush()
  const failed = view.webContents.messages.at(-1).value
  assert.equal(failed.saving, false)
  assert.match(failed.error, /未完成保存/)
  assert.equal(api.state.installs, 0)
  api.respond(view, id, 'download')
  await flush()
  assert.equal(api.state.downloads, 0)
  api.state.update = { status: 'available' }
  api.respond(view, id, 'download')
  await flush()
  assert.equal(api.state.downloads, 1)
  api.state.update = { status: 'error' }
  api.respond(view, id, 'retry')
  await flush()
  assert.equal(api.state.checks, 1)
  api.respond(view, id, 'release')
  await flush()
  assert.deepEqual(api.state.external, ['https://github.com/hyqf98/eNest/releases'])
  api.respond(view, id, 'cancel')
  assert.equal(await result, false)
})
