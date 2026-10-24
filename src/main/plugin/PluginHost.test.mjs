import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'fixture': `export const f = { views: [], events: [], messages: [], gate: null, host: null, ack: true, snapshot: true, saves: 0, memoryReleases:0, localReleases:0, clears:0, codeClears:0, codeCacheGate:null, codeCacheFail:false, closeStalled:false, firstInstall:false, installHooks:null, children: new Set(), quickChildren: new Set(), quickWindowChildren: new Set(), quickFocus:0, quickReveals:0, quickRevealFinishes:0, quickSizeRequests:[], quickWindowBounds:{x:0,y:0,width:720,height:545}, shellBounds:{x:0,y:36,width:1180,height:764}, manifestWindows:{}, detached:new Map(), detachedSeq:0, detachedEvents:[], detachedStates:[], detachedGate:null, detachedFailAttach:false, quickPrepareGate:null, quickPrepared:0, quickPresented:0, persisted:[], savedGeneral:{sessionTabs:[],sessionActivePluginId:""}, detachedCreates:[], detachedCreating:0, detachedMaxCreating:0, detachedCreateGates:new Map() };`,
  electron: `import {EventEmitter} from 'node:events'; import {f} from 'fixture';
    let seq=0;
    class WC extends EventEmitter {
      id=++seq; destroyed=false; loads=0;
      loadURL(url){this.loads++;this.url=url;(f.loadedUrls??=[]).push(url);return Promise.resolve()}; isDestroyed(){return this.destroyed};
      send(channel,msg){ f.messages.push({channel,msg}); if(msg.event==='beforeClose'||msg.event==='beforeSuspend') {if(f.ack) queueMicrotask(()=>f.host.ackBeforeClose(f.host.getPluginIdByWebContentsId(this.id),this.id,msg.operationId));} };
      setWindowOpenHandler(){}; executeJavaScript(){return f.themeGate??Promise.resolve()}; openDevTools(options){this.devToolsCalls=(this.devToolsCalls??0)+1;this.devToolsOptions=options}; focus(){this.focusCalls=(this.focusCalls??0)+1};
      close(){if(f.closeStalled)return;this.destroyed=true;this.emit('destroyed')};
    }
    export class WebContentsView { webContents=new WC(); visible=true; bounds={}; boundsHistory=[]; constructor(){f.views.push(this);this.webContents.once('destroyed',()=>{this.webContents=undefined})};setVisible(v){this.visible=v};setBorderRadius(){};setBackgroundColor(){};getBounds(){return {...this.bounds}};setBounds(bounds){this.bounds={...bounds};this.boundsHistory.push({...bounds})} }
    export const nativeTheme=new EventEmitter(); export const session={fromPartition:()=>({})};`,
  '@main/window/createShellWindow': `import {f} from 'fixture'; export const getMainWindow=()=>({isDestroyed:()=>false,isMinimized:()=>false,show(){},focus(){},contentView:{addChildView:v=>f.children.add(v),removeChildView:v=>f.children.delete(v)}}); export const getPluginContentBounds=()=>({...f.shellBounds}); export const resolvePreload=x=>x; export const sendShellEvent=e=>f.events.push(e);`,
  '@main/window/createQuickWindow': `
    import {f} from 'fixture';
    const surface={addChildView:v=>f.quickChildren.add(v),removeChildView:v=>f.quickChildren.delete(v)};
    const win={getContentBounds:()=>({...f.quickWindowBounds}),contentView:{addChildView:v=>f.quickWindowChildren.add(v),removeChildView:v=>f.quickWindowChildren.delete(v)}};
    const wc={isDestroyed:()=>false,focus:()=>{f.quickFocus++}};
    export const getQuickWindow=()=>win; export const ensureQuickWindow=()=>win;
    export const prepareQuickWindowForPlugin=async guard=>{f.quickPrepared++;if(f.quickPrepareGate)await f.quickPrepareGate;return guard()};
    export const presentQuickWindowForPlugin=commit=>{f.quickPresented++;if(f.quickPresentFail)return false;commit?.();return true};
    export const getQuickPluginParent=()=>surface;
    export const revealQuickPlugin=()=>{f.quickReveals++};
    export const finishQuickPluginReveal=()=>{f.quickRevealFinishes++};
    export const getQuickPluginBounds=()=>{const {width,height}=win.getContentBounds();return {x:1,y:64,width:width-2,height:height-65}}; export const getQuickWebContents=()=>wc;
    export const setQuickContentSize=size=>{f.quickSizeRequests.push({...size})}; export const hideQuickWindow=()=>{};
    export const setQuickPluginHiddenHook=()=>{}; export const setQuickPluginRelayout=()=>{}; export const setQuickPluginResetHook=()=>{}; export const setQuickPluginSummonHook=()=>{};
  `,
  '@main/settings/SettingsStore': `import {f} from 'fixture'; export const settingsStore={getAll:()=>({general:f.savedGeneral}),setAll:async value=>{f.persisted.push(value)},flushNow(){}};`,
  '@main/window/detachedPluginWindows': `
    import {f} from 'fixture';
    export const bindDetachedWindowHost=value=>{f.detachedHost=value};
    export async function createDetachedWindow(id,mode,size,position,options){
      f.detachedCreates.push({id,mode,options});f.detachedCreating++;f.detachedMaxCreating=Math.max(f.detachedMaxCreating,f.detachedCreating);
      if(f.detachedCreateGates.has(id))await f.detachedCreateGates.get(id);
      if(f.detachedGate)await f.detachedGate;
      f.detachedCreating--;
      const children=new Set();
      const win={id:++f.detachedSeq,visible:false,focused:false,destroyed:false,
        isDestroyed(){return this.destroyed},isMinimized:()=>false,restore(){},show(){this.visible=true},focus(){this.focused=true},
        contentView:{addChildView(v){if(f.detachedFailAttach)throw Error('attach failed');children.add(v)},removeChildView:v=>children.delete(v)}};
      f.detached.set(id,{win,children,mode,history:options?.restored?structuredClone(options.restored):{mode,bounds:{x:10,y:20,width:size.width,height:size.height+(mode==='quick'?100:36)},maximized:false,minimized:false,alwaysOnTop:false},bounds:{x:0,y:mode==='quick'?100:36,width:size.width,height:size.height}});return win;
    }
    export const presentRestoredDetachedWindow=id=>{const entry=f.detached.get(id);if(entry){entry.win.visible=!entry.history.minimized;f.detachedHost.visibility(id,entry.win.visible)}};
    export const getDetachedWindowSession=id=>{const state=f.detached.get(id)?.history;return state?structuredClone(state):null};
    export const getDetachedWindow=id=>f.detached.get(id)?.win;
    export const getDetachedParent=id=>f.detached.get(id)?.win.contentView;
    export const getDetachedChrome=id=>f.detached.has(id)?{webContents:{focus(){}}}:null;
    export const getDetachedPluginBounds=id=>f.detached.get(id)?.bounds??{};
    export const destroyDetachedWindow=id=>{const entry=f.detached.get(id);if(entry)entry.win.destroyed=true;f.detached.delete(id)};
    export const sendDetachedEvent=(id,event)=>f.detachedEvents.push({id,event});
    export const updateDetachedState=state=>f.detachedStates.push(state);
  `,
  '@main/dev/DevConsole': `import {f} from 'fixture'; export const prepareDevPluginReload=async()=>{f.preparations=(f.preparations??0)+1;if(f.prepareDevGate)await f.prepareDevGate;return f.preparedDev??null};`,
  '@main/plugin/localFiles': `import {f} from 'fixture'; export const releaseLocalFiles=()=>{f.localReleases++};`,
  '@main/window/orbRailViews': `export const raiseOrbRailViews=()=>{};`,
  '@main/logs/logService': `export const logInfo=()=>{}; export const logWarn=()=>{};`,
  '@main/plugin/PluginSessionStore': `import {f} from 'fixture'; export const clearPluginSession=()=>{f.clears++}; export const releaseSessionMemory=()=>{f.memoryReleases++}; export const deleteSessionSnapshot=()=>{}; export const loadSessionSnapshot=()=>true; export const saveSessionSnapshot=()=>{f.saves++;return f.snapshot}; export const getSessionRevision=()=>0;`,
  '@main/plugin/PluginRegistry': `import {f} from 'fixture'; export const pluginRegistry={ensureInstalled:async id=>{if(f.gate)await f.gate;if(f.firstInstall){const release=await f.installHooks.beforeReplace(id);try{await f.installHooks.afterReplace(id,'/fixture/'+id)}finally{release?.()}f.firstInstall=false}return {id,name:id,rootPath:'/fixture/'+id}},get:id=>({id,name:id,icon:'enest://plugin/'+id+'/assets/market/icon.svg',glyph:'P',color:'#257',rootPath:f.firstInstall||f.uninstalled?.has(id)?undefined:'/fixture/'+id,...(f.devSummary?.id===id?f.devSummary:{})}),addDevPlugin:summary=>{f.devSummary=summary;f.devRegistrations=(f.devRegistrations??0)+1},getManifest:id=>({id,name:id,main:'index.html',window:f.manifestWindows[id]}),getBuildRevision:()=> 'build1',invalidateBuildRevision:()=> 'build2'};`,
  '@main/plugin/pluginEnabledStore': `export const isEnabledSync=()=>true;`,
  '@main/plugin/PluginInstaller': `import {f} from 'fixture'; export const setPluginInstallLifecycleHooks=hooks=>{f.installHooks=hooks};`,
  '@main/plugin/pluginProtocol': `import {f} from 'fixture'; export const registerPluginProtocolForSession=()=>{}; export const invalidatePluginFileCache=()=>{}; export const invalidatePluginCodeCache=async()=>{f.codeClears++;if(f.codeCacheGate)await f.codeCacheGate;if(f.codeCacheFail)throw Error('cache unavailable')};`,
  '@main/plugin/pluginSessionPolicy': `export const configurePluginSession=()=>{}; export const releasePluginEndpoints=()=>{}; export const allowPluginEndpoint=()=>()=>{};`,
  '@main/plugin/PermissionService': `export const permissionService={cancelFor(){}};`,
  '@main/proxy/proxyService': `import {f} from 'fixture'; export const applyProxyToPluginPartition=async()=>{if(f.proxyGate)await f.proxyGate}; export const getActiveProxy=()=>({type:'none'});`,
  '@main/db/pluginStorage': `export const releasePluginStorage=()=>true;`,
  '@main/contrib/ContributionRegistry': `export const contributionRegistry={releaseQuickProviders(){}};`,
  '@main/hotkey/pluginRuntimeHotkeys': `export const releasePluginHotkeys=()=>{};`,
  '@main/theme/resolveThemeCss': `export const resolveThemeTokens=()=>({}); export const themeTokensToInjectScript=()=>'';`,
  '@main/theme/appearanceService': `import {f} from 'fixture'; export const appearanceService={getAppearance:preferred=>{f.appearancePreferred=preferred;return f.appearance??{revision:1}}};`,
  '@main/plugin/externalLinks': `export const routeExternal=async()=>{}; export const isInternalNavigation=()=>true;`
}
async function fixture() {
  const result = await build({ stdin:{contents:`export {PluginHost,pluginHost} from '@main/plugin/PluginHost'; export {f} from 'fixture'; export {getRuntimeScope} from '@main/plugin/PluginRuntimeScope'; export {acquirePluginActivity} from '@main/plugin/activityRegistry'; export {bindQuickInputHost,configureQuickInput,getQuickInputState} from '@main/plugin/quickInputService'; export const nonce=${Math.random()};`,resolveDir:root},tsconfig:root+'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},({path})=>path in adapters?{path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:adapters[path],loader:'js'}))}}] })
  const api=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
  api.f.host=api.pluginHost
  api.bindQuickInputHost({current:()=>api.pluginHost.getQuickPlugin(),owns:id=>api.pluginHost.isQuickInputOwner(id),detached:id=>api.pluginHost.getPlacement(id).kind==='detached',publish:(id,event)=>api.pluginHost.sendSurfaceEvent(id,event),focus:id=>api.pluginHost.focusPlugin(id),send:(id,event)=>api.pluginHost.sendEvent(id,event),dismiss:id=>api.pluginHost.dismissQuickPlugin(id)})
  return {...api,host:api.f.host}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function loaded(ctx,id){await ctx.host.openPlugin(id);ctx.host.getWebContents(id).emit('did-finish-load');await tick()}

test('theme broadcasts forward the authoritative appearance alongside compatibility tokens', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one')
    c.f.appearance = { revision: 9, theme: { source: 'enest.builtin', id: 'warm', legacy: false }, mode: 'dark' }
    c.host.broadcastTheme()
    assert.equal(c.f.messages.filter(({ msg }) => msg.type === 'appearance-change').at(-1).msg.appearance, c.f.appearance)
    assert.ok(c.f.messages.some(({ msg }) => msg.type === 'theme-change'))
    assert.equal(c.f.appearancePreferred, 'auto')
  } finally { await c.host.destroyAll() }
})

test('save all clears only successfully acknowledged dirty instances and ignores stale operations',async()=>{
  const c=await fixture();await loaded(c,'one');await loaded(c,'two')
  try {
    c.host.setPluginDirty('one',true);c.host.setPluginDirty('two',true)
    const saving=c.host.requestSaveAll('update')
    const first=c.host.pendingAcks.get('one'),second=c.host.pendingAcks.get('two')
    c.host.ackBeforeClose('one',first.wcId,'stale-operation',true)
    assert.equal(c.host.pendingAcks.has('one'),true)
    c.host.ackBeforeClose('one',first.wcId,first.operationId,true)
    c.host.ackBeforeClose('two',second.wcId,second.operationId,false)
    assert.deepEqual(await saving,{total:2,acked:1,timedOut:1,dirtyBefore:2})
    assert.deepEqual(c.host.getDirtySnapshot().map(({pluginId,dirty})=>({pluginId,dirty})),[{pluginId:'one',dirty:false},{pluginId:'two',dirty:true}])
  } finally {await c.host.destroyAll()}
})

test('concurrent opens own exactly one renderer; load does not refresh itself',async()=>{
  const c=await fixture();let release;c.f.gate=new Promise(r=>release=r)
  const first=c.host.openPlugin('one'),second=c.host.openPlugin('one');release();await Promise.all([first,second])
  assert.equal(c.f.views.length,1);assert.equal(c.f.children.size,1)
  c.f.views[0].webContents.emit('did-finish-load');assert.equal(c.f.views[0].webContents.loads,1)
  await c.host.destroyAll();assert.equal(c.f.children.size,0);assert.ok(c.f.views.every(v=>v.webContents===undefined))
})

test('direct cold Quick launch never activates a main-window tab and initially loads the requested mode',async()=>{
  const c=await fixture()
  try {
    await c.host.launchPluginIn('one','quick')
    assert.equal(c.f.views.length,1);assert.match(c.host.getWebContents('one').url,/mode=quick/)
    assert.equal(c.host.getPlacement('one').kind,'quick');assert.equal(c.host.getQuickPlugin(),'one')
    assert.equal(c.host.hasShellTab('one'),false);assert.equal(c.f.events.some(e=>e.type==='plugin-active'),false)
    assert.equal(c.f.children.size,0);assert.equal(c.f.quickChildren.size,1)
    assert.equal(c.f.quickPresented,1)
  } finally {await c.host.destroyAll()}
})

test('directed launches migrate detached and warm instances without replacing their runtime',async()=>{
  const c=await fixture()
  try {
    await loaded(c,'one');const wc=c.host.getWebContents('one'),scope=c.getRuntimeScope('one')
    await c.host.detachPlugin('one')
    await c.host.launchPluginIn('one','quick')
    assert.equal(c.host.getPlacement('one').kind,'quick');assert.equal(c.f.detached.size,0)
    await c.host.launchPluginIn('one','shell')
    assert.equal(c.host.getPlacement('one').kind,'shell');assert.equal(c.host.hasShellTab('one'),true)
    assert.equal(c.host.getWebContents('one'),wc);assert.equal(c.getRuntimeScope('one'),scope)
    assert.equal(wc.loads,1);assert.equal(c.f.views.length,1)
  } finally {await c.host.destroyAll()}
})

test('directed launch wakes a hibernated detached plugin at its requested mode without reopening its source',async()=>{
  const c=await fixture()
  try {
    await loaded(c,'one');await c.host.detachPlugin('one');c.host.setDetachedVisible('one',false)
    c.host.hibernatePlugin('one');await tick();await tick();assert.equal(c.host.isHibernated('one'),true)
    const old=c.f.detached.get('one').win;old.visible=false;old.focused=false
    await c.host.launchPluginIn('one','quick')
    assert.equal(old.visible,false);assert.equal(old.focused,false);assert.equal(old.destroyed,true)
    assert.equal(c.host.getPlacement('one').kind,'quick');assert.match(c.host.getWebContents('one').url,/mode=quick/)
    assert.equal(c.host.isOpened('one'),true)
  } finally {await c.host.destroyAll()}
})

test('failed directed presentation restores a dormant shell or detached source without running the prepared plugin',async()=>{
  for(const kind of ['shell','detached']) {
    const c=await fixture()
    try {
      await loaded(c,'one')
      if(kind==='detached'){await c.host.detachPlugin('one');c.host.setDetachedVisible('one',false)}
      else await loaded(c,'two')
      c.host.hibernatePlugin('one');await tick();await tick()
      assert.equal(c.host.isHibernated('one'),true)
      const loads=c.f.loadedUrls.length,sourceWindow=c.f.detached.get('one')?.win
      c.f.quickPresentFail=true
      await assert.rejects(c.host.launchPluginIn('one','quick'),/could not be presented/)
      assert.equal(c.f.loadedUrls.length,loads,'failed destination must not execute plugin initialization')
      assert.equal(c.host.isOpened('one'),false);assert.equal(c.host.isHibernated('one'),true)
      assert.equal(c.host.getPlacement('one').kind,kind);assert.equal(c.host.getLayoutMode('one'),'shell')
      if(sourceWindow)assert.equal(c.f.detached.get('one').win,sourceWindow)
      await c.host.openPlugin('one')
      assert.equal(c.host.getPlacement('one').kind,kind);assert.equal(c.host.getLayoutMode('one'),'shell')
      assert.match(c.host.getWebContents('one').url,/mode=shell/)
    } finally {await c.host.destroyAll()}
  }
})

test('a failed first presentation releases its unstarted renderer and leaves no tab or pending URL',async()=>{
  const c=await fixture()
  try {
    c.f.quickPresentFail=true
    await assert.rejects(c.host.launchPluginIn('one','quick'),/could not be presented/)
    assert.equal(c.f.loadedUrls?.length??0,0);assert.equal(c.host.isOpened('one'),false)
    assert.equal(c.host.hasShellTab('one'),false);assert.equal(c.f.quickChildren.size,0)
    assert.equal(c.f.views[0].webContents,undefined)
    c.f.quickPresentFail=false;await c.host.launchPluginIn('one','shell')
    assert.match(c.host.getWebContents('one').url,/mode=shell/);assert.equal(c.f.loadedUrls.length,1)
  } finally {await c.host.destroyAll()}
})

test('native setup rejection retires only the new renderer and preserves its dormant detached source',async()=>{
  const c=await fixture()
  try {
    await loaded(c,'one');await c.host.detachPlugin('one');c.host.setDetachedVisible('one',false)
    c.host.hibernatePlugin('one');await tick();await tick()
    const source=c.f.detached.get('one'),identity=c.host.hibernated.get('one')
    const loads=c.f.loadedUrls.length,messages=c.f.messages.length
    c.f.detachedFailAttach=true
    await assert.rejects(c.host.launchPluginIn('one','quick'),/attach failed/)
    assert.equal(c.host.isOpened('one'),false);assert.equal(c.host.isHibernated('one'),true)
    assert.equal(c.host.hibernated.get('one'),identity);assert.equal(c.f.detached.get('one'),source)
    assert.equal(c.host.getPlacement('one').kind,'detached');assert.equal(c.host.getLayoutMode('one'),'shell')
    assert.equal(c.getRuntimeScope('one'),undefined);assert.equal(c.f.views.at(-1).webContents,undefined)
    assert.equal(c.f.loadedUrls.length,loads);assert.equal(c.f.messages.length,messages)
    assert.equal(source.children.size,0);assert.equal(c.f.quickChildren.size,0)
    c.f.detachedFailAttach=false
    await c.host.openPlugin('one')
    assert.equal(c.f.detached.get('one'),source);assert.match(c.host.getWebContents('one').url,/mode=shell/)
  } finally {c.f.detachedFailAttach=false;await c.host.destroyAll()}
})

test('a newer binding cancels a cold launch before allocation and becomes the sole destination',async()=>{
  const c=await fixture();let release,revision=1;c.f.gate=new Promise(r=>release=r)
  try {
    const first=c.host.launchPluginIn('one','quick',undefined,()=>revision===1)
    const rejected=assert.rejects(first,/cancelled/);await tick();revision=2
    const second=c.host.launchPluginIn('one','shell',undefined,()=>revision===2)
    release();await rejected;await second
    assert.equal(c.f.views.length,1);assert.equal(c.host.getPlacement('one').kind,'shell')
    assert.equal(c.f.quickPresented,0);assert.equal(c.host.hasShellTab('one'),true)
  } finally {release?.();await c.host.destroyAll()}
})

test('directed launch refuses a native modal in either source or destination without moving the source',async()=>{
  const c=await fixture()
  try {
    await loaded(c,'one');await c.host.detachPlugin('one');await loaded(c,'two')
    const lockSource=c.host.acquireWindowInteraction('one')
    await assert.rejects(c.host.launchPluginIn('one','quick'),/对话框/);lockSource()
    const lockTarget=c.host.acquireWindowInteraction('two')
    await assert.rejects(c.host.launchPluginIn('one','shell'),/对话框/);lockTarget()
    assert.equal(c.host.getPlacement('one').kind,'detached');assert.equal(c.f.detached.size,1)
    assert.equal(c.f.quickPresented,0)
  } finally {await c.host.destroyAll()}
})

test('close during directed preparation cancels, while a launch after close began waits for retirement',async()=>{
  const c=await fixture();let release
  try {
    c.f.proxyGate=new Promise(r=>release=r)
    const launching=c.host.launchPluginIn('one','shell'),rejected=assert.rejects(launching,/cancelled/)
    await tick();await c.host.closePlugin('one');release();await rejected
    assert.equal(c.f.views.length,0);assert.equal(c.host.hasShellTab('one'),false)
    c.f.proxyGate=null;await loaded(c,'one');const wc=c.host.getWebContents('one');c.f.ack=false
    const closing=c.host.closePlugin('one'),reopening=c.host.launchPluginIn('one','quick')
    await tick();assert.equal(c.f.views.length,1)
    const ack=c.host.pendingAcks.get('one');c.host.ackBeforeClose('one',wc.id,ack.operationId)
    await Promise.all([closing,reopening]);assert.equal(c.host.getPlacement('one').kind,'quick')
    assert.equal(c.f.views.length,2);assert.equal(wc.isDestroyed(),true);c.f.ack=true
  } finally {release?.();c.f.ack=true;await c.host.destroyAll()}
})
test('closing while installation is pending cancels creation and logical restoration',async()=>{
  const c=await fixture();let release;c.f.gate=new Promise(r=>release=r)
  c.host.restoreTabs(['one']);const opening=c.host.openPlugin('one');const rejected=assert.rejects(opening,/cancelled/)
  await c.host.closePlugin('one');release();await rejected
  assert.equal(c.f.views.length,0);assert.deepEqual(c.f.events.filter(e=>e.type==='plugin-tabs').at(-1).tabs,[])
})
test('close detaches immediately, repeated closes share completion, reopen waits old generation',async()=>{
  const c=await fixture();await loaded(c,'one');c.f.ack=false
  const old=c.host.getWebContents('one'),scope=c.getRuntimeScope('one');const close=c.host.closePlugin('one')
  assert.equal(c.f.children.size,0);assert.equal(c.f.views[0].visible,false);assert.ok(scope.signal.aborted)
  assert.strictEqual(c.host.closePlugin('one'),close)
  const reopened=c.host.openPlugin('one');await tick();assert.equal(c.f.views.length,1)
  const ack=c.host.pendingAcks.get('one');c.host.ackBeforeClose('one',old.id+1,ack.operationId)
  assert.equal(old.isDestroyed(),false)
  c.host.ackBeforeClose('one',old.id,ack.operationId);await Promise.all([close,reopened]);assert.equal(c.f.views.length,2);assert.ok(old.isDestroyed());assert.notEqual(c.getRuntimeScope('one').owner.generation,scope.owner.generation)
  c.f.ack=true;await c.host.destroyAll()
})
test('lazy and crashed tabs close; background close preserves active tab, active close picks right',async()=>{
  const c=await fixture();c.host.restoreTabs(['a','b','c']);await loaded(c,'b')
  await c.host.closePlugin('a');assert.equal(c.host.getActive(),'b')
  await c.host.closePlugin('b');await tick();assert.equal(c.host.getActive(),'c')
  c.host.getWebContents('c').emit('render-process-gone',{}, {reason:'crashed'})
  await c.host.closePlugin('c');assert.equal(c.host.logicalTabs.size,0);await c.host.destroyAll()
})
test('background finishing load is eligible for suspension; failed checkpoints retain runtime',async()=>{
  const c=await fixture();await c.host.openPlugin('one');c.host.hideAllViews();c.host.getWebContents('one').emit('did-finish-load');await tick()
  assert.equal(c.host.getState('one'),'background');c.f.snapshot=false;c.host.hibernatePlugin('one');await tick();await tick();assert.ok(c.host.isOpened('one'))
  c.f.snapshot=true;c.host.hibernatePlugin('one');await tick();await tick();assert.ok(c.host.isHibernated('one'));assert.equal(c.host.isOpened('one'),false);assert.equal(c.f.memoryReleases,1);assert.equal(c.f.clears,0)
  await c.host.openPlugin('one');assert.ok(c.host.isOpened('one'));await c.host.destroyAll()
})
test('activity blocks suspension and activation cancels an in-flight checkpoint',async()=>{
  const c=await fixture();await loaded(c,'one');c.host.hideAllViews();const release=c.getRuntimeScope('one').acquireActivity('test query')
  c.host.hibernatePlugin('one');await tick();assert.equal(c.f.saves,0);release();c.f.ack=false;c.host.hibernatePlugin('one');await tick()
  c.host.activatePlugin('one');const ack=c.host.pendingAcks.get('one');c.host.ackBeforeClose('one',c.host.getWebContents('one').id,ack.operationId)
  await tick();assert.equal(c.f.saves,0);assert.equal(c.host.getState('one'),'active');c.f.ack=true;await c.host.destroyAll()
})

test('concurrent shell and quick opens migrate the one renderer into the final container',async()=>{
  const c=await fixture();let release;c.f.gate=new Promise(r=>release=r)
  const first=c.host.openPlugin('one'),second=c.host.openPlugin('one',undefined,{container:'quick'})
  release();await Promise.all([first,second]);assert.equal(c.f.views.length,1)
  assert.equal(c.host.getContainer('one'),'quick');assert.equal(c.f.children.size,0);assert.equal(c.f.quickChildren.size,1)
  assert.equal(c.f.quickWindowChildren.size,0, 'plugin views belong to the Quick surface, not the window root')
  await c.host.destroyAll();assert.equal(c.f.quickChildren.size,0)
})

test('Quick plugins use a fixed height independent of manifest and resize, and dismiss restores the home height',async()=>{
  const c=await fixture()
  c.f.manifestWindows.small={width:320,height:120,minHeight:80}
  c.f.manifestWindows.large={width:1400,height:1100,minHeight:900}
  try {
    // A resize received before activation must not survive as a later size preference.
    c.host.resizePlugin('small',{width:900,height:850})
    assert.equal(c.f.quickSizeRequests.length,0)
    await c.host.openPlugin('small',undefined,{container:'quick'})
    c.host.getWebContents('small').emit('did-finish-load');await tick()
    const small=c.f.views[0]
    assert.deepEqual(small.bounds,{x:1,y:64,width:718,height:480})
    assert.deepEqual(c.f.quickSizeRequests.at(-1),{height:545})
    const activeRequests=c.f.quickSizeRequests.length
    for(const size of [{height:90},{width:1300,height:980},{height:480}]) c.host.resizePlugin('small',size)
    assert.equal(c.f.quickSizeRequests.length,activeRequests, 'ui.resize/setHeight cannot request native resizes')
    assert.deepEqual(small.bounds,{x:1,y:64,width:718,height:480})

    const switchRequests=c.f.quickSizeRequests.length
    await c.host.openPlugin('large',undefined,{container:'quick'})
    c.host.getWebContents('large').emit('did-finish-load');await tick()
    assert.equal(small.visible,false)
    assert.deepEqual(c.f.views[1].bounds,small.bounds, 'manifest minHeight cannot expand the viewport')
    assert.ok(c.f.quickSizeRequests.length>switchRequests)
    assert.ok(c.f.quickSizeRequests.slice(switchRequests).every(size=>size.height===545), 'switching plugins must not collapse to the home height')
    const backgroundRequests=c.f.quickSizeRequests.length
    c.host.resizePlugin('small',{height:1600})
    assert.equal(c.f.quickSizeRequests.length,backgroundRequests)
    c.host.showQuickPlugin('small')
    assert.deepEqual(small.bounds,{x:1,y:64,width:718,height:480})
    assert.ok(c.f.quickSizeRequests.every(size=>size.height===545))
    const dismissRequests=c.f.quickSizeRequests.length
    c.host.dismissQuickPlugin('small')
    assert.deepEqual(c.f.quickSizeRequests.slice(dismissRequests),[{height:248}], 'returning to the common grid restores its two-row height')
    await c.host.closePlugin('small')
    await c.host.openPlugin('small',undefined,{container:'quick'})
    assert.deepEqual(c.f.views.at(-1).bounds,{x:1,y:64,width:718,height:480})
    assert.deepEqual(c.f.quickSizeRequests.at(-1),{height:545})
    assert.equal(c.f.quickSizeRequests.filter(size=>size.height===248).length,1)
    assert.ok(c.f.quickSizeRequests.every(size=>Object.keys(size).length===1&&[248,545].includes(size.height)), 'only host-owned home and plugin heights are requested')
    assert.equal(c.f.quickReveals,0, 'plugin entry cannot clip the shared surface down to the input bar')
  } finally {await c.host.destroyAll()}
})

test('Quick plugin layout follows actual native bounds after display changes and container migration',async()=>{
  const c=await fixture()
  try {
    await c.host.openPlugin('one',undefined,{container:'quick'})
    const view=c.f.views[0],wc=c.host.getWebContents('one')
    wc.emit('did-finish-load');await tick()
    assert.deepEqual(view.bounds,{x:1,y:64,width:718,height:480})
    // A constrained display may clamp the fixed preferred size; plugins use that actual viewport.
    c.f.quickWindowBounds={x:12,y:18,width:600,height:400}
    c.host.layoutQuickPlugins()
    assert.deepEqual(view.bounds,{x:1,y:64,width:598,height:335})
    c.host.pinToShell('one')
    assert.deepEqual(view.bounds,c.f.shellBounds)
    const shellLayouts=view.boundsHistory.length,sizeRequests=c.f.quickSizeRequests.length
    c.host.resizePlugin('one',{width:350,height:120})
    c.host.resizePlugin('one',{height:1000})
    assert.equal(view.boundsHistory.length,shellLayouts)
    assert.equal(c.f.quickSizeRequests.length,sizeRequests)
    assert.deepEqual(view.bounds,c.f.shellBounds, 'desktop viewport remains user-controlled')
    await c.host.openPlugin('one',undefined,{container:'quick'})
    assert.equal(c.host.getWebContents('one'),wc)
    assert.deepEqual(view.bounds,{x:1,y:64,width:598,height:335})
    c.f.quickWindowBounds={x:0,y:0,width:720,height:545}
    c.host.layoutQuickPlugins()
    assert.deepEqual(view.bounds,{x:1,y:64,width:718,height:480})
    assert.equal(c.f.quickReveals,0)
  } finally {await c.host.destroyAll()}
})

test('native Quick workbench Escape dismisses a nonempty plugin query directly without destroying its runtime',async()=>{
  const c=await fixture()
  try {
    await c.host.openPlugin('one',undefined,{container:'quick'})
    const wc=c.host.getWebContents('one'),scope=c.getRuntimeScope('one')
    wc.emit('did-finish-load');await tick()
    assert.equal(c.configureQuickInput('one',{placeholder:'Plugin search',value:'nonempty query'}),true)
    const focusBefore=c.f.quickFocus,finishBefore=c.f.quickRevealFinishes
    let prevented=false
    wc.emit('before-input-event',{preventDefault(){prevented=true}},{type:'keyDown',key:'Escape'})
    assert.equal(prevented,true)
    assert.equal(c.host.getQuickPlugin(),null)
    assert.equal(c.getQuickInputState(),null)
    assert.equal(c.f.events.filter(event=>event.type==='quick-plugin-mode').at(-1).mode,null)
    assert.equal(c.f.views[0].visible,false)
    assert.equal(c.host.getState('one'),'background')
    assert.equal(c.host.getWebContents('one'),wc)
    assert.equal(c.getRuntimeScope('one'),scope)
    assert.equal(scope.signal.aborted,false)
    assert.equal(wc.isDestroyed(),false)
    assert.equal(c.f.quickFocus,focusBefore+1)
    assert.equal(c.f.quickRevealFinishes,finishBefore+1)
    assert.equal(c.f.messages.some(({msg})=>msg.type==='quick-input-change'),false, 'host Escape must not only clear the plugin query')
  } finally { await c.host.destroyAll() }
})

test('native Quick Escape preserves keyboard ownership and ignores auto-repeat until a fresh press',async()=>{
  const c=await fixture()
  try {
    await c.host.openPlugin('one',undefined,{container:'quick'})
    const wc=c.host.getWebContents('one')
    wc.emit('did-finish-load');await tick()
    const press=(input={})=>{
      let prevented=false
      wc.emit('before-input-event',{preventDefault(){prevented=true}},{type:'keyDown',key:'Escape',...input})
      return prevented
    }
    for(const context of ['terminal','editor','overlay']) {
      c.host.setInputContext('one',context)
      assert.equal(press(),false,context)
      assert.equal(c.host.getQuickPlugin(),'one',context)
    }
    c.host.setInputContext('one','workbench')
    for(const input of [{isComposing:true},{control:true},{meta:true},{alt:true},{shift:true},{type:'keyUp'}]) {
      assert.equal(press(input),false)
      assert.equal(c.host.getQuickPlugin(),'one')
    }
    assert.equal(press({isAutoRepeat:true}),true)
    assert.equal(c.host.getQuickPlugin(),'one')
    assert.equal(press(),true)
    assert.equal(c.host.getQuickPlugin(),null)
    const exits=c.f.events.filter(event=>event.type==='quick-plugin-mode'&&event.mode===null).length
    assert.equal(press({isAutoRepeat:true}),false)
    assert.equal(c.f.events.filter(event=>event.type==='quick-plugin-mode'&&event.mode===null).length,exits)
    c.host.showQuickPlugin('one')
    assert.equal(press({isAutoRepeat:true}),true)
    assert.equal(c.host.getQuickPlugin(),'one', 'held Escape cannot dismiss a newly shown plugin')
    assert.equal(press(),true)
    assert.equal(c.host.getQuickPlugin(),null)
  } finally { await c.host.destroyAll() }
})

test('first-install hooks do not cancel their own opening and cache failures do not reject installation',async()=>{
  const c=await fixture();c.f.firstInstall=true;c.f.codeCacheFail=true
  await loaded(c,'one');assert.equal(c.f.views.length,1);assert.equal(c.f.codeClears,1);assert.equal(c.host.getState('one'),'active')
  await c.host.destroyAll()
})

test('reload waits compiled cache invalidation and an explicit close cancels its reopen',async()=>{
  const c=await fixture();await loaded(c,'one');let releaseCache;c.f.codeCacheGate=new Promise(r=>releaseCache=r)
  c.host.reloadPlugin('one');await tick();assert.equal(c.f.views.length,1);assert.equal(c.f.codeClears,1)
  const closed=c.host.closePlugin('one');releaseCache();await closed;await tick()
  assert.equal(c.f.views.length,1);assert.equal(c.host.logicalTabs.size,0)
  c.f.codeCacheGate=null;c.f.codeCacheFail=true;await loaded(c,'one');c.host.reloadPlugin('one');const opened=c.host.openPlugin('one')
  await opened;assert.equal(c.f.views.length,3);assert.equal(c.host.isOpened('one'),true)
  await c.host.destroyAll()
})

test('a replaced suspend operation cannot clear or acknowledge a later suspension',async()=>{
  const c=await fixture();await loaded(c,'one');c.f.ack=false;c.host.hideAllViews();c.host.hibernatePlugin('one')
  const first=c.host.pendingAcks.get('one');c.host.activatePlugin('one');c.host.hideAllViews();c.host.hibernatePlugin('one')
  const second=c.host.pendingAcks.get('one');assert.notEqual(first.operationId,second.operationId)
  await tick();assert.equal(c.host.suspending.size,1)
  c.host.ackBeforeClose('one',c.host.getWebContents('one').id,first.operationId);await tick();assert.equal(c.f.saves,0)
  c.host.ackBeforeClose('one',c.host.getWebContents('one').id,second.operationId);await tick();await tick()
  assert.equal(c.f.saves,1);assert.equal(c.host.isHibernated('one'),true)
  c.f.ack=true;await c.host.destroyAll()
})

test('close during suspension cancels its checkpoint and kill-on-hide failures schedule a bounded retry',async()=>{
  const c=await fixture();await loaded(c,'one');c.f.snapshot=false;c.host.setKillOnHide('one',true);c.host.hideAllViews()
  await tick();await tick();assert.equal(c.f.saves,1);assert.equal(c.host.hibernateTimers.has('one'),true);assert.equal(c.f.memoryReleases,0)
  c.f.snapshot=true;c.f.ack=false;c.host.hibernatePlugin('one');const close=c.host.closePlugin('one');await tick()
  const ack=c.host.pendingAcks.get('one');c.host.ackBeforeClose('one',ack.wcId,ack.operationId);await close
  assert.equal(c.f.saves,1);assert.equal(c.host.isHibernated('one'),false);assert.equal(c.host.pendingAcks.size,0)
  assert.equal(c.f.localReleases,1);await c.host.destroyAll()
})

test('unconfirmed native destruction waits resource cleanup and blocks orphan-producing reopen',async()=>{
  const c=await fixture();await loaded(c,'one');const old=c.host.getWebContents('one');c.f.closeStalled=true
  let release;const cleanup=new Promise(r=>release=r);c.getRuntimeScope('one').addDisposer(()=>cleanup)
  let completed=false;const close=c.host.closePlugin('one');const rejected=assert.rejects(close,/destruction not confirmed/).then(()=>{completed=true})
  await new Promise(r=>setTimeout(r,350));assert.equal(completed,false);assert.equal(c.host.getDiagnostics().retiring,1)
  release();await rejected;assert.equal(c.getRuntimeScope('one'),undefined)
  await assert.rejects(c.host.openPlugin('one'),/destruction is still pending/);assert.equal(c.f.views.length,1)
  assert.equal(c.f.clears,1, 'failed native destruction must still release the closed session')
  assert.equal(c.host.containers.has('one'),false)
  assert.equal(c.host.pendingEnter.has('one'),false)
  old.destroyed=true;old.emit('destroyed');assert.equal(c.host.getDiagnostics().retiring,0)
  c.f.closeStalled=false;await loaded(c,'one');await c.host.destroyAll()
})

test('container migration preserves runtime and does not replay consumed enter payload',async()=>{
  const c=await fixture();await c.host.openPlugin('one',{code:'edit',type:'regex',payload:{id:1}},{container:'quick'})
  const wc=c.host.getWebContents('one'),scope=c.getRuntimeScope('one');wc.emit('did-finish-load');await tick()
  c.host.pinToShell('one');assert.equal(c.host.getWebContents('one'),wc);assert.equal(c.getRuntimeScope('one'),scope)
  assert.equal(wc.loads,1);assert.equal(c.f.quickChildren.size,0);assert.equal(c.f.children.size,1)
  const entered=c.f.messages.filter(item=>item.msg.event==='enter').map(item=>item.msg)
  assert.deepEqual(entered[0].payload,{id:1});assert.equal(entered.at(-1).payload,undefined)
  assert.equal(entered[0].type,'regex');assert.equal(entered.at(-1).type,undefined)
  await c.host.destroyAll()
})

test('host-owned work protects background runtimes and release reapplies the alive limit',async()=>{
  const c=await fixture(),releases=[]
  for(let i=0;i<7;i++){await loaded(c,'work'+i);releases.push(c.acquirePluginActivity('work'+i,'transfer','active transfer'))}
  c.host.hideAllViews();c.host.enforceAliveLimit();await tick();assert.equal(c.host.getDiagnostics().entries.length,7)
  assert.equal(c.f.saves,0);releases[0]();await tick();await tick()
  assert.equal(c.host.isHibernated('work0'),true);assert.equal(c.host.getDiagnostics().entries.length,6)
  for(const release of releases)release()
  await c.host.destroyAll()
})

test('LRU does not subtract a retired suspension from the resident count twice',async()=>{
  const c=await fixture();let release;const cleanup=new Promise(r=>release=r)
  for(let i=0;i<8;i++){await loaded(c,'lru'+i);c.getRuntimeScope('lru'+i).addDisposer(()=>cleanup)}
  await tick();assert.ok(c.host.getDiagnostics().entries.length<=6)
  assert.equal(c.host.getDiagnostics().hibernated,2)
  release();await c.host.destroyAll()
})

test('switching ready tabs schedules idle hibernation without reaching the LRU limit', async t => {
  const c = await fixture()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await loaded(c, 'one'); await loaded(c, 'two')
  assert.equal(c.host.getState('one'), 'background')
  assert.equal(c.host.hibernateTimers.has('one'), true)
  t.mock.timers.tick(180000)
  await tick(); await tick()
  assert.equal(c.host.isHibernated('one'), true)
  assert.equal(c.host.getState('two'), 'active')
  await c.host.destroyAll()
})

test('hidden main window keeps tab selection, hibernates, and restores it on show', async () => {
  const c = await fixture()
  await loaded(c, 'one')
  c.host.setShellVisible(false)
  assert.equal(c.host.getActive(), 'one')
  assert.equal(c.host.getState('one'), 'background')
  assert.equal(c.host.hibernateTimers.has('one'), true)
  c.host.hibernatePlugin('one'); await tick(); await tick()
  assert.equal(c.host.isHibernated('one'), true)
  c.host.setShellVisible(true); await tick(); await tick()
  c.host.getWebContents('one').emit('did-finish-load')
  await tick()
  assert.equal(c.host.getState('one'), 'active')
  assert.equal(c.f.views.length, 2)
  c.host.setShellVisible(false)
  await loaded(c, 'two')
  assert.equal(c.host.getState('two'), 'background', 'loading while hidden must not reactivate')
  c.host.setShellVisible(true)
  assert.equal(c.host.getState('two'), 'active')
  await c.host.destroyAll()
})


test('shutdown clears checkpoints of hibernated Quick-only plugins', async () => {
  const c = await fixture()
  await c.host.openPlugin('quick-only', undefined, { container: 'quick' })
  c.host.getWebContents('quick-only').emit('did-finish-load'); await tick()
  c.host.dismissQuickPlugin('quick-only')
  c.host.hibernatePlugin('quick-only'); await tick(); await tick()
  assert.equal(c.host.isHibernated('quick-only'), true)
  assert.equal(c.host.logicalTabs.has('quick-only'), false)
  assert.equal(c.f.clears, 0)
  await c.host.destroyAll()
  assert.equal(c.f.clears, 1)
  assert.equal(c.host.getDiagnostics().hibernated, 0)
})


test('tab identity updates are bounded text, survive hibernation and migration, and clear on final close', async () => {
  const c = await fixture(), latest = () => c.f.events.filter(event => event.type === 'plugin-tabs').at(-1).tabs[0]
  try {
    await loaded(c, 'one')
    assert.equal(latest().icon, 'enest://plugin/one/assets/market/icon.svg')
    c.host.setTitle('one', 'Draft task'); c.host.setIcon('one', '✓'); c.host.setBadge('one', 7)
    assert.equal(latest().title, 'Draft task'); assert.equal(latest().glyph, '✓'); assert.equal(latest().icon, null); assert.equal(latest().badge, '7')
    for (const value of ['https://evil.test/icon.png', 'file:///tmp/icon.svg', 'enest://plugin/other/assets/a.svg', '/x', 'abc', '\n']) assert.throws(() => c.host.setIcon('one', value), /icon/)
    for (const value of [-1, NaN, 1.5, 1000000, '123456789', {}]) assert.throws(() => c.host.setBadge('one', value), /badge/)
    assert.throws(() => c.host.setTitle('one', 'x'.repeat(121)), /title/)
    c.host.hideAllViews(); c.host.hibernatePlugin('one'); await tick(); await tick()
    assert.equal(latest().status, 'hibernated'); assert.equal(latest().title, 'Draft task'); assert.equal(latest().glyph, '✓'); assert.equal(latest().badge, '7')
    await loaded(c, 'one')
    assert.equal(latest().title, 'Draft task'); assert.equal(latest().icon, null)
    await c.host.openPlugin('one', undefined, { container: 'quick' })
    c.host.setTitle('one', 'Quick draft'); c.host.setBadge('one', 'OK')
    await c.host.openPlugin('one')
    assert.equal(latest().title, 'Quick draft'); assert.equal(latest().badge, 'OK'); assert.equal(latest().glyph, '✓')
    c.host.setIcon('one', ''); c.host.setTitle('one', ''); c.host.setBadge('one', '')
    assert.equal(latest().icon, 'enest://plugin/one/assets/market/icon.svg'); assert.equal(latest().title, 'one'); assert.equal(latest().badge, '')
    c.host.setTitle('one', 'Transient'); c.host.setIcon('one', 'X'); c.host.setBadge('one', 9)
    await c.host.closePlugin('one'); await loaded(c, 'one')
    assert.equal(latest().title, 'one'); assert.equal(latest().icon, 'enest://plugin/one/assets/market/icon.svg'); assert.equal(latest().badge, '')
  } finally { await c.host.destroyAll() }
})

test('detach retains layout and runtime while dock switches layout and preserves tab order', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'a'); await loaded(c, 'b')
    const wc = c.host.getWebContents('a'), scope = c.getRuntimeScope('a')
    const id = c.host.entries.get('a').tabSessionId
    await c.host.detachPlugin('a', { x: 50, y: 80 })
    assert.equal(c.host.getPlacement('a').kind, 'detached')
    assert.equal(c.host.getLayoutMode('a'), 'shell')
    assert.equal(c.host.hasShellTab('a'), false)
    assert.equal(c.host.getWebContents('a'), wc)
    assert.equal(c.getRuntimeScope('a'), scope)
    assert.equal(c.f.views.length, 2)
    assert.equal(wc.loads, 1)
    assert.equal(c.f.detached.get('a').children.size, 1)
    assert.equal(c.host.getActive(), 'b')
    await c.host.openPlugin('a', undefined, { container: 'quick' })
    assert.equal(c.host.getPlacement('a').kind, 'detached', 'ordinary launch focuses detached instance')
    await c.host.dockPlugin('a', 'quick')
    assert.equal(c.host.getPlacement('a').kind, 'quick')
    assert.equal(c.host.getLayoutMode('a'), 'quick')
    assert.equal(c.f.detached.size, 0)
    await c.host.detachPlugin('a')
    assert.equal(c.host.getLayoutMode('a'), 'quick')
    assert.equal(c.host.isQuickInputOwner('a'), true)
    await c.host.dockPlugin('a', 'shell', 0)
    assert.deepEqual([...c.host.logicalTabs.keys()], ['a', 'b'])
    assert.equal(c.host.getLayoutMode('a'), 'shell')
    assert.equal(c.host.getWebContents('a'), wc)
    assert.equal(c.host.entries.get('a').tabSessionId, id)
    assert.equal(scope.signal.aborted, false)
    assert.equal(c.f.detached.size, 0)
    assert.equal(c.f.messages.filter(({ msg }) => msg.type === 'mode-change').length, 2)
  } finally { await c.host.destroyAll() }
})

