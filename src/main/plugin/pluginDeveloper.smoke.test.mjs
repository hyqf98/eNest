/** Build the shell and real SSH plugin before ENEST_DEVELOPER_SMOKE=1. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, cp, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { _electron as electron } from 'playwright-core'
const require = createRequire(import.meta.url)
const root = process.cwd()
async function poll(read, accepts, label, timeout = 15000) {
  let value, error
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { value = await read(); if (accepts(value)) return value } catch (caught) { error = caught }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}

test('real SSH starts from its own package, DevTools/logs work, and developer removal preserves data', {
  skip: process.env.ENEST_DEVELOPER_SMOKE !== '1', timeout: 90000
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-developer-')), dataRoot = join(dir, 'data')
  const source = join(root, 'eNest_plugin/plugins/com.enest.ssh'), id = 'com.enest.ssh'
  const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))
  const installedPath = join(dataRoot, 'plugins', id, manifest.version)
  const artifacts = process.env.ENEST_DEVELOPER_ARTIFACTS || await mkdtemp(join(tmpdir(), 'enest-developer-evidence-'))
  let app, slowServer, pendingEntryResponse, logs = ''
  try {
    await mkdir(dataRoot, { recursive: true }); await mkdir(artifacts, { recursive: true })
    await cp(join(source, 'dist'), installedPath, { recursive: true })
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', backgroundEffect: 'none', overrides: {} }, general: { animationLevel: 'low', quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: {} }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: join(dir, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
    app.process().on('exit', (code, signal) => { logs += `\nElectron exit: ${code} / ${signal}` })
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    }, source)
    const inShell = code => app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html')).executeJavaScript(code), code)
    const inPlugin = code => app.evaluate(({ webContents }, { id, code }) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(`enest://plugin/${id}/`))
      if (!wc) throw new Error('SSH renderer unavailable')
      return wc.executeJavaScript(code)
    }, { id, code })
    await poll(() => inShell('Boolean(document.querySelector(".app-boot.ready .market-grid"))'), Boolean, 'shell rendered')
    const showDeveloper = async () => {
      await inShell("document.querySelector('.bottom-bar button').click()")
      await poll(() => inShell("Boolean([...document.querySelectorAll('.settings-tabs button')].find(button=>button.textContent.includes('开发者')))"), Boolean, 'settings navigation')
      await inShell("[...document.querySelectorAll('.settings-tabs button')].find(button=>button.textContent.includes('开发者')).click()")
      await poll(() => inShell("Boolean(document.querySelector('.dev-load-primary'))"), Boolean, 'developer page')
    }
    await showDeveloper()
    const developerText = await inShell("document.querySelector('.page-settings').innerText")
    assert.doesNotMatch(developerText, /预览方式|调用跟踪|退出即杀/)
    await inShell("document.querySelector('.dev-load-primary').click()")
    const registered = await poll(() => inShell(`window.enestShell.getPlugins().then(plugins=>plugins.find(p=>p.id===${JSON.stringify(id)}&&p.dev))`), Boolean, 'SSH registration')
    assert.equal(registered.sourcePath, source)
    assert.equal(registered.rootPath, join(source, 'dist'))
    assert.equal(registered.devUrl, undefined)
    const ui = await poll(() => inPlugin(`({ready:document.querySelector('#app')?.dataset.workbench,text:document.body.innerText.slice(0,800),buttons:document.querySelectorAll('button').length,bridge:typeof window.enest?.storage?.set})`), state => state.ready === 'ready' && state.buttons > 8, 'real SSH workbench')
    assert.equal(ui.bridge, 'function')
    assert.doesNotMatch(ui.text, /Nexus 企业协同平台/)
    const png = await app.evaluate(async ({ webContents }, id) => (await webContents.getAllWebContents().find(wc => wc.getURL().startsWith(`enest://plugin/${id}/`)).capturePage()).toPNG().toString('base64'), id)
    await writeFile(join(artifacts, 'ssh-ready.png'), Buffer.from(png, 'base64'))
    await inPlugin("window.enest.storage.set('developer.smoke.preserved','keep-me')")
    await inPlugin("console.log('developer-smoke-console-ready')")
    await showDeveloper()
    await poll(() => inShell("document.querySelector('.dev-log').innerText"), text => text.includes('developer-smoke-console-ready') && text.includes('启动完成'), 'developer console and load logs')
    await inShell("[...document.querySelectorAll('.dev-plugin-actions button')].find(button=>button.textContent.trim()==='DevTools').click()")
    await poll(() => app.evaluate(({ webContents }, id) => webContents.getAllWebContents().find(wc => wc.getURL().startsWith(`enest://plugin/${id}/`))?.isDevToolsOpened(), id), Boolean, 'native plugin DevTools opened')
    await poll(() => app.evaluate(async ({ webContents }, id) => {
      const tools = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(`enest://plugin/${id}/`))?.devToolsWebContents
      return tools && !tools.isLoading() && await tools.executeJavaScript('document.readyState === "complete" && document.body.children.length > 0')
    }, id), Boolean, 'native DevTools frontend loaded')
    await app.evaluate(({ webContents }, id) => webContents.getAllWebContents().find(wc => wc.getURL().startsWith(`enest://plugin/${id}/`)).closeDevTools(), id)
    await inShell("window.confirm=()=>true;[...document.querySelectorAll('.dev-plugin-actions button')].find(button=>button.textContent.trim()==='移出').click()")
    const remaining = await poll(() => inShell(`window.enestShell.getPlugins().then(plugins=>plugins.find(p=>p.id===${JSON.stringify(id)}))`), state => state && !state.dev, 'developer registration removed')
    assert.equal(remaining.rootPath, installedPath, 'installed package remains after developer removal')
    await access(join(source, 'plugin.json')); await access(join(installedPath, 'plugin.json'))
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    await poll(() => inPlugin("document.querySelector('#app')?.dataset.workbench"), value => value === 'ready', 'installed SSH reopened')
    assert.equal(await inPlugin("window.enest.storage.get('developer.smoke.preserved')"), 'keep-me')
    // Hold a real document response so the intermediate native presentation is
    // deterministic, rather than racing a fast local file load.
    const loadingId = 'com.enest.smoke.loading', loadingSource = join(dir, loadingId)
    let loadingManifest, matchingServer = false
    slowServer = createServer((request, response) => {
      if (request.url.startsWith('/plugin.json')) response.end(JSON.stringify(matchingServer ? loadingManifest : { id: 'com.example.another', main: 'index.html' }))
      else pendingEntryResponse = response
    })
    await new Promise(resolve => slowServer.listen(0, '127.0.0.1', resolve))
    const loadingUrl = `http://127.0.0.1:${slowServer.address().port}/`
    await mkdir(join(loadingSource, 'public/assets/market/screenshots'), { recursive: true })
    for (const asset of ['icon.svg', 'README.md', 'screenshots/01-main.png']) await cp(join(source, 'public/assets/market', asset), join(loadingSource, 'public/assets/market', asset))
    loadingManifest = { ...manifest, id: loadingId, name: '启动过渡验证', permissions: [], contributes: undefined, development: { main: loadingUrl } }
    await writeFile(join(loadingSource, 'plugin.json'), JSON.stringify(loadingManifest))
    await writeFile(join(loadingSource, 'package.json'), JSON.stringify({ name: loadingId, version: manifest.version, type: 'module' }))
    await cp(join(loadingSource, 'public'), join(loadingSource, 'dist'), { recursive: true })
    await writeFile(join(loadingSource, 'dist/plugin.json'), JSON.stringify({ ...loadingManifest, development: undefined }))
    await writeFile(join(loadingSource, 'dist/index.html'), '<!doctype html><html><body><h1>本地构建已启动</h1></body></html>')
    const initialEntry = await inShell(`window.enestShell.loadDevPlugin(${JSON.stringify(loadingSource)})`)
    assert.equal(initialEntry.rootPath, join(loadingSource, 'dist'))
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(loadingId)})`)
    await poll(() => inShell(`window.enestShell.getPluginDiagnostics().then(result=>result.host.entries.find(entry=>entry.pluginId===${JSON.stringify(loadingId)})?.state)`), state => state === 'active', 'initial automatic distribution loaded')
    matchingServer = true
    await inShell(`window.enestShell.reloadPlugin(${JSON.stringify(loadingId)})`)
    await poll(() => Boolean(pendingEntryResponse), Boolean, 'held plugin document request')
    const refreshedEntry = await inShell(`window.enestShell.getPlugins().then(plugins=>plugins.find(plugin=>plugin.id===${JSON.stringify(loadingId)}))`)
    assert.equal(refreshedEntry.devUrl, loadingUrl)
    assert.equal(refreshedEntry.rootPath, loadingSource)
    assert.equal(refreshedEntry.sourcePath, loadingSource)
    const loadingText = await poll(() => inShell("document.querySelector('.plugin-view [role=status]')?.innerText"), text => text?.includes('正在启动'), 'visible shell loading indicator')
    const loadingAnimation = await inShell("getComputedStyle(document.querySelector('.plugin-launch-spinner')).animationName")
    assert.equal(loadingAnimation, 'plugin-launch-spin')
    const loadingEntry = await inShell(`window.enestShell.getPluginDiagnostics().then(result=>result.host.entries.find(entry=>entry.pluginId===${JSON.stringify(loadingId)}))`)
    const nativeVisible = wcId => app.evaluate(({ BaseWindow }, wcId) => BaseWindow.getAllWindows().flatMap(win => win.contentView.children).find(view => view.webContents?.id === wcId)?.getVisible(), wcId)
    assert.equal(await nativeVisible(loadingEntry.wcId), false, 'the blank native surface stays hidden above the loading UI')
    const loadingPng = await app.evaluate(async ({ webContents }) => (await webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html')).capturePage()).toPNG().toString('base64'))
    await writeFile(join(artifacts, 'plugin-starting.png'), Buffer.from(loadingPng, 'base64'))
    pendingEntryResponse.setHeader('Content-Type', 'text/html; charset=utf-8')
    pendingEntryResponse.end('<!doctype html><html><body><h1>插件已启动</h1></body></html>')
    await poll(() => nativeVisible(loadingEntry.wcId), Boolean, 'loaded native surface revealed')
    assert.equal(await inShell("Boolean(document.querySelector('.plugin-view [role=status]'))"), false)
    const evidence = { source, selectedRoot: registered.rootPath, actualUi: ui, devToolsOpened: true, consoleAndLoadLogs: true, developerControlsSimplified: true, sourcePreserved: true, installedPackagePreserved: true, pluginDataPreserved: true, automaticReload: { previous: 'own distribution', next: 'matching development server', sourcePathPreserved: true }, loadingTransition: { text: loadingText, animation: loadingAnimation, nativeHiddenBeforeLoad: true, nativeVisibleAfterLoad: true }, artifacts }
    await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log('Developer smoke evidence:', JSON.stringify(evidence))
  } catch (error) { throw new Error(`${error.stack || error}\n${logs}`) }
  finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    if (slowServer) { slowServer.closeAllConnections(); await new Promise(resolve => slowServer.close(resolve)) }
    await rm(dir, { recursive: true, force: true })
  }
})
