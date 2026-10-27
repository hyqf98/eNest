/** Build first. ENEST_SHORTCUT_SMOKE=1 node --test tests/main/window/pluginShortcuts.smoke.test.mjs */
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

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const ids = ['com.example.smoke.shortcuts-a', 'com.example.smoke.shortcuts-b']
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read, accept, label, timeout = 15000) {
  let value, error
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    try { value = await read(); if (accept(value)) return value } catch (caught) { error = caught }
    await pause(25)
  }
  throw Error(`${label}: ${error?.message ?? JSON.stringify(value)}`)
}
function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { count: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] }
}

test('plugin shortcuts migrate, register and reuse native views across layouts', {
  skip: process.env.ENEST_SHORTCUT_SMOKE !== '1', timeout: 240000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-shortcuts-smoke-'))
  const artifacts = process.env.ENEST_SHORTCUT_SMOKE_ARTIFACTS ? resolve(process.env.ENEST_SHORTCUT_SMOKE_ARTIFACTS)
    : await mkdtemp(join(tmpdir(), 'enest-shortcuts-artifacts-'))
  const dataRoot = join(directory, 'data'), userData = join(directory, 'user-data')
  const evidence = { platform: process.platform, artifacts, measurements: [], screenshots: [], realSystemHotkey: false }
  let app, failure, logs = ''
  try {
    await mkdir(artifacts, { recursive: true })
    for (const id of ids) {
      const folder = join(dataRoot, 'plugins', id, '1.0.0')
      await mkdir(join(folder, 'assets/market/screenshots'), { recursive: true })
      await writeFile(join(folder, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0f766e"/></svg>')
      await writeFile(join(folder, 'assets/market/README.md'), '# Shortcut fixture')
      await writeFile(join(folder, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      await writeFile(join(folder, 'plugin.json'), JSON.stringify({ id, name: id === ids[0] ? '快捷键测试 A' : '快捷键测试 B',
        description: 'Isolated shortcut fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg',
        market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] },
        permissions: [], features: [{ code: 'main', cmds: [id] }], ui: { chrome: 'none', background: 'opaque', themeAware: false } }))
      await writeFile(join(folder, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><style>body{background:#edf5f2;color:#143f32;font:16px system-ui;padding:24px}input{font:inherit;padding:10px}</style></head><body><h1>快捷键直接启动</h1><input id="state" value="页面状态保留"><script src="assets/fixture.js"></script></body></html>')
      await writeFile(join(folder, 'assets/fixture.js'), 'window.identity=crypto.randomUUID();window.enters=[];window.enest.onEnter(e=>window.enters.push(e));window.ready=true;')
    }
    const modifier = process.platform === 'darwin' ? 'Control+Alt+Command' : 'Control+Alt+Shift'
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', overrides: {} },
      general: { quickLauncher: { enabled: false }, animationLevel: 'low', closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] },
      pluginLaunch: { [ids[0]]: { hotkey: `${modifier}+1`, mode: 'quick', aliases: ['keep-me'] } }, plugins: {} }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    app.process().stderr.on('data', chunk => { logs = (logs + chunk).slice(-100000) })
    app.process().stdout.on('data', chunk => { logs = (logs + chunk).slice(-100000) })
    const evaluate = (surface, code, pluginId = ids[0]) => app.evaluate(({ webContents }, { surface, code, pluginId }) => {
      const wc = webContents.getAllWebContents().find(wc => {
        try {
          const url = new URL(wc.getURL())
          return surface === 'plugin' ? url.searchParams.get('pid') === pluginId || url.protocol === 'enest:' && url.hostname === pluginId
            : surface === 'quick' ? url.searchParams.get('surface') === 'quick'
              : url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface')
        } catch { return false }
      })
      if (!wc) throw Error(`Missing ${surface}`)
      return wc.executeJavaScript(code)
    }, { surface, code, pluginId })
    const call = (method, ...args) => evaluate('shell', `window.enestShell[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
    const captureShell = async name => {
      const screenshot = await app.evaluate(async ({ app: electronApp, BaseWindow, webContents }) => {
        const win = BaseWindow.getAllWindows().find(win => win.getTitle() !== 'eNest Quick')
        electronApp.focus({ steal: true }); if (win.isMinimized()) win.restore(); win.show(); win.focus()
        const wc = webContents.getAllWebContents().find(wc => { try { const url = new URL(wc.getURL()); return url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface') } catch { return false } })
        // DOM assertions can finish before the compositor presents the new settings tab.
        await wc.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))))')
        return (await wc.capturePage()).toPNG().toString('base64')
      })
      await writeFile(join(artifacts, name), Buffer.from(screenshot, 'base64'))
      evidence.screenshots.push(name)
    }
    const inventory = () => app.evaluate(({ BaseWindow, webContents }, pluginIds) => {
      const views = (view, visible = true) => [...(view.webContents ? [{ wcId: view.webContents.id, url: view.webContents.getURL(), visible: visible && view.getVisible() }] : []),
        ...view.children.flatMap(child => views(child, visible && view.getVisible()))]
      const matches = url => { try { const u = new URL(url); return pluginIds.includes(u.searchParams.get('pid')) || u.protocol === 'enest:' && pluginIds.includes(u.hostname) } catch { return false } }
      return { renderers: webContents.getAllWebContents().filter(wc => matches(wc.getURL())).map(wc => ({ id: wc.id, url: wc.getURL() })),
        windows: BaseWindow.getAllWindows().map(win => ({ id: win.id, title: win.getTitle(), visible: win.isVisible(), focused: win.isFocused(),
          pluginViews: views(win.contentView).filter(v => matches(v.url)) })) }
    }, ids)
    const visibleIn = async mode => {
      const state = await inventory()
      return state.windows.find(win => win.visible && win.pluginViews.some(v => v.visible && v.url.includes(ids[0]))
        && (mode === 'quick' ? win.title === 'eNest Quick' : win.title !== 'eNest Quick'))
    }
    await poll(() => evaluate('shell', 'typeof window.enestShell?.getPluginShortcuts'), x => x === 'function', 'shortcut preload')
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    let snapshot = await call('getPluginShortcuts')
    assert.equal(snapshot.bindings.length, 1)
    const first = snapshot.bindings[0]
    assert.equal(snapshot.states[0].status, 'registered')
    assert.equal((await inventory()).renderers.length, 0, 'registration must not preload plugins')
    await poll(() => evaluate('shell', '!!document.querySelector(".app-boot.ready .app")'), Boolean, 'shell startup completed')
    await call('setShellView', 'settings')
    await poll(() => evaluate('shell', 'document.querySelectorAll(".settings-tabs button").length'), n => n > 0, 'settings loaded')
    const account = await call('getAccountState')
    if (!account.providers.find(provider => provider.id === 'github')?.available) {
      await evaluate('shell', `void [...document.querySelectorAll('.settings-tabs button')].find(button=>button.textContent==='个人资料')?.click()`)
      await poll(() => evaluate('shell', '!!document.querySelector(".account-provider")'), Boolean, 'profile login button')
      assert.equal(await evaluate('shell', 'document.querySelector(".account-provider").disabled'), false, 'unconfigured login remains clickable')
      await evaluate('shell', 'void document.querySelector(".account-provider").click()')
      const message = await poll(() => evaluate('shell', 'document.querySelector(".account-error")?.textContent'), text => /GitHub.*(?:尚未配置|地址无效)|尚未配置 GitHub/.test(text ?? ''), 'actionable login configuration error')
      assert.equal((await call('getAccountState')).pendingProviderId, null, 'failed login does not leave a pending session')
      evidence.unconfiguredProfileLogin = { clickable: true, message, pending: false }
      await captureShell('profile-login-unconfigured.png')
    }
    await evaluate('shell', `void [...document.querySelectorAll('.settings-tabs button')].find(b=>b.textContent==='快捷键')?.click()`)
    await poll(() => evaluate('shell', 'document.querySelectorAll(".shortcut-plugin-group").length'), count => count === 2, 'installed plugin shortcut cards')
    await evaluate('shell', `void [...document.querySelector('.shortcut-plugin-group[data-plugin-id="${ids[0]}"]').querySelectorAll('button')].find(b=>b.textContent.includes('添加快捷键'))?.click()`)
    await poll(() => evaluate('shell', '!!document.querySelector(".shortcut-editor")'), Boolean, 'inline editor')
    await evaluate('shell', `void [...document.querySelectorAll('.shortcut-editor [role="radiogroup"][aria-label="启动位置"] [role="radio"]')].find(button=>button.textContent==='主窗口')?.click()`)
    await app.evaluate(({ app, BaseWindow }) => {
      const win = BaseWindow.getAllWindows().find(win => win.getTitle() !== 'eNest Quick')
      app.focus({ steal: true }); if (win.isMinimized()) win.restore(); win.show(); win.focus()
      const visit = view => { if (view.webContents?.getURL().includes('/renderer/index.html')) view.webContents.focus(); for (const child of view.children) visit(child) }
      visit(win.contentView)
    })
    await evaluate('shell', 'void document.querySelector(".shortcut-editor .shortcut-recorder input").focus()')
    await poll(() => call('getPluginShortcuts'), s => s.states.every(state => state.status === 'suspended'), 'recording pauses shortcuts')
    await app.evaluate(({ webContents }, modifiers) => {
      const wc = webContents.getAllWebContents().find(wc => { try { const url = new URL(wc.getURL()); return url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface') } catch { return false } })
      wc.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers })
    }, process.platform === 'darwin' ? ['control', 'alt', 'meta'] : ['control', 'alt', 'shift'])
    await poll(() => evaluate('shell', 'document.querySelector(".shortcut-editor .shortcut-recorder input").value'), value => value.endsWith('+ 2'), 'native keydown preview')
    assert.equal((await call('getPluginShortcuts')).bindings.length, 1, 'keydown preview does not save')
    await app.evaluate(({ webContents }, modifiers) => {
      const wc = webContents.getAllWebContents().find(wc => { try { const url = new URL(wc.getURL()); return url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface') } catch { return false } })
      wc.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers })
    }, process.platform === 'darwin' ? ['control', 'alt', 'meta'] : ['control', 'alt', 'shift'])
    await poll(() => evaluate('shell', '!document.querySelector(".shortcut-editor button[type=submit]").disabled'), Boolean, 'native key capture and conflict precheck')
    await evaluate('shell', 'void document.querySelector(".shortcut-editor button[type=submit]").click()')
    snapshot = await poll(() => call('getPluginShortcuts'), s => s.bindings.length === 2, 'UI saves binding')
    const shellId = snapshot.bindings.find(binding => binding.id !== first.id).id
    assert.equal(snapshot.bindings.find(binding => binding.id === shellId).mode, 'shell')
    assert.ok(snapshot.states.every(state => state.status === 'registered'))
    evidence.nativeRecorderAndUiSave = true
    const duplicate = await call('savePluginShortcut', { pluginId: ids[1], accelerator: `${modifier}+2`, mode: 'quick', enabled: true })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.probe.ownerBindingId, shellId)
    evidence.conflictKeepsOriginal = true

    await evaluate('shell', `void [...document.querySelector('.shortcut-plugin-group[data-plugin-id="${ids[1]}"]').querySelectorAll('button')].find(button=>button.textContent.includes('添加快捷键'))?.click()`)
    await evaluate('shell', 'void document.querySelector(".shortcut-editor .shortcut-recorder input").focus()')
    await poll(() => call('getPluginShortcuts'), state => state.states.every(item => item.status === 'suspended'), 'second recording pauses shortcuts')
    await app.evaluate(({ webContents }, modifiers) => {
      const wc = webContents.getAllWebContents().find(wc => { try { const url = new URL(wc.getURL()); return url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface') } catch { return false } })
      wc.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers })
    }, process.platform === 'darwin' ? ['control', 'alt', 'meta'] : ['control', 'alt', 'shift'])
    await poll(() => evaluate('shell', 'document.querySelector(".shortcut-editor [role=alert]")?.textContent'), text => text?.includes('快捷键测试 A') && text.includes('确认覆盖并保存'), 'automatic conflict names its owner')
    assert.equal((await call('getPluginShortcuts')).bindings.find(binding => binding.id === shellId).enabled, true, 'precheck never overrides without confirmation')
    await evaluate('shell', 'void document.querySelector(".shortcut-editor .shortcut-probe").scrollIntoView({block:"center"})')
    await captureShell('shortcut-conflict-confirm.png')
    await evaluate('shell', 'void [...document.querySelectorAll(".shortcut-editor button")].find(button=>button.textContent === "确认覆盖并保存")?.click()')
    snapshot = await poll(() => call('getPluginShortcuts'), state => state.bindings.length === 3, 'confirmed shortcut takeover')
    const takeover = snapshot.bindings.find(binding => binding.pluginId === ids[1])
    assert.equal(snapshot.bindings.find(binding => binding.id === shellId).enabled, false)
    assert.equal(snapshot.states.find(state => state.id === takeover.id).status, 'registered')
    evidence.nativeConflictConfirmation = true
    // Restore this fixture's original pair for the launch/migration checks below.
    await call('removePluginShortcut', takeover.id)
    const restore = await call('savePluginShortcut', { ...snapshot.bindings.find(binding => binding.id === shellId), enabled: true })
    assert.equal(restore.ok, true, JSON.stringify(restore))

    const launch = async (bindingId, mode) => {
      const started = performance.now()
      const result = await call('launchPluginShortcut', bindingId)
      assert.equal(result.ok, true, JSON.stringify(result))
      await poll(() => visibleIn(mode), Boolean, `visible in ${mode}`)
      await poll(() => evaluate('plugin', 'window.ready'), Boolean, 'plugin ready')
      return performance.now() - started
    }
    evidence.firstColdMs = await launch(first.id, 'quick')
    const initial = await inventory(), wcId = initial.renderers[0].id
    const identity = await evaluate('plugin', 'window.identity')
    await evaluate('plugin', 'document.querySelector("#state").value="preserved through shortcuts";void 0')
    await launch(shellId, 'shell')
    await launch(first.id, 'quick')
    assert.equal((await inventory()).renderers[0].id, wcId)
    assert.equal(await evaluate('plugin', 'window.identity'), identity)
    assert.equal(await evaluate('plugin', 'document.querySelector("#state").value'), 'preserved through shortcuts')
    await poll(() => evaluate('quick', 'document.body.innerText'), x => !x.includes('正在加载'), 'quick loading clears')
    evidence.reusedView = true

    for (const [bindingId, mode] of [[shellId, 'shell'], [first.id, 'quick']]) {
      const detached = await evaluate(await visibleIn('quick') ? 'quick' : 'shell', `window.enestWindows.command(${JSON.stringify({ action: 'detach', pluginId: ids[0] })})`)
      assert.equal(detached.ok, true, JSON.stringify(detached))
      await launch(bindingId, mode)
      assert.equal((await inventory()).renderers[0].id, wcId)
      assert.equal(await evaluate('plugin', 'window.identity'), identity)
    }
    evidence.detachedReturnsToBoundPosition = true

    // Exercise the real OS accelerator independently from command timing below.
    if (process.platform === 'darwin' && process.env.ENEST_SHORTCUT_SYSTEM_INPUT === '1') {
      await call('quickHide')
      await app.evaluate(({ BaseWindow }) => {
        const win = BaseWindow.getAllWindows().find(win => win.getTitle() !== 'eNest Quick')
        win.minimize()
      })
      await execute('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 19 using {control down, option down, command down}'])
      await poll(() => visibleIn('shell'), Boolean, 'OS shortcut main window')
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find(win => win.getTitle() !== 'eNest Quick').hide())
      await execute('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 19 using {control down, option down, command down}'])
      await poll(() => visibleIn('shell'), Boolean, 'OS shortcut restores hidden main window')
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find(win => win.getTitle() !== 'eNest Quick').hide())
      await execute('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 18 using {control down, option down, command down}'])
      await poll(() => visibleIn('quick'), Boolean, 'OS shortcut Quick window')
      evidence.realSystemHotkey = true
      evidence.hiddenMainSystemHotkey = true
    }

    for (const tabStyle of ['classic', 'orb']) {
      await launch(shellId, 'shell')
      await call('setShellView', 'settings')
      await evaluate('shell', `void [...document.querySelectorAll('.settings-tabs button')].find(b=>b.textContent==='通用')?.click()`)
      await poll(() => evaluate('shell', 'document.querySelectorAll(".tab-style-seg button").length'), n => n === 2, 'layout controls')
      await evaluate('shell', `void document.querySelectorAll('.tab-style-seg button')[${tabStyle === 'classic' ? 0 : 1}].click()`)
      await poll(() => evaluate('shell', 'document.documentElement.dataset.tabStyle'), style => style === tabStyle, 'renderer layout changes')
      await launch(shellId, 'shell')
      const results = await evaluate('shell', `Promise.all([window.enestShell.launchPluginShortcut(${JSON.stringify(first.id)}),window.enestShell.launchPluginShortcut(${JSON.stringify(shellId)}),window.enestShell.launchPluginShortcut(${JSON.stringify(first.id)})])`)
      assert.equal(results.at(-1).ok, true, JSON.stringify(results))
      await poll(() => visibleIn('quick'), Boolean, `${tabStyle} last intent`)
      assert.equal((await inventory()).renderers.length, 1)
    }
    evidence.classicAndOrb = true

    // Cold/warm timings use the public IPC, include native-view observation and
    // exclude OS input delivery. They are not physical key-to-pixel timings.
    await call('removePluginShortcut', shellId)
    const keys = [...'234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...Array.from({ length: 14 }, (_, i) => `F${i + 1}`)]
    for (const count of [1, 10, 50]) {
      snapshot = await call('getPluginShortcuts')
      for (let i = snapshot.bindings.length; i < count; i++) {
        const saved = await call('savePluginShortcut', { pluginId: ids[0], accelerator: `${modifier}+${keys[i - 1]}`, mode: 'quick', enabled: true })
        assert.equal(saved.ok, true, JSON.stringify(saved))
      }
      assert.equal((await call('getPluginShortcuts')).bindings.length, count)
      const warm = [], hiddenWarm = [], cold = []
      for (let i = 0; i < 20; i++) warm.push(await launch(first.id, 'quick'))
      for (let i = 0; i < 20; i++) {
        await call('quickHide')
        hiddenWarm.push(await launch(first.id, 'quick'))
      }
      assert.equal((await inventory()).renderers.length, 1)
      for (let i = 0; i < 5; i++) {
        await call('closePlugin', ids[0])
        await poll(inventory, s => s.renderers.length === 0, 'close completes')
        cold.push(await launch(first.id, 'quick'))
      }
      evidence.measurements.push({ bindings: count, visibleWarm: percentiles(warm), hiddenWarm: percentiles(hiddenWarm), cold: percentiles(cold) })
    }
    await call('setPluginEnabled', ids[0], false)
    assert.ok((await call('getPluginShortcuts')).states.every(state => state.status === 'plugin-disabled'))
    await call('setPluginEnabled', ids[0], true)
    assert.ok((await call('getPluginShortcuts')).states.every(state => state.status === 'registered'))
    evidence.disableEnable = true
    const quickKey = `${modifier}+F18`
    const quickSaved = await call('quickSetHotkeys', { enabled: true, hotkeys: [quickKey], activeHotkey: quickKey })
    assert.equal(quickSaved.ok, true, JSON.stringify(quickSaved))
    assert.equal(quickSaved.registered.length, 1)
    const quickConflict = await call('quickSetHotkeys', { hotkeys: [first.accelerator], activeHotkey: first.accelerator })
    assert.equal(quickConflict.ok, false)
    assert.deepEqual((await call('quickGetConfig')).registered, quickSaved.registered)
    assert.ok((await call('getPluginShortcuts')).states.every(state => state.status === 'registered'))
    await call('quickHide')
    await call('setShellView', 'settings')
    await evaluate('shell', `void [...document.querySelectorAll('.settings-tabs button')].find(b=>b.textContent==='快捷键')?.click()`)
    await poll(() => evaluate('shell', 'document.body.innerText'), text => text.includes('添加快捷键'), 'shortcut settings UI')
    await captureShell('shortcut-settings.png')
    evidence.finalBindings = (await call('getPluginShortcuts')).bindings.length
    await app.close()
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    app.process().stderr.on('data', chunk => { logs = (logs + chunk).slice(-100000) })
    app.process().stdout.on('data', chunk => { logs = (logs + chunk).slice(-100000) })
    await poll(() => evaluate('shell', 'typeof window.enestShell?.getPluginShortcuts'), x => x === 'function', 'restart preload')
    snapshot = await call('getPluginShortcuts')
    assert.equal(snapshot.bindings.length, 50)
    assert.ok(snapshot.states.every(state => state.status === 'registered'))
    assert.equal((await inventory()).renderers.length, 0, 'restart must not preload shortcut plugins')
    const quickRestored = await call('quickGetConfig')
    assert.equal(quickRestored.enabled, true)
    assert.deepEqual(quickRestored.registered, quickSaved.registered)
    assert.equal((await call('quickSetHotkeys', { enabled: false })).ok, true)
    assert.ok((await call('getPluginShortcuts')).states.every(state => state.status === 'registered'))
    evidence.quickPersistenceAndIndependentToggle = true
    evidence.restartPersistence = true
    await call('uninstallPlugin', ids[0])
    await poll(() => call('getPluginShortcuts'), s => s.bindings.length === 0, 'uninstall removes bindings')
    evidence.uninstallCleanup = true
    evidence.status = 'pass'
  } catch (error) {
    failure = error; evidence.status = 'fail'; evidence.error = String(error?.stack ?? error)
    if (app) evidence.documents = await app.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents().map(async wc => ({
      url: wc.getURL(), text: await wc.executeJavaScript('document.body?.innerText').catch(() => '')
    })))).catch(() => [])
  } finally {
    await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2))
    await writeFile(join(artifacts, 'electron.log'), logs)
    if (app) await app.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
    console.log(`shortcut smoke artifacts: ${artifacts}`)
  }
  if (failure) throw failure
})
