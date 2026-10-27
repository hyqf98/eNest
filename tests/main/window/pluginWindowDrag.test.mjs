import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const adapters = {
  fixture: `export const state = { cursor:{x:120,y:120}, workArea:{x:-1000,y:-500,width:3000,height:2000},
    windows:[], roles:new Map(), nextId:1, moves:[], closes:[], visibility:[], placement:{kind:'shell'},
    generation:1, revision:0, histories:[],activations:[],snapshotStatus:'ready',restoredFocus:false,captures:0, locks:0, orbLocks:0, interaction:false, main:null, shell:null, quick:null,
    loadFailure:false, viewFailure:false, nullAfterClose:false, deadIdThrows:false, appearanceSink:null, moveGate:null, theme:{backgroundEffect:'tunnel'}, themePacks:[] };`,
  electron: `import { EventEmitter } from 'node:events'; import { state } from 'fixture';
    export class View { children=[]; bounds={x:0,y:0,width:0,height:0};
      addChildView(view){this.children.push(view)} removeChildView(view){this.children=this.children.filter(v=>v!==view)}
      setBounds(bounds){this.bounds={...bounds}} getBounds(){return {...this.bounds}} setBackgroundColor(){} }
    class Contents extends EventEmitter { _id=state.nextId++;get id(){if(this.destroyed&&state.deadIdThrows)throw Error('Object has been destroyed');return this._id} destroyed=false; messages=[]; scripts=[];
      isDestroyed(){return this.destroyed} send(channel,payload){this.messages.push({channel,payload})}
      async loadURL(url){this.url=url;if(state.loadFailure)throw Error('load failure')}
      async executeJavaScript(script){this.scripts.push(script)}
      async capturePage(){state.captures++;return {isEmpty:()=>false,resize(){return this},toDataURL:()=> 'data:image/png;base64,AAA'}}
      close(){if(this.destroyed)return;this.destroyed=true;this.emit('destroyed')} focus(){} }
    export class WebContentsView extends View { _contents=new Contents(); get webContents(){return state.nullAfterClose&&this._contents.destroyed?undefined:this._contents} constructor(options){super();if(state.viewFailure)throw Error('view allocation failed');this.options=options} }
    export class BaseWindow extends EventEmitter { _id=state.nextId++;get id(){if(this.destroyed&&state.deadIdThrows)throw Error('Object has been destroyed');return this._id}contentView=new View();destroyed=false;visible=false;focused=false;minimized=false;maximized=false;
      constructor(options){super();this.options=options;this.bounds={x:options.x??0,y:options.y??0,width:options.width,height:options.height};this.normalBounds={...this.bounds};state.windows.push(this)}
      static getAllWindows(){return state.windows.filter(win=>!win.destroyed)}
      isDestroyed(){return this.destroyed} isVisible(){return this.visible} isMinimized(){return this.minimized}
      isFocused(){return this.focused} isAlwaysOnTop(){return !!this.options.alwaysOnTop} isMaximized(){return this.maximized} isFullScreen(){return false}
      getBounds(){return {...this.bounds}} getContentBounds(){return this.getBounds()} getNormalBounds(){return this.maximized||this.minimized?{...this.normalBounds}:this.getBounds()}
      setBounds(bounds){this.bounds={...bounds};if(!this.maximized&&!this.minimized)this.normalBounds={...bounds};this.emit('resize')} setPosition(x,y){this.bounds.x=x;this.bounds.y=y}
      setAlwaysOnTop(value){this.options.alwaysOnTop=value;this.emit('always-on-top-changed',{},value)} setMinimumSize(){} setIgnoreMouseEvents(value,options){this.ignore={value,options}} setTitle(title){this.title=title}
      show(){this.visible=true;this.emit('show')} showInactive(){this.visible=true;this.emit('show');if(state.restoredFocus)this.focus()}
      hide(){this.visible=false;this.emit('hide')} focus(){for(const win of state.windows)win.focused=false;this.focused=true;this.emit('focus')}
      close(){let cancelled=false;this.emit('close',{preventDefault(){cancelled=true}});if(!cancelled)this.destroy()}
      destroy(){if(this.destroyed)return;this.destroyed=true;this.visible=false;this.emit('closed')}
      unmaximize(){this.maximized=false;this.bounds={...this.normalBounds};this.emit('unmaximize')} maximize(){if(!this.maximized)this.normalBounds={...this.bounds};this.maximized=true;this.bounds={...state.workArea};this.emit('maximize')} minimize(){if(!this.maximized)this.normalBounds={...this.bounds};this.minimized=true;this.emit('minimize')} restore(){this.minimized=false;this.emit('restore')} }
    export const screen=new EventEmitter();screen.getCursorScreenPoint=()=>({...state.cursor});screen.getDisplayMatching=()=>({workArea:{...state.workArea}});
    export const nativeTheme=new EventEmitter();export const app={getAppPath:()=>'/fixture'};`,
  '@main/ipc/ipcSecurity': `import { state } from 'fixture'; export const registerTrustedSurface=(wc,role)=>state.roles.set(wc.id,role); export const getTrustedSurfaceRole=id=>state.roles.get(id)??null;`,
  '@main/settings/SettingsStore': `import { state } from 'fixture';export const settingsStore={getAll:()=>({general:{animationLevel:'medium',locale:'zh-CN'}}),getTheme:()=>state.theme};`,
  '@main/theme/themePacks': `import { state } from 'fixture';export const themePackRegistry={list:()=>state.themePacks};`,
  '@main/theme/resolveThemeCss': `export const resolveThemeTokens=()=>({mode:'dark',tokens:{'--bg':'#123'}});`,
  '@main/window/createShellWindow': `import { state } from 'fixture'; export const resolvePreload=name=>'/preload/'+name; export const resolveWindowIcon=()=>'/icon.png';
    export const getMainWindow=()=>state.main;export const getShellWebContents=()=>state.shell;export const setDetachedAppearanceSink=fn=>{state.appearanceSink=fn};`,
  '@main/window/createQuickWindow': `import { state } from 'fixture';export const getQuickWindow=()=>state.quick;export const getQuickWebContents=()=>state.quick?.webContents??null;
    export const acquireQuickInteraction=()=>{state.locks++;return()=>{state.locks--}};`,
  '@main/window/orbRailViews': `import { state } from 'fixture';export const getOrbDragSurface=()=>null;export const acquireOrbDragExpansion=()=>{state.orbLocks++;return()=>{state.orbLocks--}};`,
  '@main/plugin/PluginRegistry': `export const pluginRegistry={get:id=>({name:'Plugin '+id})};`,
  '@main/plugin/PluginRuntimeScope': `import {state} from 'fixture';export const getRuntimeScope=()=>({owner:{generation:state.generation}});`,
  '@main/plugin/PluginHost': `import {state} from 'fixture';export const pluginHost={
    getPlacement:()=>state.placement,getPlacementRevision:()=>state.revision,getQuickPlugin:()=>state.quickPlugin??null,
    hasShellTab:id=>id==='a'||id==='b',hasWindowInteraction:()=>state.interaction,getDetachedState:id=>({pluginId:id,title:'Plugin '+id,generation:state.generation}),
    getWebContents:()=>state.pluginContents,reorderPlugin:(id,index)=>state.moves.push(['sort',id,index]),
    dockPlugin:async(id,target,index,guard)=>{await state.moveGate;if(guard&&!guard())throw Error('move cancelled');state.moves.push(['dock',id,target,index]);state.placement={kind:target};state.revision++},
    detachPlugin:async(id,point,guard)=>{await state.moveGate;if(guard&&!guard())throw Error('move cancelled');state.moves.push(['detach',id,point]);state.placement={kind:'detached',windowId:1};state.revision++}
  };`
}
let fixtureId = 0
async function fixture(t) {
  const bundle = await build({ stdin: { contents: `export * from '@main/window/detachedPluginWindows';export * from '@main/window/pluginWindowDrag';export {state} from 'fixture';export {BaseWindow,WebContentsView,screen,nativeTheme} from 'electron';export const id=${++fixtureId};`, resolveDir: process.cwd() },
    tsconfig:'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fixture',setup(builder){
      builder.onResolve({filter:/.*/},({path})=>Object.hasOwn(adapters,path)?{path,namespace:'mock'}:undefined)
      // Observe private drag state only in the in-memory verification bundle.
      builder.onLoad({filter:/[/\\]pluginWindowDrag\.ts$/,namespace:'file'},({path})=>({contents:readFileSync(path,'utf8')+`
        export function getPluginDragDiagnostics() {
          return { active: !!session, armed: !!armed, registrations: registrations.size, sourceId: session?.senderId ?? null }
        }`,loader:'ts'}))
      builder.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:adapters[path]}))
    }}] })
  const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  const main=new api.BaseWindow({x:100,y:100,width:800,height:600}), view=new api.WebContentsView()
  main.contentView.addChildView(view);main.show();main.focus()
  api.state.main=main;api.state.shell=view.webContents;api.state.roles.set(view.webContents.id,'shell')
  api.state.pluginContents=new api.WebContentsView().webContents
  api.bindDetachedWindowHost({ close:id=>api.state.closes.push(id),visibility:(...args)=>api.state.visibility.push(args),layout:()=>{},
    history:(id,state)=>api.state.histories.push({id,state}),activate:id=>api.state.activations.push(id),
    snapshot:id=>({pluginId:id,title:'Plugin '+id,mode:'quick',generation:api.state.snapshotStatus==='lazy'?0:1,status:api.state.snapshotStatus}) })
  t.after(()=>{api.cancelPluginWindowDrag();api.destroyAllDetachedWindows()})
  return api
}
const tabTarget={kind:'shell',axis:'x',rect:{x:0,y:0,width:700,height:36},items:[
  {pluginId:'a',rect:{x:0,y:0,width:100,height:36}},
  {pluginId:'b',rect:{x:100,y:0,width:100,height:36}},
  {pluginId:'c',rect:{x:200,y:0,width:100,height:36}}
]}
const settle=()=>new Promise(resolve=>setTimeout(resolve,25))

