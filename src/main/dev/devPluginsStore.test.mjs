import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
const root=await mkdtemp(join(tmpdir(),'enest-dev-records-'))
const adapters={'@main/paths/pathsService':`export const getAppPaths=()=>({plugins:${JSON.stringify(join(root,'plugins'))}});`,'@main/logs/logService':'export const logWarn=()=>{}'}
const output=await build({entryPoints:['src/main/dev/devPluginsStore.ts'],tsconfig:'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'adapters',setup(b){b.onResolve({filter:/.*/},x=>x.path in adapters?{path:x.path,namespace:'adapter'}:undefined);b.onLoad({filter:/.*/,namespace:'adapter'},x=>({contents:adapters[x.path],loader:'js'}))}}]})
const api=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
test('concurrent registrations preserve source/URL/mode and kill-on-hide updates without losing records',async()=>{
 try{
  await Promise.all(Array.from({length:12},(_,i)=>api.upsertDevPluginRecord(`test.${i}`,`/source/test.${i}`,{url:i?'http://192.168.1.1:5173/':'',preview:'source'})))
  await Promise.all([api.setDevPluginKillOnHide('test.0',true),api.upsertDevPluginRecord('test.0','/new/test.0',{preview:'dist'}),api.dropDevPluginRecord('test.1')])
  const records=await api.readDevPluginRecords();assert.equal(records.length,11)
  // 旧 preview:'dist' 入参迁移为 mode:'prod'，不再落 preview 字段
  assert.deepEqual(records.find(x=>x.id==='test.0'),{id:'test.0',path:'/new/test.0',mode:'prod',killOnHide:true})
  assert.equal(records.find(x=>x.id==='test.2').url,'http://192.168.1.1:5173/')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('legacy dev.json records migrate preview to mode on read; mode switch keeps url and killOnHide',async()=>{
 const file=join(root,'plugins','dev.json')
 try{
  await mkdir(join(root,'plugins'),{recursive:true})
  await writeFile(file,JSON.stringify([
    {id:'legacy.dist',path:'/src/a',preview:'dist'},
    {id:'legacy.source',path:'/src/b',preview:'source',url:'http://127.0.0.1:5175/',killOnHide:true}
  ]))
  let records=await api.readDevPluginRecords()
  assert.deepEqual(records.find(x=>x.id==='legacy.dist'),{id:'legacy.dist',path:'/src/a',mode:'prod'})
  assert.deepEqual(records.find(x=>x.id==='legacy.source'),{id:'legacy.source',path:'/src/b',url:'http://127.0.0.1:5175/',killOnHide:true}, 'preview:source 不产生 mode 字段')
  await api.updateDevPluginMode('legacy.source','prod')
  records=await api.readDevPluginRecords()
  const switched=records.find(x=>x.id==='legacy.source')
  assert.equal(switched.mode,'prod')
  assert.equal(switched.url,'http://127.0.0.1:5175/','模式切换保留 url')
  assert.equal(switched.killOnHide,true,'模式切换保留 killOnHide')
 }finally{await rm(root,{recursive:true,force:true})}
})