test('shell selection and layout never hide or resize a visible independent plugin', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one'); await c.host.detachPlugin('one')
    const view = c.host.entries.get('one').view, bounds = { ...view.bounds }
    await loaded(c, 'two')
    c.host.hideAllViews(); c.host.layoutAll(); c.host.setShellVisible(false)
    assert.equal(view.visible, true)
    assert.deepEqual(view.bounds, bounds)
    c.host.enforceAliveLimit(); c.host.hibernatePlugin('one'); await tick()
    assert.equal(c.host.isOpened('one'), true)
    assert.equal(c.host.getState('one'), 'active')
    c.host.setDetachedVisible('one', false)
    assert.equal(view.visible, false)
    assert.equal(c.host.getState('one'), 'background')
    c.host.hibernatePlugin('one'); await tick(); await tick()
    assert.equal(c.host.isHibernated('one'), true)
    assert.equal(c.host.getPlacement('one').kind, 'detached')
    assert.equal(c.f.detached.size, 1)
    c.host.setDetachedVisible('one', true); await tick(); await tick()
    assert.equal(c.host.isOpened('one'), true)
    assert.equal(c.host.getPlacement('one').kind, 'detached')
    assert.equal(c.f.detached.get('one').children.size, 1)
    assert.equal(c.f.children.size, 1)
  } finally { await c.host.destroyAll() }
})

