import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const standardSize = { width: 720, height: 248 }
const expandedSize = { width: 720, height: 545 }
const standardPluginBounds = { x: 1, y: 64, width: 718, height: 480 }
const adapters = {
  'quick-geometry-fixture': `export const state = {
    windows: [], workArea: { x: 100, y: 40, width: 1600, height: 1000 },
    captureCalls: 0, captureGate: null, logs: [], trusted: [], eventSink: null
  };`,
  electron: `
    import { EventEmitter } from 'node:events';
    import { state } from 'quick-geometry-fixture';
    export class View {
      children = []; bounds = { x: 0, y: 0, width: 0, height: 0 }; boundsHistory = [];
      addChildView(view) { this.children.push(view); }
      removeChildView(view) { this.children = this.children.filter(child => child !== view); }
      setBounds(bounds) { this.bounds = { ...bounds }; this.boundsHistory.push({ ...bounds }); }
      getBounds() { return { ...this.bounds }; }
      setBackgroundBlur(value) { this.blur = value; }
      setBorderRadius(value) { this.radius = value; }
      setBackgroundColor(value) { this.background = value; }
    }
    class WebContents extends EventEmitter {
      destroyed = false; loading = false; url = ''; messages = []; scripts = []; loads = 0;
      isDestroyed() { return this.destroyed; }
      isLoadingMainFrame() { return this.loading; }
      getURL() { return this.url; }
      loadURL(url) { this.loads++; this.url = url; this.loading = true; return Promise.resolve(); }
      loadFile(file, options) { return this.loadURL('file://' + file + (options?.query ? '?' + new URLSearchParams(options.query) : '')); }
      finishLoad() { this.loading = false; this.emit('did-finish-load'); }
      send(channel, payload) { this.messages.push({ channel, payload }); }
      executeJavaScript(code) { this.scripts.push(code); return Promise.resolve(); }
      focus() {}
      isDevToolsOpened() { return false; }
      close() { this.destroyed = true; this.emit('destroyed'); }
    }
    export class WebContentsView extends View {
      webContents = new WebContents();
      constructor(options) { super(); this.options = options; }
    }
    export class BaseWindow extends EventEmitter {
      contentView = new View(); destroyed = false; visible = false; focused = false;
      boundsHistory = []; showAttempts = 0;
      constructor(options) {
        super(); this.options = options;
        this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
        state.windows.push(this);
      }
      isDestroyed() { return this.destroyed; }
      isVisible() { return this.visible; }
      isFocused() { return this.focused; }
      getBounds() { return { ...this.bounds }; }
      getContentBounds() { return this.getBounds(); }
      setBounds(bounds) {
        if (this.destroyed) throw new Error('cannot resize a destroyed window');
        const resized = bounds.width !== this.bounds.width || bounds.height !== this.bounds.height;
        this.bounds = { ...bounds }; this.boundsHistory.push({ ...bounds });
        if (resized) this.emit('resize');
      }
      show() {
        this.showAttempts++;
        if (this.destroyed) throw new Error('cannot show a destroyed window');
        this.visible = true;
      }
      hide() { this.visible = false; this.focused = false; }
      focus() { this.focused = true; }
      moveTop() {}
      setAlwaysOnTop() {}
      setVisibleOnAllWorkspaces() {}
      destroy() {
        if (this.destroyed) return;
        this.destroyed = true; this.visible = false; this.focused = false; this.emit('closed');
      }
    }
    export const screen = new EventEmitter();
    screen.getCursorScreenPoint = () => ({ x: state.workArea.x + 100, y: state.workArea.y + 100 });
    screen.getDisplayNearestPoint = screen.getDisplayMatching = () => ({ id: 1, workArea: { ...state.workArea } });
    export const app = { getAppPath: () => '/quick-geometry-fixture' };
  `,
  '@main/ipc/ipcSecurity': `import { state } from 'quick-geometry-fixture'; export const registerTrustedSurface = (...args) => state.trusted.push(args);`,
  '@main/clipboard/nativeClipboard': `import { state } from 'quick-geometry-fixture'; export async function capturePasteTarget() { state.captureCalls++; await state.captureGate; }`,
  '@main/plugin/pluginProtocol': `export const ensureShellSessionProtocol = () => {};`,
  '@main/logs/logService': `import { state } from 'quick-geometry-fixture'; export const logInfo = () => {}; export const logError = (...args) => state.logs.push(args);`,
  '@main/settings/SettingsStore': `export const settingsStore = { getAll: () => ({ general: { animationLevel: 'high' } }) };`,
  './createShellWindow': `import { state } from 'quick-geometry-fixture'; export const resolvePreload = file => file; export const setQuickEventSink = sink => { state.eventSink = sink; };`
}

