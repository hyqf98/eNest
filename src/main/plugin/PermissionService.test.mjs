import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const grants = new Map(), prompts=[]
globalThis.__permissionFixture={grants,prompts,polling:0}
const bundle=await build({ stdin:{contents:"export * from '@main/plugin/PermissionService';export { BUILTIN_PLUGIN_CAPABILITIES } from '@shared/pluginPermissionPolicy';",resolveDir:root},tsconfig:root+'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fixture',setup(b){
  b.onResolve({filter:/^@main\/plugin\/PermissionService$/},()=>({path:root+'src/main/plugin/PermissionService.ts'}))
  b.onResolve({filter:/^(electron|@main\/)/},args=>({path:args.path,namespace:'fixture'}))
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
    const f=globalThis.__permissionFixture;
    const win={isDestroyed:()=>false,isMinimized:()=>false,show:()=>{}};
    export const pluginHost={getContainerWindow:()=>win}; export const getMainWindow=()=>win; export const acquireQuickInteraction=()=>()=>{};
    export const settingsStore={getPermissionGrant:(id,p)=>f.grants.get(id+':'+p)||'ask',setPermissionGrant:async(id,p,v)=>f.grants.set(id+':'+p,v)};
    export const logWarn=()=>{};export const revalidateClipboardPolling=()=>f.polling++;
    export const dialog={showMessageBox:(_win,options)=>new Promise(resolve=>{const prompt={options,resolve};f.prompts.push(prompt);options.signal.addEventListener('abort',()=>resolve({response:0}),{once:true})})};
  `}))
}}]})
const {PermissionService,BUILTIN_PLUGIN_CAPABILITIES}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
async function next(count){for(let i=0;i<50;i++){if(prompts.length>=count)return prompts[count-1];await new Promise(r=>setTimeout(r,1))}throw new Error('missing native prompt')}

test('native consent: renderer forgery denied; once not persisted; always persisted',async()=>{
  const service=new PermissionService()
  const first=service.request('first','fs.read','read file')
  const prompt=await next(1)
  assert.equal(service.resolveRequest('forged','always'),false)
  assert.equal(prompt.options.defaultId,0)
  assert.equal(prompt.options.cancelId,0)
  prompt.resolve({response:1})
  assert.equal(await first,true)
  assert.equal(grants.has('first:fs.read'),false)
  const second=service.request('first','fs.read','read file')
  ;(await next(2)).resolve({response:2})
  assert.equal(await second,true)
  assert.equal(grants.get('first:fs.read'),'allow')
  assert.equal(await service.request('first','fs.read','again'),true)
  assert.equal(prompts.length,2)
})

test('native consent: global queue serialized; closing plugin aborts active and queued requests',async()=>{
  const service=new PermissionService(), before=prompts.length
  const a=service.request('closing','fs.write','write'), b=service.request('closing','fs.read','read'), c=service.request('next','fs.read','read')
  const active=await next(before+1)
  assert.equal(prompts.length,before+1)
  service.cancelFor('closing')
  assert.equal(await a,false); assert.equal(await b,false)
  assert.equal(active.options.signal.aborted,true)
  ;(await next(before+2)).resolve({response:0})
  assert.equal(await c,false)
  assert.equal(grants.get('next:fs.read'),'deny')
})

test('built-in capabilities never prompt, even when an older install saved deny or ask',async()=>{
  const service=new PermissionService(), before=prompts.length
  for(const permission of BUILTIN_PLUGIN_CAPABILITIES) {
    for(const previous of [undefined,'ask','deny']) {
      grants.set('builtin:'+permission,previous)
      assert.equal(await service.request('builtin',permission,'own plugin capability'),true,permission)
    }
  }
  assert.equal(prompts.length,before)
})

test('system capabilities retain saved denial and an unknown capability never auto-allows',async()=>{
  const service=new PermissionService(), before=prompts.length
  grants.set('restricted:fs.read','deny')
  assert.equal(await service.request('restricted','fs.read','external file'),false)
  assert.equal(prompts.length,before)
  const future=service.request('restricted','future.system.capability','unknown system capability')
  ;(await next(before+1)).resolve({response:0})
  assert.equal(await future,false)
})
