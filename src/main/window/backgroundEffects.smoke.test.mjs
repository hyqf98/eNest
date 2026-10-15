/** Build first. ENEST_BACKGROUND_SMOKE=1 node --test src/main/window/backgroundEffects.smoke.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pluginId = 'com.enest.smoke.backgrounds'
const packId = `${pluginId}.effects`
const selection = id => `plugin:${pluginId}:${packId}:${id}`
async function poll(read, accept, label, timeout = 12000) {
  let value, error
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    try { value = await read(); if (accept(value)) return value } catch (caught) { error = caught }
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw Error(`${label}: ${error?.message ?? JSON.stringify(value)}`)
}

test('native backgrounds persist, synchronize all shell surfaces and follow plugin lifecycle', {
  skip: process.env.ENEST_BACKGROUND_SMOKE !== '1', timeout: 120000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-background-smoke-'))
  const dataRoot = join(directory, 'data')
  const folder = join(dataRoot, 'plugins', pluginId, '1.0.0')
  let app
  const evidence = { builtins: [], pluginPreset: false, pluginVideo: false, disabledFallback: false, reload: false, detached: false, quick: false, atmosphereSurfaces: [], atmosphereWithoutEffect: false }
  try {
    await mkdir(join(folder, 'assets/market/screenshots'), { recursive: true })
    await writeFile(join(folder, 'assets/market/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#175"/></svg>')
    await writeFile(join(folder, 'assets/market/README.md'), '# Background smoke fixture')
    await writeFile(join(folder, 'assets/market/screenshots/preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-t', '1', '-an', '-c:v', 'libvpx', join(folder, 'assets/loop.webm')])
    const pack = { id: packId, name: 'Background QA', mode: 'dark', tokens: {}, backgroundEffects: [
      { id: 'jade', name: 'Jade QA', renderer: 'preset', preset: 'aurora', colors: ['#071B20', '#3AD7AE', '#F5DCA1'], logoStyle: 'orbit' },
      { id: 'film', name: 'Video QA', renderer: 'video', video: `enest://plugin/${pluginId}/assets/loop.webm`, poster: `enest://plugin/${pluginId}/assets/market/screenshots/preview.png`, logoStyle: 'fold' },
    ] }
    await writeFile(join(folder, 'plugin.json'), JSON.stringify({ id: pluginId, name: 'Background QA', description: 'Isolated background integration fixture', version: '1.0.0', main: 'index.html', icon: 'assets/market/icon.svg', market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] }, permissions: [], features: [{ code: 'main', cmds: ['background-qa'] }], ui: { chrome: 'none', background: 'transparent', themeAware: true }, contributes: { themePacks: [pack] } }))
    await writeFile(join(folder, 'index.html'), '<!doctype html><html><body><h1>Transparent plugin fixture</h1></body></html>')
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'dark', overrides: {}, backgroundEffect: 'tunnel' }, general: { animationLevel: 'high', quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: {} }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: join(directory, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    const run = (surface, code) => app.evaluate(({ webContents }, { surface, code }) => {
      const wc = webContents.getAllWebContents().find(wc => {
        const url = wc.getURL()
        if (surface === 'quick') return url.includes('surface=quick')
        if (surface === 'detached') return url.includes('/detached-plugin.html')
        if (surface === 'plugin') return url.includes('pid=com.enest.smoke.backgrounds') || url.startsWith('enest://com.enest.smoke.backgrounds/')
        return url.includes('/renderer/index.html') && !url.includes('surface=')
      })
      if (!wc) throw Error(`Missing ${surface}`)
      return wc.executeJavaScript(code)
    }, { surface, code })
    const visibleEffect = surface => run(surface, 'document.querySelector(".background-effect")?.dataset.backgroundEffect ?? document.documentElement.dataset.backgroundEffect')
    await poll(() => run('shell', '!!document.querySelector(".app-boot.ready .app")'), Boolean, 'Startup complete')
    for (const id of ['fold', 'aurora', 'orbit', 'ripple', 'tunnel']) {
      await run('shell', `window.enestShell.setTheme('dark',{}, {backgroundEffect:${JSON.stringify(id)}})`)
      await poll(() => visibleEffect('shell'), value => value === id, `Shell ${id}`)
      await run('shell', 'window.dispatchEvent(new Event("enest:preview-splash"))')
      await poll(() => run('shell', '({effect:document.querySelector(".splash[data-ready=true] .background-effect")?.dataset.backgroundEffect,parts:document.querySelectorAll(".splash [data-assembly-part]").length,title:document.querySelector(".splash-word")?.textContent})'), value => value.effect === id && value.parts === 9 && value.title === 'eNest', `Splash ${id}`)
      await run('shell', 'document.querySelector(".splash-close").click()')
      evidence.builtins.push(id)
    }
    await run('shell', 'window.enestShell.quickToggle()')
    await poll(() => visibleEffect('quick'), value => value === 'tunnel', 'Quick effect')
    evidence.quick = true
    await run('shell', `window.enestShell.setTheme('dark',{}, {backgroundEffect:${JSON.stringify(selection('jade'))}})`)
    await poll(() => visibleEffect('shell'), value => value === selection('jade'), 'Plugin preset')
    await poll(() => visibleEffect('quick'), value => value === selection('jade'), 'Quick live update')
    evidence.pluginPreset = true
    await run('shell', `window.enestShell.openPlugin(${JSON.stringify(pluginId)})`)
    await poll(() => run('plugin', 'typeof window.enest?.theme?.register'), value => value === 'function', 'Plugin ready')
    // Dynamic registration uses the existing plugin API and source binding.
    await run('plugin', `window.enest.theme.register(${JSON.stringify({ ...pack, source: 'forged.source' })})`)
    const packs = await run('shell', 'window.enestShell.getTheme().then(t=>t.packs)')
    assert.equal(packs.find(item => item.id === packId).source, pluginId)
    assert.equal((await run('shell', `window.enestWindows.command({action:'detach',pluginId:${JSON.stringify(pluginId)}})`)).ok, true)
    await poll(() => visibleEffect('detached'), value => value === selection('jade'), 'Detached background')
    evidence.detached = true
    const atmosphere = { type: 'color', value: 'linear-gradient(120deg, #ddaa77, #335577)', opacity: 0.65, fit: 'cover' }
    await run('shell', `window.enestShell.setTheme('dark',{}, {background:${JSON.stringify(atmosphere)},backgroundSource:'user'})`)
    for (const surface of ['shell', 'quick', 'detached']) {
      await poll(() => run(surface, '(()=>{const layer=document.querySelector(".background-atmosphere");return layer&&{image:layer.style.backgroundImage,opacity:layer.style.opacity}})()'),
        value => value?.image.includes('linear-gradient') && value.opacity === '0.65', `${surface} atmosphere update`)
      evidence.atmosphereSurfaces.push(surface)
    }
    await run('shell', 'window.dispatchEvent(new Event("enest:preview-splash"))')
    await poll(() => run('shell', 'document.querySelector(".splash .background-atmosphere")?.style.opacity'), value => value === '0.65', 'Startup atmosphere update')
    evidence.atmosphereSurfaces.push('startup')
    await run('shell', 'document.querySelector(".splash-close").click()')
    await run('shell', `window.enestShell.setTheme('dark',{}, {background:${JSON.stringify({ ...atmosphere, value: '#447755', opacity: 0.25 })},backgroundSource:'user'})`)
    for (const surface of ['shell', 'quick', 'detached']) {
      await poll(() => run(surface, '(()=>{const layer=document.querySelector(".background-atmosphere");return layer&&{color:layer.style.backgroundColor,image:layer.style.backgroundImage,opacity:layer.style.opacity}})()'),
        value => value?.color === 'rgb(68, 119, 85)' && value.image === '' && value.opacity === '0.25', `${surface} atmosphere replacement`)
    }
    await run('shell', "window.enestShell.setTheme('dark',{}, {backgroundEffect:'none'})")
    for (const surface of ['quick', 'detached']) {
      await poll(() => run(surface, '(()=>{const layer=document.querySelector(".background-atmosphere");return layer&&{color:layer.style.backgroundColor,blend:layer.classList.contains("background-atmosphere--blend")}})()'),
        value => value?.color === 'rgb(68, 119, 85)' && !value.blend, `${surface} atmosphere without effect`)
    }
    await run('shell', 'window.dispatchEvent(new Event("enest:preview-splash"))')
    await poll(() => run('shell', '(()=>{const layer=document.querySelector(".splash .background-atmosphere");return layer&&{color:layer.style.backgroundColor,opacity:layer.style.opacity,blended:layer.classList.contains("background-atmosphere--blend"),effect:!!document.querySelector(".splash .background-effect")}})()'),
      value => value?.color === 'rgb(68, 119, 85)' && value.opacity === '0.25' && !value.blended && !value.effect, 'Startup atmosphere without effect')
    await run('shell', 'document.querySelector(".splash-close").click()')
    evidence.atmosphereWithoutEffect = true
    await run('shell', `window.enestShell.setTheme('dark',{}, {backgroundEffect:${JSON.stringify(selection('film'))}})`)
    await poll(() => run('shell', 'document.querySelector(".background-effect video")?.readyState'), value => value >= 2, 'Plugin video protocol playback')
    await poll(() => visibleEffect('detached'), value => value === selection('film'), 'Detached live video update')
    evidence.pluginVideo = true
    await run('shell', `window.enestShell.setPluginEnabled(${JSON.stringify(pluginId)},false)`)
    await poll(() => visibleEffect('shell'), value => value === 'tunnel', 'Disabled plugin fallback')
    assert.equal((await run('shell', 'window.enestShell.getTheme()')).backgroundEffect, selection('film'))
    evidence.disabledFallback = true
    await run('shell', `window.enestShell.setTheme('dark',{}, {backgroundEffect:'ripple'})`)
    await run('shell', 'setTimeout(()=>location.reload(),0);true')
    await poll(() => run('shell', 'document.querySelector(".splash[data-ready=true] .background-effect")?.dataset.backgroundEffect'), value => value === 'ripple', 'Reload startup selection')
    await poll(() => run('shell', 'document.querySelector(".app-boot.ready .app-bg")?.dataset.backgroundEffect'), value => value === 'ripple', 'Reload workspace selection')
    evidence.reload = true
    await run('shell', "window.enestShell.setTheme('dark',{}, {backgroundEffect:'none',background:undefined})")
    await poll(() => run('shell', 'document.querySelectorAll(".background-effect").length'), value => value === 0, 'Off removes effect')
    console.log(JSON.stringify(evidence))
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