test('detached windows are hidden prepared native top-level windows and dispose only owned chrome',async t=>{
  const api=await fixture(t),win=await api.createDetachedWindow('a','quick',{width:720,height:400},{x:-850,y:-400})
  assert.equal(win.options.parent,undefined);assert.equal(win.options.skipTaskbar,undefined)
  assert.equal(win.isVisible(),false);assert.equal(win.options.icon,'/icon.png')
  assert.deepEqual(api.getDetachedPluginBounds('a'),{x:0,y:100,width:720,height:400})
  const chrome=api.getDetachedChrome('a');assert.equal(chrome.options.webPreferences.sandbox,true)
  assert.equal(chrome.options.webPreferences.nodeIntegration,false)
  assert.equal(api.getPluginForDetachedSender(chrome.webContents.id),'a')
  assert.equal(api.getDetachedState('a').appearance.theme,'dark')
  assert.match(chrome.webContents.url,/mode=quick/)
  assert.equal(await api.createDetachedWindow('a','quick',{width:800,height:500}),win)
  api.destroyDetachedWindow('a')
  assert.equal(win.isDestroyed(),true);assert.equal(chrome.webContents.isDestroyed(),true)
  assert.deepEqual(api.state.closes,[],'migration disposal must not close the plugin runtime')
  assert.equal(api.screen.listenerCount('display-removed'),0)
  assert.equal(api.nativeTheme.listenerCount('updated'),0)
})

