/** Build first, then: ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginApp.smoke.test.mjs
 * Optional ENEST_APP_SMOKE_EXECUTABLE runs a packaged app using the same isolated fixtures. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
async function poll(read, accepts, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value, error
  while (Date.now() < deadline) {
    try { value = await read(); if (accepts(value)) return value } catch (e) { error = e }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Smoke polling timed out: ${error?.message || JSON.stringify(value)}`)
}

test('built application loads actual preloads and retires every plugin after immediate tab close', { skip: process.env.ENEST_APP_SMOKE !== '1', timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-app-smoke-'))
  const dataRoot = join(dir, 'data-root'), userData = join(dir, 'electron-user-data')
  const ids = ['com.example.smoke.normal', 'com.example.smoke.stalled', 'com.example.smoke.third']
  let app, stderr = '', stdout = ''
  try {
    for (const id of ids) {
      const fixture = join(dataRoot, 'plugins', id, '1.0.0')
      await mkdir(join(fixture, 'assets/market/screenshots'), { recursive: true })
      await writeFile(join(fixture, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#257"/></svg>')
      await writeFile(join(fixture, 'assets/market/README.md'), '# Isolated smoke fixture')
      await writeFile(join(fixture, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      await writeFile(join(fixture, 'plugin.json'), JSON.stringify({ id, name: id, description: 'Isolated native lifecycle smoke fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: {readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png']}, permissions: ['storage.local', 'timer.background', 'notify'] }))
      await writeFile(join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Lifecycle smoke</title></head><body><p>Plugin lifecycle smoke</p><script src="assets/fixture.js"></script></body></html>')
      await writeFile(join(fixture, 'assets/fixture.js'), `
        window.__smokeReady = false;
        window.enest.onBeforeClose(${id.endsWith('stalled') ? '() => new Promise(() => {})' : "async () => { await window.enest.storage.session.set('closed', true); }"});
        window.enest.storage.session.set('counter', 1).then(() => { window.__smokeReady = true; }).catch(e => { window.__smokeError = e.message; });
      `)
    }
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', overrides: {} }, general: { quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: Object.fromEntries(ids.map(id => [id, { permissionGrants: { 'storage.local': 'allow', 'timer.background': 'allow' } }])) }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    delete env.ENEST_REMOTE_DEBUG
    const packagedExecutable = process.env.ENEST_APP_SMOKE_EXECUTABLE
    app = await electron.launch({ executablePath: packagedExecutable || require('electron'), args: packagedExecutable ? [] : [root], env, timeout: 25000 })
    app.process().stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64000) })
    app.process().stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64000) })
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    const inShell = code => app.evaluate(({ webContents }, code) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html'))
      if (!wc) throw new Error('Shell web contents not created')
      return wc.executeJavaScript(code)
    }, code)
    await poll(() => inShell('typeof window.enestShell?.getPluginDiagnostics'), value => value === 'function')
    const plugins = await inShell('window.enestShell.getPlugins()')
    assert.ok(ids.every(id => plugins.some(plugin => plugin.id === id && plugin.installed)), JSON.stringify(plugins))
    const baseline = await inShell('window.enestShell.getPluginDiagnostics()')
    assert.equal(baseline.host.entries.length, 0)
    // Sandboxed auxiliary windows cannot execute ESM preloads. Exercise the
    // actual standalone CJS artifacts, including inside a packaged app.asar.
    const auxiliary = await app.evaluate(async ({ app, BrowserWindow }) => {
      const result = []
      for (const [name, bridge, method] of [['recorderPreload', 'recorderBridge', 'chunk'], ['regionOverlayPreload', 'regionOverlay', 'confirm'], ['pinPreload', 'pinCtl', 'close']]) {
        const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: app.getAppPath() + '/out/preload/' + name + '.cjs' } })
        try {
          await probe.loadURL('data:text/html;charset=utf-8,<title>Isolated preload probe</title>')
          result.push({ name, sandbox: probe.webContents.getLastWebPreferences().sandbox, method: await probe.webContents.executeJavaScript(`typeof window.${bridge}?.${method}`) })
        } finally { probe.destroy() }
      }
      return result
    })
    assert.ok(auxiliary.every(item => item.sandbox && item.method === 'function'), JSON.stringify(auxiliary))
    const shellSandbox = await app.evaluate(({webContents}) => webContents.getAllWebContents().filter(wc => wc.getURL().includes('/out/renderer/')).every(wc => wc.getLastWebPreferences().sandbox))
    assert.equal(shellSandbox, true)
    const measurements = []
    for (let cycle = 0; cycle < 2; cycle++) {
      const openedAt = Date.now()
      for (const id of ids) await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
      await poll(() => app.evaluate(async ({ webContents }, ids) => {
        const contents = webContents.getAllWebContents().filter(wc => ids.some(id => wc.getURL().includes(id)))
        return Promise.all(contents.map(wc => wc.executeJavaScript('({ ready: window.__smokeReady, error: window.__smokeError, bridge: typeof window.enest?.onBeforeClose, noNode: typeof require === "undefined" && typeof process === "undefined" })')))
      }, ids), values => values.length === ids.length && values.every(value => value.ready && value.bridge === 'function' && value.noNode))
      const openMs = Date.now() - openedAt
      const active = await inShell('window.enestShell.getPluginDiagnostics()')
      assert.equal(active.host.entries.length, ids.length)
      assert.equal(active.resources.length, ids.length)
      assert.equal(active.session.plugins, ids.length)
      await app.evaluate(({ webContents }, ids) => {
        const timing = { startedAt: Date.now(), destroyed: [] }
        globalThis.__enestSmokeNativeClose = timing
        for (const wc of webContents.getAllWebContents()) {
          const id = ids.find(id => wc.getURL().includes(id))
          if (id) wc.once('destroyed', () => timing.destroyed.push({ id, ms: Date.now() - timing.startedAt }))
        }
      }, ids)
      const closedAt = Date.now()
      await inShell(`Promise.all(${JSON.stringify(ids)}.map(id => window.enestShell.closePlugin(id)))`)
      const ackMs = Date.now() - closedAt
      const immediate = await inShell('window.enestShell.getPluginDiagnostics()')
      assert.equal(immediate.host.logicalTabs, 0)
      assert.equal(immediate.host.entries.length, 0)
      const after = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => value.host.closing === 0 && value.host.retiring === 0 && value.resources.length === 0, 5000)
      assert.equal(after.host.opening, 0)
      assert.equal(after.host.hibernated, 0)
      assert.equal(after.session.plugins, 0)
      assert.equal(after.session.residentBytes, 0)
      const nativeRemaining = await app.evaluate(({ webContents }, ids) => webContents.getAllWebContents().filter(wc => ids.some(id => wc.getURL().includes(id))).length, ids)
      assert.equal(nativeRemaining, 0)
      const destroyed = await app.evaluate(() => globalThis.__enestSmokeNativeClose.destroyed)
      assert.equal(destroyed.length, ids.length)
      measurements.push({ cycle, openMs, closeAckMs: ackMs, cleanupObservedMs: Date.now() - closedAt, destroyed, instances: after.host.entries.length, nativeRemaining, activities: after.resources.length, sessionBytes: after.session.residentBytes })
    }
    // A secondary optional permission may settle after close. It must not start
    // a persistent task for the closed generation or a subsequently reopened one.
    const timerId = ids[0]
    await app.evaluate(({ dialog }) => {
      globalThis.__smokeOriginalDialog = dialog.showMessageBox
      globalThis.__smokeNativePrompt = false
      dialog.showMessageBox = () => new Promise(resolve => {
        globalThis.__smokeNativePrompt = true
        globalThis.__smokeResolvePrompt = resolve
      })
    })
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(timerId)})`)
    const inPlugin = code => app.evaluate(({ webContents }, { id, code }) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().includes(id))
      if (!wc) throw new Error('Fixture web contents missing')
      return wc.executeJavaScript(code)
    }, { id: timerId, code })
    await poll(() => inPlugin('window.__smokeReady'), Boolean)
    await inPlugin("void window.enest.focusTimer.start({ notify: true }).catch(() => {})")
    await poll(() => app.evaluate(() => globalThis.__smokeNativePrompt), Boolean)
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(timerId)})`)
    await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => value.host.closing === 0 && value.resources.length === 0)
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(timerId)})`)
    await poll(() => inPlugin('window.__smokeReady'), Boolean)
    await app.evaluate(({ dialog }) => { globalThis.__smokeResolvePrompt({response: 1, checkboxChecked: false}); dialog.showMessageBox = globalThis.__smokeOriginalDialog })
    assert.equal((await inPlugin('window.enest.focusTimer.get()')).state.status, 'idle')
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(timerId)})`)
    await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => value.host.closing === 0 && value.resources.length === 0)
    assert.doesNotMatch(stderr + stdout, /Unable to load preload|uncaughtException|unhandledRejection|Error invoking remote method/)
    console.log('Built app lifecycle evidence:', JSON.stringify({ platform: process.platform, packaged: Boolean(packagedExecutable), shellSandbox, auxiliary, measurements }))
  } catch (error) {
    throw new Error(`${error.stack || error}\nApplication stdout:\n${stdout}\nApplication stderr:\n${stderr}`)
  } finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(dir, { recursive: true, force: true })
  }
})
