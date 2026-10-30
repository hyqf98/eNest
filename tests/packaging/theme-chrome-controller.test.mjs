import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compiled = new Map()
function load(file, adapters = {}, globals = {}) {
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(new URL(`../../${file}`, new URL("../../tools/packaging/", import.meta.url)), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText)
  const module = { exports: {} }
  vm.runInNewContext(compiled.get(file), { module, exports: module.exports, URL, Request, Response, Uint8Array, Buffer, console,
    require(name) {
      if (Object.hasOwn(adapters, name)) return adapters[name]
      if (name.startsWith('node:')) return require(name)
      throw Error(`Unexpected controller dependency ${name}`)
    }, ...globals })
  return module.exports
}
const ipc = load('src/shared/types/ipc.ts')
const contract = load('src/shared/types/themeChrome.ts', { './ipc': ipc })
const constants = load('src/shared/constants.ts')
const assets = load('src/main/theme/themeChromeAssets.ts', { '@shared/pluginContract': load('src/shared/pluginContract.ts') })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const clone = value => JSON.parse(JSON.stringify(value))

function fixture() {
  const handlers = new Map(), sessions = [], views = [], timers = new Set(), calls = [], failures = [], shellEvents = [], pluginWatchers = new Set()
  let clock = 10_000, nextId = 100
  const chrome = { version: 1, classic: { entry: 'chrome/classic.html' }, rail: { entry: 'chrome/rail.html' }, dock: { entry: 'chrome/dock.html' } }
  const env = { enabled: true, manifest: true, root: '/fixture/theme', build: 1, focused: true, active: true, inset: 0,
    appearance: { theme: { source: 'fixture.theme', id: 'custom', version: '1' }, chrome },
    pack: { source: 'fixture.theme', chrome }, read: async () => new Uint8Array([60, 62]), changed: 0,
    pluginEnabled: true, targetBuild: 1, installedRevision: 0, runtime: undefined, openGate: null, openStarted: null }
  const railRows = [{ source: 'fixture.plugin', id: 'contrib', data: { id: 'contrib', title: 'New', color: '#123', glyph: '+', openCode: 'new-item' } }]
  const state = { view: 'plugin', tabStyle: 'orb', activeTabId: 't1', animationLevel: 'low',
    theme: { mode: 'dark', tokens: { '--ink': '#123456' }, appearance: { resources: { fonts: ['/private/font'] } } },
    profile: { name: 'Private account', avatar: 'data:image/png;base64,AA' },
    tabs: [{ id: 't1', pluginId: 'fixture.plugin', title: 'One', color: '#123', glyph: '1', icon: 'file:///private/icon.png', badge: '2', lazy: true, crashed: true }],
    contribEntries: [] }
  const electron = {
    app: { getAppPath: () => '/fixture/eNest' }, nativeTheme: new EventEmitter(),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, shell: {},
    session: { fromPartition(partition, options) {
      const isolated = { partition, options, protocolHandlers: new Map(), cleared: 0,
        setPermissionRequestHandler(handler) { this.permissionRequest = handler },
        setPermissionCheckHandler(handler) { this.permissionCheck = handler },
        on(name, handler) { this[name] = handler },
        webRequest: { onBeforeRequest(handler) { isolated.beforeRequest = handler } },
        protocol: { handle(name, handler) { isolated.protocolHandlers.set(name, handler) }, unhandle(name) { isolated.protocolHandlers.delete(name) } },
        clearStorageData: async () => { isolated.cleared++ },
      }
      sessions.push(isolated)
      return isolated
    } },
  }
  class Contents extends EventEmitter {
    constructor(isolated) { super(); this.id = ++nextId; this.session = isolated; this.mainFrame = { url: '', detached: false }; this.messages = []; this.destroyed = false }
    isDestroyed() { return this.destroyed }
    setWebRTCIPHandlingPolicy(value) { this.webRTCPolicy = value }
    setWindowOpenHandler(handler) { this.openWindow = handler }
    async loadURL(url) { this.mainFrame.url = url; this.url = url }
    async loadFile(file) { this.mainFrame.url = `file://${file}`; this.url = this.mainFrame.url }
    send(channel, payload) { this.messages.push({ channel, payload }) }
    close(options) { this.closeOptions = options; this.destroyed = true; this.emit('destroyed') }
  }
  electron.WebContentsView = class {
    constructor(options) { this.options = options; this.webContents = new Contents(options.webPreferences.session); this.visible = true; views.push(this) }
    setBackgroundColor(value) { this.background = value }
    setVisible(value) { this.visible = value }
    getVisible() { return this.visible }
    setBounds(value) { this.bounds = value }
    getBounds() { return this.bounds }
  }
  const pluginRegistry = {
    getAssetRootPath: () => env.root,
    isEnabled: id => id === 'fixture.theme' ? env.enabled : env.pluginEnabled && railRows.some(row => row.source === id),
    getManifest: id => env.manifest ? { contributes: { railEntries: railRows.filter(row => row.source === id).map(row => row.data) } } : null,
    getBuildRevision: id => id === 'fixture.theme' ? env.build : env.targetBuild,
    getInstalledRevision: () => env.installedRevision,
    get: () => ({ installed: true, enabled: env.pluginEnabled }),
    onInstalledChanged(listener) { pluginWatchers.add(listener); return () => pluginWatchers.delete(listener) },
  }
  const children = []
  const mainWindow = { isFocused: () => env.focused, isDestroyed: () => false,
    contentView: { children, addChildView(view) { const old = children.indexOf(view); if (old >= 0) children.splice(old, 1); children.push(view) },
      removeChildView(view) { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1) } } }
  const windowService = { getMainWindow: () => mainWindow, resolvePreload: name => `/preload/${name}`, sendShellEvent: event => shellEvents.push(event),
    getShellBounds: () => ({ width: 1200, height: 800 }), getPluginTopInset: () => env.inset, setPluginLeftInset() {} }
  const pluginHost = {
    hasShellTab: id => id === 't1', activatePlugin: id => calls.push(['activate', id]),
    closePlugin: async (id, reason) => { calls.push(['close', id, reason]) },
    detachPlugin: async id => { calls.push(['detach', id]) }, reorderPlugin: (id, index) => calls.push(['reorder', id, index]),
    openPlugin: async (id, enter, options) => {
      if (options?.guard && !options.guard()) throw Error('plugin launch cancelled')
      env.openStarted?.()
      if (env.openGate) await env.openGate
      if (options?.guard && !options.guard()) throw Error('plugin launch cancelled')
      calls.push(['open', id, enter])
    },
  }
  const rail = load('src/main/contrib/railContributions.ts', {
    './ContributionRegistry': { listRailEntries: () => railRows },
    '@main/plugin/PluginRegistry': { pluginRegistry },
    '@main/plugin/PluginRuntimeScope': { getRuntimeScope: () => env.runtime },
    '@main/plugin/PluginHost': { pluginHost },
  })
  state.contribEntries = rail.readRailContributionEntries()
  const api = load('src/main/theme/themeChromeSurface.ts', {
    electron, 'node:fs/promises': { realpath: async () => env.root },
    '@shared/types/themeChrome': contract, '@main/plugin/PluginRegistry': { pluginRegistry },
    '@main/contrib/railContributions': rail,
    '@main/window/createShellWindow': windowService,
    '@main/logs/logService': { logInfo() {}, logWarn() {} }, './appearanceService': { appearanceService: { getAppearance: () => env.appearance } },
    './themePacks': { themePackRegistry: { get: id => id === env.appearance.theme.id ? env.pack : null } },
    './themeChromeAssets': { ...assets, readChromeAsset: (...args) => env.read(...args) },
    '@main/plugin/PluginHost': { pluginHost },
    '@main/ipc/shellHandlers': { navigateWorkspace: async route => { calls.push(['home', route]) }, openShellSettings: () => calls.push(['settings']) },
  }, { performance: { now: () => clock }, setTimeout(callback, ms) { const timer = { callback, ms, unref() {} }; timers.add(timer); return timer }, clearTimeout: timer => timers.delete(timer) })
  const security = load('src/main/ipc/ipcSecurity.ts', { electron, '@shared/types/ipc': ipc })
  function make(part = 'rail') {
    const selected = api.selectThemeChrome(part)
    assert.ok(selected)
    return new api.ThemeChromeSurface(part, selected, { state: () => state, active: () => env.active,
      expand: value => calls.push(['expand', value]), changed: () => { env.changed++ }, failed: signature => failures.push(signature) })
  }
  function event(surface) { return { sender: surface.view.webContents, senderFrame: surface.view.webContents.mainFrame } }
  function invoke(surface, channel, ...args) { return handlers.get(channel)(event(surface), ...args) }
  function show(surface) { invoke(surface, contract.ThemeChromeChannels.Ready); surface.view.setVisible(true) }
  function click(surface) {
    const wc = surface.view.webContents
    wc.emit('before-mouse-event', {}, { button: 'left', type: 'mouseDown' }); clock += 10
    wc.emit('before-mouse-event', {}, { button: 'left', type: 'mouseUp' })
  }
  const dispatch = (surface, action) => invoke(surface, contract.ThemeChromeChannels.Action, action)
  function orb() {
    return load('src/main/window/orbRailViews.ts', { electron, '@main/window/transientViews': { raiseTransientViews() {} },
      '@main/ipc/ipcSecurity': security, '@shared/constants': constants, '@shared/types/ipc': ipc,
      '@main/window/createShellWindow': windowService, '@main/settings/SettingsStore': { settingsStore: { getAll: () => ({ general: { animationLevel: 'low' } }) } },
      '@main/theme/resolveThemeCss': { resolveThemeTokens: () => ({ mode: 'light', tokens: {} }) },
      '@main/contrib/railContributions': rail, '@main/plugin/PluginRegistry': { pluginRegistry },
      '@main/logs/logService': { logInfo() {}, logWarn() {} }, '@main/theme/themeChromeSurface': api,
    }, { process: { env: {} }, queueMicrotask })
  }
  return { api, env, state, sessions, views, handlers, timers, calls, failures, shellEvents, make, show, click, event, invoke, dispatch, security,
    orb, mainWindow, pluginWatchers, electron, rail, railRows,
    advance(ms) { clock += ms } }
}

