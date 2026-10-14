/**
 * Build first, then:
 * ENEST_QUICK_SMOKE=1 node --test src/main/window/quickWindow.smoke.test.mjs
 * Optional ENEST_QUICK_SMOKE_EXECUTABLE targets a packaged app.
 * Screenshots and evidence remain in a separate temporary artifacts directory;
 * ENEST_QUICK_SMOKE_ARTIFACTS can select that directory explicitly.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pluginId = 'com.enest.smoke.quick-window'
const barHeight = 64
const homeHeight = 248
const quickWidth = 720
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function poll(read, accepts, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value, lastError
  while (Date.now() < deadline) {
    try {
      value = await read()
      if (accepts(value)) return value
    } catch (error) { lastError = error }
    await pause(40)
  }
  throw new Error(`${label}: ${lastError?.message || JSON.stringify(value)}`)
}

/** All access starts at Electron's own window/WebContents inventory, not page order. */
function createQuickHarness(app, id, artifacts) {
  const evaluate = (target, code) => app.evaluate(({ webContents }, { target, code, id }) => {
    const wc = webContents.getAllWebContents().find(contents => {
      if (contents.isDestroyed()) return false
      try {
        const url = new URL(contents.getURL())
        if (target === 'plugin') return url.searchParams.get('pid') === id || (url.protocol === 'enest:' && url.hostname === id)
        if (target === 'quick') return url.searchParams.get('surface') === 'quick'
        return url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface')
      } catch { return false }
    })
    if (!wc) throw new Error(`Missing ${target} WebContents`)
    return wc.executeJavaScript(code)
  }, { target, code, id })

  const nativeState = () => app.evaluate(({ BaseWindow }, id) => {
    const win = BaseWindow.getAllWindows().find(candidate => {
      try { return candidate.getTitle() === 'eNest Quick' || new URL(candidate.webContents?.getURL()).searchParams.get('surface') === 'quick' } catch { return false }
    })
    if (!win) return null
    const plugins = []
    // Accumulate local offsets and ancestor visibility. This also works when a
    // native clipping/shape View is inserted between contentView and the plugin.
    function visit(view, parentX, parentY, parentVisible, isRoot = false) {
      const bounds = view.getBounds()
      const x = isRoot ? 0 : parentX + bounds.x
      const y = isRoot ? 0 : parentY + bounds.y
      const visible = parentVisible && view.getVisible()
      const wc = view.webContents
      if (wc && !wc.isDestroyed()) {
        try {
          const url = new URL(wc.getURL())
          if (url.searchParams.get('pid') === id || (url.protocol === 'enest:' && url.hostname === id)) {
            plugins.push({ wcId: wc.id, visible, localBounds: bounds, bounds: { x, y, width: bounds.width, height: bounds.height } })
          }
        } catch { /* The main renderer may not have a URL yet. */ }
      }
      for (const child of view.children) visit(child, x, y, visible)
    }
    visit(win.contentView, 0, 0, true, true)
    return { windowId: win.id, visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds(), contentBounds: win.getContentBounds(), plugins }
  }, id)

  const domState = () => evaluate('quick', `(() => {
    const root = document.querySelector('.quick-root');
    const bar = document.querySelector('.quick-search-bar');
    const input = bar?.querySelector('input');
    if (!root || !bar || !input) return null;
    const rect = bar.getBoundingClientRect();
    const style = element => {
      const computed = getComputedStyle(element);
      return { appRegion: computed.getPropertyValue('-webkit-app-region') || computed.getPropertyValue('app-region'), userSelect: computed.userSelect };
    };
    return { mode: root.dataset.mode, expanded: root.dataset.expanded, query: input.value,
      bar: { top: rect.top, bottom: rect.bottom, height: rect.height, ...style(bar) },
      input: { ...style(input), width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height, fontSize: getComputedStyle(input).fontSize }, buttons: [...bar.querySelectorAll('button')].map(button => ({ label: button.getAttribute('aria-label') || button.title, ...style(button) })),
      resultsVisible: Boolean(document.querySelector('#quick-results')),
      footerVisible: Boolean(document.querySelector('.quick-footer')),
      marketIconLoaded: Boolean(document.querySelector('.quick-market img')?.naturalWidth),
      enriching: Boolean(document.querySelector('.quick-spinner')),
      grids: [...document.querySelectorAll('.quick-group-items')].map(grid => ({ columns: getComputedStyle(grid).gridTemplateColumns, height: grid.getBoundingClientRect().height })),
      resultCount: document.querySelectorAll('.quick-result').length,
      panelTop: document.querySelector('.quick-panel')?.getBoundingClientRect().top ?? null,
      surfaceBottom: document.querySelector('.quick-shell').getBoundingClientRect().bottom,
      focusInInput: document.activeElement === input };
  })()`)

  const key = (target, type = 'keyDown', repeat = false) => app.evaluate(async ({ app: electronApp, BaseWindow, webContents }, { id, target, type, repeat }) => {
    const win = BaseWindow.getAllWindows().find(candidate => {
      try { return candidate.getTitle() === 'eNest Quick' || new URL(candidate.webContents?.getURL()).searchParams.get('surface') === 'quick' } catch { return false }
    })
    if (!win) throw new Error('Quick window not created')
    const wc = target === 'quick' ? win.webContents : webContents.getAllWebContents().find(contents => {
      try {
        const url = new URL(contents.getURL())
        return url.searchParams.get('pid') === id || (url.protocol === 'enest:' && url.hostname === id)
      } catch { return false }
    })
    if (!wc || wc.isDestroyed()) throw new Error(`Missing ${target} keyboard target`)
    // Win.focus alone does not activate the process after macOS screenshot or
    // other desktop automation has made a different application foreground.
    electronApp.focus({ steal: true })
    win.focus()
    wc.focus()
    if (target === 'quick') await wc.executeJavaScript("document.querySelector('.quick-search-bar input')?.focus()")
    wc.__quickSmokeExpectedInput = { type, key: 'Escape' }
    wc.sendInputEvent({ type, keyCode: 'Escape', modifiers: repeat ? ['isautorepeat'] : [] })
  }, { id, target, type, repeat })

  const screenshot = async name => {
    const output = join(artifacts, `${name}.png`)
    if (process.platform === 'darwin') {
      const mediaId = await app.evaluate(({ BaseWindow }) => {
        const win = BaseWindow.getAllWindows().find(candidate => candidate.getTitle() === 'eNest Quick')
        if (!win) throw new Error('Quick window not created')
        return win.getMediaSourceId().split(':')[1]
      })
      await execFileAsync('/usr/sbin/screencapture', ['-x', '-o', '-l', mediaId, output])
      return { kind: 'native-window-composite', file: output }
    }
    // BaseWindow has no capturePage. Per-WebContents captures are explicitly
    // labelled and must not be mistaken for a composited native-window image.
    const images = await app.evaluate(async ({ webContents }, id) => {
      const images = []
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue
        let kind
        try {
          const url = new URL(wc.getURL())
          if (url.searchParams.get('surface') === 'quick') kind = 'shell-only'
          else if (url.searchParams.get('pid') === id || (url.protocol === 'enest:' && url.hostname === id)) kind = 'plugin-only'
        } catch { continue }
        if (kind) images.push({ kind, png: (await wc.capturePage()).toPNG().toString('base64') })
      }
      return images
    }, id)
    const files = []
    for (const image of images) {
      const file = join(artifacts, `${name}-${image.kind}.png`)
      await writeFile(file, Buffer.from(image.png, 'base64'))
      files.push({ kind: image.kind, file })
    }
    return { kind: 'separate-webcontents', files }
  }

  return { evaluate, nativeState, domState, key, screenshot }
}