test('a native dialog prevents relocation and its release permits relocation', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one')
    const release = c.host.acquireWindowInteraction('one')
    assert.equal(c.host.hasWindowInteraction('one'), true)
    await assert.rejects(c.host.detachPlugin('one'), /native dialog/)
    assert.equal(c.f.detached.size, 0)
    release(); release()
    assert.equal(c.host.hasWindowInteraction('one'), false)
    await c.host.detachPlugin('one')
    const done = c.host.acquireWindowInteraction('one')
    await assert.rejects(c.host.dockPlugin('one', 'shell'), /native dialog/)
    await c.host.closePlugin('one')
    assert.equal(c.host.hasWindowInteraction('one'), false)
    done()
    assert.equal(c.f.detached.size, 0)
  } finally { await c.host.destroyAll() }
})

test('close racing native window creation cancels relocation without leaking a window', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one')
    let release
    c.f.detachedGate = new Promise(resolve => { release = resolve })
    const moved = c.host.detachPlugin('one')
    await tick()
    await c.host.closePlugin('one')
    release()
    await assert.rejects(moved, /cancelled/)
    assert.equal(c.f.detached.size, 0)
    assert.equal(c.f.children.size, 0)
    assert.equal(c.host.isOpened('one'), false)
  } finally { await c.host.destroyAll() }
})