test('chrome selection is bound to current installed/enabled theme source, entry and build revision', () => {
  const f = fixture(), selected = f.api.selectThemeChrome('rail')
  assert.equal(selected.entry, 'chrome/rail.html')
  f.env.enabled = false; assert.equal(f.api.selectThemeChrome('rail'), null); f.env.enabled = true
  f.env.manifest = false; assert.equal(f.api.selectThemeChrome('rail'), null); f.env.manifest = true
  f.env.root = ''; assert.equal(f.api.selectThemeChrome('rail'), null); f.env.root = '/fixture/theme'
  f.env.pack = { ...f.env.pack, source: 'different' }; assert.equal(f.api.selectThemeChrome('rail'), null)
  f.env.pack.source = 'fixture.theme'
  f.env.appearance.chrome = { ...f.env.appearance.chrome, rail: { entry: 'chrome/other.html' } }
  assert.equal(f.api.selectThemeChrome('rail'), null)
  f.env.appearance.chrome = f.env.pack.chrome
  const surface = f.make()
  assert.equal(surface.current(), true)
  f.env.build++
  assert.equal(surface.current(), false)
  f.env.appearance.theme.source = 'enest.builtin'
  assert.equal(f.api.selectThemeChrome('rail'), null)
})

test('custom renderer stays isolated and never gains trusted shell/window IPC capability', () => {
  const f = fixture(), surface = f.make(), wc = surface.view.webContents, isolated = wc.session
  const prefs = surface.view.options.webPreferences
  assert.equal(prefs.preload, '/preload/themeChromePreload.js')
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity', 'backgroundThrottling']) assert.equal(prefs[key], true)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(isolated.options.cache, false)
  assert.match(isolated.partition, /^enest-chrome-/)
  assert.equal(f.security.getTrustedSurfaceRole(wc.id), null)
  for (const channel of [ipc.IpcChannels.ShellGetSettings, ipc.IpcChannels.ShellOpenPlugin, ipc.IpcChannels.ShellActivateRailContribution, ipc.IpcChannels.PluginWindowCommand]) {
    assert.throws(() => f.security.assertSurfaceSender(f.event(surface), channel), /untrusted surface/)
  }
  let permission = true
  isolated.permissionRequest(wc, 'media', value => { permission = value })
  assert.equal(permission, false)
  assert.equal(isolated.permissionCheck(), false)
  assert.equal(wc.openWindow({ url: 'https://example.invalid' }).action, 'deny')
  assert.equal(wc.webRTCPolicy, 'disable_non_proxied_udp')
})

