import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  electron: `
    const icon = { isEmpty: () => false };
    export const state = { result: {canceled:true,filePaths:[]}, parent:null, drags:[], focus:0, windowLocks:0, failWindowLease:false, failMessage:false };
    export const app = { getFileIcon: async () => icon };
    export const nativeImage = { createEmpty: () => icon, createFromBuffer: () => icon };
    export const dialog = { showOpenDialog: async (parent) => { state.parent=parent; return state.pending || state.result }, showMessageBox: () => { if(state.failMessage)throw Error('native dialog failed');return Promise.resolve({ response: 1 }) } };
    export const shell = { showItemInFolder: () => {} };
  `,
  '@main/plugin/PluginHost': `
    import {state} from 'electron';
    export const parent = {id:'quick-window', isDestroyed:()=>false};
    export const pluginHost = { getContainerWindow: () => parent, acquireWindowInteraction: () => { if(state.failWindowLease)throw Error('window moving');state.windowLocks++;let active=true;return ()=>{if(active){active=false;state.windowLocks--}} },
      getWebContents: () => ({isDestroyed:()=>false,startDrag:item=>state.drags.push(item)}) };
  `,
  '@main/window/createQuickWindow': `
    import {state} from 'electron';
    export const acquireQuickInteraction = () => { state.focus++; let active=true;
      return () => { if(active){active=false;state.focus--} } };
  `
}
const bundled = await build({
  stdin: { resolveDir: root, contents: `
    export * from '@main/plugin/activityRegistry';
    export * from '@main/plugin/quickInputPolicy';
    export * from '@main/plugin/localFiles';
    export {state} from 'electron';
    export {parent} from '@main/plugin/PluginHost';
  ` },
  tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{name:'adapters',setup(builder){
    builder.onResolve({filter:/^(electron|@main\/)/},({path})=>path in adapters?{path,namespace:'adapter'}:undefined)
    builder.onLoad({filter:/.*/,namespace:'adapter'},({path})=>({contents:adapters[path],loader:'js'}))
  }}]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

test('SSH/SQL/overlay keyboard ownership preserves native control keys and IME', () => {
  for (const context of ['terminal','editor','overlay']) {
    for (const key of ['Escape','Enter','k','c','d','z','ArrowUp','ArrowDown']) {
      for (const modifier of [{},{control:true},{meta:true}]) {
        assert.equal(api.quickInputAction({type:'keyDown',key,...modifier},context),null)
      }
    }
  }
  assert.equal(api.quickInputAction({type:'keyDown',key:'k',meta:true},'workbench'),'search')
  assert.equal(api.quickInputAction({type:'keyDown',key:'Enter',control:true},'workbench'),'pin')
  assert.equal(api.quickInputAction({type:'keyDown',key:'Escape'},'workbench'),'dismiss')
  for(const input of [
    {key:'Enter',meta:true,isComposing:true}, {key:'Enter',meta:true,shift:true},
    {key:'Escape',control:true},{key:'k',meta:true,alt:true},{type:'keyUp',key:'Escape'},
    {key:'Enter'},{key:'ArrowUp'}
  ]) assert.equal(api.quickInputAction({type:'keyDown',...input},'workbench'),null)
})

test('activity leases release only their own generation and notify only when idle', () => {
  const idle=[]
  const unsubscribe=api.onPluginActivityIdle(id=>idle.push(id))
  const first=api.acquirePluginActivity('ssh','session:1','SSH')
  const second=api.acquirePluginActivity('ssh','session:1','SSH')
  first();first()
  assert.equal(api.hasPluginActivity('ssh'),true)
  assert.equal(api.listPluginActivities('ssh').length,1)
  assert.deepEqual(idle,[])
  second()
  assert.deepEqual(idle,['ssh'])
  const stale=api.acquirePluginActivity('db','transaction:1','transaction')
  api.releasePluginActivities('db')
  const current=api.acquirePluginActivity('db','transaction:1','transaction')
  stale()
  assert.equal(api.hasPluginActivity('db'),true)
  current()
  assert.deepEqual(idle,['ssh','db'])
  unsubscribe()
})

test('local handles enforce plugin ownership, drop read-only access, and directory scope', async () => {
  const dir=await mkdtemp(join(tmpdir(),'enest-handles-'))
  try {
    const selected=join(dir,'selected');await mkdir(selected)
    const file=join(selected,'document.txt');await writeFile(file,'data')
    await writeFile(join(dir,'outside.txt'),'outside')
    await symlink(join(dir,'outside.txt'),join(selected,'escape.txt'))
    const [drop]=await api.localFilesFromDrop('files',[file,file])
    assert.equal(await api.resolveLocalFileHandle('files',drop.id),await realpath(file))
    await assert.rejects(api.resolveLocalFileHandle('other',drop.id),/invalid/)
    await assert.rejects(api.resolveLocalFileHandle('files',drop.id,'write'),/invalid/)
    const rootHandle=await api.grantLocalFile('files',selected)
    const list=await api.listLocalFiles('files',{handleId:rootHandle.id})
    assert.deepEqual(list.entries.map(x=>x.name),['document.txt'])
    await assert.rejects(api.listLocalFiles('files',{handleId:rootHandle.id,relativePath:'..'}),/outside/)
    await rm(file);await symlink(join(dir,'outside.txt'),file)
    await assert.rejects(api.resolveLocalFileHandle('files',drop.id),/scope/)
  } finally {api.releaseLocalFiles('files');await rm(dir,{recursive:true,force:true})}
})

test('native picker uses current container and always releases blur protection', async () => {
  api.state.result={canceled:true,filePaths:[]}
  assert.deepEqual(await api.pickLocalFiles('picker'),[])
  assert.equal(api.state.parent,api.parent)
  assert.equal(api.state.focus,0)
  api.state.result={canceled:false,filePaths:['/this/file/does/not/exist']}
  await assert.rejects(api.pickLocalFiles('picker'))
  assert.equal(api.state.focus,0)
})

test('native drag requires caller-owned prepared files and holds activity until drag end', async () => {
  const dir=await mkdtemp(join(tmpdir(),'enest-drag-'))
  try {
    const file=join(dir,'file.txt');await writeFile(file,'prepared')
    const handle=await api.grantLocalFile('drag',file)
    const {exportId}=await api.prepareLocalDrag('drag',[handle.id])
    assert.throws(()=>api.startLocalDrag('other',exportId),/not prepared/)
    assert.equal(api.startLocalDrag('drag',exportId),true)
    assert.equal(api.hasPluginActivity('drag'),true)
    assert.equal(api.state.focus,1)
    assert.equal(api.state.windowLocks,1)
    assert.deepEqual(api.state.drags.at(-1).files,[await realpath(file)])
    api.endLocalDrag('drag');api.endLocalDrag('drag')
    assert.equal(api.hasPluginActivity('drag'),false)
    assert.equal(api.state.focus,0)
    assert.equal(api.state.windowLocks,0)
    await writeFile(join(dir,'other.txt'),'other');await rm(file);await symlink(join(dir,'other.txt'),file)
    assert.throws(()=>api.startLocalDrag('drag',exportId),/changed/)
    api.releaseLocalFiles('drag')
    assert.throws(()=>api.startLocalDrag('drag',exportId),/not prepared/)
  } finally {api.releaseLocalFiles('drag');await rm(dir,{recursive:true,force:true})}
})

test('a picker completing after plugin teardown cannot grant files to its replacement', async () => {
  const dir=await mkdtemp(join(tmpdir(),'enest-stale-picker-'))
  try {
    const file=join(dir,'file.txt');await writeFile(file,'selected')
    let finish
    api.state.pending=new Promise(resolve=>{finish=resolve})
    const picking=api.pickLocalFiles('stale-picker')
    assert.equal(api.state.focus,1)
    assert.equal(api.hasPluginActivity('stale-picker'),true)
    api.releaseLocalFiles('stale-picker')
    assert.equal(api.state.focus,0)
    assert.equal(api.hasPluginActivity('stale-picker'),false)
    const replacement=await api.grantLocalFile('stale-picker',file)
    finish({canceled:false,filePaths:[file]})
    await assert.rejects(picking,/expired/)
    assert.equal(await api.resolveLocalFileHandle('stale-picker',replacement.id),await realpath(file))
    assert.equal(api.state.focus,0)
  } finally {
    delete api.state.pending
    api.releaseLocalFiles('stale-picker')
    await rm(dir,{recursive:true,force:true})
  }
})

test('window migration rejection and a synchronous native dialog failure leave no leases', async () => {
  try {
    api.state.failWindowLease = true
    await assert.rejects(api.pickLocalSaveFile('moving-save'), /window moving/)
    assert.equal(api.hasPluginActivity('moving-save'), false)
    assert.equal(api.state.focus, 0)
    assert.equal(api.state.windowLocks, 0)
    api.state.failWindowLease = false
    api.state.failMessage = true
    await assert.rejects(api.localFilesFromDrop('drop-failure', ['/fixture.txt']), /native dialog failed/)
    assert.equal(api.state.focus, 0)
    assert.equal(api.state.windowLocks, 0)
  } finally {
    api.state.failWindowLease = false; api.state.failMessage = false
    api.releaseLocalFiles('moving-save'); api.releaseLocalFiles('drop-failure')
  }
})
