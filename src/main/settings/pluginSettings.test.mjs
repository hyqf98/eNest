import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root=fileURLToPath(new URL('../../../',import.meta.url))
const adapters={
  '@main/db/sqliteService': `
    import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(':memory:');
    export const kvStore={getDatabase:()=>db};
    export const runInTransaction=(_db,fn)=>{db.exec('BEGIN');try{fn();db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}};
  `,
  '@main/logs/logService':'export const logInfo=()=>{};export const logWarn=()=>{};',
  '@main/window/createShellWindow':'export const sendShellEvent=()=>{};',
  '@main/window/orbRailViews':'export const refreshOrbRailContribEntries=()=>{};',
  '@main/settings/SettingsStore':'export const settingsStore={getPluginSettings:()=>({})};'
}
const bundle=await build({
  stdin:{resolveDir:root,contents:`export {contributionRegistry as registry} from '@main/contrib/ContributionRegistry';export {pluginSettingsBridge as bridge} from '@main/settings/PluginSettingsBridge';`},
  tsconfig:join(root,'tsconfig.node.json'),bundle:true,write:false,platform:'node',format:'esm',
  plugins:[{name:'adapters',setup(builder){
    builder.onResolve({filter:/^@main\//},({path})=>path in adapters?{path,namespace:'adapter'}:undefined)
    builder.onLoad({filter:/.*/,namespace:'adapter'},({path})=>({contents:adapters[path],loader:'js'}))
  }}]
})
const {registry,bridge}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('registering plugin settings preserves other contributions and sibling sections',()=>{
  registry.registerManifestContributes('db',{
    settings:[{id:'general',title:'General',items:[{key:'density',label:'Density',type:'text'}]}],
    homeCards:[{id:'query',title:'Query'}],railEntries:[{id:'recent',title:'Recent'}]
  })
  const page={key:'workbench',type:'page',label:'快捷键与工作台',entry:{code:'settings',payload:{tab:'shortcuts'}}}
  bridge.register('db',{id:'advanced',title:'Advanced',items:[page]})
  assert.equal(registry.listSlot('home-cards').length,1)
  assert.equal(registry.listSlot('rail-entries').length,1)
  assert.equal(bridge.listAll().length,2)
  assert.deepEqual(bridge.listAll().find(x=>x.id==='advanced').items,[page])
  assert.equal(bridge.get('db','workbench'),undefined)
  bridge.register('db',{id:'advanced',title:'Updated',items:[page]})
  assert.equal(bridge.listAll().length,2)
  assert.equal(bridge.listAll().find(x=>x.id==='advanced').title,'Updated')
  bridge.unregister('db')
  assert.equal(bridge.listAll().length,0)
  assert.equal(registry.listSlot('home-cards').length,1)
  assert.equal(registry.listSlot('rail-entries').length,1)
})