test('attachment failure restores source bounds, placement, and renderer ownership', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one')
    const view = c.host.entries.get('one').view, bounds = { ...view.bounds }, revision = c.host.getPlacementRevision('one')
    c.f.detachedFailAttach = true
    await assert.rejects(c.host.detachPlugin('one'), /attach failed/)
    assert.equal(c.host.getPlacement('one').kind, 'shell')
    assert.equal(c.host.getPlacementRevision('one'), revision)
    assert.equal(c.f.children.has(view), true)
    assert.equal(c.f.detached.size, 0)
    assert.deepEqual(view.bounds, bounds)
    assert.equal(c.getRuntimeScope('one').signal.aborted, false)
  } finally { await c.host.destroyAll() }
})

test('detached reload and crash recovery retain the native window, final close destroys it', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one'); await c.host.detachPlugin('one')
    const win = c.f.detached.get('one').win, oldWc = c.host.getWebContents('one')
    c.host.reloadPlugin('one'); await tick(); await tick()
    await c.host.openPlugin('one')
    assert.equal(c.f.detached.get('one').win, win)
    assert.notEqual(c.host.getWebContents('one'), oldWc)
    const wc = c.host.getWebContents('one')
    wc.emit('did-finish-load'); wc.emit('render-process-gone', {}, { reason: 'crashed' }); await tick(); await tick()
    assert.equal(c.host.getDetachedState('one').status, 'error')
    assert.equal(c.f.detached.get('one').children.size, 0)
    await c.host.openPlugin('one')
    assert.equal(c.f.detached.get('one').win, win)
    assert.equal(c.f.detached.get('one').children.size, 1)
    await c.host.closePlugin('one')
    assert.equal(c.f.detached.size, 0)
    assert.equal(c.host.getDetachedState('one'), null)
  } finally { await c.host.destroyAll() }
})

