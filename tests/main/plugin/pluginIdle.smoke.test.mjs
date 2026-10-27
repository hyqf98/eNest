/** Real default three-minute idle policy; no fake clock or reduced host timeout. */
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
async function poll(read, accepts, label, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout
  let value, error
  while (Date.now() < deadline) {
    try { value = await read(); if (accepts(value)) return value } catch (e) { error = e }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}

test('real three-minute A to B idle destroys only A and restores its checkpoint on wake', { skip: process.env.ENEST_IDLE_SMOKE !== '1', timeout: 240000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-idle-smoke-')), dataRoot = join(dir, 'data')
  const ids = ['com.example.smoke.idle-a', 'com.example.smoke.idle-b']
  let app, logs = ''
  try {
    for (const id of ids) {
      const fixture = join(dataRoot, 'plugins', id, '1.0.0')
      await mkdir(join(fixture, 'assets/market/screenshots'), { recursive: true })
      await writeFile(join(fixture, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#257"/></svg>')
      await writeFile(join(fixture, 'assets/market/README.md'), '# Native idle fixture')
      await writeFile(join(fixture, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      await writeFile(join(fixture, 'plugin.json'), JSON.stringify({ id, name: id, description: 'Three minute native idle policy fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] }, permissions: ['storage.local'] }))
      await writeFile(join(fixture, 'index.html'), '<!doctype html><html><body><p id="state">Starting</p><script src="assets/fixture.js"></script></body></html>')
      await writeFile(join(fixture, 'assets/fixture.js'), `
        window.__ready = false; window.__draft = 0;
        enest.onBeforeSuspend(async () => { await enest.storage.session.set('draft', window.__draft); });
        enest.storage.session.get('draft').then(value => { window.__draft = value ?? 0; document.getElementById('state').textContent = String(window.__draft); window.__ready = true; });
      `)
    }
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ general: { quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: Object.fromEntries(ids.map(id => [id, { permissionGrants: { 'storage.local': 'allow' } }])) }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: join(dir, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    app.process().stdout.on('data', chunk => { logs = (logs + chunk).slice(-30000) }); app.process().stderr.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
    const inShell = code => app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html')).executeJavaScript(code), code)
    const inPlugin = (id, code) => app.evaluate(({ webContents }, { id, code }) => webContents.getAllWebContents().find(wc => wc.getURL().includes(`/${id}/`)).executeJavaScript(code), { id, code })
    await poll(() => inShell('typeof window.enestShell?.openPlugin'), value => value === 'function', 'shell ready')
    await poll(() => inShell('Boolean(document.querySelector(".app-boot.ready .market-grid"))'), Boolean, 'shell initial render')
    await new Promise(resolve => setTimeout(resolve, 250))
    for (const id of ids) {
      await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
      await poll(() => inPlugin(id, 'window.__ready'), Boolean, `${id} ready`)
    }
    // Both are now warm. Activate A, make an unsaved business draft, then select B.
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(ids[0])})`)
    await inPlugin(ids[0], 'window.__draft = 42')
    const before = await inShell('window.enestShell.getPluginDiagnostics()')
    const aId = before.host.entries.find(entry => entry.pluginId === ids[0]).wcId
    const bId = before.host.entries.find(entry => entry.pluginId === ids[1]).wcId
    await app.evaluate(({ webContents }, aId) => {
      globalThis.__idleSmoke = { startedAt: Date.now(), destroyedAfterMs: null }
      webContents.fromId(aId).once('destroyed', () => { globalThis.__idleSmoke.destroyedAfterMs = Date.now() - globalThis.__idleSmoke.startedAt })
    }, aId)
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(ids[1])})`)
    const selected = await inShell('window.enestShell.getPluginDiagnostics()')
    assert.equal(selected.host.entries.find(entry => entry.pluginId === ids[0]).state, 'background')
    assert.equal(selected.host.entries.find(entry => entry.pluginId === ids[1]).state, 'active')
    console.log('Real idle timer started; leaving A in background and B selected for the production 180 seconds')
    const idle = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => value.host.hibernated === 1 && value.host.entries.length === 1 && value.host.entries[0].pluginId === ids[1] && !value.host.closing, 'default 180-second idle hibernation', 215000, 1000)
    const timing = await app.evaluate(() => globalThis.__idleSmoke)
    assert.ok(timing.destroyedAfterMs >= 179000 && timing.destroyedAfterMs < 215000, JSON.stringify(timing))
    assert.equal(idle.host.entries[0].wcId, bId); assert.equal(idle.host.entries[0].state, 'active')
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(ids[0])})`)
    await poll(() => inPlugin(ids[0], 'window.__ready'), Boolean, 'woken A ready')
    assert.equal(await inPlugin(ids[0], 'window.__draft'), 42)
    const restored = await inShell('window.enestShell.getPluginDiagnostics()')
    const restoredA = restored.host.entries.find(entry => entry.pluginId === ids[0])
    assert.notEqual(restoredA.wcId, aId); assert.equal(restoredA.state, 'active')
    for (const id of ids) await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    const cleanup = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => !value.host.closing && !value.host.retiring && value.host.entries.length === 0 && value.resources.length === 0, 'idle fixture cleanup')
    assert.equal(cleanup.session.residentBytes, 0)
    const evidence = { platform: process.platform, measuredAt: new Date().toISOString(), policy: 'production default 180 seconds; real elapsed clock', before, selected, timing, idle, restored: { originalWcId: aId, newWcId: restoredA.wcId, draft: 42, selectedBRetained: bId }, cleanup }
    const evidenceRoot = join(root, '.cache/verification/plugin-idle')
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log('Real idle native evidence:', JSON.stringify({ destroyedAfterMs: timing.destroyedAfterMs, oldA: aId, newA: restoredA.wcId, retainedB: bId, restoredDraft: 42 }))
  } catch (error) { throw new Error(`${error.stack || error}\n${logs}`) }
  finally { if (app) await app.close().catch(() => app.process().kill('SIGKILL')); await rm(dir, { recursive: true, force: true }) }
})
