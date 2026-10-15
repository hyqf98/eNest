/** Build first, then ENEST_HOME_SEARCH_SMOKE=1 node --test src/main/launcher/homeSearch.smoke.test.mjs.
 * ENEST_HOME_SEARCH_ARTIFACTS selects a persistent evidence directory.
 * This opt-in smoke opens a real scanned app only when ENEST_HOME_SEARCH_APP is supplied. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = process.cwd()
const id = 'com.enest.smoke.home-search'
async function poll(read, accepts, label, timeout = 20000) {
  let value, error
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { value = await read(); error = undefined; if (accepts(value)) return value } catch (caught) { error = caught }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}

test('main-window search opens scanned apps and dynamic provider results in the shell, with marketplace details', {
  skip: process.env.ENEST_HOME_SEARCH_SMOKE !== '1', timeout: 100000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-home-search-'))
  const dataRoot = join(directory, 'data'), userData = join(directory, 'profile')
  const artifacts = process.env.ENEST_HOME_SEARCH_ARTIFACTS || await mkdtemp(join(tmpdir(), 'enest-home-search-evidence-'))
  const evidence = { platform: process.platform, artifacts }
  let app, logs = ''
  try {
    const fixture = join(dataRoot, 'plugins', id, '1.0.0')
    await mkdir(join(fixture, 'assets/market/screenshots'), { recursive: true })
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(fixture, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#247b68"/></svg>')
    await writeFile(join(fixture, 'assets/market/README.md'), '# Native search fixture')
    await writeFile(join(fixture, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    await writeFile(join(fixture, 'plugin.json'), JSON.stringify({ id, name: '主窗搜索验证', description: 'Native search provider fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', permissions: ['contribute'],
      market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] }, features: [{ code: 'main', cmds: ['home-static-fixture'] }] }))
    await writeFile(join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Native main-window search fixture</title></head><body><h1>主窗口动态结果已打开</h1><pre id="payload"></pre><script src="assets/fixture.js"></script></body></html>')
    await writeFile(join(fixture, 'assets/fixture.js'), `window.__homeEnters=[];
      window.enest.onEnter(event=>{window.__homeEnters.push(event);document.querySelector('#payload').textContent=JSON.stringify(event,null,2)});
      window.enest.contribute.onQuickQuery(({reqId,query})=>window.enest.contribute.respondQuickQuery(reqId,query==='home-dynamic-fixture'?[{id:'native-result',title:'动态搜索结果',code:'dynamic-entry',payload:{query,source:'native-provider'}}]:[]));
      window.enest.contribute.registerQuickProvider({id:'native-home',explain:'主窗搜索 provider'}).then(result=>{window.__providerResult=result;window.__providerReady=result.ok}).catch(error=>window.__providerError=String(error));`)
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', backgroundEffect: 'none', overrides: {} }, general: { animationLevel: 'low', quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: { [id]: { permissionGrants: { contribute: 'allow' } } } }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    const inSurface = (surface, code) => app.evaluate(({ webContents }, { surface, code, id }) => {
      const wc = webContents.getAllWebContents().find(wc => surface === 'shell'
        ? wc.getURL().includes('/out/renderer/index.html') && !new URL(wc.getURL()).searchParams.has('surface')
        : wc.getURL().startsWith(`enest://plugin/${id}/`))
      if (!wc) throw new Error(`${surface} web contents missing: ${webContents.getAllWebContents().map(item => item.getURL()).join(', ')}`)
      return wc.executeJavaScript(code)
    }, { surface, code, id })
    const inShell = code => inSurface('shell', code), inPlugin = code => inSurface('plugin', code)
    const search = async query => {
      const page = app.windows().find(page => page.url().includes('/out/renderer/index.html') && !new URL(page.url()).searchParams.has('surface'))
      assert.ok(page, 'main window page available')
      await page.getByRole('combobox').fill(query)
      await poll(() => inShell('({value:document.querySelector("[role=combobox]")?.value,busy:document.querySelector(".home-search-list")?.getAttribute("aria-busy")})'), state => state.value === query && state.busy === 'false', `search ${query}`)
    }
    const clickResult = async resultId => inShell(`document.querySelector('[data-home-result-id='+CSS.escape(${JSON.stringify(resultId)})+']').click()`)
    const capture = async name => {
      const png = await app.evaluate(async ({ webContents }) => (await webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html') && !new URL(wc.getURL()).searchParams.has('surface')).capturePage()).toPNG().toString('base64'))
      const file = join(artifacts, name + '.png')
      await writeFile(file, Buffer.from(png, 'base64'))
      return file
    }
    await poll(() => inShell('Boolean(document.querySelector(".app-boot.ready [role=combobox]"))'), Boolean, 'main renderer')
    // Observe the real native API and forward unchanged. No app scan or launch response is mocked.
    await app.evaluate(({ shell }) => {
      const open = shell.openPath.bind(shell)
      globalThis.__homeOpenedApps = []
      shell.openPath = async path => {
        const error = await open(path)
        globalThis.__homeOpenedApps.push({ path, error })
        return error
      }
    })
    await app.evaluate(({ app }) => {
      globalThis.__homeNativeEvents=[]
      app.on('web-contents-created', (_event, wc) => {
        for (const name of ['did-start-navigation','did-navigate','did-fail-load','did-finish-load','console-message','render-process-gone']) {
          wc.on(name, (...args) => globalThis.__homeNativeEvents.push({id:wc.id,name,url:wc.isDestroyed()?'destroyed':wc.getURL(),data:args.slice(1).map(arg=>typeof arg==='object'?String(arg):arg)}))
        }
      })
    })
    const appQuery = process.env.ENEST_HOME_SEARCH_APP || 'QQ'
    await search(appQuery)
    const nativeApps = await inShell(`Array.from(document.querySelectorAll('.home-search-result')).filter(node=>node.querySelector('.home-search-kind').textContent==='本机应用').map(node=>({id:node.dataset.homeResultId,title:node.querySelector('.home-search-title').textContent,path:node.querySelector('.home-search-subtitle').textContent}))`)
    assert.ok(nativeApps.length > 0, 'real application scanner returns installed apps')
    const firstApp = nativeApps.find(item => item.title.toLowerCase() === appQuery.toLowerCase()) || nativeApps[0]
    await poll(() => inShell(`Boolean(document.querySelector('[data-home-result-id='+CSS.escape(${JSON.stringify(firstApp.id)})+'] img')?.naturalWidth)`), Boolean, 'real application icon')
    evidence.nativeApps = nativeApps
    evidence.applicationScreenshot = await capture('homepage-native-app-search')
    if (process.env.ENEST_HOME_SEARCH_APP) {
      await clickResult(firstApp.id)
      evidence.realAppLaunch = await poll(() => app.evaluate(() => globalThis.__homeOpenedApps), calls => calls.some(call => call.path === firstApp.path), 'native application launch')
      assert.equal(evidence.realAppLaunch.find(call => call.path === firstApp.path).error, '')
    }
    await search('home-static-fixture')
    const staticId = await poll(() => inShell(`Array.from(document.querySelectorAll('.home-search-result')).map(node=>node.dataset.homeResultId).find(value=>value.startsWith('plugin:${id}:'))`), Boolean, 'static plugin entry')
    await clickResult(staticId)
    await poll(() => inPlugin('window.__providerReady'), Boolean, 'native provider registered', 5000)
    await inShell('document.querySelector(".home-tab").click()')
    await poll(() => inShell('Boolean(document.querySelector("[role=combobox]"))'), Boolean, 'home restored')
    await search('home-dynamic-fixture')
    const providerId = await poll(() => inShell(`Array.from(document.querySelectorAll('.home-search-result')).find(node=>node.innerText.includes('动态搜索结果'))?.dataset.homeResultId`), Boolean, 'dynamic provider search result')
    evidence.providerScreenshot = await capture('homepage-native-provider-search')
    await clickResult(providerId)
    evidence.providerEnter = await poll(() => inPlugin('window.__homeEnters.at(-1)'), entry => entry?.code === 'dynamic-entry', 'provider entry received')
    assert.deepEqual(evidence.providerEnter.payload, { query: 'home-dynamic-fixture', source: 'native-provider' })
    evidence.placement = await app.evaluate(({ BaseWindow }, id) => {
      const found = []
      const visit = (view, window, visible) => {
        const isVisible = visible && view.getVisible()
        if (view.webContents && view.webContents.getURL().startsWith(`enest://plugin/${id}/`)) found.push({ title: window.getTitle(), visible: isVisible, bounds: view.getBounds(), shellUrl: window.contentView.children.map(child=>child.webContents?.getURL()).find(url=>url?.includes('/out/renderer/index.html')) })
        for (const child of view.children) visit(child, window, isVisible)
      }
      for (const window of BaseWindow.getAllWindows()) visit(window.contentView, window, window.isVisible())
      return found
    }, id)
    assert.equal(evidence.placement.length, 1)
    assert.equal(evidence.placement[0].visible, true)
    assert.ok(evidence.placement[0].shellUrl?.includes('/out/renderer/index.html'))
    assert.ok(!evidence.placement[0].shellUrl.includes('surface=quick'))
    await poll(() => inShell('document.querySelector(".tab.active")?.textContent'), text => text?.includes('主窗搜索验证'), 'active shell plugin tab')
    await inShell('document.querySelector(".home-tab").click()')
    const market = await inShell('window.enestShell.getPlugins().then(items=>items.find(item=>!item.installed))')
    assert.ok(market, 'catalog has an uninstalled market entry')
    await search(market.name)
    await inShell("Array.from(document.querySelectorAll('.home-search-scopes button')).find(button=>button.textContent==='插件市场').click()")
    await poll(() => inShell(`Boolean(document.querySelector('[data-home-result-id='+CSS.escape(${JSON.stringify('market:' + market.id)})+']'))`), Boolean, 'market result')
    await clickResult('market:' + market.id)
    await poll(() => inShell('Boolean(document.querySelector(".plugin-detail-modal, .detail-modal"))'), Boolean, 'market detail dialog')
    assert.equal(await inShell(`window.enestShell.getPlugins().then(items=>items.find(item=>item.id===${JSON.stringify(market.id)})?.installed)`), false)
    evidence.marketplace = { id: market.id, name: market.name, detailOpened: true, installed: false }
    await writeFile(join(artifacts, 'homepage-search-native-qa.json'), JSON.stringify(evidence, null, 2))
    console.log('Native homepage search:', JSON.stringify(evidence))
  } catch (error) {
    if (app) console.log('Native load diagnostics:', JSON.stringify(await app.evaluate(async ({webContents})=>({events:globalThis.__homeNativeEvents,contents:await Promise.all(webContents.getAllWebContents().map(async wc=>({id:wc.id,url:wc.getURL(),state:await wc.executeJavaScript('(async()=>({href:location.href,title:document.title,text:document.body.innerText.slice(0,500),ready:document.readyState,api:typeof window.enest,enters:window.__homeEnters,result:window.__providerResult,error:window.__providerError,scripts:[...document.scripts].map(x=>x.src),resources:performance.getEntriesByType("resource").map(x=>({name:x.name,size:x.encodedBodySize})),script:location.protocol==="enest:"?await fetch("assets/fixture.js").then(async r=>({status:r.status,content:await r.text()})):undefined}))()').catch(e=>String(e))})))})),null,2))
    await writeFile(join(artifacts, 'homepage-search-native-failure.log'), `${error.stack || error}\n${logs}`)
    throw new Error(`${error.stack || error}\n${logs}`)
  } finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(directory, { recursive: true, force: true })
  }
})