let fixtureId = 0
async function fixture(t) {
  const result = await build({
    stdin: {
      contents: `export * from '@main/window/createQuickWindow'; export { state } from 'quick-geometry-fixture'; export { screen, View } from 'electron'; export const fixtureId = ${++fixtureId};`,
      resolveDir: root
    },
    tsconfig: root + 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'quick-geometry-adapters', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    } }]
  })
  const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
  t.after(() => api.destroyQuickWindow())
  return api
}

async function showLoaded(api) {
  assert.equal(await api.showQuickWindow(), true)
  const win = api.getQuickWindow()
  if (win.webContents.isLoadingMainFrame()) win.webContents.finishLoad()
  assert.equal(api.isQuickVisible(), true)
  return win
}

function assertGeometry(api, expectedSize = standardSize) {
  const win = api.getQuickWindow(), surface = api.getQuickPluginParent()
  const bounds = win.getContentBounds()
  assert.deepEqual({ width: bounds.width, height: bounds.height }, expectedSize)
  const fullSurface = { x: 0, y: 0, ...expectedSize }
  assert.deepEqual(surface.getBounds(), fullSurface, 'native parent must expose the full shell and plugin, without a reveal crop')
  assert.deepEqual(win.shellView.getBounds(), fullSurface)
  assert.equal(surface.children.includes(win.shellView), true)
  assert.deepEqual(api.getQuickPluginBounds(), {
    x: 1, y: 64, width: Math.max(0, expectedSize.width - 2), height: Math.max(0, expectedSize.height - 65)
  })
  const area = api.state.workArea
  assert.ok(bounds.x >= area.x + 16 && bounds.y >= area.y + 16)
  assert.ok(bounds.x + bounds.width <= area.x + area.width - 16)
  assert.ok(bounds.y + bounds.height <= area.y + area.height - 16)
}

test('show and reopen use two home rows; entering a plugin expands the complete native surface', async t => {
  const api = await fixture(t)
  const win = await showLoaded(api)
  assertGeometry(api)
  api.setQuickContentSize({ height: 545 })
  assertGeometry(api, expandedSize)
  assert.deepEqual(api.getQuickPluginBounds(), standardPluginBounds)
  assert.equal(win.options.resizable, false)
  const plugin = new api.View()
  api.getQuickPluginParent().addChildView(plugin)
  api.setQuickPluginRelayout(() => plugin.setBounds(api.getQuickPluginBounds()))
  api.applyQuickHeightAfterShow()
  assert.deepEqual(plugin.getBounds(), standardPluginBounds)

  api.hideQuickWindow('test-hide')
  assert.equal(api.isQuickVisible(), false)
  api.setQuickContentSize({ width: 1200, height: 900 })
  api.setQuickContentHeight(64)
  assert.equal(await showLoaded(api), win, 'reopen reuses the existing window')
  assertGeometry(api)
  assert.deepEqual(plugin.getBounds(), { ...standardPluginBounds, height: 183 })
  assert.equal(win.webContents.loads, 1)
  assert.equal(api.state.captureCalls, 2)
  assert.equal(api.state.windows.length, 1)
})

test('list measurements grow and shrink within the maximum while width stays constant', async t => {
  const api = await fixture(t)
  const win = await showLoaded(api)
  for (const [requested, expected] of [[170, 170], [365, 365], [170, 170], [9999, 545], [248, 248], [1, 65]]) {
    api.setQuickContentSize({ width: 1800, height: requested })
    assertGeometry(api, { width: 720, height: expected })
  }
  api.setQuickContentHeight(248)
  const mutations = win.boundsHistory.length
  for (const height of [248, 0, -1, NaN, Infinity]) {
    api.setQuickContentHeight(height, true)
    assertGeometry(api)
  }
  api.finishQuickPluginReveal()
  assertGeometry(api)
  assert.equal(win.boundsHistory.length, mutations, 'unchanged or invalid measurements must not emit native resize work')
  assert.deepEqual(api.state.logs, [])
})

