import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
async function fixture() {
  const result = await build({
    stdin: { contents: `export * from './src/main/window/mainWindowState.ts'; export * from './src/shared/windowState.ts'; export { setDetachedAppearanceSink, sendShellEvent } from './src/main/window/createShellWindow.ts'; export { screen } from 'electron'; export { settingsStore } from '@main/settings/SettingsStore';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: `${root}/tsconfig.node.json`,
    plugins: [{ name: 'window-state-fixture', setup(build) {
      build.onResolve({ filter: /^(electron|@main\/settings\/SettingsStore|@main\/ipc\/ipcSecurity)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron'
        ? `import { EventEmitter } from 'node:events'; export const app = {}, nativeImage = {}; export class BaseWindow {}; export class WebContentsView {}; export const screen = new EventEmitter(); screen.area = {x: -1440, y: 0, width: 1440, height: 900}; screen.getDisplayMatching = () => ({workArea: screen.area});`
        : args.path === '@main/ipc/ipcSecurity' ? `export const registerTrustedSurface = () => {};`
        : `export const settingsStore = { state: {general: {}}, writes: [], getAll() { return this.state }, async setAll(patch) { this.writes.push(structuredClone(patch)); this.state.general = {...this.state.general, ...patch.general} } };` }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
}

test('history rejects corrupted bounds and layout while copying valid negative-DIP geometry', async () => {
  const { normalizeWindowGeometry, normalizeDetachedWindowSession } = await fixture()
  const saved = { mode: 'quick', bounds: { x: -1250.4, y: 40, width: 700, height: 520 }, alwaysOnTop: true, minimized: 'yes' }
  const normalized = normalizeDetachedWindowSession(saved)
  assert.equal(normalized.bounds.x, -1250)
  assert.equal(normalized.alwaysOnTop, true)
  assert.equal(normalized.minimized, false)
  saved.bounds.width = 5
  assert.equal(normalized.bounds.width, 700)
  for (const bounds of [{x: NaN,y:0,width:700,height:500},{x:0,y:Infinity,width:700,height:500},{x:0,y:0,width:0,height:500},{x:0,y:0,width:30000,height:500}]) assert.equal(normalizeWindowGeometry({bounds}), undefined)
  assert.equal(normalizeDetachedWindowSession({ ...saved, mode: 'unknown' }), undefined)
})

test('window history does not broadcast appearance updates to every independent renderer', async () => {
  const api = await fixture()
  let appearances = 0
  api.setDetachedAppearanceSink(() => { appearances++ })
  api.sendShellEvent({ type: 'settings-changed', generalKeys: ['mainWindowState', 'sessionTabs', 'sessionActivePluginId'] })
  assert.equal(appearances, 0)
  api.sendShellEvent({ type: 'settings-changed', generalKeys: ['fontFamily'] })
  api.sendShellEvent({ type: 'theme-changed', mode: 'dark' })
  assert.equal(appearances, 2)
})

test('main window clamps removed-display positions, coalesces move events and freezes before cleanup', async () => {
  const api = await fixture()
  api.settingsStore.state.general.mainWindowState = { bounds: { x: 9000, y: -5000, width: 1200, height: 800 }, maximized: true }
  assert.deepEqual(api.readMainWindowState().bounds, { x: -1200, y: 0, width: 1200, height: 800 })
  const win = new EventEmitter()
  let bounds = { x: -1300, y: 30, width: 1000, height: 700 }, minimized = false
  Object.assign(win, {
    isDestroyed: () => false, getNormalBounds: () => ({...bounds}), getBounds: () => ({...bounds}),
    isMaximized: () => false, isMinimized: () => minimized,
    setBounds: value => { bounds = value; win.emit('resize') }
  })
  api.trackMainWindowState(win)
  for (let i = 0; i < 100; i++) { bounds.x++; win.emit('move') }
  assert.equal(api.settingsStore.writes.length, 0, 'no settings writes on the move hot path')
  api.flushMainWindowState()
  assert.equal(api.settingsStore.writes.length, 1)
  assert.equal(api.settingsStore.writes[0].general.mainWindowState.bounds.x, -1200)
  api.screen.area = { x: 0, y: 0, width: 1920, height: 1080 }
  api.screen.emit('display-removed')
  assert.equal(bounds.x, 0, 'unplugged screen leaves the title bar reachable')
  minimized = true
  api.flushMainWindowState(true)
  assert.equal(api.settingsStore.writes.at(-1).general.mainWindowState.minimized, true)
  const count = api.settingsStore.writes.length
  minimized = false; win.emit('restore'); win.emit('close')
  api.flushMainWindowState()
  assert.equal(api.settingsStore.writes.length, count, 'quit native events cannot replace saved layout')
  win.emit('closed')
  assert.equal(api.screen.listenerCount('display-removed'), 0)
  assert.equal(api.screen.listenerCount('display-metrics-changed'), 0)
})
