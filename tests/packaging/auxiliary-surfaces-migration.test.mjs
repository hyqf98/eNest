import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const compiled = new Map()
function load(path, imports = {}) {
  if (!compiled.has(path)) compiled.set(path, ts.transpileModule(readFileSync(new URL(path, root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.get(path))(name => {
    if (Object.hasOwn(imports, name)) return imports[name]
    if (name.startsWith('node:')) return require(name)
    throw new Error(`Unexpected dependency ${name}`)
  }, module, module.exports)
  return module.exports
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const OWNER = 'com.fixture.screen'
const channels = { AuxiliaryContext: 'auxiliary:context', AuxiliaryPost: 'auxiliary:post', AuxiliaryClose: 'auxiliary:close', AuxiliaryMessage: 'auxiliary:message', PluginEvent: 'plugin:event' }

function fixture(t) {
  const scopes = load('src/main/plugin/PluginRuntimeScope.ts')
  const scope = scopes.createRuntimeScope({ pluginId: OWNER, generation: 1, wcId: 1 })
  const handlers = new Map(), windows = [], sessions = [], events = []
  const owner = { id: 1, isDestroyed: () => false, send: (channel, data) => events.push({ channel, data }) }
  let revision = 'v1', visible = true, permission = true, file = async () => '/fixture/asset.html'
  let source = async () => ({ id: 'display:9', display_id: '9' })
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false; this.focused = false; this.destroyed = false; this.messages = []
      this.webContents = Object.assign(new EventEmitter(), { id: windows.length + 10, mainFrame: { url: '' },
        send: (channel, data) => this.messages.push({ channel, data }), isDestroyed: () => this.destroyed,
        setWindowOpenHandler: handler => { this.openHandler = handler }, setWebRTCIPHandlingPolicy() {} })
      windows.push(this)
    }
    async loadURL(url) { this.webContents.mainFrame.url = url }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    show() { this.visible = true }
    hide() { this.visible = false }
    focus() { this.focused = true }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
  }
  function partition(name) {
    const value = Object.assign(new EventEmitter(), {
      name,
      protocol: { unhandle() {} },
      webRequest: { onBeforeRequest: fn => { value.beforeRequest = fn }, onHeadersReceived: fn => { value.headersReceived = fn } },
      setPermissionRequestHandler: fn => { value.permissionRequest = fn }, setPermissionCheckHandler: fn => { value.permissionCheck = fn },
      setDevicePermissionHandler: fn => { value.devicePermission = fn }, setDisplayMediaRequestHandler: fn => { value.displayMedia = fn },
      clearStorageData: async () => {}, clearCache: async () => {}, closeAllConnections: async () => {}
    })
    sessions.push(value); return value
  }
  const api = load('src/main/window/pluginAuxiliaryWindows.ts', {
    electron: { BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, session: { fromPartition: partition }, webContents: { fromId: id => id === 1 ? owner : null } },
    '@shared/types/ipc': { IpcChannels: channels }, '@main/plugin/PluginRuntimeScope': scopes,
    '@main/plugin/PluginRegistry': { pluginRegistry: { get: () => ({ devSource: true }), getRootPath: () => '/fixture', getBuildRevision: () => revision, getManifest: () => ({ permissions: ['screen.record', 'pin.create'] }) } },
    '@main/plugin/PluginHost': { pluginHost: { isPluginVisible: () => visible, sendEvent() { throw new Error('Closing owner must use captured wcId') } } },
    '@main/plugin/pluginPaths': { resolvePluginFile: (...args) => file(...args) },
    '@main/plugin/pluginProtocol': { registerPluginProtocolForSession() {} },
    '@main/plugin/PermissionService': { permissionService: { isGranted: () => permission } },
    '@main/screen/screenService': { resolveCaptureDisplay: () => ({ id: 9, bounds: { x: -800, y: 0, width: 800, height: 600 }, workArea: { x: -800, y: 0, width: 800, height: 580 }, scaleFactor: 2 }), captureDisplaySource: (...args) => source(...args) },
    '@main/window/createShellWindow': { resolvePreload: name => `/fixture/${name}` }
  })
  api.registerAuxiliaryHandlers()
  t.after(async () => { api.disposeAuxiliaryWindows(); await scope.dispose() })
  const invoke = (name, data, frame) => handlers.get(channels[name])({ sender: windows.at(-1).webContents, senderFrame: frame ?? windows.at(-1).webContents.mainFrame }, data)
  return { api, scope, handlers, windows, sessions, events, invoke, setRevision: value => { revision = value }, setVisible: value => { visible = value }, setPermission: value => { permission = value }, setFile: value => { file = value }, setSource: value => { source = value } }
}

test('auxiliary payload bounds reject cycles, custom objects, deep structure and oversized binaries', t => {
  const { api } = fixture(t)
  assert.equal(api.auxiliaryPayloadBytes({ bytes: new ArrayBuffer(8) }, 100), 13)
  const cycle = {}; cycle.cycle = cycle
  assert.throws(() => api.auxiliaryPayloadBytes(cycle, 100), /cycles/)
  assert.throws(() => api.auxiliaryPayloadBytes(new Date(), 100), /plain data/)
  assert.throws(() => api.auxiliaryPayloadBytes(new ArrayBuffer(101), 100), /byte limit/)
  let deep = {}; for (let i = 0; i < 23; i++) deep = { child: deep }
  assert.throws(() => api.auxiliaryPayloadBytes(deep, 1024), /structure/)
})

test('auxiliary loads isolated sandbox assets, consumes context once and rejects foreign frames', async t => {
  const f = fixture(t)
  const { windowId } = await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/test.html', data: { text: 'fixture only' } })
  const win = f.windows[0], session = f.sessions[0]
  assert.equal(win.options.webPreferences.sandbox, true)
  assert.equal(win.options.webPreferences.nodeIntegration, false)
  assert.match(win.options.webPreferences.preload, /auxiliaryPreload/)
  assert.deepEqual(win.openHandler(), { action: 'deny' })
  assert.equal(session.devicePermission(), false)
  assert.deepEqual(f.api.getAuxiliaryMemoryOwners(), [{ pluginId: OWNER, generation: 1, wcId: win.webContents.id }])
  assert.deepEqual(f.invoke('AuxiliaryContext').data, { text: 'fixture only' })
  assert.throws(() => f.invoke('AuxiliaryContext'), /already consumed/)
  assert.throws(() => f.invoke('AuxiliaryPost', {}, { url: win.webContents.mainFrame.url }), /foreign/)
  assert.throws(() => f.api.sendAuxiliaryMessage('com.foreign', windowId, {}), /not owned/)
  f.invoke('AuxiliaryPost', { from: 'fixture' })
  assert.deepEqual(f.events.at(-1).data, { type: 'auxiliary.message', windowId, data: { from: 'fixture' } })
  assert.equal(f.api.closeAuxiliaryWindow(OWNER, windowId), true)
  assert.equal(win.destroyed, true); assert.equal(session.displayMedia, null)
  assert.equal(f.api.getAuxiliaryDiagnostics().windows, 0); assert.equal(f.scope.activityCount, 0)
})

test('auxiliary session blocks remote requests, other plugin assets, child frames and navigation', async t => {
  const f = fixture(t); await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/test.html' })
  const win = f.windows[0], session = f.sessions[0]
  const allowed = (url, resourceType = 'script') => { let decision; session.beforeRequest({ url, resourceType, webContentsId: win.webContents.id, method: 'GET' }, value => { decision = value }); return !decision.cancel }
  assert.equal(allowed(`enest://plugin/${OWNER}/assets/main.js`), true)
  for (const url of ['https://example.invalid/', 'file:///fixture', 'enest://plugin/com.other/assets/main.js', `enest://plugin/${OWNER}/src/private.js`]) assert.equal(allowed(url), false)
  assert.equal(allowed(`enest://plugin/${OWNER}/assets/frame.html`, 'subFrame'), false)
  let headers; session.headersReceived({ responseHeaders: {} }, value => { headers = value.responseHeaders })
  assert.match(headers['Content-Security-Policy'][0], /script-src 'self'/)
  let prevented = false; win.webContents.emit('will-navigate', { preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.equal(win.destroyed, true)
})

test('concurrent auxiliary reservations stay bounded and source/owner changes reject before a window appears', async t => {
  const f = fixture(t), gate = deferred(); f.setFile(() => gate.promise)
  const pending = Array.from({ length: 8 }, () => f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/test.html' }))
  await assert.rejects(f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/test.html' }), /resource limit/)
  f.setRevision('v2'); gate.resolve('/fixture/safe.html')
  assert.ok((await Promise.allSettled(pending)).every(row => row.status === 'rejected'))
  assert.equal(f.windows.length, 0); assert.equal(f.api.getAuxiliaryDiagnostics().windows, 0)
  assert.equal(f.scope.activityCount, 0)
})

test('capture requires visible owner, real gesture, exact main frame and one fixed source', async t => {
  const f = fixture(t)
  f.setVisible(false)
  await assert.rejects(f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/record.html', capture: {} }), /visible/)
  f.setVisible(true)
  await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/record.html', capture: { displayId: 9, withAudio: true } })
  const win = f.windows[0], session = f.sessions[0]
  const request = { frame: win.webContents.mainFrame, videoRequested: true, audioRequested: true, userGesture: true }
  assert.equal(session.permissionCheck(win.webContents, 'display-capture', '', { isMainFrame: true, requestingUrl: win.webContents.mainFrame.url }), true)
  assert.equal(session.permissionCheck(win.webContents, 'media', '', { isMainFrame: true, requestingUrl: win.webContents.mainFrame.url }), false)
  let reply
  session.displayMedia({ ...request, userGesture: false }, value => { reply = value }); assert.deepEqual(reply, {})
  session.displayMedia({ ...request, frame: { ...request.frame } }, value => { reply = value }); assert.deepEqual(reply, {})
  session.displayMedia(request, value => { reply = value }); await settle()
  assert.equal(reply.video.id, 'display:9'); assert.equal(reply.audio, 'loopback')
  session.displayMedia(request, value => { reply = value }); assert.deepEqual(reply, {})
})

test('revoked capture and topmost permission terminate surfaces; late source replies never grant', async t => {
  const f = fixture(t), gate = deferred(); f.setSource(() => gate.promise)
  await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/record.html', capture: {} })
  const win = f.windows[0], handler = f.sessions[0].displayMedia
  let reply
  handler({ frame: win.webContents.mainFrame, videoRequested: true, userGesture: true }, value => { reply = value })
  f.setPermission(false); f.api.revokeAuxiliaryCapture(OWNER); gate.resolve({ id: 'must-not-leak' }); await settle()
  assert.deepEqual(reply, {}); assert.equal(win.destroyed, true)
  await assert.rejects(f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/pin.html', alwaysOnTop: true }), /pin.create/)
  f.setPermission(true); await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/pin.html', alwaysOnTop: true })
  f.api.revokeAuxiliaryTopmost(OWNER)
  assert.equal(f.api.getAuxiliaryDiagnostics().windows, 0)
})

test('close grace permits only existing owner messages until drainSignal aborts; new capture stays denied', async t => {
  const f = fixture(t), { windowId } = await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/record.html', capture: {} })
  const frame = f.windows[0].webContents.mainFrame
  f.scope.markClosing()
  assert.equal(f.scope.signal.aborted, true); assert.equal(f.scope.drainSignal.aborted, false)
  f.api.sendAuxiliaryMessage(OWNER, windowId, { type: 'stop' })
  f.invoke('AuxiliaryPost', { type: 'stopped' })
  assert.equal(f.events.at(-1).data.data.type, 'stopped')
  await assert.rejects(f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/new.html' }), /closing/)
  assert.throws(() => f.invoke('AuxiliaryContext'), /closing/)
  let reply; f.sessions[0].displayMedia({ frame, userGesture: true, videoRequested: true }, value => { reply = value })
  assert.deepEqual(reply, {})
  await f.scope.dispose()
  assert.equal(f.scope.drainSignal.aborted, true); assert.equal(f.windows[0].destroyed, true)
  assert.throws(() => f.invoke('AuxiliaryPost', {}), /foreign/)
})

test('plugin-private stable Session slots are reusable only after retired handlers and storage have drained', async t => {
  const f = fixture(t), first = await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/test.html' }), gate = deferred()
  const oldSession = f.sessions[0], oldFrame = f.windows[0].webContents.mainFrame, firstUrl = oldFrame.url
  oldSession.clearStorageData = () => gate.promise
  f.api.closeAuxiliaryWindow(OWNER, first.windowId)
  assert.equal(oldSession.displayMedia, null); assert.equal(oldSession.beforeRequest, null)
  const second = await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/test.html' })
  assert.notEqual(f.sessions[1].name, oldSession.name)
  assert.equal(f.api.getAuxiliaryDiagnostics().reservedSlots, 2)
  gate.resolve(); await settle()
  f.api.closeAuxiliaryWindow(OWNER, second.windowId); await settle()
  await f.api.openAuxiliaryWindow(OWNER, { entry: 'assets/test.html' })
  assert.equal(f.sessions[2].name, oldSession.name)
  assert.notEqual(f.windows[2].webContents.mainFrame.url, firstUrl)
  assert.throws(() => f.invoke('AuxiliaryPost', {}, oldFrame), /foreign/)
})

test('native capture uses exact display IDs and checks owner/consent again after enumeration', async t => {
  const scopes = load('src/main/plugin/PluginRuntimeScope.ts'), scope = scopes.createRuntimeScope({ pluginId: OWNER, generation: 1, wcId: 1 })
  t.after(() => scope.dispose())
  let allowed = true, sourceIds = ['9'], enumerate
  const crops = [], image = { isEmpty: () => false, getSize: () => ({ width: 1600, height: 1200 }), toDataURL: () => 'data:image/png;base64,fixture', crop: bounds => { crops.push(bounds); return image } }
  const display = { id: 9, bounds: { x: 0, y: 0, width: 800, height: 600 }, size: { width: 800, height: 600 }, workArea: {}, scaleFactor: 2 }
  const api = load('src/main/screen/screenService.ts', {
    electron: { screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] }, desktopCapturer: { getSources: () => enumerate ? enumerate() : Promise.resolve(sourceIds.map(display_id => ({ display_id, thumbnail: image }))) } },
    '@main/plugin/PluginRuntimeScope': scopes, '@main/plugin/PermissionService': { permissionService: { isGranted: () => allowed } },
    '@main/plugin/PluginRegistry': { pluginRegistry: { getManifest: () => ({ permissions: ['screen.capture', 'screen.record'] }) } },
    '@main/plugin/OsPermissionChecks': { checkScreenCapture: () => ({ ok: true }) }
  })
  assert.equal((await api.captureScreen(OWNER, { displayId: 9, bounds: { x: -10, y: 2, width: 40, height: 50 } })).displayId, 9)
  assert.deepEqual(crops[0], { x: 0, y: 2, width: 40, height: 50 })
  await assert.rejects(api.captureScreen(OWNER, { displayId: 7 }), /Display unavailable/)
  sourceIds = ['10']; await assert.rejects(api.captureScreen(OWNER), /unavailable/)
  const gate = deferred(); enumerate = () => gate.promise
  const pending = api.captureScreen(OWNER); allowed = false; gate.resolve([{ display_id: '9', thumbnail: image }])
  await assert.rejects(pending, /permission denied/)
  assert.equal(scope.activityCount, 0)
})
