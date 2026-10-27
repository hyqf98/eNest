/** Build first. Run alone: ENEST_APPEARANCE_NATIVE=1 node --test tests/main/home/appearanceSurfaces.native.test.mjs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pluginId = 'com.example.workspace.acceptance'
const pause = ms => new Promise(done => setTimeout(done, ms))
const observeStartup = `(() => {
  if(window.workspaceStartupObservation)return;
  const state=window.workspaceStartupObservation={choice:false,preparing:false,splash:false,ready:false,started:performance.now()};
  const observe=()=>{
    state.choice ||= !!document.querySelector('.theme-setup .appearance-theme-card');
    state.splash ||= !!document.querySelector('.splash');
    state.preparing ||= /正在准备首页|正在准备 eNest|正在读取主题和首页|正在打开主题首页/.test(document.body?.textContent??'');
    if(!state.ready&&document.querySelector('.app-boot.ready')){state.ready=true;state.readyAfterMs=performance.now()-state.started;}
  };
  new MutationObserver(observe).observe(document,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
  observe();
})()`

async function poll(read, accepts, label, milliseconds = 18000) {
  let value, error
  for (const deadline = Date.now() + milliseconds; Date.now() < deadline;) {
    try { value = await read(); error = undefined; if (accepts(value)) return value } catch (caught) { error = caught }
    await pause(60)
  }
  throw Error(`${label}: ${error?.message ?? JSON.stringify(value)}`)
}

// Catalog/detail data only: this fixture is never launched or given a backend.
async function writeCatalogFixture(dataRoot) {
  const folder = join(dataRoot, 'plugins', 'acceptance', '1.0.0')
  await mkdir(join(folder, 'assets/market/screenshots'), { recursive: true })
  await writeFile(join(folder, 'plugin.json'), JSON.stringify({
    id: pluginId, name: 'Workspace acceptance', version: '1.0.0', main: 'index.html',
    description: 'Local catalog and detail fixture; no business engine is started.',
    category: '其它', author: 'eNest acceptance', permissions: [], icon: 'assets/market/icon.svg',
    market: { featured: true, readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] }, ui: { themeAware: true, chrome: 'none', background: 'opaque' },
  }))
  await writeFile(join(folder, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#a85532"/><path d="M18 20h28v8H26v8h18v8H18z" fill="#fffdfa"/></svg>')
  await writeFile(join(folder, 'assets/market/README.md'), '# Workspace acceptance\n\nCatalog/detail data only. Do not launch this fixture.\n')
  await writeFile(join(folder, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  await writeFile(join(folder, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Fixture must not launch</title><p>This file is not part of runtime acceptance.</p>')
}

test('single default Workspace proves direct first-run startup, unified routes, dynamic settings, safe recovery and restart', {
  skip: process.env.ENEST_APPEARANCE_NATIVE !== '1', timeout: 150000,
}, async () => {
  await access(join(root, 'out/main/index.js'))
  await access(join(root, 'out/renderer/home.html'))
  const directory = await mkdtemp(join(tmpdir(), 'enest-workspace-native-'))
  const dataRoot = join(directory, 'data'), userData = join(directory, 'profile')
  const artifacts = process.env.ENEST_APPEARANCE_EVIDENCE ? resolve(process.env.ENEST_APPEARANCE_EVIDENCE) : join(directory, 'evidence')
  const evidence = {
    platform: process.platform, checks: {}, renders: [], screenshots: [], diagnostics: [],
    scope: 'Real offline Electron shell and one default Workspace; one catalog-only fixture. No business plugins or cross-platform matrix.',
  }
  let app, failure, logs = ''
  try {
    await mkdir(artifacts, { recursive: true })
    await writeCatalogFixture(dataRoot)
    const env = {
      ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData,
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
      http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', no_proxy: '',
    }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    const launch = async () => {
      app = await electron.launch({ executablePath: require('electron'), args: [root, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'], env, timeout: 30000 })
      await app.context().addInitScript(observeStartup)
      for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-90000) })
      await app.evaluate(({ app }) => {
        globalThis.workspaceAcceptanceConsole = []
        app.on('web-contents-created', (_event, contents) => {
          contents.on('console-message', details => {
            globalThis.workspaceAcceptanceConsole.push({ url: contents.getURL(), message: details.message, level: details.level })
          })
          contents.on('did-fail-load', (_event, code, description, url) => {
            globalThis.workspaceAcceptanceConsole.push({ url, code, message: description })
          })
        })
      })
      assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    }
    const close = async () => {
      if (!app) return
      evidence.diagnostics.push(...await app.evaluate(() => globalThis.workspaceAcceptanceConsole ?? []).catch(() => []))
      await app.close().catch(() => app.process().kill('SIGKILL'))
      app = undefined
    }
    const contentsId = surface => app.evaluate(({ webContents }, surface) => webContents.getAllWebContents().find(wc => {
      if (wc.isDestroyed()) return false
      const url = new URL(wc.getURL() || 'about:blank')
      return surface === 'workspace'
        ? url.protocol === 'enest-home:' && url.hostname === 'surface'
        : url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface')
    })?.id, surface)
    const evaluate = async (surface, code) => {
      const id = await contentsId(surface)
      if (id === undefined) throw Error(`Native ${surface} surface is not mounted`)
      return app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code), { id, code })
    }
    const call = (method, ...args) => evaluate('shell', `window.enestShell.${method}(...${JSON.stringify(args)})`)
    const inventory = () => app.evaluate(({ BaseWindow, webContents }) => {
      const visit = view => [...(view.webContents ? [{ id: view.webContents.id, url: view.webContents.getURL(), visible: view.getVisible(), bounds: view.getBounds() }] : []), ...view.children.flatMap(visit)]
      return {
        windows: BaseWindow.getAllWindows().map(win => ({ id: win.id, views: visit(win.contentView) })),
        contents: webContents.getAllWebContents().filter(wc => !wc.isDestroyed()).map(wc => ({ id: wc.id, url: wc.getURL() })),
      }
    })
    const workspaceVisible = async () => {
      const id = await contentsId('workspace')
      return (await inventory()).windows.flatMap(win => win.views).some(view => view.id === id && view.visible)
    }
    const click = async (surface, selector, ratio = 0.5) => {
      const position = await evaluate(surface, `new Promise((resolve,reject)=>{
        const node=document.querySelector(${JSON.stringify(selector)});
        if(!node||node.disabled||node.getAttribute('aria-disabled')==='true')return reject(Error('Missing or disabled control: '+${JSON.stringify(selector)}));
        node.scrollIntoView({block:'center',inline:'nearest'});
        requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=node.getBoundingClientRect();
          if(r.width<=0||r.height<=0)return reject(Error('Control is not visible'));
          resolve({x:Math.round(r.x+r.width*${ratio}),y:Math.round(r.y+r.height/2)})
        }))
      })`)
      const id = await contentsId(surface)
      await app.evaluate(({ app, BaseWindow, webContents }, { id, position }) => {
        app.focus({ steal: true })
        const contains = view => view.webContents?.id === id || view.children.some(contains)
        const win = BaseWindow.getAllWindows().find(win => contains(win.contentView))
        win?.show(); win?.focus()
        const wc = webContents.fromId(id)
        wc.focus()
        wc.sendInputEvent({ type: 'mouseMove', ...position })
        wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position })
        wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position })
      }, { id, position })
    }
    const capture = async (surface, name) => {
      const id = await contentsId(surface)
      await evaluate(surface, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const bytes = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), id)
      await writeFile(join(artifacts, name), Buffer.from(bytes, 'base64'))
      evidence.screenshots.push({ surface, name, kind: 'Actual WebContents capture; native visibility checked independently.' })
    }
    const dom = () => evaluate('workspace', `(() => {
      const root=document.documentElement;
      return {route:root.dataset.workspaceRoute,theme:root.dataset.appearanceTheme,mode:root.dataset.theme,
        visible:root.dataset.homeVisible,accent:getComputedStyle(root).getPropertyValue('--accent').trim(),
        radius:getComputedStyle(root).getPropertyValue('--appearance-control-radius').trim(),
        settings:!!document.querySelector('.workspace-settings:not(.workspace-settings-loading)'),
        cards:document.querySelectorAll('.card[data-plugin-card]').length,overflow:root.scrollWidth>innerWidth+2};
    })()`)
    const routeReady = async page => {
      await poll(() => call('getHomeState'), value => value.status === 'ready' && value.route?.page === page && !value.recovery, `${page} route acknowledgement`)
      const state = await poll(dom, value => value.route === page && value.visible === 'true', `${page} actual Workspace document`)
      assert.equal(await workspaceVisible(), true, `${page} is visible in the native view tree`)
      assert.equal(state.overflow, false)
      evidence.renders.push(state)
      return state
    }
    // Marketplace/installed is provider state: the host route stays on catalog and only the
    // list below changes. Wait for the segment to actually take effect in the document.
    const segmentReady = async (segment, label) => {
      await poll(() => call('getHomeState'), value => value.status === 'ready' && value.route?.page === 'catalog' && !value.recovery, `${label} keeps the host catalog route`)
      const state = await poll(dom, value => value.route === 'catalog' && value.visible === 'true', `${label} actual Workspace document`)
      const pressed = await poll(
        () => evaluate('workspace', `document.querySelector('.home-toolbar .segmented button[aria-pressed="true"]')?.textContent ?? ''`),
        value => value === segment,
        `${label} segment takes effect without a host navigation`
      )
      assert.equal(pressed, segment)
      assert.equal(await workspaceVisible(), true, `${label} is visible in the native view tree`)
      assert.equal(state.overflow, false)
      evidence.renders.push(state)
      return state
    }
    const noBusinessRuntime = async () => {
      const current = await inventory()
      assert.deepEqual(current.contents.filter(item => item.url.startsWith('enest://plugin/')), [], 'catalog/detail never start a plugin engine')
      assert.equal(current.contents.filter(item => item.url.startsWith('enest-home://surface/')).length, 1, 'one Workspace runtime serves every route')
    }

    await launch()
    await poll(() => evaluate('shell', 'typeof window.enestShell'), value => value === 'object', 'first-run shell preload')
    await evaluate('shell', observeStartup)
    assert.equal(Object.hasOwn((await call('getSettings')).general, 'themeSetupComplete'), false)
    assert.deepEqual((await call('getAppearance')).packs.filter(pack => pack.source === 'enest.builtin').map(pack => pack.id), ['default'])
    await poll(() => evaluate('shell', '!!document.querySelector(".splash[data-ready=true]")'), Boolean, 'first-run animation waits for the default Home ACK without confirmation')
    assert.equal(await workspaceVisible(), false, 'first-run prewarmed Workspace cannot cover Splash')
    const firstPrewarmedId = await poll(() => contentsId('workspace'), Number.isInteger, 'default Workspace prepares behind the first-run animation')
    const firstBootViews = (await inventory()).windows.flatMap(win => win.views)
    assert.ok(!firstBootViews.some(view => view.url.includes('orb-overlay') && view.visible), 'native chrome stays hidden until the first-run handoff')
    await capture('shell', '01-first-run-startup-animation.png')
    await poll(() => evaluate('shell', '!!document.querySelector(".app-boot.ready")'), Boolean, 'first-run animation hands off directly to Home')
    await routeReady('catalog')
    const firstStartup = await evaluate('shell', 'window.workspaceStartupObservation')
    assert.equal(firstStartup.choice, false, 'a fresh installation never renders the retired selection wizard')
    assert.equal(firstStartup.preparing, false, 'a fresh installation has no secondary preparing page')
    assert.equal(firstStartup.splash, true)
    assert.equal(Object.hasOwn((await call('getSettings')).general, 'themeSetupComplete'), false)
    const originalWorkspace = await contentsId('workspace')
    assert.equal(originalWorkspace, firstPrewarmedId, 'the first-run handoff reuses the hidden prewarmed Workspace')
    const catalog = await evaluate('workspace', 'window.enestWorkspace.getCatalog()')
    assert.ok(catalog.items.some(item => item.pluginId === pluginId && item.installed))
    assert.deepEqual(await evaluate('workspace', '[typeof window.enestWorkspace,typeof window.enestHome,typeof window.enestShell,typeof window.enest,typeof require,typeof process]'), ['object', 'object', 'undefined', 'undefined', 'undefined', 'undefined'])
    await capture('workspace', '02-catalog.png')
    evidence.checks.firstRunDirectStartupAndOfflineCatalog = { ...firstStartup, oneWorkspace: true, hiddenDuringSplash: true }
    evidence.checks.offlineMethod = 'Fresh data/profile; nonexistent proxy and Chromium DNS blocked. Only one catalog fixture is installed.'

    const originalHierarchy = await evaluate('workspace', `(() => ({
      market:!!document.querySelector('.page-home .home-scroll .market-page-heading'),
      search:!!document.querySelector('.market-search-header .search-wrap'),
      categories:!!document.querySelector('.home-toolbar .category-filter'),
      card:!!document.querySelector('.market-category .market-grid .card .card-actions'),
      featured:!!document.querySelector('.market-featured .product-carousel .product-slide .product-copy'),
      floatingSettings:!!document.querySelector('.bottom-bar .float-btn'),
      retiredLayout:!!document.querySelector('.workspace-route-nav,.home-card-main,.home-brand')
    }))()`)
    assert.deepEqual(originalHierarchy, { market: true, search: true, categories: true, card: true, featured: true, floatingSettings: true, retiredLayout: false })
    evidence.checks.originalReactHierarchy = originalHierarchy

    await click('workspace', '.home-toolbar .segmented button:nth-child(2)')
    await segmentReady('已安装', 'installed segment')
    await capture('workspace', '03-installed.png')
    await evaluate('workspace', `(() => {
      const source=document.querySelector('.card[data-plugin-id="${pluginId}"]');
      window.workspaceDetailMotion={source:source.getBoundingClientRect().toJSON(),samples:[],until:performance.now()+1400};
      const record=()=>{const s=window.workspaceDetailMotion,overlay=document.querySelector('.detail-overlay'),modal=document.querySelector('.detail-modal');
        if(modal)s.samples.push({phase:overlay.dataset.detailPhase,rect:modal.getBoundingClientRect().toJSON(),source:source.getBoundingClientRect().toJSON()});
        if(performance.now()<s.until)requestAnimationFrame(record);
      };requestAnimationFrame(record);return true;
    })()`)
    await click('workspace', `.card[data-plugin-id="${pluginId}"] .card-detail-trigger`)
    await routeReady('detail')
    assert.equal(await evaluate('workspace', 'document.querySelector("#plugin-detail-title")?.textContent'), 'Workspace acceptance')
    await poll(() => evaluate('workspace', 'document.querySelector(".detail-overlay")?.dataset.detailPhase'), phase => phase === 'open', 'original measured detail motion completes')
    const detailMotion = await evaluate('workspace', 'window.workspaceDetailMotion')
    const openingSamples = detailMotion.samples.filter(sample => sample.phase === 'opening')
    const openedSample = detailMotion.samples.find(sample => sample.phase === 'open')
    assert.ok(openingSamples.length >= 2, 'real original source-card detail has animated opening frames')
    assert.ok(openedSample, 'detail reaches its original steady dialog geometry')
    assert.ok(Math.abs(openingSamples[0].rect.width - openedSample.rect.width) > 10 || Math.abs(openingSamples[0].rect.x - openedSample.rect.x) > 10, 'source-to-detail geometry is not replaced by a static sidebar')
    await poll(() => evaluate('workspace', 'document.querySelector(".detail-body .markdown-body h2.md-h1")?.textContent'), title => title === 'Workspace acceptance', 'README uses the original nested heading hierarchy, not a preformatted text panel')
    evidence.checks.originalDetailMotion = { openingFrames: openingSamples.length, source: detailMotion.source, first: openingSamples[0].rect, open: openedSample.rect }
    const detail = await evaluate('workspace', `window.enestWorkspace.getDetail(${JSON.stringify(pluginId)})`)
    assert.equal(detail.pluginId, pluginId)
    assert.equal('assetUrl' in detail, false)
    assert.equal('rootPath' in detail, false)
    await capture('workspace', '04-detail.png')
    await noBusinessRuntime()

    await evaluate('workspace', `(() => {
      window.workspaceDetailClosing={samples:[],until:performance.now()+1200};
      const record=()=>{const s=window.workspaceDetailClosing,overlay=document.querySelector('.detail-overlay'),modal=document.querySelector('.detail-modal');
        if(modal)s.samples.push({phase:overlay.dataset.detailPhase,rect:modal.getBoundingClientRect().toJSON()});
        if(performance.now()<s.until)requestAnimationFrame(record);
      };requestAnimationFrame(record);return true;
    })()`)
    await click('workspace', '.detail-actions [data-detail-close]')
    await segmentReady('已安装', 'detail close')
    const closing = await evaluate('workspace', 'window.workspaceDetailClosing.samples.filter(sample=>sample.phase==="closing")')
    assert.ok(closing.length >= 2, 'closing reuses the original interruptible geometry transition')
    assert.equal(await evaluate('workspace', `document.activeElement?.closest('.card')?.dataset.pluginId`), pluginId, 'closing restores source-card keyboard focus')
    evidence.checks.originalDetailMotion.closingFrames = closing.length
    await click('workspace', `.card[data-plugin-id="${pluginId}"] .card-detail-trigger`)
    await routeReady('detail')
    await poll(() => evaluate('workspace', 'document.querySelector(".detail-overlay")?.dataset.detailPhase'), phase => phase === 'open', 'reopened detail settles before settings navigation')

    await click('workspace', '.detail-launch .btn')
    await routeReady('settings')
    await poll(() => evaluate('workspace', '!!document.querySelector(".workspace-settings:not(.workspace-settings-loading)")'), Boolean, 'theme-owned settings document')
    assert.equal(await evaluate('shell', '!!document.querySelector(".page-settings")'), false, 'ordinary settings are not rendered in the host')
    const snapshot = await evaluate('workspace', 'window.enestWorkspace.getSettings()')
    const hostSnapshot = await call('getAppearance')
    const defaultPack = hostSnapshot.packs.find(pack => pack.source === 'enest.builtin' && pack.id === 'default')
    const declaration = defaultPack.settings.groups.flatMap(group => group.fields).find(field => field.binding.target === 'component' && field.binding.key === 'controlRadius')
    assert.ok(declaration, 'editable field comes from the theme schema')
    const field = snapshot.sections.flatMap(section => section.fields).find(field => field.id.endsWith(`:${declaration.key}`))
    assert.equal(field.type, 'slider')
    assert.equal(field.value, hostSnapshot.appearance.components.controlRadius)
    const themeTabSelector = await evaluate('workspace', `(() => {const buttons=[...document.querySelectorAll('.settings-tabs [data-tab]')];const index=buttons.findIndex(button=>button.textContent==='主题');if(index<0)throw Error('Theme category missing');return '.settings-tabs [data-tab]:nth-child('+(index+1)+')'})()`)
    await click('workspace', themeTabSelector)
    const sliderSelector = `[data-setting-id=${JSON.stringify(field.id)}] .ui-slider-track`
    await poll(() => evaluate('workspace', `!!document.querySelector(${JSON.stringify(sliderSelector)})`), Boolean, 'schema-driven control rendered')
    await click('workspace', sliderSelector, 0.75)
    const updated = await poll(() => call('getAppearance'), value => value.profile.values[declaration.key] !== undefined && value.appearance.components.controlRadius !== field.value, 'dynamic setting persists through the restricted bridge')
    const changedRadius = updated.appearance.components.controlRadius
    await poll(dom, value => value.radius === `${changedRadius}px`, 'Workspace immediately applies the setting')
    assert.equal(await contentsId('workspace'), originalWorkspace, 'settings updates retain the same native runtime')
    assert.equal(await evaluate('workspace', 'document.querySelectorAll(".workspace-theme-choice").length'), 1)
    await capture('workspace', '05-dynamic-theme-settings.png')
    evidence.checks.unifiedRoutesAndDynamicSettings = { field: field.id, before: field.value, after: changedRadius }

    const effectDeclaration = defaultPack.settings.groups.flatMap(group => group.fields).find(item => item.binding.target === 'background' && item.binding.key === 'effect')
    const effectField = snapshot.sections.flatMap(section => section.fields).find(item => item.id.endsWith(`:${effectDeclaration.key}`))
    evidence.checks.originalBackgroundPresets = []
    for (const effect of ['fold', 'aurora', 'orbit', 'ripple', 'tunnel']) {
      const optionIndex = effectField.options.findIndex(option => option.value === effect)
      assert.ok(optionIndex >= 0)
      await click('workspace', `[data-setting-id=${JSON.stringify(effectField.id)}] .bg-effect-card:nth-child(${optionIndex + 1})`)
      await poll(() => call('getAppearance'), value => value.appearance.background.effect === effect, `${effect} persists from a real native selection`)
      const background = await poll(() => evaluate('workspace', `(() => {const field=document.querySelector('.background-effect');const canvas=field?.querySelector('canvas');return {effect:field?.dataset.backgroundEffect,fallback:field?.classList.contains('background-effect--fallback'),canvases:document.querySelectorAll('.background-effect canvas').length,width:canvas?.width,height:canvas?.height}})()`), value => value.effect === effect && value.canvases === 1 && !value.fallback && value.width > 1 && value.height > 1, `${effect} runs the original single GPU canvas`)
      assert.equal(await contentsId('workspace'), originalWorkspace, 'preset changes retain the isolated Workspace runtime')
      evidence.checks.originalBackgroundPresets.push(background)
      await capture('workspace', `05-background-${effect}.png`)
    }

    const splashSection = snapshot.sections.find(section => section.actions?.some(action => action.id === 'appearance.preview-splash'))
    assert.ok(splashSection, 'startup preview is declared by the theme schema')
    const previewIndex = splashSection.actions.findIndex(action => action.id === 'appearance.preview-splash')
    await click('workspace', `[data-settings-section=${JSON.stringify(splashSection.id)}] .workspace-settings-actions button:nth-child(${previewIndex + 1})`)
    await poll(() => evaluate('shell', '!!document.querySelector(".splash[role=dialog]")'), Boolean, 'theme-owned startup preview renders in the trusted shell')
    assert.equal(await workspaceVisible(), false, 'native Workspace yields to the startup preview')
    await poll(() => evaluate('shell', `(() => {const word=document.querySelector('.splash .splash-word-char');return !!word&&getComputedStyle(word).visibility!=='hidden'&&Number(getComputedStyle(word).opacity)>.6})()`), Boolean, 'original startup logo choreography becomes visibly rendered')
    await capture('shell', '05-startup-preview.png')
    await click('shell', '.splash-close')
    await routeReady('settings')
    assert.equal(await contentsId('workspace'), originalWorkspace, 'closing preview resumes the same settings runtime')
    evidence.checks.startupPreviewAndSettingsRestore = true

    await click('shell', '.titlebar-recovery')
    await poll(() => evaluate('shell', '!!document.querySelector(".page-settings")'), Boolean, 'trusted host safety panel')
    await poll(() => call('getHomeState'), value => value.recovery === true, 'Workspace recovery suspension')
    assert.equal(await workspaceVisible(), false)
    const latest = await evaluate('workspace', 'window.enestWorkspace.getSettings()')
    const denied = await evaluate('workspace', `window.enestWorkspace.updateSetting(${JSON.stringify({ id: field.id, value: field.value, revision: latest.revision })}).then(()=>({ok:true}),error=>({ok:false,error:String(error)}))`)
    assert.equal(denied.ok, false, 'hidden Workspace cannot write settings behind a safety panel')
    await call('setHomeVisible', true)
    assert.equal(await workspaceVisible(), false, 'ordinary visibility cannot bypass the recovery lock')
    await capture('shell', '06-host-safe-recovery.png')
    await click('shell', '.home-tab')
    await routeReady('catalog')
    assert.equal(await contentsId('workspace'), originalWorkspace)
    await noBusinessRuntime()
    evidence.checks.trustedRecoveryAndWriteRevocation = true

    await call('updateThemeProfile', { theme: { source: 'enest.builtin', id: 'default' }, values: { motion: 'medium', tabStyle: 'orb' } })
    await close()
    await launch()
    await poll(() => evaluate('shell', 'typeof window.enestShell'), value => value === 'object', 'restarted shell preload')
    await evaluate('shell', observeStartup)
    await poll(() => evaluate('shell', '!!document.querySelector(".splash[data-ready=true]")'), Boolean, 'restart retains the original launch animation')
    assert.equal(await workspaceVisible(), false, 'prewarmed Workspace cannot cover Splash')
    const prewarmedId = await poll(() => contentsId('workspace'), Number.isInteger, 'Workspace starts while Splash is still mounted')
    const bootViews = (await inventory()).windows.flatMap(win => win.views)
    assert.ok(!bootViews.some(view => view.url.includes('orb-overlay') && view.visible), 'restored orb settings cannot create visible chrome over Splash')
    await poll(() => evaluate('shell', '!!document.querySelector(".app-boot.ready")'), Boolean, 'restart opens the Workspace')
    await routeReady('catalog')
    const startup = await evaluate('shell', 'window.workspaceStartupObservation')
    assert.equal(startup.choice, false, 'restart does not repeat the selection wizard')
    assert.equal(startup.preparing, false, 'normal startup never renders a second preparing page')
    assert.equal(startup.splash, true)
    assert.equal(await contentsId('workspace'), prewarmedId, 'handoff reuses the hidden prewarmed Workspace')
    assert.equal(await evaluate('shell', '!!document.querySelector(".theme-setup .appearance-theme-card")'), false)
    assert.equal(Object.hasOwn((await call('getSettings')).general, 'themeSetupComplete'), false)
    assert.equal((await call('getAppearance')).appearance.components.controlRadius, changedRadius)
    await noBusinessRuntime()
    evidence.checks.startupPrewarmAndDirectHandoff = { ...startup, oneWorkspace: true, hiddenDuringSplash: true }
    await capture('workspace', '07-restart-direct-catalog.png')
    evidence.checks.restartSkipsSelectionAndRetainsSetting = true
    await poll(inventory, state => state.windows.flatMap(win => win.views).some(view => view.url.includes('orb-overlay') && view.visible), 'saved orb chrome appears after handoff')
    await call('navigateWorkspace', { page: 'settings', sectionId: 'theme' })
    await routeReady('settings')
    await click('workspace', themeTabSelector)
    await click('workspace', `[data-settings-section=${JSON.stringify(splashSection.id)}] .workspace-settings-actions button:nth-child(${previewIndex + 1})`)
    await poll(() => evaluate('shell', '!!document.querySelector(".splash[role=dialog]")'), Boolean, 'orb startup preview')
    await poll(inventory, state => !state.windows.flatMap(win => win.views).some(view => view.visible && (view.url.includes('orb-overlay') || view.url.startsWith('enest-home://surface/'))), 'Home and native orb chrome both yield to preview')
    await click('shell', '.splash-close')
    await routeReady('settings')
    await poll(inventory, state => state.windows.flatMap(win => win.views).some(view => view.url.includes('orb-overlay') && view.visible), 'same orb chrome resumes after preview')
    assert.equal(await contentsId('workspace'), prewarmedId)
    evidence.checks.orbPreviewHidesAndRestoresNativeChrome = true
    evidence.status = 'pass'
    await close()
  } catch (error) {
    failure = error; evidence.status = 'fail'; evidence.error = String(error.stack ?? error)
    if (app) evidence.failureInventory = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map(wc => ({ id: wc.id, url: wc.getURL() }))).catch(() => [])
  } finally {
    if (app) {
      evidence.diagnostics.push(...await app.evaluate(() => globalThis.workspaceAcceptanceConsole ?? []).catch(() => []))
      await app.close().catch(() => app.process().kill('SIGKILL'))
    }
    const mainLog = await readFile(join(dataRoot, 'logs', 'main.log'), 'utf8').catch(() => '')
    if (mainLog) await writeFile(join(artifacts, 'main.log'), mainLog)
    await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    await writeFile(join(artifacts, 'electron.log'), logs)
    console.log(process.env.ENEST_APPEARANCE_EVIDENCE ? `Native Workspace evidence: ${artifacts}` : JSON.stringify({ status: evidence.status, checks: evidence.checks, error: evidence.error }))
    await rm(directory, { recursive: true, force: true })
  }
  if (failure) throw failure
})
