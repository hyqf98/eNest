import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  fixture: `export const state={events:[],launches:[],opens:[],quickRevision:0,placements:{},placementRevisions:{},visible:false,captures:0,prepared:0,focused:0,hidden:0,config:{},captureGate:null,prepareGate:null,launchGate:null,launchError:null,installed:true,enabled:true};`,
  '@main/clipboard/nativeClipboard': `import {state as s} from 'fixture';export async function capturePasteTarget(){s.events.push('capture');s.captures++;await s.captureGate;s.events.push('captured')}`,
  '@main/plugin/PluginRegistry': `import {state as s} from 'fixture';export const pluginRegistry={get:id=>({id,installed:s.installed,enabled:s.enabled})}`,
  '@main/settings/SettingsStore': `import {state as s} from 'fixture';export const settingsStore={getPluginLaunchConfig:id=>s.config[id]}`,
  '@main/window/createQuickWindow': `import {state as s} from 'fixture';
    export const getQuickShowRevision=()=>s.quickRevision;export const isQuickVisible=()=>s.visible;
    export async function prepareQuickWindowForPlugin(guard){s.prepared++;s.events.push('prepare');await s.prepareGate;return guard()&&!s.prepareFail}
    export function hideQuickWindow(){s.hidden++;s.visible=false;s.quickRevision++}`,
  '@main/window/createShellWindow': `import {state as s} from 'fixture';import {EventEmitter} from 'node:events';s.mainWindow=Object.assign(new EventEmitter(),{isDestroyed:()=>false,isMinimized:()=>false,show:()=>s.events.push('shell-show'),focus:()=>s.focused++});export const getMainWindow=()=>s.mainWindow;export const sendShellEvent=e=>s.events.push(e)`,
  '@main/plugin/PluginHost': `import {state as s} from 'fixture';export const pluginHost={
    getPlacement:id=>({kind:s.placements[id]??'shell'}),getPlacementRevision:id=>s.placementRevisions[id]??0,
    async openPlugin(id,enter,opts){if(!opts.guard())throw Error('plugin launch cancelled');s.opens.push([id,enter])},
    async launchPluginIn(id,mode,enter,guard){s.events.push('launch:'+id);await s.launchGate;if(!guard())throw Error('plugin launch cancelled');if(s.launchError)throw Error(s.launchError);s.launches.push([id,mode,enter]);s.placements[id]=mode;s.placementRevisions[id]=(s.placementRevisions[id]??0)+1;if(mode==='quick'){s.visible=true;s.quickRevision++;s.events.push('quick-present')}}
  }`,
  '@main/logs/logService': `export const logWarn=()=>{}`
}
async function fixture() {
  const output = await build({stdin:{contents:`export * from '@main/launcher/pluginLauncher';export {state} from 'fixture';export const nonce=${Math.random()}`,resolveDir:root},tsconfig:root+'tsconfig.node.json',bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},({path})=>path in adapters?{path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:adapters[path]}))}}]})
  return import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function gate(){let release;const promise=new Promise(resolve=>release=resolve);return {promise,release}}

test('direct Quick launch captures the external target before presentation and coalesces held keys',async()=>{
  const {state:s,launchPlugin}=await fixture(), capture=gate()
  s.captureGate=capture.promise
  const request={pluginId:'one',mode:'quick',source:'shortcut'}
  const first=launchPlugin(request),repeat=launchPlugin(request)
  assert.equal(first,repeat);await tick();assert.equal(s.launches.length,0);assert.equal(s.captures,1)
  capture.release();assert.deepEqual(await first,{ok:true})
  assert.ok(s.events.indexOf('captured')<s.events.indexOf('quick-present'))
  assert.equal(launchPlugin(request),first);assert.equal(s.launches.length,1)
})

test('visible Quick retains its external paste target and uses the configured search mode',async()=>{
  const {state:s,launchPlugin}=await fixture();s.visible=true;s.config.one={mode:'quick'}
  assert.deepEqual(await launchPlugin({pluginId:'one',source:'quick'}),{ok:true})
  assert.equal(s.captures,0);assert.deepEqual(s.launches[0],['one','quick',undefined])
  s.config.two={mode:'shell'}
  await launchPlugin({pluginId:'two',source:'quick',enter:{code:'connect',payload:{id:1}}})
  assert.deepEqual(s.launches[1],['two','shell',{code:'connect',payload:{id:1}}]);assert.equal(s.focused,1)
})