test('IPC requires exact live WebContents, current main frame and exact granted document URL', () => {
  const f = fixture(), surface = f.make(), wc = surface.view.webContents
  const handler = f.handlers.get(contract.ThemeChromeChannels.Snapshot)
  assert.equal(handler(f.event(surface)).version, 1)
  for (const value of [
    { sender: { id: wc.id, isDestroyed: () => false, mainFrame: wc.mainFrame }, senderFrame: wc.mainFrame },
    { sender: wc, senderFrame: { url: wc.url } }, { sender: wc, senderFrame: null },
  ]) assert.throws(() => handler(value), /Retired or foreign/)
  for (const suffix of ['?same-origin', '#fragment', '/next']) {
    wc.mainFrame.url = wc.url + suffix
    assert.throws(() => handler(f.event(surface)), /Retired or foreign/)
  }
  wc.mainFrame.url = wc.url
  f.env.enabled = false
  assert.throws(() => handler(f.event(surface)), /Retired or foreign/)
  f.env.enabled = true
  surface.dispose()
  assert.throws(() => handler(f.event(surface)), /Retired or foreign/)
})

test('custom snapshot omits account, full appearance, local icons and contribution launch codes', () => {
  const f = fixture(), surface = f.make(), snapshot = f.invoke(surface, contract.ThemeChromeChannels.Snapshot)
  assert.equal(snapshot.profile, undefined)
  assert.equal(snapshot.theme.appearance, undefined)
  assert.equal(snapshot.tabs[0].icon, undefined)
  assert.equal(snapshot.contribEntries[0].openCode, undefined)
  assert.equal(snapshot.tabs[0].badge, '2')
  assert.equal(snapshot.tabs[0].lazy, true)
  assert.equal(snapshot.tabs[0].crashed, true)
  assert.deepEqual(clone(snapshot.theme.tokens), { '--ink': '#123456' })
  assert.doesNotMatch(JSON.stringify(snapshot), /private|Private account|new-item/)
})