test('main-owned session includes detached windows and freezes before app cleanup', async () => {
  const c = await fixture()
  await loaded(c, 'one'); await loaded(c, 'two')
  await c.host.detachPlugin('two')
  c.host.prepareSessionShutdown()
  const session = c.f.persisted.at(-1).general
  assert.deepEqual(session.sessionTabs.map(tab => tab.pluginId), ['one', 'two'])
  assert.equal(session.sessionActivePluginId, 'two')
  await c.host.destroyAll()
  assert.deepEqual(c.f.persisted.at(-1).general, session)
  assert.equal(c.f.detached.size, 0)
})

test('compact input survives detach and unrelated Quick resets, then clears only on shell docking', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'shell-next')
    await c.host.openPlugin('mini', undefined, { container: 'quick' })
    c.host.getWebContents('mini').emit('did-finish-load'); await tick()
    c.configureQuickInput('mini', { value: 'retained query', placeholder: 'Find' })
    const scope = c.getRuntimeScope('mini')
    await c.host.detachPlugin('mini')
    assert.equal(c.host.getDetachedState('mini').input.value, 'retained query')
    c.host.activatePlugin('shell-next')
    await c.host.openPlugin('other-mini', undefined, { container: 'quick' })
    c.host.getWebContents('other-mini').emit('did-finish-load'); await tick()
    c.configureQuickInput('other-mini', { value: 'other query' })
    c.host.onQuickHidden()
    assert.equal(c.getQuickInputState('mini').value, 'retained query')
    assert.equal(c.getQuickInputState('other-mini'), null)
    assert.equal(c.getRuntimeScope('mini'), scope)
    let prevented = false
    const focusBefore = c.host.getWebContents('mini').focusCalls ?? 0
    c.host.getWebContents('mini').emit('before-input-event', { preventDefault() { prevented = true } }, { type: 'keyDown', key: 'Escape' })
    assert.equal(prevented, true)
    assert.equal(c.host.getPlacement('mini').kind, 'detached')
    assert.equal(c.getQuickInputState('mini').value, '')
    assert.equal(c.host.getWebContents('mini').focusCalls, focusBefore + 1)
    c.configureQuickInput('mini', { value: 'retained query' })
    await loaded(c, 'independent-watcher'); await c.host.detachPlugin('independent-watcher')
    await c.host.openPlugin('other-mini', undefined, { container: 'quick' })
    c.configureQuickInput('other-mini', { value: 'replaced query' })
    await c.host.dockPlugin('mini', 'quick')
    assert.equal(c.getQuickInputState('mini').value, 'retained query', 'publishing another detached state during docking must not prune this owner')
    assert.equal(c.host.getState('other-mini'), 'background')
    assert.equal(c.getQuickInputState('other-mini'), null)
    await c.host.detachPlugin('mini')
    await c.host.dockPlugin('mini', 'shell')
    assert.equal(c.getQuickInputState('mini'), null)
  } finally { await c.host.destroyAll() }
})