test('detached appearance resolves the global background and keeps native plugin content above its backdrop', async t => {
  const api = await fixture(t)
  const win = await api.createDetachedWindow('a', 'quick', { width: 720, height: 400 })
  const chrome = api.getDetachedChrome('a'), plugin = new api.WebContentsView()
  win.contentView.addChildView(plugin)
  assert.equal(api.getDetachedState('a').appearance.backgroundEffect.id, 'tunnel')
  const atmosphere = { type: 'color', value: 'linear-gradient(120deg, #447755, #223344)', opacity: 0.6, fit: 'cover' }
  api.state.theme.background = atmosphere
  api.state.theme.backgroundSource = 'user'
  api.broadcastDetachedAppearance()
  assert.deepEqual(chrome.webContents.messages.at(-1).payload.state.appearance.background, atmosphere)
  assert.equal(chrome.getBounds().height, win.getContentBounds().height)
  assert.equal(api.getDetachedPluginBounds('a').y, 100)
  const source = 'com.example.backgrounds'
  api.state.themePacks = [{ id: 'night', name: 'Night', source, tokens: {}, mode: 'dark', backgroundEffects: [
    { id: 'silk', name: 'Silk', renderer: 'preset', preset: 'aurora', speed: 0.5 }
  ] }]
  api.state.theme.backgroundEffect = `plugin:${source}:night:silk`
  api.broadcastDetachedAppearance()
  const chosen = chrome.webContents.messages.at(-1).payload.state.appearance.backgroundEffect
  assert.equal(chosen.source, source); assert.equal(chosen.preset, 'aurora'); assert.equal(chosen.speed, 0.5)
  assert.deepEqual(win.contentView.children, [chrome, plugin], 'appearance refreshes must not raise chrome above the plugin')
  assert.deepEqual(plugin.webContents.scripts, [], 'opaque plugin documents are not rewritten')
  api.state.themePacks = []
  api.broadcastDetachedAppearance()
  assert.equal(api.getDetachedState('a').appearance.backgroundEffect.id, 'tunnel')
  api.state.theme.backgroundEffect = 'none'
  api.broadcastDetachedAppearance()
  assert.equal(api.getDetachedState('a').appearance.backgroundEffect, null)
  assert.deepEqual(api.getDetachedPluginBounds('a'), { x: 0, y: 100, width: 720, height: 400 })
})