test('display changes clamp the expanded plugin and reopening returns to compact home', async t => {
  const api = await fixture(t)
  await showLoaded(api)
  api.setQuickContentSize({ height: 545 })
  const plugin = new api.View()
  api.getQuickPluginParent().addChildView(plugin)
  api.setQuickPluginRelayout(() => plugin.setBounds(api.getQuickPluginBounds()))
  for (const [event, area, expected] of [
    ['display-metrics-changed', { x: 100, y: 40, width: 620, height: 430 }, { width: 588, height: 398 }],
    ['display-removed', { x: -700, y: -200, width: 500, height: 350 }, { width: 468, height: 318 }],
    ['display-metrics-changed', { x: 0, y: 0, width: 1920, height: 1080 }, expandedSize]
  ]) {
    api.state.workArea = area
    api.screen.emit(event, {}, { id: 1, workArea: area }, ['workArea'])
    assertGeometry(api, expected)
    assert.deepEqual(plugin.getBounds(), api.getQuickPluginBounds())
  }
  api.hideQuickWindow()
  api.state.workArea = { x: 800, y: 0, width: 600, height: 400 }
  api.screen.emit('display-metrics-changed', {}, { id: 1, workArea: api.state.workArea }, ['workArea'])
  await showLoaded(api)
  assertGeometry(api, { width: 568, height: 248 })
})

test('destroy removes screen listeners and closes the owned renderer without accumulating handlers', async t => {
  const api = await fixture(t)
  for (let cycle = 0; cycle < 3; cycle++) {
    const win = await showLoaded(api)
    assert.equal(api.screen.listenerCount('display-metrics-changed'), 1)
    assert.equal(api.screen.listenerCount('display-removed'), 1)
    api.destroyQuickWindow()
    assert.equal(api.getQuickWindow(), null)
    assert.equal(api.getQuickPluginParent(), null)
    assert.equal(win.webContents.isDestroyed(), true)
    assert.equal(api.screen.listenerCount('display-metrics-changed'), 0)
    assert.equal(api.screen.listenerCount('display-removed'), 0)
    const mutations = win.boundsHistory.length
    api.screen.emit('display-metrics-changed')
    api.screen.emit('display-removed')
    assert.equal(win.boundsHistory.length, mutations)
  }
})

test('destroy during paste-target capture invalidates the pending show before a window can be created', async t => {
  const api = await fixture(t)
  let release
  api.state.captureGate = new Promise(resolve => { release = resolve })
  const showing = api.showQuickWindow()
  assert.equal(api.state.captureCalls, 1)
  api.destroyQuickWindow()
  release()
  assert.equal(await showing, false)
  assert.equal(api.getQuickWindow(), null)
  assert.equal(api.state.windows.length, 0)
  assert.equal(api.screen.listenerCount('display-metrics-changed'), 0)
})

test('late renderer load callbacks cannot show a hidden or destroyed Quick window', async t => {
  const api = await fixture(t)
  assert.equal(await api.showQuickWindow(), true)
  const hidden = api.getQuickWindow()
  assert.equal(hidden.isVisible(), false)
  api.hideQuickWindow('before-load')
  hidden.webContents.finishLoad()
  assert.equal(hidden.showAttempts, 0)
  assert.equal(api.isQuickVisible(), false)

  api.destroyQuickWindow()
  assert.equal(await api.showQuickWindow(), true)
  const destroyed = api.getQuickWindow()
  const oldLoad = destroyed.webContents.rawListeners('did-finish-load').at(-1)
  // A native close does not increment showRevision. The old callback must also
  // verify the window identity before touching a newly created replacement.
  destroyed.destroy()
  const replacement = api.ensureQuickWindow()
  oldLoad.call(destroyed.webContents)
  assert.equal(destroyed.showAttempts, 0)
  assert.equal(replacement.showAttempts, 0)
  assert.equal(api.getQuickWindow(), replacement)
  assert.equal(api.isQuickVisible(), false)
  assert.deepEqual(api.state.logs, [])
  await showLoaded(api)
  assertGeometry(api)
})

test('plugin docking waits for a ready Quick renderer without resetting the owner or capturing focus', async t => {
  const api = await fixture(t)
  let resets = 0
  api.setQuickPluginResetHook(() => { resets++ })
  const preparing = api.prepareQuickWindowForPlugin()
  const win = api.getQuickWindow()
  assert.equal(win.webContents.isLoadingMainFrame(), true)
  assert.equal(win.isVisible(), false)
  assert.equal(api.state.captureCalls, 0)
  assert.equal(resets, 0)
  win.webContents.finishLoad()
  assert.equal(await preparing, true)
  assert.equal(win.isVisible(), false)
  api.setQuickContentSize({ height: 545 })
  const revision = api.getQuickShowRevision()
  assert.equal(api.presentQuickWindowForPlugin(), true)
  assert.equal(win.isVisible(), true)
  assert.equal(api.getQuickShowRevision(), revision + 1)
  assertGeometry(api, expandedSize)
  const messages = win.webContents.messages.length
  assert.equal(await api.prepareQuickWindowForPlugin(), true)
  assert.equal(api.presentQuickWindowForPlugin(), true)
  assert.equal(win.webContents.messages.length, messages, 'already-visible Quick does not receive another renderer reset')
  assert.equal(resets, 0)
  assert.equal(api.state.captureCalls, 0)
})

