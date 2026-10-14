import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, mkdir, realpath, writeFile, symlink, rm } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
const adapters = {
  electron: `export const app={getVersion:()=> '0.1.0'};`,
  '@main/logs/logService': `export const logInfo=()=>{};export const logWarn=()=>{};`,
  './pluginInstallTasks': `export const extractPluginArchive=(source,dest)=>globalThis.__standardExtract?.(source,dest);export const writePluginBuildRevision=()=>{};`
}
const output = await build({ stdin: { contents: `export * from '@main/plugin/pluginPaths';export * from '@main/plugin/PluginInstaller';export * from '@shared/pluginContract';`, resolveDir: process.cwd() }, tsconfig:'tsconfig.node.json', bundle:true, write:false, platform:'node',format:'esm',plugins:[{name:'adapters',setup(b){b.onResolve({filter:/.*/},x=>x.path in adapters?{path:x.path,namespace:'adapter'}:undefined);b.onLoad({filter:/.*/,namespace:'adapter'},x=>({contents:adapters[x.path],loader:'js'}))}}] })
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
const id='com.test.standard'
const manifest=()=>({id,name:'Standard',description:'Fixture',version:'0.1.0',main:'index.html',icon:'assets/market/icon.svg',market:{readme:'assets/market/README.md',screenshots:['assets/market/screenshots/main.webp']}})
async function fixture(source=false){
 const parent=await mkdtemp(join(tmpdir(),'enest-standard-'));const root=join(parent,id);const assetRoot=join(root,source?'public/assets':'assets');
 await mkdir(join(assetRoot,'market/screenshots'),{recursive:true});if(source)await writeFile(join(root,'package.json'),JSON.stringify({name:id,version:'0.1.0',type:'module'}));await writeFile(join(root,'index.html'),'<html>fixture</html>');await writeFile(join(assetRoot,'market/icon.svg'),'<svg/>');await writeFile(join(assetRoot,'market/README.md'),'Fixture');await writeFile(join(assetRoot,'market/screenshots/main.webp'),'fixture');await writeFile(join(root,'plugin.json'),JSON.stringify(manifest()));return{root,parent};
}
test('source preview serves fixed roots and rejects dependencies, dotfiles, traversal and symlink escape',async()=>{
 const {root,parent}=await fixture(true)
 try{
  assert.equal(await api.resolvePluginFile(root,'assets/market/icon.svg',true),await realpath(join(root,'public/assets/market/icon.svg')))
  await writeFile(join(parent,'secret'),'private');await symlink(join(parent,'secret'),join(root,'public/assets/secret'))
  for(const path of ['plugin.json','package.json','.env','node_modules/main.js','../secret','assets/../secret','assets/%2e%2e/secret','assets/secret']) assert.equal(await api.resolvePluginFile(root,path,true),null,path)
  assert.equal(await api.resolvePluginFile(root,'assets/market/icon.svg',false),null)
 }finally{await rm(parent,{recursive:true,force:true})}
})
test('development server accepts explicit LAN origin without requiring a dist build',async()=>{
 const {root,parent}=await fixture(true)
 try{
  const m={...manifest(),development:{main:'http://192.168.1.25:5173/'}};await writeFile(join(root,'plugin.json'),JSON.stringify(m));await rm(join(root,'index.html'))
  assert.equal((await api.installFromDirectory(root,{source:true})).id,id)
  assert.equal(api.normalizePluginDevUrl(m.development.main),m.development.main)
  for(const value of ['file:///etc/passwd','https://user:password@host/','javascript:alert(1)'])assert.throws(()=>api.normalizePluginDevUrl(value))
 }finally{await rm(parent,{recursive:true,force:true})}
})
test('published directory requires canonical metadata and contains no source-only files',async()=>{
 const {root,parent}=await fixture()
 try{
  assert.equal((await api.installFromDirectory(root)).id,id)
  await symlink(join(root,'assets/market/README.md'),join(root,'.enest-build.json'));await assert.rejects(api.installFromDirectory(root),/符号链接/);await rm(join(root,'.enest-build.json'))
  await writeFile(join(root,'package.json'),'{}');await assert.rejects(api.installFromDirectory(root),/非标准发布内容/);await rm(join(root,'package.json'))
  for(const patch of [{id:'enest.builtin'},{main:'../index.html'},{icon:'icon.svg'},{logo:'assets/market/icon.svg'},{development:{main:'http://localhost:5173/'}},{market:{readme:'../README.md',screenshots:[]}}]){
   await writeFile(join(root,'plugin.json'),JSON.stringify({...manifest(),...patch}));await assert.rejects(api.installFromDirectory(root),/invalid plugin.json/)
  }
 }finally{await rm(parent,{recursive:true,force:true})}
})
test('folder installation validates the copied snapshot before publishing or replacing a build',async()=>{
 for(const change of ['manifest','layout']){
  const {root,parent}=await fixture(), destination=join(parent,'installed');let published=false,replacing=false
  api.setPluginInstallLifecycleHooks({beforeReplace:async()=>{replacing=true}})
  try{
   await assert.rejects(api.installFromFolder(root,destination,(percent)=>{
    if(percent!==35)return
    if(change==='manifest')writeFileSync(join(root,'plugin.json'),JSON.stringify({...manifest(),permissions:['fs.read']}))
    else writeFileSync(join(root,'package.json'),'{}')
   },undefined,()=>{published=true}),change==='manifest'?/plugin.json 已变化/:/非标准发布内容/)
   assert.equal(published,false);assert.equal(replacing,false)
   assert.equal(existsSync(join(destination,id,'0.1.0')),false)
  }finally{api.setPluginInstallLifecycleHooks({});await rm(parent,{recursive:true,force:true})}
 }
})
test('market archive identity mismatch is rejected before replacement or publication',async()=>{
 const {root,parent}=await fixture();let published=false,replacing=false
 globalThis.__standardExtract=(_source,destination)=>cp(root,destination,{recursive:true})
 api.setPluginInstallLifecycleHooks({beforeReplace:async()=>{replacing=true}})
 try{
  for(const expected of [{id:'com.other.plugin',version:'0.1.0'},{id,version:'0.2.0'}]){
   await assert.rejects(api.installFromZip('fixture.enestplugin',join(parent,'installed'),undefined,undefined,()=>{published=true},expected),/身份与市场版本不一致/)
  }
  assert.equal(published,false);assert.equal(replacing,false)
  assert.equal(existsSync(join(parent,'installed')),false)
 }finally{delete globalThis.__standardExtract;api.setPluginInstallLifecycleHooks({});await rm(parent,{recursive:true,force:true})}
})