test('close requests hide immediately and close the plugin exactly once; creation failure has no renderer leak',async t=>{
  const api=await fixture(t),win=await api.createDetachedWindow('a','quick',{width:700,height:400})
  win.show();win.close();win.close();assert.equal(win.isVisible(),false)
  await settle();assert.deepEqual(api.state.closes,['a']);assert.equal(win.isDestroyed(),true)
  api.state.loadFailure=true
  await assert.rejects(api.createDetachedWindow('b','shell',{width:600,height:400}),/load failure/)
  assert.equal(api.getDetachedWindow('b'),null)
  assert.equal(api.screen.listenerCount('display-removed'),0)
  assert.equal(api.state.windows.filter(win=>!win.isDestroyed()).length,1)
})

test('display removal clamps negative DIP coordinates and updates native content bounds',async t=>{
  const api=await fixture(t),win=await api.createDetachedWindow('a','quick',{width:720,height:400},{x:-850,y:-400})
  api.state.workArea={x:400,y:-200,width:600,height:350}
  api.screen.emit('display-removed')
  assert.deepEqual(win.getBounds(),{x:400,y:-200,width:600,height:350})
  assert.deepEqual(api.getDetachedPluginBounds('a'),{x:0,y:100,width:600,height:250})
})

test('sort index excludes source and drag frames do not move plugin before the final native pointer sample',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.registerPluginDropTargets(sender,[tabTarget])
  assert.equal(api.insertionIndex({x:260,y:15},tabTarget,'a'),2)
  const drag=api.beginPluginWindowDrag(sender.id,'a');assert.ok(drag)
  assert.equal(api.beginPluginWindowDrag(sender.id,'b'),null,'only one drag session')
  api.state.cursor={x:370,y:120};api.updatePluginWindowDrag(sender.id,drag.token)
  await settle();assert.deepEqual(api.state.moves,[]);assert.equal(api.state.captures,1)
  const preview=api.state.windows.at(-1)
  assert.equal(preview.options.focusable,false);assert.equal(preview.ignore.value,true)
  assert.equal(api.state.main.isFocused(),true)
  const feedback=sender.messages.filter(message=>message.payload.active).at(-1).payload
  assert.deepEqual(feedback.point,{x:370,y:120});assert.deepEqual(feedback.localPoint,{x:270,y:20})
  assert.equal(feedback.token,drag.token,'source feedback identifies the exact native session')
  api.state.cursor={x:240,y:120}
  await api.endPluginWindowDrag(sender.id,drag.token)
  assert.deepEqual(api.state.moves,[['sort','a',0]],'end must sample native pointer again')
  assert.equal(preview.isDestroyed(),true);assert.equal(preview.contentView.children[0].webContents.isDestroyed(),true)
  assert.equal(api.state.locks,0);assert.equal(api.state.orbLocks,0)
})