test('Quick joins its search bar to native plugin content keeps two home rows, stable geometry, and restores global search with Escape', {
  skip: process.env.ENEST_QUICK_SMOKE !== '1', timeout: 180000
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-quick-smoke-'))
  const artifacts = process.env.ENEST_QUICK_SMOKE_ARTIFACTS
    ? resolve(process.env.ENEST_QUICK_SMOKE_ARTIFACTS)
    : await mkdtemp(join(tmpdir(), 'enest-quick-smoke-artifacts-'))
  const dataRoot = join(dir, 'data-root'), userData = join(dir, 'electron-user-data')
  const evidence = { platform: process.platform, artifacts, snapshots: [], screenshots: [], repeatedEscapeEvents: 0 }
  let app, harness, stderr = '', stdout = '', failure
  try {
    await mkdir(artifacts, { recursive: true })
    const fixture = join(dataRoot, 'plugins', pluginId, '1.0.0')
    await mkdir(join(fixture, 'assets/market/screenshots'), { recursive: true })
      await writeFile(join(fixture, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#257"/></svg>')
      await writeFile(join(fixture, 'assets/market/README.md'), '# Isolated smoke fixture')
      await writeFile(join(fixture, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    await writeFile(join(fixture, 'plugin.json'), JSON.stringify({
      id: pluginId, name: 'Quick layout smoke', description: 'Isolated native Quick layout smoke fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: {readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png']}, permissions: [],
      features: [{ code: 'main', cmds: ['Quick layout smoke', 'quick-content'] }, { code: 'regex', cmds: [{ type: 'regex', label: '内容匹配', match: '/^\\s*quick-content\\s*$/i' }] }, { code: 'over', cmds: [{ type: 'over', label: '处理输入文本' }] }],
      window: { width: 640, height: 300 }, ui: { chrome: 'none', background: 'opaque', themeAware: false }
    }))
    await writeFile(join(fixture, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Quick native fixture</title>
      <style>html,body{margin:0;width:100%;height:100%;background:#e5f4ef;color:#143f32;font:16px system-ui}header{height:28px;background:#0f766e;color:white}p{margin:24px}</style></head>
      <body><header>Plugin top edge · native viewport 718 × 300</header><p>Quick lifecycle and geometry fixture.</p><script src="assets/fixture.js"></script></body></html>`)
    await writeFile(join(fixture, 'assets/fixture.js'), "window.__quickSmokeReady = typeof window.enest?.quickInput?.configure === 'function'; window.__quickSmokeEnters = []; window.enest.onEnter(event => window.__quickSmokeEnters.push(event));")
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({
      theme: { mode: 'light', overrides: {} },
      general: { animationLevel: 'high', quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: {}
    }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    delete env.ENEST_REMOTE_DEBUG
    const executable = process.env.ENEST_QUICK_SMOKE_EXECUTABLE
    app = await electron.launch({ executablePath: executable || require('electron'), args: executable ? [] : [root], env, timeout: 25000 })
    app.process().stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64000) })
    app.process().stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-64000) })
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    harness = createQuickHarness(app, pluginId, artifacts)
    const { evaluate, nativeState, domState, key, screenshot } = harness
    await poll(() => evaluate('shell', 'typeof window.enestShell?.quickToggle'), value => value === 'function', 'Main shell preload')
    const installed = await evaluate('shell', 'window.enestShell.getPlugins()')
    assert.ok(installed.some(plugin => plugin.id === pluginId && plugin.installed), JSON.stringify(installed))
    // Native keyboard tests activate this isolated app. Ignore unrelated physical
    // typing on the shared desktop; allow only the harness's native key events.
    // insertText below still exercises Chromium input and the React query path.
    await app.evaluate(({ app: electronApp, webContents }) => {
      const isolateInput = wc => wc.prependListener('before-input-event', (event, input) => {
        const expected = wc.__quickSmokeExpectedInput
        if (expected?.type === input.type && expected.key === input.key) {
          delete wc.__quickSmokeExpectedInput
        } else event.preventDefault()
      })
      for (const wc of webContents.getAllWebContents()) isolateInput(wc)
      electronApp.on('web-contents-created', (_event, wc) => isolateInput(wc))
    })
    evidence.physicalKeyboardIsolated = true
    await evaluate('shell', 'window.enestShell.quickToggle()')
    await poll(domState, state => state?.mode === 'list', 'Quick renderer')
    await poll(nativeState, state => state?.visible && state.contentBounds.height === homeHeight && state.contentBounds.width === quickWidth, 'Initial two-row Quick height')
    // This smoke measures geometry, content routing and keyboard behavior. Other
    // desktop tasks can activate a different application while screenshots run;
    // disable only blur-hide for this isolated test window, not in production.
    await app.evaluate(({ BaseWindow }) => {
      BaseWindow.getAllWindows().find(win => win.getTitle() === 'eNest Quick').removeAllListeners('blur')
    })
    evidence.blurHideIsolated = true
    await evaluate('quick', `window.__quickSmokeKeys = []; document.addEventListener('keydown', event => {
      if (event.key === 'Escape') window.__quickSmokeKeys.push({ repeat: event.repeat, target: event.target.tagName });
    }, true); document.querySelector('.quick-search-bar input').readOnly = true;
    document.addEventListener('beforeinput', event => { if (!window.__quickSmokeAllowText) event.preventDefault() }, true)`)

    const record = async label => {
      const snapshot = { label, dom: await domState(), native: await nativeState() }
      evidence.snapshots.push(snapshot)
      return snapshot
    }
    const openFixture = async (settled = true) => {
      const result = await evaluate('quick', `window.enestShell.quickOpen(${JSON.stringify({ kind: 'plugin', pluginId, container: 'quick' })})`)
      assert.equal(result.ok, true, JSON.stringify(result))
      await poll(domState, state => state?.mode === 'plugin', 'Plugin mode published')
      await poll(() => evaluate('plugin', 'window.__quickSmokeReady'), Boolean, 'Plugin production preload')
      if (settled) {
        await poll(nativeState, state => state?.visible && state.plugins.length === 1 && state.plugins[0].visible && state.plugins[0].bounds.y === barHeight && state.plugins[0].bounds.width === quickWidth - 2 && state.plugins[0].bounds.height === 300, 'Native plugin settled geometry')
        // Native animation can report target bounds before presentation catches up.
        await pause(650)
      }
    }
    const assertBlankLauncher = async label => {
      await poll(domState, state => state?.mode === 'list' && state.query === '' && state.resultsVisible, `${label}: blank global search`)
      await poll(nativeState, state => state?.visible && state.contentBounds.height === homeHeight && state.contentBounds.width === quickWidth && state.plugins.every(plugin => !plugin.visible), `${label}: collapsed native view`)
      // Observe past the high-animation duration to catch stale completion callbacks
      // that expand a dismissed plugin or resize the launcher a second time.
      for (let sample = 0; sample < 4; sample++) {
        await pause(180)
        const { dom, native } = await record(`${label}:${sample}`)
        assert.equal(dom.mode, 'list')
        assert.equal(dom.query, '')
        assert.equal(dom.resultsVisible, true)
        assert.equal(native.visible, true)
        assert.equal(native.contentBounds.height, homeHeight)
        assert.equal(native.contentBounds.width, quickWidth)
        assert.ok(native.plugins.every(plugin => !plugin.visible), JSON.stringify(native))
      }
    }
    const repeatEscapeOnSearch = async () => {
      const before = await evaluate('quick', 'window.__quickSmokeKeys.filter(event => event.repeat).length')
      for (let count = 0; count < 8; count++) { await key('quick', 'keyDown', true); await pause(20) }
      await key('quick', 'keyUp')
      const after = await poll(() => evaluate('quick', 'window.__quickSmokeKeys.filter(event => event.repeat).length'), count => count >= before + 8, 'Native key repeat delivery')
      evidence.repeatedEscapeEvents = after
    }

    await poll(domState, state => state?.resultCount > 8, 'Two rows of common commands')
    await poll(domState, state => state && !state.enriching, 'Visible home icons enriched', 25000)
    await poll(domState, state => state && Math.abs(state.panelTop - barHeight) < 0.001, 'Home entrance animation settled')
    const home = await record('home-two-rows')
    assert.equal(home.dom.resultCount, 16)
    assert.ok(Math.abs(home.dom.panelTop - barHeight) < 0.001, `Home panel edge ${home.dom.panelTop} did not settle at ${barHeight}`)
    assert.equal(home.dom.footerVisible, false)
    assert.equal(home.dom.marketIconLoaded, true)
    evidence.screenshots.push(await screenshot('quick-home-two-rows'))

    // Global results share the same 64px search edge and expand the native
    // container to the rendered surface, without a blank strip in between.
    await app.evaluate(async ({ app: electronApp, BaseWindow, webContents }) => {
      const wc = webContents.getAllWebContents().find(contents => {
        try { return new URL(contents.getURL()).searchParams.get('surface') === 'quick' } catch { return false }
      })
      electronApp.focus({ steal: true })
      BaseWindow.getAllWindows().find(win => win.getTitle() === 'eNest Quick').focus()
      wc.focus()
      await wc.executeJavaScript("(() => { window.__quickSmokeAllowText = true; const input = document.querySelector('.quick-search-bar input'); input.readOnly = false; input.focus() })()")
      await wc.insertText('Quick layout smoke')
      await wc.executeJavaScript("window.__quickSmokeAllowText = false; document.querySelector('.quick-search-bar input').readOnly = true")
    })
    await poll(domState, state => state?.resultsVisible && state.resultCount > 0, 'Global search fixture result')
    await poll(nativeState, state => state?.visible && state.contentBounds.height > barHeight, 'Global results expanded window')
    await poll(() => evaluate('quick', "document.querySelectorAll('.quick-result-group').length"), count => count >= 2, 'Static search plus content recommendation')
    await pause(650)
    const searchResults = await record('global-search-results')
    assert.equal(searchResults.native.contentBounds.width, quickWidth)
    assert.equal(searchResults.dom.input.fontSize, home.dom.input.fontSize)
    assert.equal(searchResults.dom.input.width, home.dom.input.width)
    assert.equal(searchResults.dom.bar.bottom, barHeight)
    assert.equal(searchResults.dom.panelTop, barHeight)
    assert.equal(searchResults.native.contentBounds.height, Math.ceil(searchResults.dom.surfaceBottom))
    evidence.screenshots.push(await screenshot('quick-global-results'))
    await key('quick')
    await key('quick', 'keyUp')
    await assertBlankLauncher('global-search-cleared')
    await app.evaluate(async ({ app: electronApp, BaseWindow, webContents }) => {
      const wc = webContents.getAllWebContents().find(contents => {
        try { return new URL(contents.getURL()).searchParams.get('surface') === 'quick' } catch { return false }
      })
      electronApp.focus({ steal: true })
      BaseWindow.getAllWindows().find(win => win.getTitle() === 'eNest Quick').focus()
      wc.focus()
      await wc.executeJavaScript("(() => { window.__quickSmokeAllowText = true; const input = document.querySelector('.quick-search-bar input'); input.readOnly = false; input.focus() })()")
      await wc.insertText('  quick-content  ')
      await wc.executeJavaScript("window.__quickSmokeAllowText = false; document.querySelector('.quick-search-bar input').readOnly = true")
    })
    const groupTitles = await poll(() => evaluate('quick', "[...document.querySelectorAll('.quick-section-head h2')].map(el => el.textContent)"), titles => titles?.length === 3, 'Name, regex and recommendation groups')
    assert.deepEqual(groupTitles, ['最佳搜索结果', '最佳匹配', '匹配推荐'])
    await pause(650)
    evidence.screenshots.push(await screenshot('quick-content-groups'))
    await evaluate('quick', "[...document.querySelectorAll('.quick-result')].find(el => el.textContent.includes('处理输入文本')).click()")
    const recommended = await poll(() => evaluate('plugin', 'window.__quickSmokeEnters.at(-1)'), entry => entry?.type === 'over', 'Recommendation click forwarded original content')
    assert.equal(recommended.payload, '  quick-content  ')
    assert.equal(recommended.code, 'over')
    await key('quick')
    await key('quick', 'keyUp')
    await assertBlankLauncher('recommendation-return')

    await openFixture()
    const expanded = await record('expanded')
    assert.equal(expanded.native.contentBounds.width, quickWidth)
    assert.equal(expanded.dom.input.fontSize, home.dom.input.fontSize)
    assert.equal(expanded.dom.input.height, home.dom.input.height)
    assert.equal(expanded.dom.input.width, home.dom.input.width)
    assert.equal(expanded.dom.marketIconLoaded, true)
    assert.equal(expanded.dom.bar.top, 0)
    assert.equal(expanded.dom.bar.bottom, barHeight)
    assert.equal(expanded.dom.bar.height, barHeight)
    assert.equal(expanded.native.plugins[0].bounds.y, expanded.dom.bar.bottom)
    assert.equal(expanded.dom.bar.appRegion, 'drag')
    assert.equal(expanded.dom.input.appRegion, 'no-drag')
    assert.equal(expanded.dom.input.userSelect, 'text')
    assert.ok(expanded.dom.buttons.length > 0)
    assert.ok(expanded.dom.buttons.every(button => button.appRegion === 'no-drag'), JSON.stringify(expanded.dom.buttons))
    evidence.screenshots.push(await screenshot('quick-expanded'))

    const contentPayload = '  Raw Content 中文  '
    const typedOpen = await evaluate('quick', `window.enestShell.quickOpen(${JSON.stringify({ kind: 'plugin', pluginId, code: 'content', type: 'regex', payload: contentPayload })})`)
    assert.equal(typedOpen.ok, true)
    const received = await poll(() => evaluate('plugin', 'window.__quickSmokeEnters.at(-1)'), entry => entry?.type === 'regex', 'Content match delivered through production preload')
    assert.equal(received.code, 'content')
    assert.equal(received.payload, contentPayload)

    // A plugin's controlled input must not consume the first Escape merely to
    // clear its own query. The launcher should become a blank global search.
    assert.equal(await evaluate('plugin', "window.enest.quickInput.configure({ placeholder: 'Plugin query', value: 'plugin query' })"), true)
    await poll(domState, state => state?.query === 'plugin query', 'Plugin input configuration')
    await key('quick')
    await assertBlankLauncher('input-escape')
    assert.equal(await evaluate('quick', 'window.enestShell.quickInput()'), null)
    await repeatEscapeOnSearch()
    await assertBlankLauncher('input-held-escape')
    evidence.screenshots.push(await screenshot('quick-after-input-escape'))

    // Exercise main-process before-input-event routing from the native plugin,
    // then keep the same physical key held after focus returns to the search bar.
    await openFixture()
    await evaluate('plugin', "window.enest.quickInput.release().then(() => window.enest.ui.setInputContext('workbench'))")
    await key('plugin')
    await assertBlankLauncher('native-workbench-escape')
    await repeatEscapeOnSearch()
    await assertBlankLauncher('native-held-escape')

    // Interrupt entry transitions instead of waiting for their visual completion.
    for (let cycle = 0; cycle < 3; cycle++) {
      await openFixture(false)
      await key('quick')
      await key('quick', 'keyUp')
      await assertBlankLauncher(`rapid-open-escape-${cycle}`)
    }
    await openFixture()
    const reopened = await record('reopened-after-interruptions')
    assert.equal(reopened.native.plugins.length, 1)
    assert.equal(reopened.native.plugins[0].bounds.y, barHeight)
    assert.equal(reopened.native.plugins[0].bounds.width, quickWidth - 2)
    assert.equal(reopened.native.plugins[0].bounds.height, 300)
    assert.equal(reopened.dom.bar.bottom, barHeight)
    evidence.screenshots.push(await screenshot('quick-reopened'))

    // Move the live renderer to the main shell, then back to Quick. No reload,
    // duplicate child view or new renderer is permitted during either migration.
    const reusedWcId = reopened.native.plugins[0].wcId
    const pinResult = await evaluate('quick', `window.enestShell.quickOpen(${JSON.stringify({ kind: 'plugin-pin', pluginId })})`)
    assert.equal(pinResult.ok, true)
    await poll(nativeState, state => state && !state.visible && state.plugins.length === 0, 'Plugin moved from Quick to shell')
    const shellWcId = await app.evaluate(({ webContents }, id) => webContents.getAllWebContents().find(wc => {
      try { return new URL(wc.getURL()).searchParams.get('pid') === id } catch { return false }
    })?.id, pluginId)
    assert.equal(shellWcId, reusedWcId)
    await evaluate('shell', 'window.enestShell.quickToggle()')
    await poll(nativeState, state => state?.visible, 'Quick reshown after pin')
    await openFixture()
    const migratedBack = await record('shell-to-quick-reused')
    assert.equal(migratedBack.native.plugins.length, 1)
    assert.equal(migratedBack.native.plugins[0].wcId, reusedWcId)
    assert.equal(migratedBack.native.plugins[0].bounds.y, barHeight)
    evidence.migration = { quickWcId: reusedWcId, shellWcId, returnedWcId: migratedBack.native.plugins[0].wcId }

    await key('quick')
    await key('quick', 'keyUp')
    await assertBlankLauncher('final-escape')
    evidence.screenshots.push(await screenshot('quick-final-blank'))
    await evaluate('shell', `window.__quickMarketEvents = []; void window.enestShell.onEvent(event => {
      if (event.type === 'quick-open-view') window.__quickMarketEvents.push(event.view)
    })`)
    await evaluate('quick', "document.querySelector('.quick-market').click()")
    await poll(() => evaluate('shell', 'window.__quickMarketEvents.at(-1)'), view => view === 'home', 'Brand icon opens desktop plugin market')
    await poll(nativeState, state => state && !state.visible, 'Brand icon dismisses Quick')
    await evaluate('shell', 'window.enestShell.quickToggle()')
    await poll(nativeState, state => state?.visible, 'Quick reshown after opening market')
    await openFixture()
    // BaseWindow does not automatically own its children's WebContents.
    // Closing Quick must explicitly close its shell renderer.
    const quickShellWcId = await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows().find(candidate => candidate.getTitle() === 'eNest Quick')
      const id = win.webContents.id
      win.close()
      return id
    })
    await poll(() => app.evaluate(({ webContents, BaseWindow }, id) => ({
      wcExists: Boolean(webContents.fromId(id)),
      windowExists: BaseWindow.getAllWindows().some(win => win.getTitle() === 'eNest Quick')
    }), quickShellWcId), state => !state.wcExists && !state.windowExists, 'Quick BaseWindow shell WebContents destroyed')
    evidence.quickShellDestroyed = { wcId: quickShellWcId, destroyed: true }
    const closedEntry = await poll(() => evaluate('shell', 'window.enestShell.getPluginDiagnostics()'), diagnostics =>
      diagnostics.host.entries.some(entry => entry.pluginId === pluginId && entry.state === 'background'), 'Native Quick close backgrounds its plugin')
    evidence.pluginAfterWindowClose = closedEntry.host.entries.find(entry => entry.pluginId === pluginId)
    assert.doesNotMatch(stderr + stdout, /Unable to load preload|uncaughtException|unhandledRejection|Error invoking remote method/)
    evidence.passed = true
    console.log('Quick native smoke evidence:', JSON.stringify({ artifacts, screenshots: evidence.screenshots, repeatedEscapeEvents: evidence.repeatedEscapeEvents }))
  } catch (error) {
    failure = error
    evidence.passed = false
    evidence.error = String(error.stack || error)
    if (harness) {
      evidence.failureState = await Promise.allSettled([harness.domState(), harness.nativeState()])
      const image = await harness.screenshot('quick-failure').catch(() => null)
      if (image) evidence.screenshots.push(image)
    }
  } finally {
    evidence.stdout = stdout
    evidence.stderr = stderr
    await writeFile(join(artifacts, 'quick-window-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
    if (app) {
      // A failed assertion must not strand the isolated app or hang the runner.
      let closeTimer
      try {
        await Promise.race([
          app.close().catch(() => app.process().kill('SIGKILL')),
          new Promise(resolve => { closeTimer = setTimeout(() => { app.process().kill('SIGKILL'); resolve() }, 5000) })
        ])
      } finally { clearTimeout(closeTimer) }
    }
    await rm(dir, { recursive: true, force: true })
  }
  if (failure) throw new Error(`${failure.stack || failure}\nArtifacts: ${artifacts}\nApplication stdout:\n${stdout}\nApplication stderr:\n${stderr}`)
})
