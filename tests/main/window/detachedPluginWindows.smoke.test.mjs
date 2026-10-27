/** Build first. ENEST_DETACHED_SMOKE=1 node --test tests/main/window/detachedPluginWindows.smoke.test.mjs */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const ids = ['com.example.smoke.detached-a', 'com.example.smoke.detached-b']
const transientId = 'com.example.smoke.detached-transient'
const matrixIds = [...ids, ...Array.from({length:18}, (_, index) => `com.example.smoke.detached-matrix-${index + 3}`)]
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(read, accept, label, timeout = 15000) {
  let value, error
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    try { value = await read(); if (accept(value)) return value } catch (caught) { error = caught }
    await pause(30)
  }
  throw new Error(`${label}: ${error?.message ?? JSON.stringify(value)}`)
}

function harness(app) {
  const evaluate = (target, code, id = ids[0]) => app.evaluate(({ BaseWindow, webContents }, { target, code, id }) => {
    const plugin = wc => { try { const url = new URL(wc.getURL()); return url.searchParams.get('pid') === id || url.protocol === 'enest:' && url.hostname === 'plugin' && url.pathname.split('/')[1] === id } catch { return false } }
    const children = view => [...(view.webContents ? [view.webContents] : []), ...view.children.flatMap(children)]
    let contents
    if (target === 'detached') {
      const win = BaseWindow.getAllWindows().find(win => children(win.contentView).some(wc => { try { const url = new URL(wc.getURL()); return url.pathname.endsWith('/detached-plugin.html') && url.searchParams.get('pluginId') === id } catch { return false } }))
      contents = win && children(win.contentView).find(wc => wc.getURL().includes('/detached-plugin.html'))
    } else contents = webContents.getAllWebContents().find(wc => {
      if (wc.isDestroyed()) return false
      if (target === 'plugin') return plugin(wc)
      try { const url = new URL(wc.getURL()); return target === 'quick' ? url.searchParams.get('surface') === 'quick' : url.pathname.endsWith('/renderer/index.html') && !url.searchParams.get('surface') } catch { return false }
    })
    if (!contents) throw Error(`Missing ${target} surface for ${id}`)
    return contents.executeJavaScript(code)
  }, { target, code, id })
  const inventory = () => app.evaluate(({ BaseWindow, webContents }, ids) => {
    const children = view => [...(view.webContents ? [{wc:view.webContents,bounds:view.getBounds(),visible:view.getVisible()}] : []), ...view.children.flatMap(children)]
    return { contents: webContents.getAllWebContents().map(wc => ({ id:wc.id, url:wc.getURL() })),
      windows: BaseWindow.getAllWindows().map(win => ({ id:win.id, title:win.getTitle(), visible:win.isVisible(), minimized:win.isMinimized(), maximized:win.isMaximized(), alwaysOnTop:win.isAlwaysOnTop(), bounds:win.getNormalBounds(),
        views: children(win.contentView).map(({wc,bounds,visible}) => {
          let pluginId = null, chromePluginId = null
          try { const url = new URL(wc.getURL()); pluginId = ids.find(id => url.searchParams.get('pid') === id || url.protocol === 'enest:' && url.hostname === 'plugin' && url.pathname.split('/')[1] === id) ?? null; if (url.pathname.endsWith('/detached-plugin.html')) chromePluginId = url.searchParams.get('pluginId') } catch {}
          return {wcId:wc.id,url:wc.getURL(),pluginId,chromePluginId,bounds,visible}
        }) })) }
  }, matrixIds)
  const captureView = async (wcId, destination) => {
    const base64 = await app.evaluate(async ({webContents}, wcId) => {
      const wc = webContents.fromId(wcId)
      if (!wc || wc.isDestroyed()) throw Error('Capture target is closed')
      return (await wc.capturePage()).toPNG().toString('base64')
    }, wcId)
    await writeFile(destination, Buffer.from(base64, 'base64'))
  }
  return {evaluate,inventory,captureView}
}