test('resource filtering rejects foreign origins, frames, methods, grant keys and executable HTML subresources', () => {
  const f = fixture(), surface = f.make(), wc = surface.view.webContents, isolated = wc.session
  const base = { url: wc.url, method: 'GET', resourceType: 'mainFrame', webContentsId: wc.id, frame: wc.mainFrame }
  const allowed = patch => { let result; isolated.beforeRequest({ ...base, ...patch }, value => { result = value }); return result.cancel === false }
  assert.equal(allowed({}), true)
  assert.equal(allowed({ url: wc.url.replace('rail.html', 'style.css'), resourceType: 'stylesheet' }), true)
  for (const patch of [{ url: 'https://example.invalid/theme.js', resourceType: 'script' },
    { url: wc.url.replace(/surface\/[^/]+\//, 'surface/wrong/') }, { method: 'POST' },
    { frame: { url: wc.url } }, { frame: { ...wc.mainFrame, detached: true } }, { webContentsId: wc.id + 1 },
    { resourceType: 'subFrame' }, { resourceType: 'xhr' }, { resourceType: 'webSocket' }]) assert.equal(allowed(patch), false)
  f.env.enabled = false
  assert.equal(allowed({}), false)
})

test('asset response rechecks source revocation after an asynchronous local read', async () => {
  const f = fixture(), surface = f.make(), wc = surface.view.webContents
  const protocol = wc.session.protocolHandlers.get(assets.THEME_CHROME_SCHEME), pending = deferred()
  f.env.read = () => pending.promise
  const response = protocol(new Request(wc.url))
  await Promise.resolve()
  f.env.enabled = false
  pending.resolve(new Uint8Array([60, 62]))
  assert.equal((await response).status, 403)
  assert.equal((await protocol(new Request(wc.url, { method: 'POST' }))).status, 403)
  f.env.enabled = true
  assert.equal((await protocol(new Request(wc.url, { method: 'POST' }))).status, 405)
  assert.equal((await protocol(new Request('https://example.invalid'))).status, 403)
})

test('navigation, subframes, redirects and guest webviews cannot replace the granted chrome document', () => {
  const f = fixture(), surface = f.make(), wc = surface.view.webContents
  const prevented = (name, details, url) => { let denied = false; wc.emit(name, { preventDefault() { denied = true }, ...details }, url); return denied }
  assert.equal(prevented('will-navigate', {}, wc.url), false)
  assert.equal(prevented('will-navigate', {}, 'file:///private/account'), true)
  assert.equal(prevented('will-frame-navigate', { isMainFrame: true, url: wc.url }), false)
  assert.equal(prevented('will-frame-navigate', { isMainFrame: false, url: wc.url }), true)
  assert.equal(prevented('will-redirect', { url: wc.url }), true)
  assert.equal(prevented('will-attach-webview', {}), true)
})

test('actions require visible/focused readiness and one recent native gesture per privileged request', async () => {
  const f = fixture(), surface = f.make()
  await assert.rejects(f.dispatch(surface, { type: 'home' }), /not interactive/)
  f.show(surface)
  await assert.rejects(f.dispatch(surface, { type: 'home' }), /native user gesture/)
  f.click(surface)
  await f.dispatch(surface, { type: 'activate', tabId: 't1' })
  await assert.rejects(f.dispatch(surface, { type: 'close', tabId: 't1' }), /native user gesture/)
  f.click(surface); f.advance(1001)
  await assert.rejects(f.dispatch(surface, { type: 'home' }), /native user gesture/)
  f.click(surface); surface.view.webContents.emit('blur')
  await assert.rejects(f.dispatch(surface, { type: 'home' }), /native user gesture/)
  f.click(surface); f.env.focused = false
  await assert.rejects(f.dispatch(surface, { type: 'home' }), /not interactive/)
  f.env.focused = true; f.env.active = false
  await assert.rejects(f.dispatch(surface, { type: 'home' }), /not interactive/)
  f.env.active = true; surface.view.setVisible(false)
  await assert.rejects(f.dispatch(surface, { type: 'home' }), /not interactive/)
  assert.deepEqual(f.calls, [['activate', 't1']])
})

test('host resolves contribution/tab targets and refuses forged targets, invalid order and stale async action', async () => {
  const f = fixture(), surface = f.make()
  f.show(surface)
  f.click(surface)
  await f.dispatch(surface, { type: 'contribution', id: f.state.contribEntries[0].id, pluginId: 'forged', code: 'forged' })
  f.click(surface)
  await f.dispatch(surface, { type: 'detach', tabId: 't1', pluginId: 'forged' })
  f.click(surface)
  await assert.rejects(f.dispatch(surface, { type: 'activate', tabId: 'other' }), /Unknown shell tab/)
  f.click(surface)
  await assert.rejects(f.dispatch(surface, { type: 'reorder', tabId: 't1', index: 99 }), /Invalid tab index/)
  f.click(surface)
  await assert.rejects(f.dispatch(surface, { type: 'contribution', id: 'other' }), /Unknown or retired rail contribution/)
  f.click(surface)
  const pending = f.dispatch(surface, { type: 'close', tabId: 't1' })
  f.env.enabled = false
  await assert.rejects(pending, /retired during action/)
  assert.deepEqual(clone(f.calls), [['open', 'fixture.plugin', { code: 'new-item' }], ['detach', 'fixture.plugin']])
})

test('rail ids bind duplicate local ids to their own declaring source and reject raw local ids', async () => {
  const f = fixture(), surface = f.make()
  f.railRows.push({ source: 'fixture.other', id: 'contrib', data: { id: 'contrib', glyph: 'O', openCode: 'other-item' } })
  f.state.contribEntries = f.rail.readRailContributionEntries()
  const [first, second] = f.state.contribEntries
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.id, 'contrib')
  f.show(surface)
  for (const entry of [first, second]) {
    f.click(surface)
    await f.dispatch(surface, { type: 'contribution', id: entry.id, pluginId: 'forged', code: 'forged' })
  }
  assert.deepEqual(clone(f.calls), [['open', 'fixture.plugin', { code: 'new-item' }], ['open', 'fixture.other', { code: 'other-item' }]])
  f.click(surface)
  await assert.rejects(f.dispatch(surface, { type: 'contribution', id: 'contrib' }), /Unknown or retired rail contribution/)
})

test('pending rail launches recheck surface, enabled source, declaration, build and runtime generation', async () => {
  const changes = [
    (f, surface) => surface.dispose(),
    f => { f.env.pluginEnabled = false },
    f => { f.railRows.length = 0 },
    f => { f.env.targetBuild++ },
    f => { f.env.installedRevision++ },
    f => { f.env.runtime = { isCurrent: () => true, isClosing: false } },
  ]
  for (const change of changes) {
    const f = fixture(), surface = f.make(), started = deferred(), gate = deferred()
    f.env.runtime = { isCurrent: () => true, isClosing: false }
    f.env.openStarted = started.resolve
    f.env.openGate = gate.promise
    f.show(surface); f.click(surface)
    const pending = f.dispatch(surface, { type: 'contribution', id: f.state.contribEntries[0].id })
    await started.promise
    change(f, surface)
    gate.resolve()
    await assert.rejects(pending, /plugin launch cancelled/)
    assert.deepEqual(f.calls, [])
    surface.dispose()
  }
})

test('dock capability is settings-only; rail expansion is constrained and request-rate limited', async () => {
  const f = fixture(), dock = f.make('dock')
  f.show(dock); f.click(dock)
  await assert.rejects(f.dispatch(dock, { type: 'home' }), /Settings dock action required/)
  await assert.rejects(f.dispatch(dock, { type: 'expand', expanded: true }), /Invalid rail action/)
  f.click(dock)
  await f.dispatch(dock, { type: 'settings' })
  const rail = f.make('rail')
  f.show(rail)
  await assert.rejects(f.dispatch(rail, { type: 'expand', expanded: 'true' }), /Invalid rail action/)
  for (let index = 0; index < 59; index++) await f.dispatch(rail, { type: 'expand', expanded: true })
  await assert.rejects(f.dispatch(rail, { type: 'expand', expanded: false }), /rate limit/)
  f.advance(1001)
  await f.dispatch(rail, { type: 'expand', expanded: false })
  assert.deepEqual(f.calls[0], ['settings'])
})

test('ready ACK is idempotent, failed render/load timeout reports fallback, and dispose revokes all channels', () => {
  const f = fixture(), surface = f.make('classic')
  assert.equal(surface.view.getVisible(), false)
  assert.equal(f.timers.size, 1)
  f.invoke(surface, contract.ThemeChromeChannels.Ready)
  f.invoke(surface, contract.ThemeChromeChannels.Ready)
  assert.equal(f.env.changed, 1)
  assert.equal(f.timers.size, 0)
  surface.view.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.deepEqual(f.failures, [surface.signature])
  const another = f.make('rail'), timeout = [...f.timers][0]
  assert.equal(timeout.ms, 5000)
  timeout.callback()
  assert.equal(f.failures.at(-1), another.signature)
  surface.dispose(); another.dispose()
  assert.equal(f.timers.size, 0)
  assert.equal(surface.current(), false)
  assert.equal(surface.view.webContents.isDestroyed(), true)
  assert.equal(surface.view.webContents.session.cleared, 1)
  assert.equal(surface.view.webContents.session.protocolHandlers.size, 0)
  assert.equal(f.shellEvents.at(-1).inside, false, 'classic hover ownership is released')
  assert.throws(() => f.invoke(surface, contract.ThemeChromeChannels.Ready), /Retired or foreign/)
})

test('native rail retains a usable trusted fallback until custom ACK, respects modal gates and retires it after handover', () => {
  const f = fixture(), orb = f.orb()
  orb.applyOrbRailVisibility('orb', false)
  assert.equal(f.views.length, 0)
  orb.applyOrbRailVisibility('orb', true)
  const custom = f.views.find(view => view.options.webPreferences.preload.endsWith('themeChromePreload.js'))
  const fallback = f.views.find(view => view.options.webPreferences.preload.endsWith('shellPreload.js'))
  assert.ok(custom && fallback)
  assert.equal(custom.getVisible(), false)
  assert.equal(fallback.getVisible(), true)
  assert.deepEqual(clone(custom.getBounds()), clone(fallback.getBounds()))
  assert.equal(f.security.getTrustedSurfaceRole(custom.webContents.id), null)
  assert.equal(f.security.getTrustedSurfaceRole(fallback.webContents.id), 'orb')
  assert.doesNotThrow(() => f.security.assertSurfaceSender(f.event({ view: fallback }), ipc.IpcChannels.ShellActivateRailContribution))
  assert.equal(orb.getOrbDragSurface(fallback.webContents.id)?.view, fallback, 'pending fallback retains native drag ownership')
  const resume = orb.suspendOrbRailViews()
  assert.equal(custom.getVisible(), false)
  assert.equal(fallback.getVisible(), false)
  resume()
  assert.equal(fallback.getVisible(), true)
  f.invoke({ view: custom }, contract.ThemeChromeChannels.Ready)
  assert.equal(custom.getVisible(), true)
  assert.equal(fallback.webContents.isDestroyed(), true)
  assert.equal(f.security.getTrustedSurfaceRole(fallback.webContents.id), null)
  assert.equal(orb.getOrbDragSurface(custom.webContents.id), null, 'untrusted custom chrome never enters the native drag bridge')
  assert.equal(f.mainWindow.contentView.children.length, 1)
  orb.destroyOrbRailViews()
  assert.equal(f.mainWindow.contentView.children.length, 0)
  assert.equal(f.pluginWatchers.size, 0)
  assert.equal(f.electron.nativeTheme.listenerCount('updated'), 0)
  assert.equal(f.timers.size, 0)
})

test('pending failure and source revocation restore the same builtin without a hidden blank navigation interval', async () => {
  for (const reason of ['crash', 'disabled']) {
    const f = fixture(), orb = f.orb()
    orb.applyOrbRailVisibility('orb', true)
    const [custom, fallback] = f.views
    assert.equal(fallback.getVisible(), true)
    if (reason === 'crash') {
      custom.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
      await Promise.resolve()
    } else {
      f.env.enabled = false
      for (const listener of f.pluginWatchers) listener()
    }
    assert.equal(custom.webContents.isDestroyed(), true)
    assert.equal(fallback.webContents.isDestroyed(), false)
    assert.equal(fallback.getVisible(), true)
    assert.equal(f.mainWindow.contentView.children[0], fallback)
    assert.equal(f.mainWindow.contentView.children.length, 1)
    assert.equal(f.views.length, 2, 'reuse the rendered fallback instead of creating another renderer')
    assert.throws(() => f.invoke({ view: custom }, contract.ThemeChromeChannels.Snapshot), /Retired or foreign/)
    orb.destroyOrbRailViews()
  }
})

test('classic status is host ACK-driven, replays on sync, and restores inline fallback after custom failure', async () => {
  const f = fixture(), orb = f.orb()
  orb.applyOrbRailVisibility('classic', true)
  const classic = f.views.find(view => view.webContents.url?.endsWith('/classic.html'))
  assert.ok(classic)
  const latest = () => f.shellEvents.filter(event => event.type === 'theme-chrome-status').at(-1)
  assert.equal(latest().ready, false)
  f.invoke({ view: classic }, contract.ThemeChromeChannels.Ready)
  assert.equal(latest().ready, true)
  assert.equal(classic.getVisible(), true)
  f.shellEvents.length = 0
  orb.applyOrbRailVisibility('classic', true)
  assert.equal(latest().ready, true, 'a mounted renderer can recover a missed initial ACK event')
  f.env.inset = 28
  orb.layoutOrbRailViews()
  assert.equal(classic.getVisible(), false, 'custom tabs cannot cover the titlebar reveal strip')
  f.env.inset = 0
  orb.layoutOrbRailViews()
  assert.equal(classic.getVisible(), true)
  classic.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await Promise.resolve()
  assert.equal(latest().ready, false)
  assert.equal(classic.webContents.isDestroyed(), true)
  orb.destroyOrbRailViews()
})

test('builtin-only classic creates no extra top-tab renderer and style switching releases inactive native views', () => {
  const f = fixture(), orb = f.orb()
  f.env.appearance.theme.source = 'enest.builtin'
  orb.applyOrbRailVisibility('classic', true)
  assert.equal(f.views.length, 1)
  const dock = f.views[0]
  assert.equal(f.security.getTrustedSurfaceRole(dock.webContents.id), 'dock')
  assert.throws(() => f.security.assertSurfaceSender(f.event({ view: dock }), ipc.IpcChannels.ShellActivateRailContribution), /surface capability/)
  orb.applyOrbRailVisibility('orb', true)
  assert.equal(dock.webContents.isDestroyed(), true)
  assert.equal(f.views.length, 2)
  assert.equal(f.mainWindow.contentView.children.length, 1)
  assert.equal(f.security.getTrustedSurfaceRole(f.views[1].webContents.id), 'orb')
  orb.destroyOrbRailViews()
})
