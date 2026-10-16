import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import AdmZip from 'adm-zip'

const mediaFiles = {'assets/market/icon.svg':'<svg/>','assets/market/README.md':'Fixture','assets/market/screenshots/main.png':'fixture'}
const packageMetadata = {description:'Fixture',icon:'assets/market/icon.svg',market:{readme:'assets/market/README.md',screenshots:['assets/market/screenshots/main.png']}}
async function writeMedia(root){await mkdir(join(root,'assets/market/screenshots'),{recursive:true});for(const [path,body]of Object.entries(mediaFiles))await writeFile(join(root,path),body)}
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
async function bundle(contents, adapters = {}) {
  const result = await build({
    stdin: { contents, resolveDir: projectRoot }, tsconfig: join(projectRoot, 'tsconfig.node.json'),
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'adapters', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'adapter' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const assets = await bundle(`export * from '@main/plugin/pluginAssetCache'; export * from '@main/plugin/pluginFileResponse';`)

test('asset LRU coalesces concurrent reads and invalidation rejects a late cache fill', async () => {
  const cache = new assets.PluginAssetCache(8, 4)
  let reads = 0, complete
  const loader = () => { reads++; return new Promise(resolve => { complete = resolve }) }
  const first = cache.read('root', 'a', loader)
  const second = cache.read('root', 'a', loader)
  await Promise.resolve()
  assert.equal(reads, 1)
  cache.invalidate('root')
  await cache.read('root', 'a', async () => Buffer.from('new'))
  complete(Buffer.from('old'))
  await assert.rejects(first, /invalidated/)
  await assert.rejects(second, /invalidated/)
  assert.equal((await cache.read('root', 'a', async () => { throw Error('unexpected read') })).toString(), 'new')
  await cache.read('root', 'b', async () => Buffer.from('bbbb'))
  await cache.read('root', 'c', async () => Buffer.from('cccc'))
  assert.equal(cache.getStats().bytes, 8)
  await cache.read('root', 'huge', async () => Buffer.alloc(100))
  assert.equal(cache.getStats().bytes, 8)
  cache.invalidate()
  assert.deepEqual(cache.getStats(), { bytes: 0, entries: 0, pending: 0 })
})

test('file responses stream large media, support ranges/HEAD/304 and reject invalid ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-file-test-'))
  const path = join(dir, 'media.bin')
  const body = Buffer.alloc(2 * 1024 * 1024, 7)
  const options = { root: dir, mime: 'application/octet-stream', csp: "default-src 'self'", revision: 'build1' }
  try {
    await writeFile(path, body)
    assets.pluginAssetCache.invalidate()
    const response = await assets.pluginFileResponse(new Request('enest://plugin/test/media'), path, options)
    assert.equal((await response.arrayBuffer()).byteLength, body.length)
    assert.equal(assets.pluginAssetCache.getStats().bytes, 0)
    const range = await assets.pluginFileResponse(new Request('enest://plugin/test/media', { headers: { Range: 'bytes=10-19' } }), path, options)
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 10-19/${body.length}`)
    assert.equal((await range.arrayBuffer()).byteLength, 10)
    const suffix = await assets.pluginFileResponse(new Request('enest://plugin/test/media', { headers: { Range: 'bytes=-5' } }), path, options)
    assert.equal((await suffix.arrayBuffer()).byteLength, 5)
    const invalid = await assets.pluginFileResponse(new Request('enest://plugin/test/media', { headers: { Range: 'bytes=9999999-' } }), path, options)
    assert.equal(invalid.status, 416)
    const head = await assets.pluginFileResponse(new Request('enest://plugin/test/media', { method: 'HEAD' }), path, options)
    assert.equal(head.body, null)
    const unchanged = await assets.pluginFileResponse(new Request('enest://plugin/test/media', { headers: { 'If-None-Match': response.headers.get('etag') } }), path, options)
    assert.equal(unchanged.status, 304)
    assert.equal(unchanged.body, null)
    const controller = new AbortController()
    const aborted = await assets.pluginFileResponse(new Request('enest://plugin/test/media', { signal: controller.signal }), path, options)
    controller.abort()
    await assert.rejects(aborted.arrayBuffer())
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('small file cache is budgeted while dev responses read changed contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-small-file-'))
  const path = join(dir, 'index.js')
  try {
    assets.pluginAssetCache.invalidate()
    await writeFile(path, 'old')
    const options = { root: dir, mime: 'text/javascript', csp: '', revision: 'v1' }
    const response = await assets.pluginFileResponse(new Request('enest://plugin/test/index.js'), path, options)
    assert.equal(await response.text(), 'old')
    assert.equal(assets.pluginAssetCache.getStats().bytes, 3)
    await writeFile(path, 'newer')
    const dev = await assets.pluginFileResponse(new Request('enest://plugin/test/index.js'), path, { ...options, dev: true })
    assert.equal(await dev.text(), 'newer')
    assert.equal(dev.headers.get('cache-control'), 'no-store')
  } finally { assets.pluginAssetCache.invalidate(); await rm(dir, { recursive: true, force: true }) }
})

const registryAdapters = {
  'test-state': `export const state = { root: '', gate: null, disabled: new Set() };`,
  electron: `export const app = { getAppPath: () => '/fixture' };`,
  '@main/paths/pathsService': `import {state} from 'test-state'; export const getAppPaths = () => ({plugins: state.root});`,
  '@main/plugin/PluginInstaller': `import {readFile} from 'node:fs/promises'; import {join} from 'node:path'; export const installFromDirectory = async root => JSON.parse(await readFile(join(root,'plugin.json'),'utf8')); export const installFromFolder = async () => {}; export const installFromZip = async () => {}; export const withInstallLock = async (_id, action) => action(); export const beginPluginInstall = () => 1;`,
  '@main/plugin/pluginInstallTasks': `import {state} from 'test-state'; export const readPluginBuildRevision = async root => { if(state.gate) await state.gate; return root; };`,
  '@main/plugin/pluginEnabledStore': `import {state} from 'test-state'; export const isEnabledSync = id => !state.disabled.has(id); export const loadDisabledIds = async () => {}; export const persistPluginEnabled = async (id,enabled) => enabled ? state.disabled.delete(id) : state.disabled.add(id);`,
  '@main/plugin/PermissionService': `export const permissionService = {cancelFor() {}};`,
  '@main/plugin/marketClient': `export const fetchRemoteMarket = async () => []; export const downloadPluginPackage = async () => {};`,
  '@main/contrib/ContributionRegistry': `export const contributionRegistry = {listSlot: () => [], registerManifestContributes() {}, unregisterBySource() {}};`,
  '@main/theme/themePacks': `export const themePackRegistry = {registerPlugin: async () => {}, removeBySource: async () => []};`,
  '@main/window/createShellWindow': `export const sendShellEvent = () => {};`,
  '@main/logs/logService': `export const logInfo = () => {}; export const logWarn = () => {};`
}
// Resolve the same-directory import to its canonical adapter too.
registryAdapters['./pluginInstallTasks'] = registryAdapters['@main/plugin/pluginInstallTasks']
const registryApi = await bundle(`export {PluginRegistry} from '@main/plugin/PluginRegistry'; export {state} from 'test-state';`, registryAdapters)

test('registry scan is single-flight, atomically publishes and uses numeric version ordering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-registry-'))
  const registry = new registryApi.PluginRegistry()
  registryApi.state.root = dir
  async function install(id, version) {
    const root = join(dir, id, version)
    await mkdir(root, { recursive: true })
    await writeFile(join(root,'plugin.json'), JSON.stringify({...packageMetadata,id,name:id,version,main:'index.html'}))
  }
  try {
    await install('com.test.first','1.9.0')
    await install('com.test.first','1.10.0')
    await registry.scan()
    assert.equal(registry.getManifest('com.test.first').version,'1.10.0')
    const stable = registry.getInstalledRevision()
    await registry.scan()
    assert.equal(registry.getInstalledRevision(), stable)
    const beforeDescriptors = registry.getDescriptorCacheMetrics()
    assert.equal(beforeDescriptors.entries,0)
    registry.getInstalledDescriptors()
    const builtDescriptors = registry.getDescriptorCacheMetrics()
    assert.equal(builtDescriptors.builds,beforeDescriptors.builds+1)
    assert.equal(builtDescriptors.misses,beforeDescriptors.misses+1)
    assert.equal(builtDescriptors.entries,1)
    registry.getInstalledDescriptors()
    assert.equal(registry.getDescriptorCacheMetrics().hits,builtDescriptors.hits+1)
    const metricsOnly = registry.getDescriptorCacheMetrics()
    assert.deepEqual(registry.getDescriptorCacheMetrics(),metricsOnly,'sampling must not build or touch the cache')
    await install('com.test.second','1.0.0')
    let resume
    registryApi.state.gate = new Promise(resolve => { resume = resolve })
    const first = registry.scan()
    assert.equal(registry.scan(), first)
    assert.equal(registry.getInstalledDescriptors().length,1)
    resume()
    registryApi.state.gate = null
    await first
    assert.equal(registry.getInstalledDescriptors().length,2)
    assert.ok(registry.getInstalledRevision() > stable)
    const build = registry.getBuildRevision('com.test.first')
    registry.invalidateBuildRevision('com.test.first')
    assert.notEqual(registry.getBuildRevision('com.test.first'),build)
    await registry.setPluginEnabled('com.test.first',false)
    assert.equal(registry.getInstalledDescriptors().find(item => item.id === 'com.test.first').enabled,false)
  } finally { registryApi.state.gate = null; await rm(dir,{recursive:true,force:true}) }
})

test('theme cache metrics count hits, builds and bounded eviction without exposing theme inputs',async()=>{
  const api=await bundle(`export * from '@main/theme/resolveThemeCss';export {state} from 'test-state';`,{
    'test-state':`export const state={theme:{mode:'light',overrides:{}}};`,
    electron:`export const nativeTheme={shouldUseDarkColors:false};`,
    '@main/settings/SettingsStore':`import {state} from 'test-state';export const settingsStore={getTheme:()=>state.theme};`,
    '@main/theme/themePacks':`export const themePackRegistry={get:()=>null};`
  })
  assert.deepEqual(api.getThemeCacheMetrics(),{hits:0,misses:0,builds:0,evictions:0,entries:0,capacity:2})
  const first=api.resolveThemeTokens()
  assert.equal(api.resolveThemeTokens(),first)
  api.resolveThemeTokens('dark')
  api.state.theme={mode:'light',overrides:{light:{'--accent':'#123456'}}}
  api.resolveThemeTokens()
  const metrics=api.getThemeCacheMetrics()
  assert.deepEqual(metrics,{hits:1,misses:3,builds:3,evictions:1,entries:2,capacity:2})
  metrics.entries=999
  assert.equal(api.getThemeCacheMetrics().entries,2)
  assert.equal(JSON.stringify(api.getThemeCacheMetrics()).includes('#123456'),false)
})

const installerApi = await bundle(`export * from '@main/plugin/PluginInstaller'; export {state} from 'test-state';`, {
  'test-state': `export const state = {root:''};`,
  electron: `import {state} from 'test-state'; export const app = {getVersion: () => '1.0.0', getAppPath: () => state.root};`,
  '@main/logs/logService': `export const logInfo = () => {}; export const logWarn = () => {};`
})

test('archive installation runs real worker, hashes content and atomically replaces same-version files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-install-worker-'))
  installerApi.state.root = dir
  const out = join(dir,'out/main')
  const source = join(dir,'source')
  const dest = join(dir,'plugins')
  try {
    await mkdir(out,{recursive:true}); await mkdir(source,{recursive:true})
    // A standalone CJS worker fixture needs no dependencies outside the temp directory.
    const worker = await build({entryPoints:[join(projectRoot,'src/main/plugin/pluginInstallWorker.ts')],bundle:true,write:false,platform:'node',format:'cjs'})
    await writeFile(join(out,'pluginInstallWorker.js'),worker.outputFiles[0].text)
    const manifest = {...packageMetadata,id:'com.test.archive',name:'Archive',version:'1.0.0',main:'index.html'}
    await writeFile(join(source,'plugin.json'),JSON.stringify(manifest))
    await writeFile(join(source,'index.html'),'old')
    await writeMedia(source)
    await writeFile(join(source,'assets/removed.js'),'old-resource')
    const first = await installerApi.installFromFolder(source,dest)
    assert.match(first.buildRevision,/^[a-f0-9]{64}$/)
    const staleOperation = installerApi.beginPluginInstall()
    installerApi.cancelPluginInstalls(manifest.id)
    await assert.rejects(installerApi.installFromFolder(source,dest,undefined,staleOperation), /取消/)
    assert.equal(await readFile(join(first.dest,'index.html'),'utf8'),'old')
    await assert.rejects(installerApi.installPluginFromPath(source,dest,(percent) => {
      if (percent === 2) installerApi.cancelPluginInstalls(manifest.id)
    }), /取消/, 'the path dispatcher must capture its operation before async stat')
    const events=[]
    installerApi.setPluginInstallLifecycleHooks({
      beforeReplace: async () => { events.push('before'); assert.equal(await readFile(join(first.dest,'index.html'),'utf8'),'old'); return () => events.push('released') },
      afterReplace: async () => { events.push('after'); assert.equal(await readFile(join(first.dest,'index.html'),'utf8'),'new') }
    })
    const zip = new AdmZip()
    zip.addFile('plugin.json',Buffer.from(JSON.stringify(manifest)))
    zip.addFile('index.html',Buffer.from('new'))
    for(const [path,body]of Object.entries(mediaFiles))zip.addFile(path,Buffer.from(body))
    const archive=join(dir,'plugin.zip'); zip.writeZip(archive)
    const second=await installerApi.installFromZip(archive,dest)
    assert.notEqual(second.buildRevision,first.buildRevision)
    assert.deepEqual(events,['before','after','released'])
    assert.deepEqual((await readdir(second.dest)).sort(),['.enest-build.json','assets','index.html','plugin.json'])
    installerApi.setPluginInstallLifecycleHooks({beforeReplace:async () => { throw Error('busy') }})
    await assert.rejects(installerApi.installFromFolder(source,dest),/busy/)
    assert.equal(await readFile(join(second.dest,'index.html'),'utf8'),'new')
    assert.deepEqual(await readdir(dest),['com.test.archive'])
  } finally { installerApi.setPluginInstallLifecycleHooks({}); await rm(dir,{recursive:true,force:true}) }
})

/** Real installer, registry, uninstaller and queue; only native services and CPU tasks are fixtures. */
async function packageFixture() {
  const adapters = {...registryAdapters}
  delete adapters['@main/plugin/PluginInstaller']
  const taskAdapter = `
    import {cp,writeFile,readFile} from 'node:fs/promises'; import {join} from 'node:path'; import {state} from 'test-state';
    export const extractPluginArchive=async(source,dest)=>{await cp(source,dest,{recursive:true})};
    export const writePluginBuildRevision=async root=>{const revision=String(++state.hash).padStart(64,'0');await writeFile(join(root,'.enest-build.json'),JSON.stringify({revision}));return revision};
    export const readPluginBuildRevision=async root=>JSON.parse(await readFile(join(root,'.enest-build.json'),'utf8')).revision;
  `
  adapters['@main/plugin/pluginInstallTasks'] = taskAdapter
  adapters['./pluginInstallTasks'] = taskAdapter
  adapters['test-state'] = `export const state={root:'',hash:0,disabled:new Set(),events:[],downloads:[],downloadGate:null,cleanups:0,barriers:0,closeFails:false,failPublish:false,failRemoveId:null,pluginSettings:{},vaultCleared:[],clipboardRevalidations:0,archiveByUrl:new Map(),beforePublish:null,published:[]};`
  adapters.electron = `import {state} from 'test-state';export const app={getVersion:()=> '1.0.0',getAppPath:()=>state.root,getPath:()=>state.root};export const session={fromPartition:()=>({clearStorageData:async()=>{}})};`
  adapters['@main/paths/pathsService'] = `import {state} from 'test-state';import {join} from 'node:path';export const getAppPaths=()=>({plugins:join(state.root,'plugins')});export const pluginStorageFile=id=>join(state.root,'legacy',id+'.json');`
  adapters['node:fs/promises'] = `export * from 'fs/promises';import {rename as realRename,rm as realRm} from 'fs/promises';import {basename,join} from 'node:path';import {state} from 'test-state';export async function rename(source,dest){if(state.failPublish&&basename(source).startsWith('.staging-'))throw Error('fixture publish failed');await realRename(source,dest);}export async function rm(path,options){if(state.failRemoveId&&path===join(state.root,'plugins',state.failRemoveId))throw Error('fixture removal failed');return realRm(path,options);}`
  adapters['@main/plugin/marketClient'] = `import {state} from 'test-state';export const fetchRemoteMarket=async()=>[];export const downloadPluginPackage=async url=>{state.downloads.push(url);if(state.downloadGate)await state.downloadGate;return {path:state.archiveByUrl.get(url),cleanup:async()=>{state.cleanups++}}};`
  adapters['@main/window/createShellWindow'] = `import {state} from 'test-state';export const sendShellEvent=e=>state.events.push(e);`
  adapters['@main/logs/logService'] = `export const logInfo=()=>{};export const logWarn=()=>{};export const logError=()=>{};`
  adapters['@main/plugin/PluginHost'] = `import {state} from 'test-state';export const pluginHost={blockPlugin(){state.barriers++;return ()=>{state.barriers--}},closePlugin:async()=>{if(state.closeFails)throw Error('native destruction unconfirmed')},beginUninstall(){},finishUninstall(){}};`
  adapters['@main/plugin/pluginProtocol'] = `export const invalidatePluginCodeCache=async()=>{};export const invalidatePluginFileCache=()=>{};`
  adapters['@main/plugin/PluginSessionStore'] = `export const clearPluginSession=()=>{};export const deleteSessionSnapshot=()=>{};`
  adapters['@main/db/pluginStorage'] = `export const clearPluginStorage=()=>{};`
  adapters['@main/plugin/pluginFiles'] = `export const clearPluginBlobs=async()=>{};`
  adapters['@main/vault/secretVault'] = `import {state} from 'test-state';export const vaultClearPlugin=id=>{state.vaultCleared.push(id);return 0};`
  adapters['@main/timer/focusTimerService'] = `export const clearFocusTimer=()=>{};`
  adapters['@main/dev/DevConsole'] = `export const forgetDevPlugin=async()=>{};`
  adapters['@main/settings/SettingsStore'] = `import {state} from 'test-state';export const settingsStore={getTheme:()=>({}),setTheme:async()=>{},removePluginSettings:async id=>{delete state.pluginSettings[id]}};`
  adapters['@main/plugin/pluginEnabledStore'] += `export const clearPluginDisabled=async id=>state.disabled.delete(id);`
  adapters['@main/clipboard/clipboardHistory'] = `import {state} from 'test-state';export const revalidateClipboardPolling=()=>{state.clipboardRevalidations++};`
  const api = await bundle(`
    export * from '@main/plugin/PluginInstaller';export {pluginRegistry} from '@main/plugin/PluginRegistry';
    export {uninstallPlugin} from '@main/plugin/PluginUninstaller';export * from '@main/plugin/installQueue';
    export {state} from 'test-state';export const nonce=${Math.random()};
  `,adapters)
  api.state.root = await mkdtemp(join(tmpdir(),'enest-package-race-'))
  return {
    ...api,
    async source(id,version,body) {
      const source=join(api.state.root,'sources',`${id}-${version}-${Math.random()}`)
      await mkdir(source,{recursive:true})
      await writeFile(join(source,'plugin.json'),JSON.stringify({...packageMetadata,id,name:id,version,main:'index.html'}))
      await writeFile(join(source,'index.html'),body)
      await writeMedia(source)
      return source
    },
    dest:join(api.state.root,'plugins'),
    dispose:()=>rm(api.state.root,{recursive:true,force:true})
  }
}
async function until(condition) {
  for(let i=0;i<500;i++) {
    if(condition())return
    await new Promise(resolve=>setTimeout(resolve,2))
  }
  assert.fail('package fixture did not settle')
}

test('uninstall cancels active and queued market downloads without publishing or retaining barriers',async()=>{
  const c=await packageFixture();let resume;c.state.downloadGate=new Promise(resolve=>{resume=resolve})
  try {
    const ids=['com.test.queuea','com.test.queueb','com.test.queuec','com.test.queued']
    for(const id of ids){const url='https://fixture/'+id;c.state.archiveByUrl.set(url,await c.source(id,'1.0.0','body'));c.enqueueInstallFromUrl(url,{name:id})}
    assert.equal(c.getInstallQueueState().waiting.length,1)
    assert.equal((await c.uninstallPlugin(ids[0])).ok,true)
    assert.equal((await c.uninstallPlugin(ids[3])).ok,true)
    resume();await until(()=>c.getInstallQueueState().active.length+c.getInstallQueueState().waiting.length===0)
    for(const id of [ids[0],ids[3]]) {
      assert.equal(c.pluginRegistry.getRootPath(id),null)
      await assert.rejects(readFile(join(c.dest,id,'1.0.0','index.html')),/ENOENT/)
      const result=c.state.events.find(event=>event.type==='install-result'&&event.name===id)
      assert.equal(result?.ok,false);assert.match(result.error,/取消/)
    }
    assert.equal(c.state.cleanups,4);assert.equal(c.state.barriers,0)
    assert.equal(await readFile(join(c.dest,ids[1],'1.0.0','index.html'),'utf8'),'body')
  } finally {resume();await c.dispose()}
})

test('replacement cancellation releases the lock; failed native close leaves installed files intact',async()=>{
  const c=await packageFixture(),id='com.test.cancel'
  try {
    const source=await c.source(id,'1.0.0','old')
    await c.installFromFolder(source,c.dest,undefined,undefined,result=>c.pluginRegistry.publishInstalledBuild(result))
    let entered,resume;const enteredPromise=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{resume=resolve})
    let releases=0
    c.setPluginInstallLifecycleHooks({beforeReplace:async()=>{entered();await gate;return ()=>{releases++}}})
    const replacement=await c.source(id,'1.0.0','new')
    const installing=c.installFromFolder(replacement,c.dest);const cancelled=assert.rejects(installing,/取消/)
    await enteredPromise;const uninstalling=c.uninstallPlugin(id);resume();await cancelled
    assert.equal((await uninstalling).ok,true);assert.equal(releases,1);assert.equal(c.state.barriers,0)
    c.setPluginInstallLifecycleHooks({})
    await c.installFromFolder(source,c.dest,undefined,undefined,result=>c.pluginRegistry.publishInstalledBuild(result))
    c.state.closeFails=true;assert.equal((await c.uninstallPlugin(id)).ok,false)
    assert.equal(await readFile(join(c.dest,id,'1.0.0','index.html'),'utf8'),'old');assert.equal(c.state.barriers,0)
    c.state.closeFails=false;assert.equal((await c.uninstallPlugin(id)).ok,true)
  } finally {await c.dispose()}
})

test('uninstall clears only the removed plugin settings and rechecks clipboard capture after removal succeeds',async()=>{
  const c=await packageFixture(),id='com.test.permissions',other='com.test.other'
  try {
    const source=await c.source(id,'1.0.0','body')
    const install=()=>c.installFromFolder(source,c.dest,undefined,undefined,result=>c.pluginRegistry.publishInstalledBuild(result))
    await install()
    const own={density:'comfortable',permissionGrants:{'clipboard.history':'allow','fs.write':'deny'}}
    const retained={density:'compact',permissionGrants:{'net.fetch':'allow'}}
    c.state.pluginSettings[id]=structuredClone(own)
    c.state.pluginSettings[other]=structuredClone(retained)

    c.state.closeFails=true
    assert.equal((await c.uninstallPlugin(id)).ok,false)
    assert.deepEqual(c.state.pluginSettings[id],own,'failed native close must preserve settings')
    assert.equal(c.state.clipboardRevalidations,0)

    c.state.closeFails=false;c.state.failRemoveId=id
    const failed=await c.uninstallPlugin(id)
    assert.equal(failed.ok,false);assert.match(failed.error,/removal failed/)
    assert.equal(await readFile(join(c.dest,id,'1.0.0','index.html'),'utf8'),'body')
    assert.deepEqual(c.state.pluginSettings[id],own,'failed package removal must preserve settings')
    assert.deepEqual(c.state.vaultCleared,[],'failed package removal must preserve vault secrets')
    assert.deepEqual(c.state.pluginSettings[other],retained)
    assert.equal(c.state.clipboardRevalidations,0)

    c.state.failRemoveId=null
    assert.equal((await c.uninstallPlugin(id)).ok,true)
    assert.equal(Object.hasOwn(c.state.pluginSettings,id),false)
    assert.deepEqual(c.state.pluginSettings[other],retained)
    assert.equal(c.state.clipboardRevalidations,1)
    assert.deepEqual(c.state.vaultCleared,[id],'successful removal clears the plugin vault exactly once')
    await install()
    assert.equal(Object.hasOwn(c.state.pluginSettings,id),false,'reinstall must not restore previous consent')
    assert.deepEqual(c.state.pluginSettings[other],retained)
  } finally {await c.dispose()}
})

test('registry remote installation keeps its pre-download sequence through archive preparation',async()=>{
  const c=await packageFixture(),id='com.test.remote';let resume;c.state.downloadGate=new Promise(resolve=>{resume=resolve})
  try {
    const url='https://fixture/remote';c.state.archiveByUrl.set(url,await c.source(id,'1.0.0','body'))
    c.pluginRegistry.remoteMarket=[{id,name:id,version:'1.0.0',assetUrl:url}]
    const installing=c.pluginRegistry.installFromRemote(id);const cancelled=assert.rejects(installing,/取消/)
    await until(()=>c.state.downloads.length===1);assert.equal((await c.uninstallPlugin(id)).ok,true)
    resume();await cancelled;assert.equal(c.state.cleanups,1);assert.equal(c.state.barriers,0)
    assert.equal(c.pluginRegistry.getRootPath(id),null)
    await assert.rejects(readFile(join(c.dest,id,'1.0.0','index.html')),/ENOENT/)
  } finally {resume();await c.dispose()}
})

test('a failed publish rename restores the previous build and allows a later replacement',async()=>{
  const c=await packageFixture(),id='com.test.rollback'
  try {
    const first=await c.source(id,'1.0.0','old'),second=await c.source(id,'1.0.0','new')
    const old=await c.installFromFolder(first,c.dest)
    let published=0,releases=0;c.setPluginInstallLifecycleHooks({beforeReplace:async()=>()=>{releases++}})
    c.state.failPublish=true
    await assert.rejects(c.installFromFolder(second,c.dest,undefined,undefined,()=>{published++}),/publish failed/)
    assert.equal(await readFile(join(old.dest,'index.html'),'utf8'),'old');assert.equal(published,0);assert.equal(releases,1)
    assert.deepEqual(await readdir(c.dest),[id])
    c.state.failPublish=false;await c.installFromFolder(second,c.dest,undefined,undefined,()=>{published++})
    assert.equal(await readFile(join(old.dest,'index.html'),'utf8'),'new');assert.equal(published,1);assert.equal(releases,2)
  } finally {await c.dispose()}
})

test('concurrent different-version installs publish registry under lock before old-version cleanup',async()=>{
  const c=await packageFixture(),id='com.test.publish'
  try {
    const oldSource=await c.source(id,'1.0.0','old'),newSource=await c.source(id,'2.0.0','new')
    c.state.archiveByUrl.set('https://fixture/old',oldSource)
    c.pluginRegistry.remoteMarket=[{id,name:id,version:'1.0.0',assetUrl:'https://fixture/old'}]
    let entered,resume;const enteredPromise=new Promise(resolve=>{entered=resolve}),gate=new Promise(resolve=>{resume=resolve})
    let first=true
    c.setPluginInstallLifecycleHooks({beforeReplace:async()=>{if(first){first=false;entered();await gate}}})
    const a=c.pluginRegistry.installFromRemote(id);await enteredPromise
    const b=c.installFromFolder(newSource,c.dest,undefined,undefined,result=>c.pluginRegistry.publishInstalledBuild(result))
    resume();await Promise.all([a,b])
    assert.equal(c.pluginRegistry.getManifest(id).version,'2.0.0')
    assert.equal(await readFile(join(c.dest,id,'2.0.0','index.html'),'utf8'),'new')
    assert.equal(c.pluginRegistry.getRootPath(id),join(c.dest,id,'2.0.0'))
  } finally {await c.dispose()}
})