async function installFixtures(dataRoot) {
  for (const id of [...matrixIds, transientId]) {
    const folder = join(dataRoot,'plugins',id.split('.').pop(),'1.0.0')
    await mkdir(join(folder,'assets/market/screenshots'),{recursive:true})
    await writeFile(join(folder,'assets/market/icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#175"/></svg>')
    await writeFile(join(folder,'assets/market/README.md'),'# Isolated detached window fixture')
    await writeFile(join(folder,'assets/market/screenshots/preview.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'))
    await writeFile(join(folder,'plugin.json'),JSON.stringify({id,name:id.endsWith('-a')?'Detached A':'Detached B',description:'Isolated native window migration smoke',version:'1.0.0',main:'index.html',icon:'assets/market/icon.svg',market:{readme:'assets/market/README.md',screenshots:['assets/market/screenshots/preview.png']},permissions:[],features:[{code:'main',cmds:[id]}],window:{width:720,height:480},ui:{chrome:'none',background:'opaque',themeAware:false}}))
    await writeFile(join(folder,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><style>body{background:#e8f3ec;color:#153c2b;font:16px system-ui}input{font:inherit}</style></head><body><h1>Native migration fixture</h1><input id="preserved" value="preserved state"><script src="assets/fixture.js"></script></body></html>')
    await writeFile(join(folder,'assets/fixture.js'),"window.identity=crypto.randomUUID();window.modeEvents=[];window.enest.onModeChange(mode=>window.modeEvents.push(mode));window.ready=true;")
  }
  await writeFile(join(dataRoot,'settings.json'),JSON.stringify({theme:{mode:'light',overrides:{}},general:{animationLevel:'high',quickLauncher:{enabled:false},closeBehavior:'quit',tabStyle:'classic',sessionTabs:[]},plugins:{}}))
}

test('native detached windows preserve twenty migrations, isolate compact inputs and dispose every chrome',{
  skip:process.env.ENEST_DETACHED_SMOKE!=='1',timeout:180000
},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'enest-detached-smoke-'))
  const artifacts=process.env.ENEST_DETACHED_SMOKE_ARTIFACTS?resolve(process.env.ENEST_DETACHED_SMOKE_ARTIFACTS):await mkdtemp(join(tmpdir(),'enest-detached-artifacts-'))
  const dataRoot=join(directory,'data'),userData=join(directory,'user-data')
  const evidence={platform:process.platform,artifacts,roundtrips:[],screenshots:[],inputIsolation:false,nativePointerCrossScreen:false}
  let app,failure,stderr='',stdout='',api
  try {
    await mkdir(artifacts,{recursive:true});await installFixtures(dataRoot)
    const env={...process.env,ENEST_TEST_DATA_ROOT:dataRoot,ENEST_TEST_USER_DATA:userData}
    delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;delete env.ENEST_REMOTE_DEBUG
    app=await electron.launch({executablePath:require('electron'),args:[root],env,timeout:25000})
    app.process().stderr.on('data',data=>{stderr=(stderr+data).slice(-64000)})
    app.process().stdout.on('data',data=>{stdout=(stdout+data).slice(-64000)})
    assert.equal(await app.evaluate(({app})=>app.getPath('userData')),userData)
    api=harness(app);const {evaluate,inventory}=api
    await poll(()=>evaluate('shell','typeof window.enestWindows?.command'),value=>value==='function','Window bridge')
    const installed=await evaluate('shell','window.enestShell.getPlugins()')
    assert.ok(ids.every(id=>installed.some(plugin=>plugin.id===id&&plugin.installed)))
    await evaluate('shell',`window.enestShell.openPlugin(${JSON.stringify(ids[0])})`)
    await poll(()=>evaluate('plugin','window.ready'),Boolean,'First plugin ready')
    const identity=await evaluate('plugin','window.identity')
    const initial=await evaluate('shell','window.enestShell.getPluginDiagnostics()')
    const runtime=initial.host.entries.find(entry=>entry.pluginId===ids[0]);assert.ok(runtime)
    const command=async(target,request,id=ids[0])=>{
      if (target === 'detached' && (request.action === 'dock' || request.action === 'close')) {
        // Moving destroys the requesting chrome. Do not wait for its IPC reply/context.
        await evaluate(target,`(()=>{window.__commandError=null;setTimeout(()=>{void window.enestWindows.command(${JSON.stringify(request)}).then(result=>{if(!result.ok)window.__commandError=result.error||'Command failed'}).catch(error=>{window.__commandError=String(error)})},0);return true})()`,id)
        await poll(inventory,value=>{
          const owner=value.windows.find(window=>window.views.some(view=>view.pluginId===id))
          if(request.action==='close')return !owner
          if(!owner||owner.views.some(view=>view.url.includes('/detached-plugin.html')))return false
          return owner.views.some(view=>request.target==='quick'?view.url.includes('surface=quick'):view.url.includes('/renderer/index.html')&&!view.url.includes('surface=quick'))
        },`${request.action} ${id}`)
        return
      }
      assert.equal((await evaluate(target,`window.enestWindows.command(${JSON.stringify(request)})`,id)).ok,true)
    }
    for(let index=0;index<20;index++){
      const started=performance.now()
      await command('shell',{action:'detach',pluginId:ids[0]})
      const state=await poll(()=>evaluate('detached','window.enestWindows.getState()'),state=>state?.status==='ready',`Detached ${index}`)
      assert.equal(state.mode,'shell');assert.equal(state.generation,runtime.generation)
      assert.equal(await evaluate('plugin','window.identity'),identity)
      assert.equal(await evaluate('plugin','document.querySelector("#preserved").value'),'preserved state')
      const detachedMs=performance.now()-started
      if (index === 0) {
        const window=(await inventory()).windows.find(window=>window.views.some(view=>view.pluginId===ids[0]))
        for(const [part,view] of [['chrome',window.views.find(view=>view.url.includes('/detached-plugin.html'))],['plugin',window.views.find(view=>view.pluginId===ids[0])]]) {
          const path=join(artifacts,`shell-detached-${part}.png`)
          await api.captureView(view.wcId,path)
          evidence.screenshots.push({pluginId:ids[0],layout:'shell',part,path,note:'Separate native WebContents capture; not a composited OS window screenshot'})
        }
      }
      const dockStarted=performance.now()
      await command('detached',{action:'dock',pluginId:ids[0],target:'shell',index:0})
      const current=await evaluate('shell','window.enestShell.getPluginDiagnostics()')
      const entry=current.host.entries.find(entry=>entry.pluginId===ids[0])
      assert.equal(entry.wcId,runtime.wcId);assert.equal(entry.generation,runtime.generation)
      assert.equal((await inventory()).contents.filter(wc=>wc.url.includes('/detached-plugin.html')).length,0)
      evidence.roundtrips.push({index,detachIncludingChromeLoadMs:detachedMs,dockMs:performance.now()-dockStarted,wcId:entry.wcId,generation:entry.generation})
    }
    assert.deepEqual(await evaluate('plugin','window.modeEvents'),[],'dragging out/back to the same layout does not emit layout changes')
    await command('shell',{action:'dock',pluginId:ids[0],target:'quick'})
    await poll(()=>evaluate('quick','typeof window.enestWindows?.command'),value=>value==='function','Quick chrome')
    await poll(inventory,value=>value.windows.find(win=>win.title==='eNest Quick')?.visible,'Docking shows the Quick receiver')
    // Native focus is shared with other desktop work; isolate only blur-hide in this test profile.
    await app.evaluate(({BaseWindow})=>BaseWindow.getAllWindows().find(win=>win.getTitle()==='eNest Quick')?.removeAllListeners('blur'))
    evidence.blurHideIsolated=true
    await evaluate('plugin',`window.enest.quickInput.configure({placeholder:'A input',value:'alpha'})`)
    await command('quick',{action:'detach',pluginId:ids[0]})
    const first=await poll(()=>evaluate('detached','window.enestWindows.getState()'),state=>state?.input?.value==='alpha','First detached input')
    assert.equal(first.mode,'quick')
    await evaluate('shell',`window.enestShell.quickOpen(${JSON.stringify({kind:'plugin',pluginId:ids[1],container:'quick'})})`)
    await poll(()=>evaluate('plugin','window.ready',ids[1]),Boolean,'Second plugin ready')
    await evaluate('plugin',`window.enest.quickInput.configure({placeholder:'B input',value:'beta'})`,ids[1])
    await command('quick',{action:'detach',pluginId:ids[1]},ids[1])
    const second=await poll(()=>evaluate('detached','window.enestWindows.getState()',ids[1]),state=>state?.input?.value==='beta','Second detached input')
    await command('detached',{action:'input',message:{pluginId:ids[0],generation:first.generation,type:'change',value:'alpha changed'}})
    assert.equal((await evaluate('detached','window.enestWindows.getState()',ids[1])).input.value,'beta')
    await command('detached',{action:'input',message:{pluginId:ids[0],generation:first.generation,type:'escape'}})
    assert.equal((await evaluate('detached','window.enestWindows.getState()')).input.value,'')
    const foreign=await evaluate('detached',`window.enestWindows.command(${JSON.stringify({action:'input',message:{pluginId:ids[1],generation:second.generation,type:'change',value:'invalid'}})})`)
    assert.equal(foreign.ok,false);assert.equal((await evaluate('detached','window.enestWindows.getState()',ids[1])).input.value,'beta')
    evidence.inputIsolation=true
    const beforeOpen=await inventory(),firstWindow=beforeOpen.windows.find(win=>win.views.some(view=>view.pluginId===ids[0]))
    await evaluate('shell',`window.enestShell.openPlugin(${JSON.stringify(ids[0])})`)
    assert.equal((await inventory()).windows.find(win=>win.views.some(view=>view.pluginId===ids[0])).id,firstWindow.id)
    await app.evaluate(({BaseWindow})=>{
      const shell=BaseWindow.getAllWindows().find(win=>win.contentView.children.some(view=>view.webContents?.getURL().includes('/renderer/index.html')&&!view.webContents?.getURL().includes('surface=quick')))
      shell?.hide()
    })
    const hiddenMain=await inventory()
    for(const id of ids)assert.equal(hiddenMain.windows.find(win=>win.views.some(view=>view.pluginId===id)).visible,true)
    await command('detached',{action:'minimize'})
    await poll(inventory,value=>value.windows.find(win=>win.id===firstWindow.id)?.minimized,'Independent minimize')
    await app.evaluate(({BaseWindow},id)=>{const win=BaseWindow.fromId(id);win.restore();win.show();win.focus()},firstWindow.id)
    await poll(()=>evaluate('shell','window.enestShell.getPluginDiagnostics()'),value=>value.host.entries.find(entry=>entry.pluginId===ids[0])?.state==='active','Independent restore')
    evidence.beforeClose=await inventory()
    for (const id of ids) {
      const window = evidence.beforeClose.windows.find(window=>window.views.some(view=>view.pluginId===id))
      for (const [part,view] of [['chrome',window.views.find(view=>view.url.includes('/detached-plugin.html'))],['plugin',window.views.find(view=>view.pluginId===id)]]) {
        const path=join(artifacts,`${id.split('.').at(-1)}-${part}.png`)
        await api.captureView(view.wcId,path)
        evidence.screenshots.push({pluginId:id,part,path,note:'Separate native WebContents capture; not a composited OS window screenshot'})
      }
    }
    for(const id of ids){
      await command('detached',{action:'close'},id)
      await poll(inventory,value=>!value.windows.some(win=>win.views.some(view=>view.pluginId===id)),`Close ${id}`)
    }
    const final=await poll(()=>evaluate('shell','window.enestShell.getPluginDiagnostics()'),value=>value.host.entries.every(entry=>!ids.includes(entry.pluginId))&&value.host.closing===0,'Plugin cleanup complete')
    evidence.afterClose=await inventory();evidence.finalDiagnostics=final
    assert.equal(evidence.afterClose.contents.filter(wc=>wc.url.includes('/detached-plugin.html')||ids.some(id=>wc.url.includes(id))).length,0)
    evidence.matrix=[]
    for (let index=0;index<matrixIds.length;index++) {
      const id=matrixIds[index]
      await evaluate('shell',`window.enestShell.openPlugin(${JSON.stringify(id)})`)
      await poll(()=>evaluate('plugin','window.ready',id),Boolean,`Matrix plugin ${index + 1}`)
      if (![1,6,10,20].includes(index+1)) continue
      const before=await evaluate('shell','window.enestShell.getPluginDiagnostics()')
      const runtime=before.host.entries.find(entry=>entry.pluginId===id)
      const detachStart=performance.now()
      await command('shell',{action:'detach',pluginId:id},id)
      await poll(()=>evaluate('detached','window.enestWindows.getState()',id),state=>state?.status==='ready','Matrix independent ready')
      const coldDetachMs=performance.now()-detachStart,dockStart=performance.now()
      await command('detached',{action:'dock',pluginId:id,target:'shell'},id)
      const dockMs=performance.now()-dockStart
      const after=await evaluate('shell','window.enestShell.getPluginDiagnostics()')
      assert.equal(after.host.entries.find(entry=>entry.pluginId===id)?.wcId,runtime.wcId)
      const metrics=await app.evaluate(({app})=>app.getAppMetrics().map(process=>({pid:process.pid,type:process.type,cpu:process.cpu,memory:process.memory})))
      evidence.matrix.push({logicalPlugins:index+1,livePlugins:after.host.entries.length,coldDetachMs,dockMs,metrics,
        note:'Command-driven native migration and process metrics; physical drag frame latency is not measured'})
    }
    for (const id of matrixIds) await evaluate('shell',`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    await poll(()=>evaluate('shell','window.enestShell.getPluginDiagnostics()'),value=>value.host.entries.length===0&&value.host.closing===0,'Matrix cleanup complete')
    evidence.matrixAfterClose=await inventory()
    assert.equal(evidence.matrixAfterClose.contents.filter(wc=>wc.url.includes('/detached-plugin.html')||matrixIds.some(id=>wc.url.includes(id))).length,0)
    // Separate restart stage: ordinary Quick-only instances must not join the recovery list.
    await evaluate('shell',`window.enestShell.openPlugin(${JSON.stringify(ids[0])})`)
    await poll(()=>evaluate('plugin','window.ready'),Boolean,'Restart shell fixture')
    await command('shell',{action:'detach',pluginId:ids[0]})
    await evaluate('shell',`window.enestShell.quickOpen(${JSON.stringify({kind:'plugin',pluginId:ids[1],container:'quick'})})`)
    await poll(()=>evaluate('plugin','window.ready',ids[1]),Boolean,'Restart compact fixture')
    await command('quick',{action:'detach',pluginId:ids[1]},ids[1])
    await evaluate('shell',`window.enestShell.quickOpen(${JSON.stringify({kind:'plugin',pluginId:transientId,container:'quick'})})`)
    await poll(()=>evaluate('plugin','window.ready',transientId),Boolean,'Transient Quick fixture')
    // Persist shell and compact windows, plus a third unloaded-close candidate and a main Tab.
    const shellId = matrixIds[2], closeLazyId = matrixIds[3]
    await command('detached',{action:'toggle-always-on-top'},ids[0])
    await app.evaluate(({BaseWindow}, id) => {
      const win=BaseWindow.getAllWindows().find(win=>win.contentView.children.some(view=>view.webContents?.getURL().includes('pluginId='+id)))
      win.setBounds({x:80,y:90,width:760,height:560})
    }, ids[0])
    await command('detached',{action:'minimize'},ids[1])
    await evaluate('shell',`window.enestShell.openPlugin(${JSON.stringify(closeLazyId)})`)
    await poll(()=>evaluate('plugin','window.ready',closeLazyId),Boolean,'Unloaded-close candidate ready')
    await command('shell',{action:'detach',pluginId:closeLazyId},closeLazyId)
    await command('detached',{action:'maximize'},closeLazyId)
    await evaluate('shell',`window.enestShell.openPlugin(${JSON.stringify(shellId)})`)
    await poll(()=>evaluate('plugin','window.ready',shellId),Boolean,'Saved active main Tab')
    await app.evaluate(({BaseWindow})=>{
      const win=BaseWindow.getAllWindows().find(win=>win.contentView.children.some(view=>view.webContents?.getURL().includes('/renderer/index.html')&&!view.webContents.getURL().includes('surface=quick')))
      win.show();win.setBounds({x:50,y:60,width:1000,height:700})
    })
    const savedIds=[...ids,shellId,closeLazyId]
    const beforeRestart=await poll(()=>evaluate('shell','window.enestShell.getSettings()'),settings=>savedIds.every(id=>settings.general.sessionTabs.some(tab=>tab.pluginId===id))&&settings.general.sessionTabs.find(tab=>tab.pluginId===ids[0])?.detached?.alwaysOnTop&&settings.general.sessionTabs.find(tab=>tab.pluginId===ids[1])?.detached?.minimized&&settings.general.sessionTabs.find(tab=>tab.pluginId===closeLazyId)?.detached?.maximized&&settings.general.mainWindowState?.bounds.width===1000,'Window history recorded')
    assert.deepEqual(beforeRestart.general.sessionTabs.map(tab=>tab.pluginId).sort(),savedIds.sort())
    evidence.recovery={before:beforeRestart.general,transientId}
    await app.close()
    app=await electron.launch({executablePath:require('electron'),args:[root],env,timeout:25000})
    app.process().stderr.on('data',data=>{stderr=(stderr+data).slice(-64000)})
    app.process().stdout.on('data',data=>{stdout=(stdout+data).slice(-64000)})
    api=harness(app)
    await poll(()=>api.evaluate('shell','typeof window.enestShell?.getPluginDiagnostics'),value=>value==='function','Restart shell loaded')
    await poll(()=>api.evaluate('shell','window.enestShell.getPluginDiagnostics()'),value=>value.host.restoringDetached===0&&value.host.lazyDetached===3,'Three lightweight independent windows restored')
    const recoveredNative=await poll(()=>api.inventory(),value=>value.windows.find(win=>win.views.some(view=>view.chromePluginId===closeLazyId))?.maximized&&value.windows.find(win=>win.views.some(view=>view.chromePluginId===ids[1]))?.minimized,'Native restore presentation settled')
    for(const id of [...ids,closeLazyId]) await poll(()=>api.evaluate('detached','window.enestWindows.getState()',id),state=>state?.status==='lazy','Restored independent stays lazy')
    const afterRestart=await api.evaluate('shell','window.enestShell.getPluginDiagnostics()')
    assert.equal(afterRestart.host.logicalTabs,1,'only the main Tab belongs to the shell')
    assert.equal(afterRestart.host.entries.length,0,'including the saved active Tab, startup creates no plugin runtime')
    const restoredSettings=await api.evaluate('shell','window.enestShell.getSettings()')
    assert.deepEqual(restoredSettings.general.sessionTabs.map(tab=>tab.pluginId).sort(),savedIds.sort())
    assert.equal(recoveredNative.contents.some(wc=>wc.url.includes(transientId)),false)
    for(const id of ids){
      const saved=beforeRestart.general.sessionTabs.find(tab=>tab.pluginId===id).detached
      const restored=recoveredNative.windows.find(win=>win.views.some(view=>view.chromePluginId===id))
      assert.ok(restored)
      assert.deepEqual(restored.bounds,saved.bounds)
      assert.equal(restored.alwaysOnTop,!!saved.alwaysOnTop)
      assert.equal(restored.minimized,!!saved.minimized)
      assert.equal((await api.evaluate('detached','window.enestWindows.getState()',id)).mode,saved.mode)
    }
    const restoredShell=recoveredNative.windows.find(win=>win.views.some(view=>view.url.includes('/renderer/index.html')&&!view.url.includes('surface=quick')))
    assert.deepEqual(restoredShell.bounds,beforeRestart.general.mainWindowState.bounds)
    assert.equal(recoveredNative.windows.find(win=>win.views.some(view=>view.chromePluginId===closeLazyId)).maximized,true)
    const controls=await api.evaluate('detached',`['dock-shell','dock-quick','pin-window'].map(id=>{const el=document.getElementById(id);return {id,text:el.textContent.trim(),title:el.title,svg:!!el.querySelector('svg'),pressed:el.getAttribute('aria-pressed')}})`)
    assert.ok(controls.every(control=>control.text===''&&control.title&&control.svg))
    assert.equal(controls[2].pressed,'true')
    const lazyChrome=recoveredNative.windows.find(win=>win.views.some(view=>view.chromePluginId===ids[0])).views.find(view=>view.chromePluginId===ids[0])
    const lazyImage=join(artifacts,'restored-lazy-chrome.png')
    await api.captureView(lazyChrome.wcId,lazyImage)
    evidence.screenshots.push({pluginId:ids[0],part:'restored-lazy',path:lazyImage})
    // Focusing, restoring and pinning a placeholder do not implicitly launch it.
    await app.evaluate(({BaseWindow},id)=>{const win=BaseWindow.fromId(id);win.restore();win.show();win.focus()},recoveredNative.windows.find(win=>win.views.some(view=>view.chromePluginId===ids[1])).id)
    await api.evaluate('detached',`window.enestWindows.command({action:'toggle-always-on-top'})`,ids[1])
    assert.equal((await api.evaluate('shell','window.enestShell.getPluginDiagnostics()')).host.entries.length,0)
    // Closing a lazy window removes its history without creating a plugin just to close it.
    await api.evaluate('detached',`(()=>{setTimeout(()=>{void window.enestWindows.command({action:'close'})},0);return true})()`,closeLazyId)
    await poll(()=>api.inventory(),value=>!value.windows.some(win=>win.views.some(view=>view.chromePluginId===closeLazyId)),'Lazy independent closed')
    assert.equal((await api.evaluate('shell','window.enestShell.getPluginDiagnostics()')).host.entries.length,0)
    await poll(()=>api.evaluate('shell','window.enestShell.getSettings()'),value=>!value.general.sessionTabs.some(tab=>tab.pluginId===closeLazyId),'Lazy close removed history')
    evidence.recovery.after=afterRestart.host;evidence.recovery.settings=restoredSettings.general;evidence.recovery.native=recoveredNative
    // Explicit activation initializes only the selected runtime and keeps the saved layout.
    assert.equal((await api.evaluate('detached',`window.enestWindows.command({action:'activate'})`)).ok,true)
    await poll(()=>api.evaluate('plugin','window.ready'),Boolean,'Explicit independent activation')
    assert.equal((await api.evaluate('shell','window.enestShell.getPluginDiagnostics()')).host.entries.length,1)
    assert.equal((await api.evaluate('detached','window.enestWindows.getState()',ids[1])).status,'lazy')
    await api.evaluate('shell',`window.enestShell.openPlugin(${JSON.stringify(ids[1])})`)
    await poll(()=>api.evaluate('plugin','window.ready',ids[1]),Boolean,'Normal entry opens restored independent')
    assert.equal(await api.evaluate('plugin','window.enest.getLaunchMode()',ids[1]),'quick')
    assert.equal((await api.inventory()).contents.filter(wc=>wc.url.includes('/detached-plugin.html')).length,2)
    await api.evaluate('shell',`window.enestShell.activatePlugin(${JSON.stringify('t-'+shellId)})`)
    await poll(()=>api.evaluate('plugin','window.ready',shellId),Boolean,'Main Tab explicit activation')
    await api.evaluate('detached',`(()=>{setTimeout(()=>{void window.enestWindows.command({action:'dock',pluginId:${JSON.stringify(ids[0])},target:'shell'})},0);return true})()`)
    await poll(()=>api.evaluate('shell','window.enestShell.getSettings()'),value=>!value.general.sessionTabs.find(tab=>tab.pluginId===ids[0])?.detached,'Dock clears independent history')
    for(const id of [...ids,shellId]) await api.evaluate('shell',`window.enestShell.closePlugin(${JSON.stringify(id)})`)
    await poll(()=>api.evaluate('shell','window.enestShell.getPluginDiagnostics()'),value=>value.host.entries.length===0&&value.host.closing===0,'Restored instance cleanup')
    evidence.recovery.passed=true
    assert.doesNotMatch(stderr+stdout,/Unable to load preload|uncaughtException|unhandledRejection/)
    evidence.passed=true
    console.log('Detached native evidence:',JSON.stringify({artifacts,roundtrips:evidence.roundtrips.length,inputIsolation:evidence.inputIsolation}))
  }catch(error){failure=error;evidence.passed=false;evidence.error=String(error.stack||error);if(api)evidence.failureInventory=await api.inventory().catch(()=>null)}
  finally{
    evidence.stderr=stderr;evidence.stdout=stdout
    await writeFile(join(artifacts,'detached-window-evidence.json'),JSON.stringify(evidence,null,2)+'\n')
    if(app){let timer;try{await Promise.race([app.close().catch(()=>app.process().kill('SIGKILL')),new Promise(resolve=>{timer=setTimeout(()=>{app.process().kill('SIGKILL');resolve()},5000)})])}finally{clearTimeout(timer)}}
    await rm(directory,{recursive:true,force:true})
  }
  if(failure)throw new Error(`${failure.stack||failure}\nArtifacts: ${artifacts}\n${stderr}`)
})