test('a fresh press after dismissing Quick bypasses repeat suppression and launches again',async()=>{
  const {state:s,launchPlugin}=await fixture(),request={pluginId:'one',mode:'quick',source:'shortcut'}
  const first=launchPlugin(request);await first;s.visible=false;s.quickRevision++
  const reopened=launchPlugin(request)
  assert.notEqual(reopened,first);assert.deepEqual(await reopened,{ok:true});assert.equal(s.launches.length,2)
})

test('different bindings for one plugin honor the newest destination without presenting the obsolete one',async()=>{
  const {state:s,launchPlugin}=await fixture(), capture=gate();s.captureGate=capture.promise
  const quick=launchPlugin({pluginId:'one',mode:'quick',source:'shortcut'})
  const shell=launchPlugin({pluginId:'one',mode:'shell',source:'shortcut'})
  assert.deepEqual(await shell,{ok:true});capture.release()
  assert.deepEqual(await quick,{ok:false,cancelled:true});assert.deepEqual(s.launches,[['one','shell',undefined]])
})

test('two plugins competing for a hidden Quick share capture and only the latest is presented',async()=>{
  const {state:s,launchPlugin}=await fixture(), capture=gate();s.captureGate=capture.promise
  const first=launchPlugin({pluginId:'one',mode:'quick',source:'shortcut'})
  const second=launchPlugin({pluginId:'two',mode:'quick',source:'shortcut'})
  capture.release()
  assert.deepEqual(await first,{ok:false,cancelled:true});assert.deepEqual(await second,{ok:true})
  assert.equal(s.captures,1);assert.deepEqual(s.launches,[['two','quick',undefined]])
})

test('hide or close during preparation cancels before any plugin activation',async()=>{
  for(const reason of ['hide','close']) {
    const {state:s,launchPlugin}=await fixture(), waiting=gate();s.prepareGate=waiting.promise
    const opening=launchPlugin({pluginId:'one',mode:'quick',source:'settings'})
    if(reason==='hide')s.quickRevision++;else s.placementRevisions.one=1
    waiting.release();assert.deepEqual(await opening,{ok:false,cancelled:true});assert.equal(s.launches.length,0)
  }
})

test('explicit binding migrates detached instances while a search entry retains their window',async()=>{
  const {state:s,launchPlugin}=await fixture();s.placements.one='detached'
  await launchPlugin({pluginId:'one',mode:'quick',source:'quick'});assert.equal(s.opens.length,1);assert.equal(s.launches.length,0)
  await launchPlugin({pluginId:'one',mode:'quick',source:'settings'});assert.deepEqual(s.launches,[['one','quick',undefined]])
})

test('hiding the main window during a pending launch cancels its later focus and removes listeners',async()=>{
  const {state:s,launchPlugin}=await fixture(), waiting=gate();s.launchGate=waiting.promise
  const opening=launchPlugin({pluginId:'one',mode:'shell',source:'shortcut'})
  s.mainWindow.emit('hide');waiting.release()
  assert.deepEqual(await opening,{ok:false,cancelled:true});assert.equal(s.focused,0);assert.equal(s.launches.length,0)
  assert.equal(s.mainWindow.listenerCount('hide'),0);assert.equal(s.mainWindow.listenerCount('closed'),0)
})

test('failed preparation and native modal errors return failure without hiding the existing surface',async()=>{
  const {state:s,launchPlugin}=await fixture();s.prepareFail=true
  assert.equal((await launchPlugin({pluginId:'one',source:'settings'})).ok,false);assert.equal(s.launches.length,0)
  s.prepareFail=false;s.launchError='请先完成系统对话框'
  assert.deepEqual(await launchPlugin({pluginId:'one',mode:'shell',source:'settings'}),{ok:false,error:s.launchError})
  assert.equal(s.hidden,0);assert.equal(s.focused,0)
})

test('disabled or uninstalled plugins never allocate a window or capture focus',async()=>{
  const {state:s,launchPlugin}=await fixture();s.enabled=false
  assert.equal((await launchPlugin({pluginId:'one',source:'settings'})).ok,false)
  assert.equal(s.captures,0);assert.equal(s.prepared,0);assert.equal(s.launches.length,0)
})
