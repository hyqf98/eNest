/** Build first, then ENEST_NOTIFICATION_SMOKE=1 node --test src/main/window/notificationOverlay.smoke.test.mjs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'
const require = createRequire(import.meta.url)
const root = process.cwd()
const pluginId = 'com.enest.smoke.notifications'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read, check, label, timeout = 15000) {
  let value, error
  for (const until = Date.now() + timeout; Date.now() < until;) {
    try { value = await read(); if (check(value)) return value } catch (failure) { error = failure }
    await pause(60)
  }
  throw new Error(`${label}: ${error?.stack || JSON.stringify(value)}`)
}
test('native notification views stay above plugins in shell, Quick and detached containers; rich content is inert and isolated', { skip: process.env.ENEST_NOTIFICATION_SMOKE !== '1', timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-notification-native-'))
  const dataRoot = join(directory, 'data'), userData = join(directory, 'profile')
  const folder = join(dataRoot, 'plugins', pluginId, '1.0.0')
  let app, logs = ''
  const evidence = { platform: process.platform, containers: [] }
  try {
    await mkdir(join(folder, 'assets/market/screenshots'), { recursive: true })
    await writeFile(join(folder, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#39836b"/></svg>')
    await writeFile(join(folder, 'assets/market/README.md'), '# Native notification fixture')
    await writeFile(join(folder, 'assets/market/screenshots/main.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    await writeFile(join(folder, 'plugin.json'), JSON.stringify({ id: pluginId, name: '通知验收插件', description: 'Isolated notification fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/main.png'] }, permissions: [], ui: { themeAware: false } }))
    await writeFile(join(folder, 'index.html'), '<html><body style="background:#d6eae1;font:18px system-ui"><h1>插件内容仍可操作</h1><input id="field" value="保留的插件状态"></body></html>')
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', overrides: {} }, general: { animationLevel: 'medium', quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: {} }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    app.process().stderr.on('data', value => { logs = (logs + value).slice(-32000) })
    app.process().stdout.on('data', value => { logs = (logs + value).slice(-32000) })
    const run = (target, code) => app.evaluate(({ webContents }, { target, code, pluginId }) => {
      const wc = webContents.getAllWebContents().find(wc => {
        const url = wc.getURL()
        if (target === 'plugin') return url.startsWith('enest://') && url.includes(pluginId)
        if (target === 'notice') return url.endsWith('/notification-overlay.html')
        if (target === 'detached') return url.includes('/detached-plugin.html')
        if (target === 'quick') return url.includes('surface=quick')
        return url.endsWith('/renderer/index.html')
      })
      if (!wc) throw Error(`Missing ${target}`)
      return wc.executeJavaScript(code)
    }, { target, code, pluginId })
    const inventory = () => app.evaluate(({ BaseWindow }, pluginId) => {
      const walk = view => [{ view, wc: view.webContents }, ...view.children.flatMap(walk)]
      return BaseWindow.getAllWindows().map(win => ({ id: win.id, title: win.getTitle(), visible: win.isVisible(), bounds: win.getContentBounds(), views: walk(win.contentView).filter(entry => entry.wc).map(({ view, wc }) => ({ id: wc.id, url: wc.getURL(), bounds: view.getBounds(), visible: view.getVisible(), topIndex: win.contentView.children.indexOf(view), plugin: wc.getURL().startsWith('enest://') && wc.getURL().includes(pluginId) })) }))
    }, pluginId)
    await poll(() => run('shell', 'typeof window.enestNotifications?.show'), value => value === 'function', 'notification client')
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    await run('shell', `window.enestShell.openPlugin(${JSON.stringify(pluginId)})`)
    await poll(() => run('plugin', 'typeof window.enest.ui.toast'), value => value === 'function', 'plugin bridge')
    const malicious = '<p onclick="window.__xss=1">保存成功 <strong>24 项</strong></p><img src="https://tracker.invalid/x" onerror="window.__xss=2"><iframe srcdoc="danger"></iframe><script>window.__xss=3</script><a href="javascript:alert(1)">拒绝脚本</a>'
    for (const [container, position, format] of [['shell', 'center', 'html'], ['quick', 'bottom-right', 'markdown'], ['detached', 'center', 'text']]) {
      if (container === 'quick') {
        await run('shell', `window.enestWindows.command({action:'dock',pluginId:${JSON.stringify(pluginId)},target:'quick'})`)
        await poll(inventory, list => list.some(win => win.title === 'eNest Quick' && win.visible), 'Quick visible')
        await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().find(win => win.getTitle() === 'eNest Quick')?.removeAllListeners('blur'))
      } else if (container === 'detached') {
        await run('quick', `window.enestWindows.command({action:'detach',pluginId:${JSON.stringify(pluginId)}})`)
        await poll(() => run('detached', 'window.enestWindows.getState()'), state => state?.status === 'ready', 'detached ready')
      }
      const payload = { title: `${container} 通知`, body: format === 'html' ? malicious : format === 'markdown' ? '**导入完成**\n\n- 所有数据已保存\n- 仍可继续编辑' : '独立窗口中的通知', format, position, duration: 0, level: 'success' }
      assert.equal(await run('plugin', `window.enest.ui.toast(${JSON.stringify(payload)})`), true)
      await poll(() => run('notice', 'document.querySelector(".notify-card")?.textContent'), text => text?.includes(`${container} 通知`), `${container} card`)
      await pause(450)
      const metrics = await run('notice', `({height:innerHeight,scroll:document.querySelector('.notification-overlay-stack').scrollHeight,box:document.querySelector('.notification-overlay-stack').getBoundingClientRect().toJSON(),card:document.querySelector('.notify-card').getBoundingClientRect().toJSON(),root:document.querySelector('#root').getBoundingClientRect().toJSON()})`)
      const native = await poll(inventory, list => list.some(win => win.views.some(view => view.url.endsWith('/notification-overlay.html') && view.visible)), 'native notice visible')
      const win = native.find(win => win.views.some(view => view.plugin))
      const notice = win.views.find(view => view.url.endsWith('/notification-overlay.html'))
      assert.ok(notice?.visible, `${container}: notice belongs to plugin container`)
      assert.ok(notice.bounds.width < win.bounds.width, 'notification is not a full-window input blocker')
      assert.ok(notice.bounds.height < win.bounds.height)
      assert.ok(notice.topIndex >= 0)
      const pluginTop = win.views.filter(view => view.plugin).map(view => view.topIndex).filter(index => index >= 0)
      if (pluginTop.length) assert.ok(notice.topIndex > Math.max(...pluginTop), 'notice paints above native plugin')
      const safe = await run('notice', `({unsafe:document.querySelectorAll('.notify-card img,.notify-card iframe,.notify-rich [onclick],.notify-rich script').length,xss:window.__xss,source:document.querySelector('.notify-source')?.textContent,bridge:typeof window.enestShell})`)
      assert.equal(safe.unsafe, 0); assert.equal(safe.xss, undefined); assert.equal(safe.source, '通知验收插件'); assert.equal(safe.bridge, 'undefined')
      assert.equal(await run('plugin', 'document.querySelector("#field").value'), '保留的插件状态')
      const image = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), notice.id)
      const screenshot = `/tmp/enest-native-notification-${container}.png`
      await writeFile(screenshot, Buffer.from(image, 'base64'))
      evidence.containers.push({ container, notice, screenshot, safe, metrics })
      if (container === 'shell') {
        await run('shell', "window.enestShell.setTheme('dark')")
        await poll(() => run('notice', 'document.documentElement.dataset.theme'), value => value === 'dark', 'existing notification follows manual theme change')
        await run('shell', "window.enestShell.setSettings({general:{animationLevel:'low'}})")
        await poll(() => run('notice', 'document.documentElement.dataset.anim'), value => value === 'low', 'existing notification follows animation setting')
        await run('shell', "window.enestShell.setTheme('light')")
        await run('shell', "window.enestShell.setSettings({general:{animationLevel:'medium'}})")
        evidence.appearance = { liveThemeRefresh: true, liveAnimationRefresh: true }
      }
      await run('notice', "document.querySelector('.notify-close').click()")
      await poll(inventory, list => !list.some(win => win.views.some(view => view.url.endsWith('/notification-overlay.html'))), 'notice fully disposed')
    }
    await run('plugin', `window.enest.ui.toast({message:'旧 API 仍可用',type:'info',duration:1500})`)
    await poll(() => run('notice', 'document.querySelector(".notify-card")?.textContent'), text => text?.includes('旧 API'), 'legacy toast')
    const timerHostId = (await inventory()).find(win => win.views.some(view => view.plugin)).id
    await app.evaluate(({ BaseWindow }, id) => BaseWindow.fromId(id)?.hide(), timerHostId)
    await pause(1900)
    assert.ok((await inventory()).some(win => win.views.some(view => view.url.endsWith('/notification-overlay.html'))), 'hidden parent pauses notification expiration')
    await app.evaluate(({ BaseWindow }, id) => BaseWindow.fromId(id)?.show(), timerHostId)
    assert.match(await run('notice', 'document.querySelector(".notify-card")?.textContent'), /旧 API/)
    await poll(inventory, list => !list.some(win => win.views.some(view => view.url.endsWith('/notification-overlay.html'))), 'automatic dismissal', 5000)
    // The owning chrome must request the move, and it is destroyed before its IPC reply.
    await run('detached', `(()=>{setTimeout(()=>{void window.enestWindows.command({action:'dock',pluginId:${JSON.stringify(pluginId)},target:'shell'})},0);return true})()`)
    await poll(inventory, list => list.some(win => win.title === 'eNest' && win.views.some(view => view.plugin)), 'plugin returned to surviving shell window')
    await run('plugin', `window.enest.ui.toast({title:'随插件回收',body:'持久通知应在实例关闭后消失',duration:0})`)
    await poll(() => run('notice', 'document.querySelector(".notify-card")?.textContent'), text => text?.includes('随插件回收'), 'persistent owner notification')
    await run('shell', `window.enestShell.closePlugin(${JSON.stringify(pluginId)})`)
    await poll(inventory, list => !list.some(win => win.views.some(view => view.url.endsWith('/notification-overlay.html'))), 'plugin close disposes notification')
    evidence.lifecycle = { hiddenParentPausesExpiration: true, resumesRemainingDuration: true, pluginCloseDisposesNotification: true }
    await writeFile('/tmp/enest-native-notification-evidence.json', JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify(evidence))
  } catch (error) { throw new Error(`${error.stack || error}\n${logs}`) }
  finally { if (app) await app.close().catch(() => app.process().kill('SIGKILL')); await rm(directory, { recursive: true, force: true }) }
})