test('a stale external drop guard cannot commit after native window preparation', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one')
    let release, allowed = true
    c.f.detachedGate = new Promise(resolve => { release = resolve })
    const moving = c.host.detachPlugin('one', undefined, () => allowed)
    await tick(); allowed = false; release()
    await assert.rejects(moving, /cancelled/)
    assert.equal(c.host.getPlacement('one').kind, 'shell')
    assert.equal(c.f.children.size, 1)
    assert.equal(c.f.detached.size, 0)
    await assert.rejects(c.host.dockPlugin('one', 'quick', undefined, () => false), /cancelled/)
    assert.equal(c.host.getPlacement('one').kind, 'shell')
  } finally { await c.host.destroyAll() }
})

test('shell reorder persists shell order with detached sessions between its slots', async () => {
  const c = await fixture()
  try {
    for (const id of ['a', 'b', 'c', 'd']) await loaded(c, id)
    await c.host.detachPlugin('b')
    c.host.reorderPlugin('d', 1)
    c.host.prepareSessionShutdown()
    assert.deepEqual([...c.host.logicalTabs.keys()], ['a', 'd', 'c'])
    assert.deepEqual(c.f.persisted.at(-1).general.sessionTabs.map(tab => tab.pluginId), ['a', 'b', 'd', 'c'])
  } finally { await c.host.destroyAll() }
})

test('true close during detached reload removes window and prevents its reopening', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one'); await c.host.detachPlugin('one')
    let release
    c.f.codeCacheGate = new Promise(resolve => { release = resolve })
    c.host.reloadPlugin('one'); await tick(); await tick()
    await c.host.closePlugin('one')
    release(); await tick(); await tick()
    assert.equal(c.f.detached.size, 0)
    assert.equal(c.host.isOpened('one'), false)
  } finally { await c.host.destroyAll() }
})

test('Quick docking prepares before migration and presents the reused renderer only after commit', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one'); await c.host.detachPlugin('one')
    const wc = c.host.getWebContents('one')
    let release
    c.f.quickPrepareGate = new Promise(resolve => { release = resolve })
    const docking = c.host.dockPlugin('one', 'quick')
    await tick()
    assert.equal(c.f.quickPrepared, 1)
    assert.equal(c.f.quickPresented, 0)
    assert.equal(c.host.getPlacement('one').kind, 'detached')
    assert.equal(c.f.detached.size, 1)
    release(); await docking
    assert.equal(c.f.quickPresented, 1)
    assert.equal(c.host.getPlacement('one').kind, 'quick')
    assert.equal(c.host.getQuickPlugin(), 'one')
    assert.equal(c.host.getWebContents('one'), wc)
    assert.equal(c.f.detached.size, 0)
  } finally { await c.host.destroyAll() }
})

test('cancelled Quick preparation preserves both the independent source and existing Quick owner', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one'); await c.host.detachPlugin('one')
    await c.host.openPlugin('current', undefined, { container: 'quick' })
    const wc = c.host.getWebContents('one')
    let release, allowed = true
    c.f.quickPrepareGate = new Promise(resolve => { release = resolve })
    const docking = c.host.dockPlugin('one', 'quick', undefined, () => allowed)
    await tick(); allowed = false; release()
    await assert.rejects(docking, /cancelled/)
    assert.equal(c.f.quickPresented, 0)
    assert.equal(c.host.getPlacement('one').kind, 'detached')
    assert.equal(c.host.getQuickPlugin(), 'current')
    assert.equal(c.host.getWebContents('one'), wc)
    assert.equal(c.f.detached.size, 1)
  } finally { await c.host.destroyAll() }
})

