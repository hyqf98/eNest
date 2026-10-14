/** Build first, then ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginBuiltinCapabilities.smoke.test.mjs.
 * ENEST_BUILTIN_SMOKE_OUTPUT optionally writes public evidence outside the temporary profile. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
async function poll(read, accepts, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value, error
  while (Date.now() < deadline) {
    try { value = await read(); if (accepts(value)) return value } catch (failure) { error = failure }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}

test('a sandboxed plugin with no permissions uses built-in capabilities without prompts and cannot access system APIs', {
  skip: process.env.ENEST_APP_SMOKE !== '1', timeout: 60000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-builtin-capabilities-'))
  const dataRoot = join(directory, 'data'), userData = join(directory, 'profile')
  const id = 'com.enest.smoke.builtin', title = '零敏感权限插件'
  let app, logs = ''
  const evidence = { platform: process.platform, fixture: id, declaredPermissions: [], tests: [] }
  try {
    const fixture = join(dataRoot, 'plugins', id, '1.0.0')
    await mkdir(join(fixture, 'assets/market/screenshots'), { recursive: true })
    await writeFile(join(fixture, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#247b68"/></svg>')
    await writeFile(join(fixture, 'assets/market/README.md'), '# Zero permission fixture')
    await writeFile(join(fixture, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    // Omit permissions altogether: built-in APIs must not need declarations.
    await writeFile(join(fixture, 'plugin.json'), JSON.stringify({ id, name: title, description: 'Built-in capability policy native fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] } }))
    await writeFile(join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Built-in capability fixture</title></head><body><h1>Built-in capability fixture</h1></body></html>')
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ general: { quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: { [id]: { permissionGrants: { 'storage.local': 'deny', 'ui.setTitle': 'deny', 'settings.register': 'deny', theme: 'deny' } } } }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-50000) })
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    await app.evaluate(({ dialog }) => {
      globalThis.__builtinPromptCount = 0
      dialog.showMessageBox = async () => { globalThis.__builtinPromptCount++; return { response: 0, checkboxChecked: false } }
    })
    const inSurface = (surface, code) => app.evaluate(({ webContents }, { surface, code, id }) => {
      const wc = webContents.getAllWebContents().find(wc => surface === 'shell'
        ? wc.getURL().includes('/out/renderer/index.html')
        : wc.getURL().startsWith(`enest://plugin/${id}/`))
      if (!wc) throw new Error(surface + ' web contents missing')
      return wc.executeJavaScript(code)
    }, { surface, code, id })
    const inShell = code => inSurface('shell', code), inPlugin = code => inSurface('plugin', code)
    await poll(() => inShell('typeof window.enestShell?.openPlugin'), value => value === 'function', 'shell preload')
    await inShell("window.__builtinTabs=[];void window.enestShell.onEvent(event=>{if(event.type==='plugin-tabs')window.__builtinTabs=event.tabs})")
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    await poll(() => inPlugin('typeof window.enest?.storage?.set'), value => value === 'function', 'plugin preload')
    evidence.sandbox = await app.evaluate(({ webContents }, id) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(`enest://plugin/${id}/`))
      const prefs = wc.getLastWebPreferences()
      return prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration
    }, id)
    assert.equal(evidence.sandbox, true)
    assert.equal(await inPlugin('typeof require === "undefined" && typeof process === "undefined"'), true)
    const basic = await inPlugin(`(async () => {
      await window.enest.storage.set('draft', 'persisted note');
      await window.enest.storage.session.set('session-note', 'temporary note');
      await window.enest.ui.setTitle('无需授权的标题');
      await window.enest.settings.register({id:'display',title:'Display',items:[{key:'density',type:'text',label:'Density'},{key:'permissionGrants',type:'text',label:'Forbidden'}]});
      await window.enest.settings.set('density', 'compact');
      const theme = await window.enest.theme.register({id:'builtin-policy-smoke',name:'Policy smoke',tokens:{'--accent':'#247b68'}});
      return {storage:await window.enest.storage.get('draft'),session:await window.enest.storage.session.get('session-note'),setting:await window.enest.settings.get('density'),theme};
    })()`)
    assert.equal(basic.storage, 'persisted note')
    assert.equal(basic.session, 'temporary note')
    assert.equal(basic.setting, 'compact')
    assert.equal(basic.theme.source, id)
    assert.equal(basic.theme.tokens['--accent'], '#247b68')
    await poll(() => inShell('window.__builtinTabs'), tabs => tabs.some(tab => tab.title === '无需授权的标题'), 'host title snapshot')
    evidence.tests.push('storage, session storage, settings, title and theme work without manifest permissions or native prompts, ignoring legacy denials')
    const maliciousTheme = await inPlugin(`window.enest.theme.register({id:'builtin-policy-smoke',name:'Policy smoke',source:'enest.builtin',tokens:{'--accent':'#247b68'},background:{type:'color',value:'url(https://example.invalid/track)',opacity:1,fit:'cover'}})`)
    assert.equal(maliciousTheme.source, id)
    assert.equal(maliciousTheme.background, undefined)
    evidence.tests.push('theme source is host-bound and remote CSS background is stripped before reaching shell rendering')
    const rejected = await inPlugin(`(async () => {
      const result = {};
      for (const [name, action] of [
        ['file',()=>window.enest.localFiles.read({handleId:'forged'})],
        ['network',()=>window.enest.net.fetch({url:'https://example.invalid/'})],
        ['clipboard',()=>window.enest.clipboard.readText()],
        ['globalSearch',()=>window.enest.contribute.registerQuickProvider({id:'global-search'})],
        ['settingsRead',()=>window.enest.settings.get('permissionGrants')],
        ['settingsWrite',()=>window.enest.settings.set('permissionGrants',{'fs.read':'allow','net.fetch':'allow'})]
      ]) {try {await action();result[name]='unexpected success'} catch(error) {result[name]=error.message}}
      return result;
    })()`)
    assert.match(rejected.file, /permission denied: fs.read/)
    assert.match(rejected.network, /permission denied: net.fetch/)
    assert.match(rejected.clipboard, /permission denied: clipboard.read/)
    assert.match(rejected.globalSearch, /permission denied: contribute/)
    assert.match(rejected.settingsRead, /reserved plugin settings key/)
    assert.match(rejected.settingsWrite, /reserved plugin settings key/)
    evidence.rejected = rejected
    evidence.tests.push('undeclared external file, network, clipboard and global search-provider access rejected; settings cannot read or overwrite host authorization')
    evidence.nativePrompts = await app.evaluate(() => globalThis.__builtinPromptCount)
    assert.equal(evidence.nativePrompts, 0)
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    const cleanup = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), state => !state.host.entries.length && !state.host.closing && !state.host.retiring && !state.resources.length, 'runtime cleanup')
    evidence.cleanup = { instances: cleanup.host.entries.length, resources: cleanup.resources.length, sessionBytes: cleanup.session.residentBytes }
    assert.equal(cleanup.session.residentBytes, 0)
    if (process.env.ENEST_BUILTIN_SMOKE_OUTPUT) {
      await mkdir(dirname(process.env.ENEST_BUILTIN_SMOKE_OUTPUT), { recursive: true })
      await writeFile(process.env.ENEST_BUILTIN_SMOKE_OUTPUT, JSON.stringify(evidence, null, 2))
    }
    console.log('Built-in capability evidence:', JSON.stringify(evidence))
  } catch (error) {
    throw new Error(`${error.stack || error}\nApplication logs:\n${logs}`)
  } finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(directory, { recursive: true, force: true })
  }
})