test('Quick preparation cancellation and renderer failure leave the destination hidden', async t => {
  const api = await fixture(t)
  assert.equal(await api.prepareQuickWindowForPlugin(() => false), false)
  assert.equal(api.getQuickWindow(), null)
  const preparing = api.prepareQuickWindowForPlugin()
  const hidden = api.getQuickWindow()
  api.hideQuickWindow('cancel-dock')
  hidden.webContents.finishLoad()
  assert.equal(await preparing, false)
  assert.equal(hidden.isVisible(), false)
  assert.equal(hidden.webContents.listenerCount('did-fail-load'), 0)
  api.destroyQuickWindow()
  const idleWindow = api.ensureQuickWindow()
  const loadListeners = idleWindow.webContents.listenerCount('did-finish-load')
  const failing = api.prepareQuickWindowForPlugin()
  const failed = api.getQuickWindow()
  failed.webContents.emit('did-fail-load', {}, -2, 'load failed', 'file://fixture', true)
  assert.equal(await failing, false)
  assert.equal(failed.isVisible(), false)
  assert.equal(failed.webContents.listenerCount('did-finish-load'), loadListeners)
  assert.equal(failed.webContents.listenerCount('did-fail-load'), 0)
})

test('initial blank load and a finish event during navigation cannot commit Quick docking', async t => {
  const api = await fixture(t)
  let prepared = false, commits = 0
  const preparing = api.prepareQuickWindowForPlugin().then(value => { prepared = value; return value })
  const win = api.getQuickWindow(), targetUrl = win.webContents.url
  win.webContents.url = 'about:blank'
  win.webContents.finishLoad()
  await Promise.resolve()
  assert.equal(prepared, false)
  assert.equal(api.presentQuickWindowForPlugin(() => { commits++ }), false)
  win.webContents.url = targetUrl
  win.webContents.loading = true
  win.webContents.emit('did-finish-load')
  await Promise.resolve()
  assert.equal(prepared, false)
  assert.equal(api.presentQuickWindowForPlugin(() => { commits++ }), false)
  win.webContents.loading = false
  win.webContents.emit('did-stop-loading')
  assert.equal(await preparing, true)
  assert.equal(api.presentQuickWindowForPlugin(() => { assert.equal(win.isVisible(), true); commits++ }), true)
  assert.equal(commits, 1)
  assert.equal(win.webContents.listenerCount('did-stop-loading'), 0)
})

test('a failed native show cannot commit and failed attachment restores hidden presentation', async t => {
  const api = await fixture(t)
  const preparing = api.prepareQuickWindowForPlugin()
  const win = api.getQuickWindow()
  win.webContents.finishLoad(); await preparing
  let commits = 0
  const show = win.show
  win.show = () => { throw new Error('show failed') }
  assert.equal(api.presentQuickWindowForPlugin(() => { commits++ }), false)
  assert.equal(commits, 0)
  assert.equal(win.isVisible(), false)
  win.show = show
  assert.throws(() => api.presentQuickWindowForPlugin(() => { throw new Error('attach failed') }), /attach failed/)
  assert.equal(win.isVisible(), false)
})

test('direct plugin presentation resets the renderer before its mode event and preserves committed focus', async t => {
  const api = await fixture(t), order=[]
  const preparing=api.prepareQuickWindowForPlugin(),win=api.getQuickWindow()
  win.webContents.finishLoad();await preparing
  win.webContents.focus=()=>order.push('shell-focus')
  const send=win.webContents.send.bind(win.webContents)
  win.webContents.send=(channel,payload)=>{order.push(channel);send(channel,payload)}
  assert.equal(api.presentQuickWindowForPlugin(()=>{order.push('plugin-mode');order.push('plugin-focus')}),true)
  assert.ok(order.indexOf('quick:shown')<order.indexOf('plugin-mode'))
  assert.equal(order.filter(item=>item==='shell-focus'||item==='plugin-focus').at(-1),'plugin-focus')
})