test('outside drop detaches, but blocked surfaces and modal/changed generations never transfer',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.registerPluginDropTargets(sender,[tabTarget])
  api.state.interaction=true;assert.equal(api.beginPluginWindowDrag(sender.id,'a'),null);api.state.interaction=false
  assert.equal(api.beginPluginWindowDrag(999,'a'),null)
  let drag=api.beginPluginWindowDrag(sender.id,'a');api.state.cursor={x:1100,y:900}
  await api.endPluginWindowDrag(sender.id+1,drag.token)
  assert.equal(api.getPluginDragDiagnostics().active,true)
  await api.endPluginWindowDrag(sender.id,drag.token)
  assert.deepEqual(api.state.moves,[['detach','a',{x:1100,y:900}]])
  api.state.placement={kind:'shell'};api.state.cursor={x:120,y:120};api.state.moves=[]
  drag=api.beginPluginWindowDrag(sender.id,'a');api.state.generation++
  api.state.cursor={x:1100,y:900};await api.endPluginWindowDrag(sender.id,drag.token)
  assert.deepEqual(api.state.moves,[]);assert.equal(api.getPluginDragDiagnostics().active,false)
  api.state.cursor={x:120,y:120};drag=api.beginPluginWindowDrag(sender.id,'a')
  api.state.cursor={x:500,y:500};await api.endPluginWindowDrag(sender.id,drag.token)
  assert.deepEqual(api.state.moves,[],'inside eNest non-target content cancels')
})

test('source hiding cancels preview and releases all locks; twenty drag cycles do not accumulate listeners',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.registerPluginDropTargets(sender,[tabTarget])
  for(let cycle=0;cycle<20;cycle++){
    const drag=api.beginPluginWindowDrag(sender.id,'a');assert.ok(drag)
    if(cycle===0)api.state.main.hide()
    else await api.endPluginWindowDrag(sender.id,drag.token,true)
    assert.equal(api.getPluginDragDiagnostics().active,false)
    assert.equal(api.state.main.listenerCount('hide'),0)
    assert.equal(api.state.locks,0);assert.equal(api.state.orbLocks,0)
    api.state.main.show()
  }
  await settle();assert.equal(api.state.windows.filter(win=>!win.isDestroyed()).length,1)
})

test('an overlapping native eNest window blocks targets underneath it',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.registerPluginDropTargets(sender,[tabTarget])
  const blocker=new api.BaseWindow({x:100,y:100,width:400,height:200,alwaysOnTop:true});blocker.show()
  const drag=api.beginPluginWindowDrag(sender.id,'a')
  await api.endPluginWindowDrag(sender.id,drag.token)
  assert.deepEqual(api.state.moves,[])
})

test('native preview allocation failure unwinds the partially created window',async t=>{
  const api=await fixture(t)
  api.state.viewFailure=true
  const warn=console.warn;console.warn=()=>{}
  try { assert.equal(api.beginPluginWindowDrag(api.state.shell.id,'a'),null) } finally { console.warn=warn }
  assert.equal(api.getPluginDragDiagnostics().active,false)
  assert.equal(api.state.windows.filter(win=>!win.isDestroyed()).length,1)
  assert.equal(api.state.locks,0);assert.equal(api.state.orbLocks,0)
})

test('queued move revalidates incarnation and releases preview when cancellation arrives during commit',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.registerPluginDropTargets(sender,[tabTarget])
  const drag=api.beginPluginWindowDrag(sender.id,'a')
  api.state.cursor={x:1200,y:900}
  let release;api.state.moveGate=new Promise(resolve=>{release=resolve})
  const ending=api.endPluginWindowDrag(sender.id,drag.token)
  api.cancelPluginWindowDrag();api.state.generation++
  release()
  await assert.rejects(ending,/move cancelled/)
  assert.deepEqual(api.state.moves,[])
  assert.equal(api.getPluginDragDiagnostics().active,false)
  assert.equal(api.state.locks,0);assert.equal(api.state.orbLocks,0)
  assert.equal(api.state.windows.filter(win=>!win.isDestroyed()).length,1)
})

test('arming protects pre-threshold Quick interactions and transfers the lease without a focus gap',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.armPluginWindowDrag(999,'a');assert.equal(api.state.locks,0)
  api.armPluginWindowDrag(sender.id,'a');assert.equal(api.state.locks,1)
  api.armPluginWindowDrag(sender.id,'a');assert.equal(api.state.locks,1,'duplicate pointer-down does not stack leases')
  api.armPluginWindowDrag(sender.id+1,null);assert.equal(api.state.locks,1,'other surfaces cannot release the armed owner')
  const drag=api.beginPluginWindowDrag(sender.id,'a')
  assert.equal(api.getPluginDragDiagnostics().armed,false);assert.equal(api.state.locks,1)
  await api.endPluginWindowDrag(sender.id,drag.token,true);assert.equal(api.state.locks,0)
  api.armPluginWindowDrag(sender.id,'a');api.state.main.hide()
  assert.equal(api.state.locks,0);assert.equal(api.getPluginDragDiagnostics().armed,false)
  assert.equal(api.state.main.listenerCount('hide'),0)
  api.state.main.show();api.armPluginWindowDrag(sender.id,'a');api.armPluginWindowDrag(sender.id,null)
  assert.equal(api.state.locks,0);assert.equal(api.state.main.listenerCount('hide'),0)
})

