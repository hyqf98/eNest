/** Build first, then ENEST_APP_SMOKE=1 node --test src/main/plugin/pluginTabIcons.smoke.test.mjs.
 * Optional ENEST_TAB_ICONS_SMOKE_OUTPUT preserves JSON evidence outside the temporary profile. */
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
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}
function tabSnapshot(selector, badgeSelector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const candidate = element.querySelector('img');
    const image = candidate && !candidate.hidden && getComputedStyle(candidate).display !== 'none' ? candidate : null;
    const badge = element.querySelector(${JSON.stringify(badgeSelector)}) || element.parentElement?.querySelector(${JSON.stringify(badgeSelector)});
    return { title: element.title, text: element.textContent,
      image: image ? { src: image.currentSrc || image.src, complete: image.complete, width: image.naturalWidth, height: image.naturalHeight } : null,
      glyph: element.querySelector('.plugin-icon-glyph,.orb-glyph')?.textContent || '',
      badge: badge?.textContent || '' };
  })()`
}

test('production classic and orb tabs load package icons and synchronize bounded title/glyph/badge updates', {
  skip: process.env.ENEST_APP_SMOKE !== '1', timeout: 90000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-tab-icons-'))
  const dataRoot = join(directory, 'data'), userData = join(directory, 'profile')
  const id = 'com.enest.smoke.tab-icons', name = 'Tab 图标验证'
  const iconUrl = `enest://plugin/${id}/assets/market/icon.svg`
  let app, tabId, logs = ''
  const evidence = { platform: process.platform, fixture: id, states: [] }
  try {
    const fixture = join(dataRoot, 'plugins', id, '1.0.0')
    await mkdir(join(fixture, 'assets/market/screenshots'), { recursive: true })
    await writeFile(join(fixture, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#bd542b"/><path d="M18 16h23l7 8v24H18z" fill="#fff"/><path d="M24 29h18M24 35h18M24 41h12" stroke="#bd542b" stroke-width="3"/></svg>')
    await writeFile(join(fixture, 'assets/market/README.md'), '# Native tab icon fixture')
    await writeFile(join(fixture, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    await writeFile(join(fixture, 'plugin.json'), JSON.stringify({ id, name, description: 'Isolated classic/orb tab metadata fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] }, permissions: ['ui.setTitle', 'ui.setIcon', 'ui.setBadge'] }))
    await writeFile(join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Tab icon fixture</title></head><body><h1>Tab metadata fixture</h1></body></html>')
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', overrides: {} }, general: { quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [], animationLevel: 'low' }, plugins: { [id]: { permissionGrants: { 'ui.setTitle': 'allow', 'ui.setIcon': 'allow', 'ui.setBadge': 'allow' } } } }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-50000) })
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    const inSurface = (surface, code) => app.evaluate(({ webContents }, { surface, code, id }) => {
      const contents = webContents.getAllWebContents().find(wc => {
        const url = wc.getURL()
        if (surface === 'shell') return url.includes('/out/renderer/index.html')
        if (surface === 'orb') return url.includes('/out/renderer/orb-overlay.html') && new URL(url).searchParams.get('part') === 'rail'
        return url.startsWith(`enest://plugin/${id}/`)
      })
      if (!contents) throw new Error(surface + ' web contents missing')
      return contents.executeJavaScript(code)
    }, { surface, code, id })
    const inShell = code => inSurface('shell', code), inPlugin = code => inSurface('plugin', code), inOrb = code => inSurface('orb', code)
    const classic = () => inShell(tabSnapshot(`.tab[data-tab="${tabId}"]`, '.tab-badge'))
    const orb = () => inOrb(tabSnapshot(`[data-activate="${tabId}"]`, '.orb-badge'))
    const hostTab = () => inShell(`window.__tabIconSnapshot?.find(tab => tab.id === ${JSON.stringify(tabId)})`)
    const loadedIcon = state => state?.image?.complete && state.image.width > 0 && state.image.src === iconUrl
    const rejected = async code => assert.equal(await inPlugin(`(async () => { try { await ${code}; return false } catch { return true } })()`), true, code)
    await poll(() => inShell('typeof window.enestShell?.openPlugin'), value => value === 'function', 'shell bridge')
    await poll(() => inShell('Boolean(document.querySelector(".app-boot.ready .market-grid"))'), Boolean, 'shell UI')
    await inShell("window.__tabIconSnapshot=[];void window.enestShell.onEvent(event=>{if(event.type==='plugin-tabs')window.__tabIconSnapshot=event.tabs})")
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    tabId = (await poll(() => inShell('window.__tabIconSnapshot?.[0]'), tab => Boolean(tab?.id), 'opened host tab')).id
    assert.equal(typeof tabId, 'string')
    await poll(() => inPlugin('typeof window.enest?.ui?.setIcon'), value => value === 'function', 'plugin bridge')
    const native = await app.evaluate(({ webContents }, id) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL().startsWith(`enest://plugin/${id}/`))
      return { wcId: wc.id, sandbox: wc.getLastWebPreferences().sandbox }
    }, id)
    assert.equal(native.sandbox, true)
    assert.equal(await inPlugin('typeof require === "undefined" && typeof process === "undefined"'), true)
    evidence.native = native
    evidence.states.push({ phase: 'classic manifest', ...await poll(classic, loadedIcon, 'classic package image') })
    assert.equal((await hostTab()).icon, iconUrl)

    await inPlugin("window.enest.ui.setTitle('动态标题一')")
    await inPlugin('window.enest.ui.setBadge(7)')
    await inPlugin("window.enest.ui.setIcon('★')")
    evidence.states.push({ phase: 'classic override', ...await poll(classic, state => state?.title === '动态标题一' && state.glyph === '★' && state.badge === '7' && !state.image, 'classic metadata override') })
    const classicHost = await poll(hostTab, tab => tab?.title === '动态标题一' && tab.glyph === '★' && tab.icon === null && tab.badge === '7', 'host metadata snapshot')
    evidence.classicHost = classicHost
    for (const value of ['https://example.test/icon.svg', 'assets/market/icon.svg', 'a b', 'abc']) await rejected(`window.enest.ui.setIcon(${JSON.stringify(value)})`)
    await rejected(`window.enest.ui.setTitle(${JSON.stringify('x'.repeat(121))})`)
    await rejected('window.enest.ui.setBadge(-1)')
    await rejected("window.enest.ui.setBadge('123456789')")
    assert.deepEqual(await hostTab(), classicHost, 'rejected metadata must not change the host snapshot')
    await inPlugin("window.enest.ui.setIcon('')")
    evidence.states.push({ phase: 'classic restored', ...await poll(classic, loadedIcon, 'classic restored package image') })

    // Use the real settings UI so the renderer store, persisted setting and native rail all transition.
    await inShell("document.querySelector('.bottom-bar button').click()")
    await poll(() => inShell('document.querySelectorAll(".tab-style-seg button").length'), count => count === 2, 'tab style settings')
    await inShell("document.querySelectorAll('.tab-style-seg button')[1].click()")
    await poll(() => inShell('document.documentElement.dataset.tabStyle'), style => style === 'orb', 'renderer orb mode')
    assert.equal((await inShell('window.enestShell.getSettings()')).general.tabStyle, 'orb')
    await poll(() => inOrb('Boolean(document.querySelector("#orb-tabs-zone"))'), Boolean, 'native orb rail')
    await inOrb("(() => {const r=document.querySelector('#orb-tabs-zone').getBoundingClientRect();document.documentElement.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:10,clientY:r.top+r.height/2}))})()")
    evidence.states.push({ phase: 'orb manifest', ...await poll(orb, state => loadedIcon(state) && state.title === '动态标题一' && state.badge === '7', 'orb package image') })
    await inPlugin("window.enest.ui.setTitle('圆轨动态标题')")
    await inPlugin("window.enest.ui.setIcon('◇')")
    await inPlugin("window.enest.ui.setBadge('NEW')")
    evidence.states.push({ phase: 'orb override', ...await poll(orb, state => state?.title === '圆轨动态标题' && state.glyph === '◇' && state.badge === 'NEW' && !state.image, 'orb metadata override') })
    evidence.orbHost = await poll(hostTab, tab => tab?.title === '圆轨动态标题' && tab.glyph === '◇' && tab.icon === null && tab.badge === 'NEW', 'orb host snapshot')
    await inPlugin("window.enest.ui.setTitle('  ')")
    await inPlugin("window.enest.ui.setIcon('')")
    await inPlugin("window.enest.ui.setBadge('')")
    evidence.states.push({ phase: 'orb restored', ...await poll(orb, state => loadedIcon(state) && state.title === name && !state.badge, 'orb restored metadata') })

    await inShell("document.querySelectorAll('.tab-style-seg button')[0].click()")
    await poll(() => inShell('document.documentElement.dataset.tabStyle'), style => style === 'classic', 'renderer classic mode')
    await poll(classic, state => loadedIcon(state) && state.title === name && !state.badge, 'classic after orb')
    await inPlugin("window.enest.ui.setTitle('应随关闭丢弃')")
    await inPlugin("window.enest.ui.setIcon('临')")
    await inPlugin('window.enest.ui.setBadge(9)')
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), state => !state.host.entries.length && !state.host.closing && !state.resources.length, 'closed runtime cleanup')
    await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
    evidence.states.push({ phase: 'reopen defaults', ...await poll(classic, state => loadedIcon(state) && state.title === name && !state.badge, 'reopened default metadata') })
    await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    const cleanup = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), state => !state.host.entries.length && !state.host.closing && !state.host.retiring && !state.resources.length, 'final cleanup')
    evidence.cleanup = { instances: cleanup.host.entries.length, activities: cleanup.resources.length, sessionBytes: cleanup.session.residentBytes }
    assert.equal(cleanup.session.residentBytes, 0)
    if (process.env.ENEST_TAB_ICONS_SMOKE_OUTPUT) {
      await mkdir(dirname(process.env.ENEST_TAB_ICONS_SMOKE_OUTPUT), { recursive: true })
      await writeFile(process.env.ENEST_TAB_ICONS_SMOKE_OUTPUT, JSON.stringify(evidence, null, 2))
    }
    console.log('Native classic/orb tab evidence:', JSON.stringify(evidence))
  } catch (error) {
    throw new Error(`${error.stack || error}\nApplication output:\n${logs}`)
  } finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(directory, { recursive: true, force: true })
  }
})
