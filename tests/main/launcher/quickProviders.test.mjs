import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../../../',import.meta.url))
async function fixture(){
 const adapters={
  fixture:`export const f={reply:null,request:null,grant:'allow',registered:true};`,
  '@main/contrib/ContributionRegistry':`import {f} from 'fixture';export const contributionRegistry={getQuickProviders:()=>f.registered?[{id:'search',pluginId:'one'}]:[]};`,
  '@main/plugin/PluginHost':`import {f} from 'fixture'; export const pluginHost={isOpened:()=>true,getWebContents:()=>({}),sendEvent:(id,payload)=>{f.request=payload;f.reply?.(id,payload)}};`,
  '@main/logs/logService':`export const logWarn=()=>{};`,
  '@main/settings/SettingsStore':`import {f} from 'fixture';export const settingsStore={getPermissionGrant:()=>f.grant};`
 }
 const result=await build({stdin:{contents:`export * from '@main/launcher/quickProviders';export * from '@main/plugin/PluginRuntimeScope';export {f} from 'fixture';export const nonce=${Math.random()}`,resolveDir:root},bundle:true,write:false,platform:'node',format:'esm',tsconfig:root+'tsconfig.node.json',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},({path})=>path in adapters?{path,namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:adapters[path]}))}}]})
 return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
}
test('provider pending request is registered before dispatch and results are bounded',async()=>{
 const c=await fixture(),scope=c.createRuntimeScope({pluginId:'one',generation:1,wcId:1})
 c.f.reply=(id,p)=>c.resolveQuickQuery(id,p.reqId,Array.from({length:150},(_,id)=>({id})))
 const result=await c.queryQuickProviders('search');assert.equal(result[0].items.length,100);await scope.dispose()
})
test('wrong owner cannot resolve provider; runtime abort settles immediately and old reply is ignored',async()=>{
 const c=await fixture(),scope=c.createRuntimeScope({pluginId:'one',generation:1,wcId:1})
 const result=c.queryQuickProviders('search'),req=c.f.request
 c.resolveQuickQuery('two',req.reqId,[{title:'forged'}]);scope.markClosing()
 assert.deepEqual((await result)[0].items,[]);await scope.dispose()
 c.resolveQuickQuery('one',req.reqId,[{title:'late'}])
})

test('superseded searches abort immediately without closing the provider runtime',async()=>{
 const c=await fixture(),scope=c.createRuntimeScope({pluginId:'one',generation:1,wcId:1}),controller=new AbortController()
 const result=c.queryQuickProviders('search',controller.signal),req=c.f.request
 controller.abort()
 assert.deepEqual((await result)[0].items,[])
 assert.equal(scope.signal.aborted,false)
 c.resolveQuickQuery('one',req.reqId,[{title:'late'}])
 await scope.dispose()
})

test('revoked providers receive no query and cannot return after revocation or unregister',async()=>{
 const c=await fixture(),scope=c.createRuntimeScope({pluginId:'one',generation:1,wcId:1})
 c.f.grant='deny'
 assert.deepEqual((await c.queryQuickProviders('private query'))[0].items,[])
 assert.equal(c.f.request,null)
 c.f.grant='allow'
 const revoked=c.queryQuickProviders('first'),first=c.f.request
 c.f.grant='deny';c.resolveQuickQuery('one',first.reqId,[{title:'rejected'}])
 assert.deepEqual((await revoked)[0].items,[])
 c.f.grant='allow'
 const removed=c.queryQuickProviders('second'),second=c.f.request
 c.f.registered=false;c.resolveQuickQuery('one',second.reqId,[{title:'rejected'}])
 assert.deepEqual((await removed)[0].items,[])
 await scope.dispose()
})