test('stationary-pointer target scrolling recomputes insertion and hidden receivers still clear feedback',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.state.cursor={x:240,y:120}
  api.registerPluginDropTargets(sender,[tabTarget])
  const drag=api.beginPluginWindowDrag(sender.id,'a')
  const feedback=()=>sender.messages.filter(message=>message.channel==='window:plugin-drag-event').at(-1)?.payload
  assert.equal(feedback().index,0)
  api.registerPluginDropTargets(sender,[{...tabTarget,items:tabTarget.items.map(item=>({...item,rect:{...item.rect,x:item.rect.x-100}}))}])
  await settle();assert.equal(feedback().index,1)
  api.state.main.hide()
  assert.equal(api.getPluginDragDiagnostics().active,false)
  assert.equal(feedback().active,false,'hidden source receives reset instead of retaining transforms on next show')
  assert.equal(feedback().token,drag.token,'cancellation keeps its session identity after the native session is disposed')
  await api.endPluginWindowDrag(sender.id,drag.token,true)
})

test('cleanup retains the WebContents handle when native View drops its getter after close',async t=>{
  const api=await fixture(t)
  api.state.nullAfterClose=true
  const win=await api.createDetachedWindow('a','quick',{width:720,height:400})
  const chrome=api.getDetachedChrome('a'),contents=chrome.webContents
  assert.doesNotThrow(()=>api.destroyDetachedWindow('a'))
  assert.equal(chrome.webContents,undefined);assert.equal(contents.isDestroyed(),true);assert.equal(win.isDestroyed(),true)
  const drag=api.beginPluginWindowDrag(api.state.shell.id,'a')
  const preview=api.state.windows.at(-1),previewContents=preview.contentView.children[0].webContents
  await assert.doesNotReject(api.endPluginWindowDrag(api.state.shell.id,drag.token,true))
  assert.equal(previewContents.isDestroyed(),true);assert.equal(preview.isDestroyed(),true)
  await settle()
})

test('twenty independent windows share one native theme/display subscription and clean it fully',async t=>{
  const api=await fixture(t)
  for (let index=0;index<20;index++) await api.createDetachedWindow(`window-${index}`,'quick',{width:500,height:300})
  assert.equal(api.nativeTheme.listenerCount('updated'),1)
  assert.equal(api.screen.listenerCount('display-removed'),1)
  assert.equal(api.screen.listenerCount('display-metrics-changed'),1)
  api.destroyAllDetachedWindows()
  assert.equal(api.nativeTheme.listenerCount('updated'),0)
  assert.equal(api.screen.listenerCount('display-removed'),0)
  assert.equal(api.screen.listenerCount('display-metrics-changed'),0)
})

test('source renderer crash cancels an active drag immediately even without a target registration',async t=>{
  const api=await fixture(t),sender=api.state.shell
  api.armPluginWindowDrag(sender.id,'a');assert.equal(api.state.locks,1)
  sender.emit('render-process-gone',{},{});assert.equal(api.state.locks,0)
  const drag=api.beginPluginWindowDrag(sender.id,'a');assert.ok(drag)
  sender.emit('render-process-gone',{},{});
  assert.equal(api.getPluginDragDiagnostics().active,false)
  assert.equal(api.state.locks,0);assert.equal(api.state.orbLocks,0)
  assert.equal(sender.listenerCount('render-process-gone'),0)
})

