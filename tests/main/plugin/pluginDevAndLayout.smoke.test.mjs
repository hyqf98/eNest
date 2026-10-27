/** Native source/Vite-HMR + shell layout regression. Build before ENEST_APP_SMOKE=1. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, access, realpath, rename, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer, build as viteBuild } from 'vite'
import { _electron as electron } from 'playwright-core'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
async function poll(read, accepts, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value, error
  while (Date.now() < deadline) {
    try { value = await read(); if (accepts(value)) return value } catch (e) { error = e }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}

test('native shell stays within resized viewport; external source and Vite HMR keep a single sandboxed runtime', { skip: process.env.ENEST_APP_SMOKE !== '1', timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-dev-layout-')), dataRoot = join(dir, 'data'), id = 'com.example.smoke.dev'
  const source = join(dir, 'external-projects', id)
  const artifacts = process.env.ENEST_LAYOUT_SMOKE_ARTIFACTS || await mkdtemp(join(tmpdir(), 'enest-layout-evidence-'))
  let app, vite
  let logs = ''
  const layouts = []
  console.log('Layout artifacts:', artifacts)
  try {
    await mkdir(join(source, 'public/assets/market/screenshots'), { recursive: true }); await mkdir(join(source, 'src'), { recursive: true }); await mkdir(dataRoot, { recursive: true }); await mkdir(artifacts, { recursive: true })
    await writeFile(join(source, 'public/assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2563eb"/></svg>')
    await writeFile(join(source, 'public/assets/market/README.md'), '# Native source and Vite fixture')
    await writeFile(join(source, 'public/assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ id, name: '源码热更新验证', description: 'Isolated native source and HMR fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] }, permissions: [] }))
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }))
    await writeFile(join(source, 'index.html'), '<!doctype html><html><body><h1 id="value">Loading</h1><script type="module" src="./src/main.js"></script></body></html>')
    const moduleText = value => `window.__lifetime ||= Math.random(); window.__devRuns = (window.__devRuns || 0) + 1; window.__devValue=${JSON.stringify(value)}; document.getElementById('value').textContent=window.__devValue; if (import.meta.hot) import.meta.hot.accept();`
    await writeFile(join(source, 'src/main.js'), moduleText('before'))
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', overrides: {} }, general: { quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: {} }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: join(dir, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    app.process().stdout.on('data', chunk => { logs = (logs + chunk).slice(-20000) }); app.process().stderr.on('data', chunk => { logs = (logs + chunk).slice(-20000) })
    const inShell = code => app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html')).executeJavaScript(code), code)
    await poll(() => inShell('typeof window.enestShell?.loadDevPlugin'), value => value === 'function', 'shell ready')
    await poll(() => inShell('Boolean(document.querySelector(".app-boot.ready .market-grid"))'), Boolean, 'shell rendered')
    // Direct 21px base token is an accessibility stress case; current settings UI max is 130%.
    for (const [width, height, fontScale] of [[900, 600, 1], [1200, 800, 1], [1920, 1080, 1], [900, 600, 1.5]]) {
      await app.evaluate(({ BaseWindow }, { width, height }) => {
        const win = BaseWindow.getAllWindows().find(win => win.contentView.children.some(child => child.webContents?.getURL().includes('/out/renderer/index.html')))
        win.setContentSize(width, height)
      }, { width, height })
      await inShell(`document.documentElement.style.setProperty('--font-size-base', '${14 * fontScale}px')`)
      await poll(() => inShell('({width:innerWidth,height:innerHeight})'), size => size.width === width && size.height === height, 'native resize')
      for (const view of ['home', 'settings']) {
        await inShell(`document.querySelector('${view === 'settings' ? '.bottom-bar button' : '.home-tab'}').click()`)
        await poll(() => inShell(`Boolean(document.querySelector('.page-${view}'))`), Boolean, view)
        await new Promise(resolve => setTimeout(resolve, 900))
        await inShell('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        const bounds = await inShell(`(() => { const selectors=['.app','.app-chrome','.stage','.page-${view}',${view === 'home' ? "'.home-scroll','.market-grid'" : "'.settings-shell','.settings-main'"}]; return {width:innerWidth,height:innerHeight,font:getComputedStyle(document.body).fontSize,titlebar:document.querySelector('.titlebar').getBoundingClientRect().height,containers:selectors.flatMap(selector=>{const el=document.querySelector(selector);if(!el)return [];const r=el.getBoundingClientRect();return [{selector,left:r.left,right:r.right,width:r.width,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth}]})} })()`)
        assert.equal(bounds.titlebar, 36)
        for (const container of bounds.containers) {
          assert.ok(container.left >= -1 && container.right <= width + 1, JSON.stringify({ view, width, height, fontScale, container }))
          assert.ok(container.scrollWidth <= container.clientWidth + 1, JSON.stringify({ view, width, height, fontScale, container }))
        }
        layouts.push({ view, ...bounds, fontScale })
        const png = await app.evaluate(async ({ webContents }) => (await webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html')).capturePage()).toPNG().toString('base64'))
        await writeFile(join(artifacts, `${view}-${width}x${height}-${fontScale}.png`), Buffer.from(png, 'base64'))
      }
    }
    // Exercise the actual source-picker UI/store auto-open flow. The native dialog
    // is stubbed to choose the isolated fixture, not clicked by a human.
    await app.evaluate(({ dialog }, source) => {
      globalThis.__sourcePickerCalls = 0
      dialog.showOpenDialog = async options => { globalThis.__sourcePickerCalls++; return { canceled: false, filePaths: [source] } }
    }, source)
    await inShell("document.querySelector('.bottom-bar button').click()")
    await poll(() => inShell("Boolean([...document.querySelectorAll('.settings-tabs button')].find(button=>button.textContent.includes('开发者')))"), Boolean, 'developer settings tab')
    await inShell("[...document.querySelectorAll('.settings-tabs button')].find(button=>button.textContent.includes('开发者')).click()")
    await poll(() => inShell("Boolean(document.querySelector('.dev-load-primary'))"), Boolean, 'source picker button')
    await inShell("document.querySelector('.dev-load-primary').click()")
    const registered = await poll(() => inShell(`window.enestShell.getPlugins().then(plugins=>plugins.find(plugin=>plugin.id===${JSON.stringify(id)}&&plugin.dev))`), Boolean, 'source registration from picker')
    assert.equal(registered.rootPath, source); assert.equal(registered.sourcePath, source)
    await assert.rejects(access(join(dataRoot, 'plugins', id)))
    const inPlugin = code => app.evaluate(({ webContents }, { id, code }) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().includes(id) || wc.getURL().includes('__enestDev='))
      if (!wc) throw new Error('dev renderer missing: ' + JSON.stringify(webContents.getAllWebContents().map(w => ({id:w.id,url:w.getURL()}))))
      return wc.executeJavaScript(code)
    }, { id, code })
    try { await poll(() => inPlugin('window.__devValue'), value => value === 'before', 'static source execution') } catch (error) { console.log('Source diagnostics:', JSON.stringify(await inShell('window.enestShell.getPluginDiagnostics()'))); throw error }
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    await viteBuild({ configFile: false, root: await realpath(source), logLevel: 'silent', base: './', build: { emptyOutDir: true } })
    await copyFile(join(source, 'plugin.json'), join(source, 'dist/plugin.json'))
    const dist = await inShell(`window.enestShell.loadDevPlugin(${JSON.stringify(source)},{url:'',preview:'dist'})`)
    assert.equal(dist.rootPath, join(source, 'dist')); assert.equal(dist.sourcePath, source)
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    await poll(() => inPlugin('window.__devValue'), value => value === 'before', 'compiled dist execution')
    await assert.rejects(access(join(dataRoot, 'plugins', id)))
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    vite = await createServer({ configFile: false, root: await realpath(source), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { strict: true } } })
    await vite.listen()
    const url = vite.resolvedUrls.local[0]
    await vite.close()
    await inShell("window.__devErrors=[];void window.enestShell.onEvent(event=>{if(event.type==='plugin-error')window.__devErrors.push(event)})")
    await inShell(`window.enestShell.loadDevPlugin(${JSON.stringify(source)},{url:${JSON.stringify(url)},preview:'source'})`)
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    const connectionError = await poll(() => inShell('window.__devErrors.at(-1)'), event => event?.pluginId === id, 'stopped development server reported')
    assert.match(connectionError.message, /ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED/)
    const failedServerCleanup = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => value.host.entries.length === 0 && !value.host.closing && !value.host.retiring && value.resources.length === 0, 'failed server renderer released')
    vite = await createServer({ configFile: false, root: await realpath(source), logLevel: 'error', server: { host: '127.0.0.1', port: Number(new URL(url).port), strictPort: true, fs: { strict: true } } })
    await vite.listen()
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    const devState = () => app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(url))
      if (!wc) return null
      return { wcId: wc.id, sandbox: wc.getLastWebPreferences().sandbox, ...await wc.executeJavaScript('({value:window.__devValue,runs:window.__devRuns,lifetime:window.__lifetime,noNode:typeof require==="undefined" && typeof process==="undefined",bridge:typeof window.enest?.storage})') }
    }, url)
    const before = await poll(devState, state => state?.value === 'before', 'Vite source execution')
    await poll(() => vite.ws.clients.size, size => size > 0, 'Vite HMR websocket connected')
    await writeFile(join(source, 'src/main.js.next'), moduleText('after-hmr'))
    await rename(join(source, 'src/main.js.next'), join(source, 'src/main.js'))
    const after = await poll(devState, state => state?.value === 'after-hmr', 'Vite HMR')
    assert.equal(after.wcId, before.wcId); assert.equal(after.lifetime, before.lifetime); assert.equal(after.sandbox, true); assert.equal(after.noNode, true); assert.equal(after.runs, before.runs + 1)
    await assert.rejects(access(join(dataRoot, 'plugins', id)))
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => value.host.entries.length === 0 && value.host.closing === 0 && value.resources.length === 0, 'dev cleanup')
    const evidence = { platform: process.platform, artifacts, layouts, source: { registeredPath: source, installedCopy: false, picker: 'native showOpenDialog stub returns fixture path; actual developer button and store auto-open', pickerCalls: await app.evaluate(() => globalThis.__sourcePickerCalls), autoOpenedWithoutSeparateOpenCall: true }, dist: { rootPath: dist.rootPath, sourcePath: dist.sourcePath, compiledWithVite: true, installedCopy: false }, failedServer: { connectionError, remainingRuntimes: failedServerCleanup.host.entries.length, remainingActivities: failedServerCleanup.resources.length, retrySucceeded: true }, vite: { url, before, after, sameRenderer: true } }
    await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    console.log('Native development/layout evidence:', JSON.stringify(evidence))
  } catch (error) {
    throw new Error(`${error.stack || error}\n${logs}`)
  } finally {
    await vite?.close()
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(dir, { recursive: true, force: true })
  }
})