test('native modal locks apply to every plugin sharing the source or target window', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one'); await loaded(c, 'two')
    const releaseShell = c.host.acquireWindowInteraction('one')
    assert.equal(c.host.hasWindowInteraction('two'), true)
    await assert.rejects(c.host.detachPlugin('two'), /native dialog/)
    releaseShell(); await c.host.detachPlugin('two')
    const lockShell = c.host.acquireWindowInteraction('one')
    await assert.rejects(c.host.dockPlugin('two', 'shell'), /native dialog/)
    lockShell()
    await c.host.openPlugin('mini', undefined, { container: 'quick' })
    let release
    c.f.quickPrepareGate = new Promise(resolve => { release = resolve })
    const docking = c.host.dockPlugin('two', 'quick')
    await tick()
    const lockQuick = c.host.acquireWindowInteraction('mini')
    release(); await assert.rejects(docking, /cancelled/)
    assert.equal(c.host.getPlacement('two').kind, 'detached')
    assert.equal(c.host.getQuickPlugin(), 'mini')
    assert.equal(c.f.quickPresented, 0)
    lockQuick(); await c.host.dockPlugin('two', 'quick')
    assert.equal(c.host.getQuickPlugin(), 'two')
  } finally { await c.host.destroyAll() }
})

test('Quick presentation failure cannot migrate or destroy an independent source window', async () => {
  const c = await fixture()
  try {
    await loaded(c, 'one'); await c.host.detachPlugin('one')
    const wc = c.host.getWebContents('one'), scope = c.getRuntimeScope('one')
    const revision = c.host.getPlacementRevision('one')
    c.f.quickPresentFail = true
    await assert.rejects(c.host.dockPlugin('one', 'quick'), /could not be presented/)
    assert.equal(c.host.getPlacement('one').kind, 'detached')
    assert.equal(c.host.getLayoutMode('one'), 'shell')
    assert.equal(c.host.getPlacementRevision('one'), revision)
    assert.equal(c.f.detached.size, 1)
    assert.equal(c.f.quickChildren.size, 0)
    assert.equal(c.host.getWebContents('one'), wc)
    assert.equal(c.getRuntimeScope('one'), scope)
  } finally { await c.host.destroyAll() }
})

const restoredWindow = (mode = 'shell', x = 100) => ({ mode, bounds: { x, y: 90, width: 720, height: 580 }, maximized: false, minimized: false, alwaysOnTop: true })
function savedWindows(c, ids) {
  c.f.savedGeneral = { sessionTabs: ids.map((pluginId, index) => ({ pluginId, title: pluginId, detached: restoredWindow(index % 2 ? 'quick' : 'shell', index * 80) })), sessionActivePluginId: ids[0] }
}

test('restart restores independent geometry and layout with no plugin runtimes until explicit activation', async () => {
  const c = await fixture()
  try {
    savedWindows(c, ['desk', 'mini'])
    c.f.savedGeneral.sessionTabs.push({ pluginId: 'shell-tab' })
    await c.host.restoreTabs(['desk', 'mini', 'shell-tab'])
    assert.equal(c.f.views.length, 0)
    assert.equal(c.getRuntimeScope('desk'), undefined)
    assert.equal(c.getRuntimeScope('mini'), undefined)
    assert.equal(c.host.getActive(), null)
    assert.deepEqual([...c.host.logicalTabs.keys()], ['shell-tab'])
    for (const id of ['desk', 'mini']) {
      assert.equal(c.host.getDetachedState(id).status, 'lazy')
      assert.equal(c.host.getDetachedState(id).generation, 0)
      assert.equal(c.host.getDetachedState(id).alwaysOnTop, true)
      assert.equal(c.f.detached.get(id).win.visible, true)
    }
    assert.equal(c.host.getLayoutMode('mini'), 'quick')
    const miniWindow = c.f.detached.get('mini').win
    c.host.setDetachedVisible('mini', false); c.host.setDetachedVisible('mini', true)
    await tick()
    assert.equal(c.f.views.length, 0, 'restore/show/minimize events must not activate a lazy runtime')
    await c.host.restoreTabs(['desk', 'mini', 'shell-tab'])
    assert.equal(c.f.detachedCreates.length, 2)
    await Promise.all([c.host.activateDetachedPlugin('mini'), c.host.openPlugin('mini', undefined, { container: 'shell' })])
    assert.equal(c.f.views.length, 1)
    assert.equal(c.f.detached.get('mini').win, miniWindow)
    assert.equal(c.host.getLayoutMode('mini'), 'quick')
    assert.equal(c.host.getDetachedState('mini').status, 'loading')
    c.host.getWebContents('mini').emit('did-finish-load'); await tick()
    assert.equal(c.host.getDetachedState('mini').status, 'ready')
    assert.equal(c.host.getDetachedState('desk').status, 'lazy')
  } finally { await c.host.destroyAll() }
})

test('docking an unloaded independent window to shell remains lazy; Quick docking explicitly opens it', async () => {
  const c = await fixture()
  try {
    savedWindows(c, ['desk', 'mini'])
    await c.host.restoreTabs(['desk', 'mini'])
    await c.host.dockPlugin('desk', 'shell', 0)
    assert.equal(c.f.views.length, 0)
    assert.equal(c.host.hasShellTab('desk'), true)
    assert.equal(c.host.getActive(), null)
    assert.equal(c.f.detached.has('desk'), false)
    assert.equal(c.host.windowSession.get('desk').detached, undefined)
    await c.host.dockPlugin('mini', 'quick')
    assert.equal(c.f.views.length, 1)
    assert.equal(c.host.getQuickPlugin(), 'mini')
    assert.equal(c.host.windowSession.get('mini').detached, undefined)
    c.host.activatePlugin('desk'); await tick(); await tick()
    assert.equal(c.f.views.length, 2)
    assert.equal(c.host.getLayoutMode('desk'), 'shell')
  } finally { await c.host.destroyAll() }
})

test('independent restore has two chrome workers and stale repeat IPC cannot reopen closed items', async () => {
  const c = await fixture(), release = new Map()
  try {
    const ids = ['a', 'b', 'c', 'd', 'e']; savedWindows(c, ids)
    for (const id of ids) c.f.detachedCreateGates.set(id, new Promise(resolve => release.set(id, resolve)))
    const first = c.host.restoreTabs(ids), duplicate = c.host.restoreTabs(ids)
    await tick()
    assert.equal(c.f.detachedCreating, 2)
    assert.deepEqual(c.f.detachedCreates.map(item => item.id), ['a', 'b'])
    await c.host.closePlugin('a'); await c.host.closePlugin('c')
    release.get('a')(); release.get('b')(); await tick(); await tick()
    assert.deepEqual(c.f.detachedCreates.map(item => item.id), ['a', 'b', 'd', 'e'])
    release.get('d')(); release.get('e')(); await Promise.all([first, duplicate])
    assert.equal(c.f.detachedMaxCreating, 2)
    assert.equal(c.f.views.length, 0)
    assert.deepEqual([...c.f.detached.keys()], ['b', 'd', 'e'])
    await c.host.restoreTabs(ids)
    assert.equal(c.f.detachedCreates.length, 4)
    assert.equal(c.host.windowSession.get('a'), undefined)
    assert.equal(c.host.windowSession.get('c'), undefined)
  } finally { for (const done of release.values()) done(); await c.host.destroyAll() }
})

test('shutdown during restoration preserves every queued window history without starting plugin processes', async () => {
  const c = await fixture()
  let release
  try {
    const ids = ['a', 'b', 'c', 'd']; savedWindows(c, ids)
    const saved = structuredClone(c.f.savedGeneral.sessionTabs)
    c.f.detachedGate = new Promise(resolve => { release = resolve })
    const restoring = c.host.restoreTabs(ids)
    await tick(); c.host.prepareSessionShutdown()
    const shutting = c.host.destroyAll()
    release(); await Promise.all([restoring, shutting])
    assert.deepEqual((c.f.persisted.at(-1)?.general ?? c.f.savedGeneral).sessionTabs, saved)
    assert.equal(c.f.detached.size, 0)
    assert.equal(c.f.views.length, 0)
    assert.equal(c.f.detachedCreates.length, 2)
    assert.equal(c.f.messages.some(({ msg }) => msg.event === 'beforeClose'), false)
  } finally { release?.(); await c.host.destroyAll() }
})

test('close cancels an explicit activation waiting for native restore; uninstall also cancels queued restore', async () => {
  const c = await fixture()
  let release
  try {
    savedWindows(c, ['a', 'b', 'c'])
    c.f.detachedGate = new Promise(resolve => { release = resolve })
    const restoring = c.host.restoreTabs(['a', 'b', 'c'])
    const activation = c.host.openPlugin('a'), rejected = assert.rejects(activation, /restoration cancelled/)
    await c.host.closePlugin('a')
    c.host.beginUninstall('c'); c.host.finishUninstall('c')
    release(); await restoring; await rejected
    assert.equal(c.f.views.length, 0)
    assert.deepEqual([...c.f.detached.keys()], ['b'])
    assert.equal(c.host.windowSession.get('a'), undefined)
    assert.equal(c.host.windowSession.get('c'), undefined)
  } finally { release?.(); await c.host.destroyAll() }
})

test('shutdown captures latest native geometry and closing an unloaded window removes its saved history', async () => {
  const c = await fixture()
  try {
    savedWindows(c, ['a', 'b'])
    await c.host.restoreTabs(['a', 'b'])
    await c.host.closePlugin('a')
    assert.equal(c.f.messages.some(({ msg }) => msg.event === 'beforeClose'), false)
    const latest = { ...restoredWindow('quick', -880), maximized: true, minimized: true, alwaysOnTop: false }
    c.f.detached.get('b').history = latest
    c.host.prepareSessionShutdown()
    assert.deepEqual(c.f.persisted.at(-1).general.sessionTabs, [{ pluginId: 'b', title: 'b', detached: latest }])
  } finally { await c.host.destroyAll() }
})