test('closed native Window and WebContents IDs are never read during teardown',async t=>{
  const api=await fixture(t)
  api.state.deadIdThrows=true
  const win=await api.createDetachedWindow('a','quick',{width:500,height:300})
  const windowId=win.id
  assert.equal(api.getDetachedWindow(windowId),win)
  assert.doesNotThrow(()=>api.destroyDetachedWindow('a'))
  assert.equal(api.getDetachedWindow(windowId),null)
  assert.throws(()=>win.id,/Object has been destroyed/)
  api.registerPluginDropTargets(api.state.shell,[tabTarget])
  api.armPluginWindowDrag(api.state.shell.id,'a')
  assert.doesNotThrow(()=>api.state.shell.close())
  assert.equal(api.getPluginDragDiagnostics().registrations,0)
  assert.equal(api.getPluginDragDiagnostics().armed,false)
  assert.doesNotThrow(()=>api.state.main.destroy())
})

test('restored lazy chrome retains geometry and top/max/min flags without creating or focusing a runtime',async t=>{
  const api=await fixture(t)
  api.state.snapshotStatus='lazy';api.state.restoredFocus=true
  const saved={mode:'quick',bounds:{x:-700,y:-200,width:700,height:500},maximized:true,minimized:true,alwaysOnTop:true}
  const win=await api.createDetachedWindow('a','quick',{width:20,height:20},undefined,{restored:saved,lazy:true})
  assert.deepEqual(win.getBounds(),saved.bounds)
  assert.equal(api.getDetachedChrome('a').getBounds().height,500)
  assert.deepEqual(api.getDetachedWindowSession('a'),saved,'a pre-show snapshot retains restore state flags')
  api.presentRestoredDetachedWindow('a')
  await settle()
  assert.deepEqual(api.state.activations,[],'showInactive platform focus race must not activate the plugin')
  assert.equal(win.isMinimized(),true);assert.equal(win.isMaximized(),true);assert.equal(win.isAlwaysOnTop(),true)
  assert.deepEqual(api.getDetachedWindowSession('a'),saved)
  assert.equal(api.getDetachedState('a').status,'lazy')
  assert.equal(new URL(api.getDetachedChrome('a').webContents.url).searchParams.get('pluginId'),'a')
  assert.equal(api.getDetachedState('a').alwaysOnTop,true)
  assert.equal(api.toggleDetachedAlwaysOnTop('a'),false)
  assert.deepEqual(api.state.activations,[],'pin state is independent of runtime activation')
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(api.state.histories.at(-1).state.alwaysOnTop,false)
  assert.deepEqual(api.state.histories.at(-1).state.bounds,saved.bounds,'history always contains normal restore bounds')
  await new Promise(resolve=>setTimeout(resolve,170))
  win.restore();win.focus();await settle()
  assert.deepEqual(api.state.activations,[],'focus and restore remain inert until the explicit activate command')
  api.state.snapshotStatus='loading';api.updateDetachedState({...api.getDetachedState('a'),status:'loading'})
  assert.equal(api.getDetachedChrome('a').getBounds().height,win.getContentBounds().height)
  api.state.snapshotStatus='ready';api.updateDetachedState({...api.getDetachedState('a'),status:'ready'})
  assert.equal(api.getDetachedChrome('a').getBounds().height,win.getContentBounds().height,'background remains below the native plugin after ready')
})

test('window history coalesces normal moves and clamps restoration after a display is removed',async t=>{
  const api=await fixture(t)
  api.state.snapshotStatus='lazy'
  const win=await api.createDetachedWindow('a','quick',{width:700,height:400},undefined,{lazy:true,restored:{mode:'quick',bounds:{x:-900,y:-400,width:700,height:500},alwaysOnTop:true}})
  api.presentRestoredDetachedWindow('a')
  api.state.histories=[]
  for(let index=0;index<10;index++){win.setBounds({x:100+index,y:150,width:650,height:450});win.emit('move')}
  assert.equal(api.state.histories.length,0)
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(api.state.histories.length,1)
  assert.deepEqual(api.state.histories[0].state.bounds,{x:109,y:150,width:650,height:450})
  win.maximize();api.state.workArea={x:400,y:-100,width:500,height:350};api.screen.emit('display-removed')
  assert.deepEqual(api.getDetachedWindowSession('a').bounds,{x:400,y:-100,width:500,height:350})
  win.unmaximize()
  assert.deepEqual(win.getBounds(),{x:400,y:-100,width:500,height:350})
  api.destroyDetachedWindow('a')
  const count=api.state.histories.length
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(api.state.histories.length,count,'destroy cancels delayed history writes')
})
