import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state': 'export const state={handlers:new Map(),keys:new Map(),win:null};',
  electron: `import {state} from 'test-state';export const shell={openExternal:async()=>{}};export const ipcMain={handle:(channel,listener)=>state.handlers.set(channel,listener),on:()=>{}};
    export const globalShortcut={register:(acc,callback)=>{if(state.keys.has(acc))return false;state.keys.set(acc,callback);return true},unregister:acc=>state.keys.delete(acc),unregisterAll:()=>state.keys.clear(),isRegistered:acc=>state.keys.has(acc)};`,
  '@main/logs/logService': 'export const logWarn=()=>{};export const logError=()=>{};',
  '@main/window/createShellWindow': "import {state} from 'test-state';export const getMainWindow=()=>state.win;",
  '@main/hotkey/pluginShortcuts': `export {beginShortcutCapture,endShortcutCapture,endShortcutCapturesForOwner} from '@main/hotkey/hotkeyRegistry';
    export const getPluginShortcuts=()=>({bindings:[],states:[]});export const savePluginShortcut=()=>({ok:true});export const removePluginShortcut=()=>({ok:true});export const probePluginShortcut=()=>({status:'free'});export const launchPluginShortcut=()=>({ok:true});`
}
const output = await build({
  stdin: { contents: "export * from '@main/ipc/shortcutHandlers';export * from '@main/ipc/ipcSecurity';export * from '@main/hotkey/hotkeyRegistry';export {IpcChannels} from '@shared/types/ipc';export {state} from 'test-state';", resolveDir: root },
  tsconfig: root + 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'capture-ipc-fixtures', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: adapters[path], resolveDir: root }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
const { state, IpcChannels: channels } = api
api.registerShortcutHandlers()
let sequence = 0
function surface(role = 'shell', trusted = true) {
  const wc = new EventEmitter()
  wc.id = ++sequence
  wc.focused = true
  wc.destroyed = false
  wc.mainFrame = { url: 'file:///fixture/index.html' }
  wc.isDestroyed = () => wc.destroyed
  wc.isFocused = () => wc.focused
  wc.setWindowOpenHandler = () => {}
  if (trusted) api.registerTrustedSurface(wc, role, wc.mainFrame.url)
  const event = { sender: wc, senderFrame: wc.mainFrame }
  return { wc, event, call: (channel, ...args) => state.handlers.get(channel)(event, ...args) }
}
test.beforeEach(() => {
  api.disposeHotkeyRegistry()
  state.win = new EventEmitter()
  state.win.focused = true
  state.win.destroyed = false
  state.win.isDestroyed = () => state.win.destroyed
  state.win.isFocused = () => state.win.focused
  const owner = { kind: 'quick', id: 'launcher' }
  assert.equal(api.applyHotkeyChanges([{ owner, registration: { owner, accelerator: 'Alt+Space', onFire() {} } }]).ok, true)
})
test.after(() => api.disposeHotkeyRegistry())

test('shortcut IPC accepts only the current trusted shell document and top frame', () => {
  const untrusted = surface('shell', false)
  assert.throws(() => untrusted.call(channels.ShellBeginShortcutCapture), /untrusted/)
  for (const role of ['quick', 'orb', 'detached']) {
    const client = surface(role)
    assert.throws(() => client.call(channels.ShellBeginShortcutCapture), /capability/)
    assert.throws(() => client.call(channels.ShellSavePluginShortcut, {}), /capability/)
  }
  const client = surface()
  assert.throws(() => state.handlers.get(channels.ShellBeginShortcutCapture)({ ...client.event, senderFrame: { url: client.wc.mainFrame.url } }), /untrusted/)
  client.wc.mainFrame.url = 'https://example.invalid/index.html'
  assert.throws(() => client.call(channels.ShellBeginShortcutCapture), /document/)
  assert.equal(state.keys.size, 1)
})

test('capture requires both the main window and the shell web contents to be focused', () => {
  const client = surface()
  state.win.focused = false
  assert.throws(() => client.call(channels.ShellBeginShortcutCapture), /聚焦/)
  state.win.focused = true
  client.wc.focused = false
  assert.throws(() => client.call(channels.ShellBeginShortcutCapture), /聚焦/)
  client.wc.focused = true
  state.win.destroyed = true
  assert.throws(() => client.call(channels.ShellBeginShortcutCapture), /聚焦/)
  state.win = null
  assert.throws(() => client.call(channels.ShellBeginShortcutCapture), /聚焦/)
  assert.equal(state.keys.size, 1)
})

test('capture tokens are bound to the actual sender ID and ignore renderer-provided owner IDs', () => {
  const first = surface()
  const other = surface()
  const { token } = first.call(channels.ShellBeginShortcutCapture, other.wc.id)
  assert.equal(state.keys.size, 0)
  other.call(channels.ShellEndShortcutCapture, token, first.wc.id)
  assert.equal(state.keys.size, 0)
  first.call(channels.ShellEndShortcutCapture, token)
  assert.equal(state.keys.size, 1)
  first.call(channels.ShellEndShortcutCapture, token)
  assert.equal(state.keys.size, 1)
})

test('web contents blur, navigation, crash and window blur/hide all release pending capture', () => {
  const client = surface()
  for (const [target, event] of [
    [client.wc, 'blur'], [client.wc, 'did-start-navigation'], [client.wc, 'render-process-gone'],
    [state.win, 'blur'], [state.win, 'hide']
  ]) {
    client.call(channels.ShellBeginShortcutCapture)
    assert.equal(state.keys.size, 0, event)
    target.emit(event)
    assert.equal(state.keys.size, 1, event)
    assert.equal(api.isShortcutCaptureActive(), false, event)
  }
  assert.equal(state.win.listenerCount('blur'), 1, 'repeated captures must not add duplicate listeners')
  assert.equal(state.win.listenerCount('hide'), 1)
})

test('destroying the shell restores shortcuts and removes listeners from the long-lived window', () => {
  const client = surface()
  client.call(channels.ShellBeginShortcutCapture)
  assert.equal(state.win.listenerCount('blur'), 1)
  assert.equal(state.win.listenerCount('hide'), 1)
  client.wc.destroyed = true
  client.wc.emit('destroyed')
  assert.equal(state.keys.size, 1)
  assert.equal(api.isShortcutCaptureActive(), false)
  assert.equal(state.win.listenerCount('blur'), 0)
  assert.equal(state.win.listenerCount('hide'), 0)
  assert.throws(() => client.call(channels.ShellBeginShortcutCapture), /untrusted/)
})
