/** Build first, then ENEST_INSTALL_SURFACE_SMOKE=1 node --test src/main/window/installSurface.native.test.mjs. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'
import AdmZip from 'adm-zip'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read, accepts, label, timeout = 15000) {
  let value, error
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    try { value = await read(); if (accepts(value)) return value } catch (caught) { error = caught }
    await pause(50)
  }
  throw Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}
function files(id) {
  return {
    'plugin.json': JSON.stringify({ id, name: id.endsWith('editor') ? '拖入验证编辑器' : 'ZIP 安装验证', version: '1.0.0', main: 'index.html',
      icon: 'assets/market/icon.svg', description: 'Isolated native package-drop fixture', category: '开发', permissions: [],
      market: { readme: 'assets/market/README.md', screenshots: ['assets/market/screenshots/preview.png'] } }),
    'index.html': '<!doctype html><html><meta charset="utf-8"><body style="background:#eff4f8;color:#1d2937;font:16px system-ui;padding:40px"><h1>插件编辑器</h1><textarea>保留编辑内容</textarea><p>普通文件仍由插件接收</p><script src="assets/editor.js"></script></body></html>',
    'assets/editor.js': 'window.drops=[];window.dragTypes=[];addEventListener("dragenter",e=>{window.dragTypes=[...e.dataTransfer.items].map(i=>i.type)});addEventListener("dragover",e=>{if(!window.noEditorDrop)e.preventDefault()});addEventListener("drop",e=>{e.preventDefault();window.drops.push(...[...e.dataTransfer.files].map(f=>f.name))});',
    'assets/market/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="#397eaa"/></svg>',
    'assets/market/README.md': '# Native ZIP fixture',
    'assets/market/screenshots/preview.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  }
}

test('trusted file drops install ZIP packages above native plugin views, preserve editor drops, and clean up', {
  skip: process.env.ENEST_INSTALL_SURFACE_SMOKE !== '1', timeout: 120000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-install-surface-'))
  const dataRoot = join(directory, 'data'), userData = join(directory, 'profile')
  const evidenceDir = process.env.ENEST_INSTALL_SURFACE_EVIDENCE || join(directory, 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  const editorId = 'com.example.smoke.drop-editor'
  let app, logs = '', failure
  const evidence = { platform: process.platform, screenshots: [], checks: {} }
  try {
    for (const [path, value] of Object.entries(files(editorId))) {
      const target = join(dataRoot, 'plugins', editorId.split('.').pop(), '1.0.0', path)
      await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value)
    }
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light' }, general: { quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [], animationLevel: 'medium' } }))
    const packages = []
    for (const [name, id] of [['valid.zip', 'com.example.smoke.zip-drop'], ['unknown.enestplugin', 'com.example.smoke.unknown-drop']]) {
      const zip = new AdmZip()
      for (const [path, value] of Object.entries(files(id))) zip.addFile(path, Buffer.from(value))
      // Enough real payload to observe the active progress panel before completion.
      if (name === 'valid.zip') zip.addFile('assets/payload.bin', randomBytes(16 * 1024 * 1024))
      const path = join(directory, name); zip.writeZip(path); packages.push({ id, path })
    }
    const invalid = join(directory, 'invalid.zip'), ordinary = join(directory, 'document.unknown')
    await writeFile(invalid, 'not a zip'); await writeFile(ordinary, 'ordinary editor data')
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: userData }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-70000) })
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
    const wcId = surface => app.evaluate(({ webContents }, { surface, editorId }) => webContents.getAllWebContents().find(wc => {
      const url = wc.getURL()
      if (surface === 'shell') return url.endsWith('/out/renderer/index.html')
      if (surface === 'install') return url.endsWith('/out/renderer/install-overlay.html')
      return url.startsWith(`enest://plugin/${editorId}/`)
    })?.id, { surface, editorId })
    const evaluate = async (surface, code) => app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code), { id: await wcId(surface), code })
    const call = (method, ...args) => evaluate('shell', `window.enestShell.${method}(...${JSON.stringify(args)})`)
    const drag = async (surface, type, path) => app.evaluate(async ({ webContents }, { id, type, path }) => {
      const wc = webContents.fromId(id)
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      await wc.debugger.sendCommand('Input.dispatchDragEvent', { type, x: 180, y: 160, data: { items: [], files: [path], dragOperationsMask: 1 } })
    }, { id: await wcId(surface), type, path })
    const resetDrags = () => app.evaluate(async ({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) if (wc.debugger.isAttached()) await wc.debugger.sendCommand('Input.cancelDragging').catch(()=>{})
    })
    const capture = async name => {
      // Native bounds can change before Chromium presents the new React frame.
      // Wait for painted content, rather than capturing the previous drag target.
      await evaluate('install', 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,40))))')
      const bytes = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id).capturePage()).toPNG().toString('base64'), await wcId('install'))
      await writeFile(join(evidenceDir, name), Buffer.from(bytes, 'base64')); evidence.screenshots.push(name)
    }
    await poll(() => evaluate('shell', 'typeof window.enestShell?.openPlugin'), type => type === 'function', 'shell bridge')
    await poll(() => evaluate('shell', '!!document.querySelector(".app-boot.ready")'), Boolean, 'shell boot')
    await evaluate('shell', 'window.installEvents=[];void window.enestShell.onEvent(e=>{if(e.type.startsWith("install-"))window.installEvents.push(e)})')
    await call('openPlugin', editorId)
    await poll(() => evaluate('plugin', 'typeof window.enest?.ui'), type => type === 'object', 'editor preload')
    await app.evaluate(({ app, BaseWindow }) => { app.focus({ steal: true }); const win = BaseWindow.getAllWindows().find(w=>w.getTitle()!=='eNest Quick'); win.show(); win.focus() })

    // A real Chromium drag produces trusted File objects with native paths.
    await drag('plugin', 'dragEnter', packages[0].path); await drag('plugin', 'dragOver', packages[0].path)
    await poll(() => wcId('install'), Boolean, 'native install surface')
    await drag('plugin', 'dragCancel', packages[0].path)
    await drag('install', 'dragEnter', packages[0].path); await drag('install', 'dragOver', packages[0].path)
    await poll(() => evaluate('install', 'document.querySelector(".install-drop-overlay")?.classList.contains("is-visible")'), Boolean, 'plus target visible')
    const stack = await app.evaluate(({ BaseWindow }, id) => BaseWindow.getAllWindows().find(w=>w.contentView.children.some(v=>v.webContents?.id===id))?.contentView.children.map(v=>v.webContents?.id), await wcId('install'))
    assert.equal(stack.at(-1), await wcId('install'), 'install target must be above the plugin view')
    await pause(350); await capture('native-zip-target.png')
    await drag('install', 'drop', packages[0].path)
    await poll(() => evaluate('install', '!!document.querySelector(".install-card.is-active [role=progressbar]")'), Boolean, 'actual installation progress bar', 3000)
    await capture('native-zip-progress.png')
    await poll(() => call('getPlugins'), plugins => plugins.some(p=>p.id===packages[0].id&&p.installed), 'ZIP installed from real drop')
    await poll(() => evaluate('install', 'document.querySelector(".install-card.is-done")?.textContent'), Boolean, 'completion panel')
    await pause(350); await capture('native-zip-complete.png')
    evidence.checks.zipNativeDrop = true; evidence.checks.abovePlugin = true
    const installation = await evaluate('shell', 'window.installEvents')
    assert.ok(installation.some(e=>e.type==='install-progress'&&e.progress>0&&e.step), 'real worker progress includes steps')
    assert.ok(installation.some(e=>e.type==='install-result'&&e.ok), 'completed result emitted')
    evidence.progress = installation.filter(e=>e.type==='install-progress').map(e=>({progress:e.progress,step:e.step}))
    await evaluate('install', 'void document.querySelector(".install-dismiss").click()')
    await resetDrags()

    // .enestplugin MIME recognition varies by OS; names are protected until drop.
    await evaluate('plugin', 'window.noEditorDrop=true;window.dragTypes=[];void 0')
    await drag('plugin', 'dragEnter', packages[1].path); await drag('plugin', 'dragOver', packages[1].path)
    evidence.unknownMimeTypes = await evaluate('plugin', 'window.dragTypes')
    if (evidence.unknownMimeTypes.some(type=>/zip|octet-stream/i.test(type))) {
      await drag('plugin', 'dragCancel', packages[1].path)
      await drag('install', 'dragEnter', packages[1].path); await drag('install', 'dragOver', packages[1].path)
      await drag('install', 'drop', packages[1].path)
    } else await drag('plugin', 'drop', packages[1].path)
    await poll(() => call('getPlugins'), plugins => plugins.some(p=>p.id===packages[1].id&&p.installed), '.enestplugin installs')
    assert.deepEqual(await evaluate('plugin', 'window.drops'), [], 'installer consumes package drops')
    evidence.checks.enestpluginNativeDrop = true
    await resetDrags()
    await evaluate('plugin', 'window.noEditorDrop=false;void 0')
    await drag('plugin', 'dragEnter', ordinary); await drag('plugin', 'dragOver', ordinary); await drag('plugin', 'drop', ordinary)
    assert.deepEqual(await evaluate('plugin', 'window.drops'), ['document.unknown'])
    assert.equal(await evaluate('plugin', 'document.querySelector("textarea").value'), '保留编辑内容')
    evidence.checks.ordinaryEditorDrop = true
    await resetDrags()

    await drag('shell', 'dragEnter', invalid); await drag('shell', 'dragOver', invalid)
    await poll(() => evaluate('install', 'document.querySelector(".install-drop-overlay")?.classList.contains("is-visible")'), Boolean, 'invalid ZIP target')
    await drag('install', 'dragEnter', invalid); await drag('install', 'dragOver', invalid); await drag('install', 'drop', invalid)
    await poll(() => evaluate('install', 'document.querySelector(".install-card.is-failed")?.textContent'), Boolean, 'archive error retained')
    await pause(350); await capture('native-zip-error.png'); evidence.checks.invalidArchive = true
    await evaluate('install', 'void document.querySelectorAll(".install-dismiss").forEach(b=>b.click())')
    await poll(() => wcId('install'), id=>!id, 'empty native view reclaimed', 12000)
    evidence.checks.idleCleanup = true
    evidence.status = 'pass'
  } catch (error) {
    failure = error; evidence.status = 'fail'; evidence.error = String(error.stack || error)
    if (app) evidence.documents = await app.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents().map(async wc=>({url:wc.getURL(),text:await wc.executeJavaScript('document.body?.innerText').catch(()=> '')})))).catch(()=>[])
  } finally {
    await writeFile(join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2)); await writeFile(join(evidenceDir, 'electron.log'), logs)
    if (app) await app.close().catch(()=> app.process().kill('SIGKILL'))
    await rm(directory, { recursive: true, force: true })
    console.log(`Native install evidence: ${evidenceDir}`)
  }
  if (failure) throw failure
})
