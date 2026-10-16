/** Build host and pack both plugins first. ENEST_WORKBENCH_SMOKE=1 node --test this-file.
 * Optional ENEST_TEST_SSH_PORT/USER/PASSWORD adds real SSH to the isolated profile.
 * Uses installed plugin assets, production CSP, real preloads and native services. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')
const root = fileURLToPath(new URL('../../../', import.meta.url))
async function poll(read, accept, timeout = 20000) {
  let value, error
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { value = await read(); if (accept(value)) return value } catch (e) { error = e }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw Error(`Workbench polling timed out: ${error?.message || JSON.stringify(value)}`)
}

// This is a full application correctness test, not a startup latency benchmark.
test('installed workbenches use real IPC/CSP and retain query and terminal across containers', { skip: process.env.ENEST_WORKBENCH_SMOKE !== '1', timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-workbench-app-')), dataRoot = join(dir, 'data'), userData = join(dir, 'profile')
  const dbId = 'com.github.eNest.database', sshId = 'com.github.eNest.ssh', ids = [dbId, sshId]
  let app, logs = ''
  try {
    const grants = {}
    for (const id of ids) {
      const source = join(root, 'eNest_plugin/plugins', id), sourceManifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))
      const archive = new AdmZip(join(root, 'eNest_plugin/dist', `${id}@${sourceManifest.version}.enestplugin`))
      const manifest = JSON.parse(archive.readAsText('plugin.json'))
      assert.equal(manifest.id, id); assert.equal(manifest.version, sourceManifest.version)
      const installedPath = join(dataRoot, 'plugins', id, manifest.version)
      await mkdir(installedPath, { recursive: true }); archive.extractAllTo(installedPath, true)
      grants[id] = { permissionGrants: Object.fromEntries(manifest.permissions.map(permission => [permission, 'allow'])) }
    }
    // Additional installed entries exercise the six-view LRU limit.
    const fillers = Array.from({ length: 7 }, (_, i) => `com.example.workbench.smoke${i}`)
    for (const id of fillers) {
      const target = join(dataRoot, 'plugins', id, '1.0.0'); await mkdir(target, { recursive: true })
      await writeFile(join(target, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', name: id, main: 'index.html', permissions: [] }))
      await writeFile(join(target, 'index.html'), '<!doctype html><title>LRU fixture</title><p>Idle installed plugin</p>')
    }
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', overrides: {} }, general: { quickLauncher: { enabled: true, hotkeys: [] }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: grants }))
    const { DatabaseSync } = await import('node:sqlite')
    const sqliteFile = join(dir, 'fixture.sqlite'), sqlite = new DatabaseSync(sqliteFile)
    sqlite.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO records VALUES(9007199254740993,'smoke')"); sqlite.close()
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env, timeout: 25000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
    await app.evaluate(({ app, webContents }) => {
      const observe = wc => wc.on('console-message', (_event, details) => { if (details.level === 'error' || details.level === 'warning') console.log('[workbench-renderer]', details.message) })
      webContents.getAllWebContents().forEach(observe)
      app.on('web-contents-created', (_event, wc) => observe(wc))
    })
    const inShell = code => app.evaluate(({ webContents }, code) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html'))
      if (!wc) throw Error('shell is loading')
      return wc.executeJavaScript(code)
    }, code)
    const inPlugin = (id, code) => app.evaluate(({ webContents }, { id, code }) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().includes(id))
      if (!wc) throw Error('plugin is loading')
      return wc.executeJavaScript(code)
    }, { id, code })
    const identity = id => app.evaluate(({ webContents }, id) => webContents.getAllWebContents().find(wc => wc.getURL().includes(id))?.id, id)
    await poll(() => inShell('typeof window.enestShell?.quickOpen'), value => value === 'function')
    await inShell(`window.enestShell.quickOpen({kind:'plugin',pluginId:${JSON.stringify(dbId)},container:'quick'})`)
    await poll(() => inPlugin(dbId, '!!document.querySelector(".wb-home")'), Boolean)
    await inPlugin(dbId, 'document.querySelector("[data-new]").click()')
    await poll(() => inPlugin(dbId, '!!document.querySelector("[data-k=driver]")'), Boolean)
    await inPlugin(dbId, `(()=>{const field=k=>document.querySelector('[data-k='+k+']');field('driver').value='sqlite';field('driver').dispatchEvent(new Event('change'));field('name').value='Smoke SQLite';field('sqlitePath').value=${JSON.stringify(sqliteFile)};document.querySelector('[data-act=save]').click()})()`)
    const savedState = await poll(() => inPlugin(dbId, "(async()=>({list:await window.enest.storage.get('db.connections'),hint:document.querySelector('[data-el=form-hint]')?.textContent,driver:document.querySelector('[data-k=driver]')?.value,options:[...document.querySelectorAll('[data-k=driver] option')].map(x=>x.value)}))()"), state => state.list?.some(item => item.name === 'Smoke SQLite'))
    const saved = savedState.list
    const connectionId = saved.find(item => item.name === 'Smoke SQLite').id
    await inShell(`window.enestShell.quickOpen({kind:'plugin',pluginId:${JSON.stringify(dbId)},container:'quick'})`)
    assert.equal(await inPlugin(dbId, 'window.enest.getLaunchMode()'), 'quick')
    assert.equal(await inPlugin(dbId, 'performance.getEntriesByType("resource").some(r=>r.name.includes("/vendor/monaco/"))'), false)
    await inPlugin(dbId, `document.querySelector('[data-connect="${connectionId}"]').click()`)
    await poll(() => inPlugin(dbId, '!!document.querySelector(".monaco-editor")'), Boolean)
    await inPlugin(dbId, `(async()=>{const {monaco}=await import('./assets/vendor/monaco/editor.js');window.__smokeEditor=monaco.editor.getEditors()[0];window.__smokeEditor.setValue('SELECT id,label FROM records;');document.querySelector('[data-action=run]').click()})()`)
    await poll(() => inPlugin(dbId, 'document.querySelector(".grid-viewport")?.textContent'), text => text?.includes('9007199254740993') && text.includes('smoke'))
    const before = await inPlugin(dbId, `(async()=>({model:window.__smokeEditor.getModel().id,value:window.__smokeEditor.getValue(),result:document.querySelector('.grid-viewport').textContent,sessions:await window.enest.db.listSessions()}))()`)
    const dbWc = await identity(dbId)
    await inPlugin(dbId, 'window.enest.ui.openInShell()')
    await poll(() => inPlugin(dbId, 'window.enest.getLaunchMode()'), value => value === 'shell')
    await inShell(`window.enestShell.quickOpen({kind:'plugin',pluginId:${JSON.stringify(dbId)},container:'quick'})`)
    await poll(() => inPlugin(dbId, 'window.enest.getLaunchMode()'), value => value === 'quick')
    const after = await inPlugin(dbId, `(async()=>({model:window.__smokeEditor.getModel().id,value:window.__smokeEditor.getValue(),result:document.querySelector('.grid-viewport').textContent,sessions:await window.enest.db.listSessions()}))()`)
    assert.equal(await identity(dbId), dbWc); assert.equal(after.model, before.model); assert.equal(after.value, before.value); assert.equal(after.result, before.result)
    assert.deepEqual(after.sessions.map(s => s.sessionKey), before.sessions.map(s => s.sessionKey))
    await inPlugin(dbId, 'window.enest.ui.openInShell()')
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(dbId)},{code:'settings'})`)
    await poll(() => inPlugin(dbId, 'document.querySelector(".wb-settings h1")?.textContent'), text => text === '数据库设置')
    // An actual uncommitted transaction must protect this installed view from LRU.
    await inPlugin(dbId, `(async()=>{const s=await window.enest.db.open({driver:'sqlite',filePath:${JSON.stringify(sqliteFile)}});window.__smokeTransaction=s.sessionKey;await window.enest.db.workbench({action:'transaction',input:{sessionKey:s.sessionKey,operation:'begin'}})})()`)
    await inShell(`window.enestShell.quickOpen({kind:'plugin',pluginId:${JSON.stringify(sshId)},container:'quick'})`)
    await poll(() => inPlugin(sshId, 'document.querySelector("#app")?.dataset.workbench'), value => value === 'ready')
    const sshWc = await identity(sshId)
    let sshSession
    if (process.env.ENEST_TEST_SSH_PORT) {
      const profile = { id: 'fixture', name: 'Smoke SSH', host: process.env.ENEST_TEST_SSH_HOST || '127.0.0.1', port: Number(process.env.ENEST_TEST_SSH_PORT), username: process.env.ENEST_TEST_SSH_USER || 'root', authType: 'password' }
      sshSession = await inPlugin(sshId, `(async()=>{const p=${JSON.stringify(profile)};window.SshWorkbenchBridge.store.upsertProfile(p);const s=await window.SshWorkbenchBridge.connectProfile(p,{ephemeralPassword:${JSON.stringify(process.env.ENEST_TEST_SSH_PASSWORD || '')}});if(!s?.sessionId)throw Error('SSH connection failed');return s.sessionId})()`)
      await inPlugin(sshId, `window.enest.ssh.write(${JSON.stringify(sshSession)},${JSON.stringify("printf '\\nenest_smoke_marker\\n'\r")})`)
      await poll(() => inPlugin(sshId, `(()=>{const b=window.SshWorkbenchBridge.activeSession()?.term?.raw?.buffer?.active;return b&&Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString().trim()).includes('enest_smoke_marker')})()`), Boolean)
    }
    await inPlugin(sshId, 'window.enest.ui.openInShell()')
    await poll(() => inPlugin(sshId, 'window.enest.getLaunchMode()'), value => value === 'shell')
    await inShell(`window.enestShell.quickOpen({kind:'plugin',pluginId:${JSON.stringify(sshId)},container:'quick'})`)
    assert.equal(await identity(sshId), sshWc)
    if (sshSession) assert.equal(await inPlugin(sshId, 'window.SshWorkbenchBridge.activeSession().sessionId'), sshSession)
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(sshId)},{code:'settings'})`)
    await poll(() => inPlugin(sshId, 'document.body.textContent'), text => text?.includes('SSH 设置') && text.includes('仅作用于 SSH 插件'))
    for (const id of fillers) await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => value.host.hibernated > 0)
    assert.equal(await identity(dbId), dbWc)
    if (sshSession) assert.equal(await identity(sshId), sshWc)
    await inPlugin(dbId, 'window.enest.db.workbench({action:"transaction",input:{sessionKey:window.__smokeTransaction,operation:"rollback"}})')
    await inShell(`Promise.all(${JSON.stringify([...ids, ...fillers])}.map(id=>window.enestShell.closePlugin(id)))`)
    const final = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => !value.host.closing && !value.host.retiring && !value.resources.length && !value.utilities.length)
    assert.equal(final.host.entries.length, 0)
    assert.doesNotMatch(logs, /Unable to load preload|uncaughtException|unhandledRejection/)
    console.log('Installed workbench evidence:', JSON.stringify({ source: 'enestplugin archives', database: 'SQLite', ssh: !!sshSession, reusedWebContents: true, preservedModelResultAndSessions: true, pluginSettingsPages: true, installedLruProtection: true, remainingResources: final.resources.length, remainingUtilities: final.utilities.length }))
  } catch (error) { throw Error(`${error.stack || error}\nApplication log:\n${logs}`) }
  finally { if (app) await app.close().catch(() => app.process().kill('SIGKILL')); await rm(dir, { recursive: true, force: true }) }
})