test('invalid history restores a lazy shell tab while unavailable plugins are removed', async () => {
  const c = await fixture()
  try {
    savedWindows(c, ['invalid', 'missing'])
    c.f.savedGeneral.sessionTabs[0].detached.bounds.width = NaN
    c.f.uninstalled = new Set(['missing'])
    await c.host.restoreTabs(['invalid', 'missing'])
    assert.deepEqual([...c.host.logicalTabs.keys()], ['invalid'])
    assert.equal(c.f.views.length, 0)
    assert.equal(c.f.detachedCreates.length, 0)
    assert.equal(c.host.windowSession.get('invalid').detached, undefined)
    assert.equal(c.host.windowSession.get('missing'), undefined)
  } finally { await c.host.destroyAll() }
})

test('closing before renderer hydration prevents its stale first restore IPC from recreating a tab', async () => {
  const c = await fixture()
  try {
    savedWindows(c, ['already-closed'])
    await c.host.closePlugin('already-closed')
    await c.host.restoreTabs(['already-closed'])
    assert.equal(c.f.detachedCreates.length, 0)
    assert.equal(c.host.hasShellTab('already-closed'), false)
    assert.equal(c.host.windowSession.get('already-closed'), undefined)
  } finally { await c.host.destroyAll() }
})

test('docking waits for an activating lazy window before migrating its one renderer', async () => {
  const c = await fixture()
  let release
  try {
    savedWindows(c, ['one']); c.f.savedGeneral.sessionTabs[0].detached.mode = 'quick'
    await c.host.restoreTabs(['one'])
    const independent = c.f.detached.get('one').win
    c.f.proxyGate = new Promise(resolve => { release = resolve })
    const opening = c.host.openPlugin('one')
    await tick()
    assert.equal(c.host.getDetachedState('one').status, 'loading')
    assert.equal(c.host.getDiagnostics().opening, 1)
    assert.equal(c.f.views.length, 0)
    const docking = c.host.dockPlugin('one', 'shell')
    await tick()
    assert.equal(c.f.detached.get('one').win, independent)
    assert.equal(c.host.hasShellTab('one'), false)
    release(); await Promise.all([opening, docking])
    assert.equal(c.f.views.length, 1)
    assert.equal(c.host.getPlacement('one').kind, 'shell')
    assert.equal(c.host.getLayoutMode('one'), 'shell')
    assert.equal(c.host.isOpened('one'), true)
    assert.equal(c.f.detached.size, 0)
    const wc = c.host.getWebContents('one')
    assert.equal(wc.loads, 1)
    wc.emit('did-finish-load'); await tick()
    assert.equal(c.host.getState('one'), 'active')
    assert.equal(c.host.getDiagnostics().opening, 0)
  } finally { release?.(); await c.host.destroyAll() }
})

test('a queued lazy dock rechecks activation begun while an earlier transfer was pending', async () => {
  const c = await fixture()
  let releaseTransfer, releaseProxy
  try {
    savedWindows(c, ['one']); await c.host.restoreTabs(['one'])
    const previous = c.host.transfer('one', () => new Promise(resolve => { releaseTransfer = resolve }))
    await tick()
    const docking = c.host.dockPlugin('one', 'shell')
    c.f.proxyGate = new Promise(resolve => { releaseProxy = resolve })
    const opening = c.host.openPlugin('one')
    await tick(); releaseTransfer(); await previous; await tick()
    assert.equal(c.f.detached.has('one'), true)
    assert.equal(c.host.hasShellTab('one'), false)
    assert.equal(c.f.views.length, 0)
    releaseProxy(); await Promise.all([opening, docking])
    assert.equal(c.host.getPlacement('one').kind, 'shell')
    assert.equal(c.host.getDiagnostics().entries.length, 1)
    assert.equal(c.f.views.length, 1)
  } finally { releaseTransfer?.(); releaseProxy?.(); await c.host.destroyAll() }
})

test('close and uninstall cancel a dock waiting for activation without reopening a runtime', async () => {
  for (const uninstall of [false, true]) {
    const c = await fixture()
    let release
    try {
      savedWindows(c, ['one']); await c.host.restoreTabs(['one'])
      c.f.proxyGate = new Promise(resolve => { release = resolve })
      const opening = c.host.openPlugin('one'), rejectedOpen = assert.rejects(opening, /cancelled/)
      await tick()
      const docking = c.host.dockPlugin('one', 'shell'), rejectedDock = assert.rejects(docking, /cancelled/)
      await tick()
      const unblock = uninstall ? c.host.blockPlugin('one') : () => {}
      await c.host.closePlugin('one', uninstall ? 'uninstall' : 'tab-close')
      if (uninstall) { c.host.beginUninstall('one'); c.host.finishUninstall('one') }
      release(); await Promise.all([rejectedOpen, rejectedDock]); unblock()
      assert.equal(c.f.views.length, 0)
      assert.equal(c.f.detached.size, 0)
      assert.equal(c.host.hasShellTab('one'), false)
      assert.equal(c.host.getDiagnostics().opening, 0)
      assert.equal(c.host.getDiagnostics().entries.length, 0)
      assert.equal(c.host.windowSession.get('one'), undefined)
    } finally { release?.(); await c.host.destroyAll() }
  }
})

test('a lazy dock queued before close cannot migrate a replacement instance', async () => {
  const c = await fixture()
  let release
  try {
    savedWindows(c, ['one']); await c.host.restoreTabs(['one'])
    const previous = c.host.transfer('one', () => new Promise(resolve => { release = resolve }))
    await tick()
    const docking = c.host.dockPlugin('one', 'quick'), rejected = assert.rejects(docking, /cancelled/)
    await c.host.closePlugin('one')
    await loaded(c, 'one')
    const replacement = c.host.getWebContents('one')
    release(); await previous; await rejected
    assert.equal(c.host.getPlacement('one').kind, 'shell')
    assert.equal(c.host.getWebContents('one'), replacement)
    assert.equal(c.f.quickPrepared, 0)
    assert.equal(c.f.views.length, 1)
  } finally { release?.(); await c.host.destroyAll() }
})


test('native plugin surfaces stay hidden until load and theme finish, including activation during startup', async () => {
  const c = await fixture()
  let releaseTheme
  c.f.themeGate = new Promise(resolve => { releaseTheme = resolve })
  try {
    await c.host.openPlugin('one')
    const view = c.f.views[0]
    assert.equal(view.visible, false, 'a blank native surface must not cover the shell loading state')
    c.host.activatePlugin('one')
    assert.equal(view.visible, false)
    view.webContents.emit('did-finish-load')
    await tick()
    assert.equal(c.host.getState('one'), 'opening')
    assert.equal(view.visible, false, 'theme hydration completes before presentation')
    c.host.hideAllViews()
    releaseTheme(); await tick()
    assert.equal(c.host.getState('one'), 'background')
    assert.equal(view.visible, false, 'finishing a hidden plugin must not cover settings')
    c.host.activatePlugin('one')
    assert.equal(view.visible, true)
  } finally { releaseTheme(); await c.host.destroyAll() }
})

test('DevTools opens or wakes the requested runtime instead of silently ignoring missing entries', async () => {
  const c = await fixture()
  try {
    await c.host.openDevTools('t-one')
    const first = c.host.getWebContents('one')
    assert.equal(first.devToolsCalls, 1)
    assert.deepEqual(first.devToolsOptions, { mode: 'detach', activate: true })
    await c.host.openDevTools('one')
    assert.equal(first.devToolsCalls, 2)
    assert.equal(c.f.views.length, 1)
    await c.host.closePlugin('one')
    await c.host.openDevTools('one')
    assert.notEqual(c.host.getWebContents('one').id, first.id)
    assert.equal(c.host.getWebContents('one').devToolsCalls, 1)
  } finally { await c.host.destroyAll() }
})


test('published active tab IDs match the renderer tab records while loading and ready', async () => {
  const c = await fixture()
  try {
    await c.host.openPlugin('one')
    const loading = c.f.events.filter(event => event.type === 'plugin-tabs').at(-1)
    assert.equal(loading.activeTabId, 't-one')
    assert.equal(loading.tabs.find(tab => tab.id === loading.activeTabId).status, 'loading')
    c.host.getWebContents('one').emit('did-finish-load'); await tick()
    const ready = c.f.events.filter(event => event.type === 'plugin-tabs').at(-1)
    assert.equal(ready.activeTabId, 't-one')
    assert.equal(ready.tabs.find(tab => tab.id === ready.activeTabId).status, 'ready')
  } finally { await c.host.destroyAll() }
})

test('development reload rechecks source entry before replacing its runtime and retains source identity', async () => {
  const c = await fixture()
  let release
  try {
    c.f.devSummary = { id: 'one', dev: true, sourcePath: '/source/one', rootPath: '/source/one/dist' }
    await loaded(c, 'one')
    const original = c.host.getWebContents('one')
    c.f.prepareDevGate = new Promise(resolve => { release = resolve })
    c.f.preparedDev = { summary: { ...c.f.devSummary, rootPath: '/source/one', devUrl: 'http://127.0.0.1:7777/', devSource: true }, manifest: { id: 'one', main: 'index.html' } }
    c.host.reloadPlugin('one')
    const reloading = c.host.reloading.get('one').promise
    await tick()
    assert.equal(c.host.getWebContents('one'), original, 'entry discovery does not destroy a working renderer')
    release(); await reloading
    assert.equal(c.f.devRegistrations, 1)
    assert.equal(c.f.devSummary.sourcePath, '/source/one')
    assert.equal(c.f.devSummary.devUrl, 'http://127.0.0.1:7777/')
    assert.notEqual(c.host.getWebContents('one').id, original.id)
    assert.equal(c.host.getPlacement('one').kind, 'shell')
  } finally { release?.(); await c.host.destroyAll() }
})
