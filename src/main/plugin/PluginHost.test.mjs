import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'fixture': `export const f = { views: [], events: [], messages: [], gate: null, host: null, ack: true, snapshot: true, saves: 0, releases: 0, memoryReleases:0, localReleases:0, clears:0, codeClears:0, codeCacheGate:null, codeCacheFail:false, releaseGate:null, closeStalled:false, firstInstall:false, installHooks:null, children: new Set(), quickChildren: new Set(), quickWindowChildren: new Set(), quickFocus:0, quickReveals:0, quickRevealFinishes:0 };`,
  electron: `import {EventEmitter} from 'node:events'; import {f} from 'fixture';
    let seq=0;
    class WC extends EventEmitter {
      id=++seq; destroyed=false; loads=0;
      loadURL(){this.loads++;return Promise.resolve()}; isDestroyed(){return this.destroyed};
      send(channel,msg){ f.messages.push({channel,msg}); if(msg.event==='beforeClose'||msg.event==='beforeSuspend') {if(f.ack) queueMicrotask(()=>f.host.ackBeforeClose(f.host.getPluginIdByWebContentsId(this.id),this.id,msg.operationId));} };
      setWindowOpenHandler(){}; executeJavaScript(){return Promise.resolve()}; focus(){};
      close(){if(f.closeStalled)return;this.destroyed=true;this.emit('destroyed')};
    }
    export class WebContentsView { webContents=new WC(); visible=true; constructor(){f.views.push(this);this.webContents.once('destroyed',()=>{this.webContents=undefined})};setVisible(v){this.visible=v};setBorderRadius(){};setBackgroundColor(){};setBounds(){} }
    export const nativeTheme=new EventEmitter(); export const session={fromPartition:()=>({})};`,
  '@main/window/createShellWindow': `import {f} from 'fixture'; export const getMainWindow=()=>({isDestroyed:()=>false,isMinimized:()=>false,show(){},focus(){},contentView:{addChildView:v=>f.children.add(v),removeChildView:v=>f.children.delete(v)}}); export const getPluginContentBounds=()=>({}); export const resolvePreload=x=>x; export const sendShellEvent=e=>f.events.push(e);`,
  '@main/window/createQuickWindow': `
    import {f} from 'fixture';
    const surface={addChildView:v=>f.quickChildren.add(v),removeChildView:v=>f.quickChildren.delete(v)};
    const win={contentView:{addChildView:v=>f.quickWindowChildren.add(v),removeChildView:v=>f.quickWindowChildren.delete(v)}};
    const wc={isDestroyed:()=>false,focus:()=>{f.quickFocus++}};
    export const getQuickWindow=()=>win; export const ensureQuickWindow=()=>win;
    export const getQuickPluginParent=()=>surface;
    export const revealQuickPlugin=()=>{f.quickReveals++};
    export const finishQuickPluginReveal=()=>{f.quickRevealFinishes++};
    export const getQuickPluginBounds=()=>({}); export const getQuickWebContents=()=>wc;
    export const setQuickContentSize=()=>{}; export const hideQuickWindow=()=>{};
    export const setQuickPluginHiddenHook=()=>{}; export const setQuickPluginRelayout=()=>{}; export const setQuickPluginResetHook=()=>{};
  `,
  '@main/plugin/localFiles': `import {f} from 'fixture'; export const releaseLocalFiles=()=>{f.localReleases++};`,
  '@main/window/orbRailViews': `export const raiseOrbRailViews=()=>{};`,
  '@main/logs/logService': `export const logInfo=()=>{}; export const logWarn=()=>{};`,
  '@main/plugin/PluginSessionStore': `import {f} from 'fixture'; export const clearPluginSession=()=>{f.clears++}; export const releaseSessionMemory=()=>{f.memoryReleases++}; export const deleteSessionSnapshot=()=>{}; export const loadSessionSnapshot=()=>true; export const saveSessionSnapshot=()=>{f.saves++;return f.snapshot}; export const getSessionRevision=()=>0;`,
  '@main/plugin/PluginRegistry': `import {f} from 'fixture'; export const pluginRegistry={ensureInstalled:async id=>{if(f.gate)await f.gate;if(f.firstInstall){const release=await f.installHooks.beforeReplace(id);try{await f.installHooks.afterReplace(id,'/fixture/'+id)}finally{release?.()}f.firstInstall=false}return {id,name:id,rootPath:'/fixture/'+id}},get:id=>({id,name:id,icon:'enest://plugin/'+id+'/assets/market/icon.svg',glyph:'P',color:'#257',rootPath:f.firstInstall?undefined:'/fixture/'+id}),getManifest:id=>({id,name:id,main:'index.html'}),getBuildRevision:()=> 'build1',invalidateBuildRevision:()=> 'build2'};`,
  '@main/plugin/pluginEnabledStore': `export const isEnabledSync=()=>true;`,
  '@main/plugin/PluginInstaller': `import {f} from 'fixture'; export const setPluginInstallLifecycleHooks=hooks=>{f.installHooks=hooks};`,
  '@main/plugin/pluginProtocol': `import {f} from 'fixture'; export const registerPluginProtocolForSession=()=>{}; export const invalidatePluginFileCache=()=>{}; export const invalidatePluginCodeCache=async()=>{f.codeClears++;if(f.codeCacheGate)await f.codeCacheGate;if(f.codeCacheFail)throw Error('cache unavailable')};`,
  '@main/plugin/pluginSessionPolicy': `export const configurePluginSession=()=>{}; export const releasePluginEndpoints=()=>{}; export const allowPluginEndpoint=()=>()=>{};`,
  '@main/plugin/PermissionService': `export const permissionService={cancelFor(){}};`,
  '@main/proxy/proxyService': `export const applyProxyToPluginPartition=async()=>{}; export const getActiveProxy=()=>({type:'none'});`,
  '@main/db/pluginStorage': `export const releasePluginStorage=()=>true;`,
  '@main/pin/pinService': `export const closeAllPins=()=>{};`,
  '@main/contrib/ContributionRegistry': `export const contributionRegistry={releaseQuickProviders(){}};`,
  '@main/hotkey/pluginRuntimeHotkeys': `export const releasePluginHotkeys=()=>{};`,
  '@main/ssh/sshSessionManager': `import {f} from 'fixture'; export const releaseSshSessions=async()=>{f.releases++;if(f.releaseGate)await f.releaseGate};`,
  '@main/database/dbSessionManager': `export const releaseDbSessions=async()=>{};`,
  '@main/theme/resolveThemeCss': `export const resolveThemeTokens=()=>({}); export const themeTokensToInjectScript=()=>'';`,
  '@main/plugin/externalLinks': `export const routeExternal=async()=>{}; export const isInternalNavigation=()=>true;`
}
async function fixture() {
  const result = await build({ stdin:{contents:`export {PluginHost,pluginHost} from '@main/plugin/PluginHost'; export {f} from 'fixture'; export {getRuntimeScope} from '@main/plugin/PluginRuntimeScope'; export {acquirePluginActivity} from '@main/plugin/activityRegistry'; export {bindQuickInputHost,configureQuickInput,getQuickInputState} from '@main/plugin/quickInputService'; export const nonce=${Math.random()};`,resolveDir:root},tsconfig:root+'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},({path})=>path in adapters?{path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:adapters[path],loader:'js'}))}}] })
  const api=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
  api.f.host=api.pluginHost
  api.bindQuickInputHost({current:()=>api.pluginHost.getQuickPlugin(),send:(id,event)=>api.pluginHost.sendEvent(id,event),dismiss:id=>api.pluginHost.dismissQuickPlugin(id)})
  return {...api,host:api.f.host}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function loaded(ctx,id){await ctx.host.openPlugin(id);ctx.host.getWebContents(id).emit('did-finish-load');await tick()}

test('concurrent opens own exactly one renderer; load does not refresh itself',async()=>{
  const c=await fixture();let release;c.f.gate=new Promise(r=>release=r)
  const first=c.host.openPlugin('one'),second=c.host.openPlugin('one');release();await Promise.all([first,second])
  assert.equal(c.f.views.length,1);assert.equal(c.f.children.size,1)
  c.f.views[0].webContents.emit('did-finish-load');assert.equal(c.f.views[0].webContents.loads,1)
  await c.host.destroyAll();assert.equal(c.f.children.size,0);assert.ok(c.f.views.every(v=>v.webContents===undefined))
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
  const c=await fixture();await c.host.openPlugin('one');c.host.hideAllViews();c.host.getWebContents('one').emit('did-finish-load')
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
  let release;c.f.releaseGate=new Promise(r=>release=r)
  let completed=false;const close=c.host.closePlugin('one');const rejected=assert.rejects(close,/destruction not confirmed/).then(()=>{completed=true})
  await new Promise(r=>setTimeout(r,350));assert.equal(completed,false);assert.equal(c.host.getDiagnostics().retiring,1)
  release();await rejected;assert.equal(c.getRuntimeScope('one'),undefined)
  await assert.rejects(c.host.openPlugin('one'),/destruction is still pending/);assert.equal(c.f.views.length,1)
  assert.equal(c.f.clears,1, 'failed native destruction must still release the closed session')
  assert.equal(c.host.containers.has('one'),false)
  assert.equal(c.host.pendingEnter.has('one'),false)
  old.destroyed=true;old.emit('destroyed');assert.equal(c.host.getDiagnostics().retiring,0)
  c.f.closeStalled=false;c.f.releaseGate=null;await loaded(c,'one');await c.host.destroyAll()
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
  const c=await fixture();let release;c.f.releaseGate=new Promise(r=>release=r)
  for(let i=0;i<8;i++)await loaded(c,'lru'+i)
  await tick();assert.ok(c.host.getDiagnostics().entries.length<=6)
  assert.equal(c.host.getDiagnostics().hibernated,2)
  release();c.f.releaseGate=null;await c.host.destroyAll()
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
