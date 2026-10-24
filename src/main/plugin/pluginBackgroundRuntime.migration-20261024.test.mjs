import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ID = 'com.github.eNest.clipboard'
const tick = () => new Promise(resolve => setImmediate(resolve))
const fixtureSource = `
export const IpcChannels={PluginBackgroundReady:'ready',PluginBackgroundHost:'host',PluginBackgroundRequest:'request',PluginBackgroundResponse:'response'};
export const BACKGROUND_MESSAGE_LIMIT=2048;
export const state={descriptors:[{id:${JSON.stringify(ID)},enabled:true,dev:false,rootPath:'/fixture/plugin',buildRevision:'one',manifest:{id:${JSON.stringify(ID)},version:'1.4.0',permissions:['clipboard.history'],background:{entry:'assets/background.html',events:['clipboard.changed'],eventSettings:{'clipboard.changed':'monitoring'},quickSearch:true},contributes:{settings:[{items:[{key:'monitoring',type:'switch',default:true},{key:'historyLimit',type:'number',default:200}]}]}}}],settings:{},persistent:true,temporary:false,blocked:false,scopeCurrent:true,scopeClosing:false,devSource:false,handlers:new Map(),listeners:new Map(),views:[],subscriptions:[],protocols:[],sent:[],emitted:[],allowances:[],legacyGuards:[],resolvedFiles:[],readGate:null,legacyGate:null,timers:new Set(),clock:0};
export function clockSetTimeout(fn,ms){const value={fn,due:state.clock+ms,unref(){}};state.timers.add(value);return value}
export function clockClearTimeout(value){state.timers.delete(value)}
export async function advance(ms){const until=state.clock+ms;for(;;){const next=[...state.timers].filter(t=>t.due<=until).sort((a,b)=>a.due-b.due)[0];if(!next)break;state.clock=next.due;state.timers.delete(next);next.fn();await Promise.resolve();await Promise.resolve()}state.clock=until}
export const ipcMain={handle:(key,fn)=>state.handlers.set(key,fn),on:(key,fn)=>state.listeners.set(key,fn)};
const partitions=new Map();state.sessions=partitions;
export const session={fromPartition:key=>{if(!partitions.has(key)){const value={request:null,downloads:new Set(),cleared:[],handler:null,setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(event,fn){this.downloads.add(fn)},removeListener(event,fn){this.downloads.delete(fn)},clearStorageData(options){this.cleared.push(options.origin);return Promise.resolve()}};value.webRequest={onBeforeRequest:fn=>{value.request=fn}};value.protocol={handle:(scheme,fn)=>{value.handler=fn;state.protocols.push(fn)},unhandle:()=>{value.handler=null}};partitions.set(key,value)}return partitions.get(key)}};
export class WebContentsView{constructor(options){this.session=options.webPreferences.session;const events=new Map();const contents={id:state.views.length+1,mainFrame:{url:''},destroyed:false,sent:[],setWindowOpenHandler(){},setWebRTCIPHandlingPolicy(){},on(key,fn){events.set(key,fn)},once(key,fn){events.set(key,fn)},loadURL(url){this.mainFrame.url=url;return Promise.resolve()},send(channel,data){this.sent.push(data);state.sent.push(data)},isDestroyed(){return this.destroyed},close(){if(this.destroyed)return;this.destroyed=true;events.get('destroyed')?.()}};this.webContents=contents;state.views.push(this)}setVisible(){}}
export const pluginRegistry={getInstalledDescriptors:()=>state.descriptors,get:id=>{const item=state.descriptors.find(x=>x.id===id);return item?{...item,devSource:state.devSource}:undefined},onInstalledChanged:fn=>{state.refresh=fn;return()=>{state.refresh=null}}};
export const getRuntimeScope=()=>({isCurrent:()=>state.scopeCurrent,get isClosing(){return state.scopeClosing}});
export const permissionService={isGranted:()=>state.temporary};
export const pluginHost={isBlockedForOpen:()=>state.blocked,sendEvent:(id,event)=>state.emitted.push({id,event})};
export const settingsStore={getPermissionGrant:()=>state.persistent?'allow':'ask',getPluginSettings:()=>state.settings};
export const isPluginAssetPath=value=>typeof value==='string'&&!value.includes('..')&&!value.includes('\\\\')&&!value.startsWith('/');
export const isPluginSettingKey=value=>typeof value==='string'&&!!value&&!['permissionGrants','__proto__','prototype','constructor'].includes(value);
export const resolvePluginFile=async(root,path,source)=>{state.resolvedFiles.push({root,path,source});return root+'/'+path};
export const pluginFileResponse=()=>new Response('fixture');
export const resolvePreload=name=>'/fixture/'+name;
export const subscribeClipboardChanges=consumer=>{if(state.rejectSubscriptions>0){state.rejectSubscriptions--;throw Error('fixture subscription limit')}const value={...consumer,active:true};state.subscriptions.push(value);return()=>{value.active=false}};
export const readPrivateDocument=async(owner,name)=>{if(state.readGate)await state.readGate;return {fixture:name}};
export const writePrivateDocument=async()=>{};
export const getPrivateBlob=async()=>null;
export const putPrivateBlob=async()=>({id:'fixture',bytes:1});
export const removePrivateBlob=async()=>true;
export const grantPrivateMigrationBudget=async(owner,source,token,bytes)=>state.allowances.push({owner,source,token,bytes});
export const readLegacyClipboardDocument=async()=>{if(state.legacyGate)await state.legacyGate;return {token:'a'.repeat(64),document:'[]'}};
export const getLegacyClipboardBlob=async()=>null;
export const getLegacyClipboardImportBudget=async()=>({bytes:1234,files:1});
export const commitLegacyClipboardMigration=async(id,source,token,guard)=>{state.legacyGuards.push(guard);guard()};
export const logInfo=()=>{};
export const logWarn=(source,message)=>{(state.warnings??=[]).push({source,message})};
`

async function fixture() {
  const names = new Set(['fixture', 'electron', '@shared/types/ipc', '@shared/types/pluginBackgroundProtocol', '@shared/pluginContract', '@shared/pluginSettingsKeys',
    './PluginRegistry', './PluginRuntimeScope', './PermissionService', './PluginHost', './pluginPaths', './pluginFileResponse', './pluginPrivateDocuments',
    '@main/window/createShellWindow', '@main/settings/SettingsStore', '@main/clipboard/clipboardNativeEvents', '@main/clipboard/legacyClipboardMigration', '@main/logs/logService'])
  const result = await build({
    stdin: { contents: `export * from './src/main/plugin/pluginBackgroundRuntime.ts';export {state,advance} from 'fixture';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'isolated-background-fixture', setup(api) {
      api.onResolve({ filter: /.*/ }, ({ path }) => names.has(path) ? { path: 'fixture', namespace: 'fixture' } : null)
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixtureSource, loader: 'js' }))
      api.onLoad({ filter: /pluginBackgroundRuntime\.ts$/ }, async ({ path }) => ({ contents: `import {clockSetTimeout as setTimeout,clockClearTimeout as clearTimeout} from 'fixture';\n${await readFile(path, 'utf8')}`, loader: 'ts' }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
}
const eventFor = contents => ({ sender: contents, senderFrame: contents.mainFrame })
async function ready(f) {
  const contents = f.state.views.at(-1).webContents
  await f.state.handlers.get('ready')(eventFor(contents))
  await tick()
  return contents
}
function respond(f, contents, data = null, ok = true) {
  const request = contents.sent.at(-1)
  assert.ok(request, 'fixture expects a pending background operation')
  f.state.listeners.get('response')(eventFor(contents), { id: request.id, ok, ...(ok ? { data } : { error: String(data) }) })
}

test('native subscriptions use declared switch defaults and require persisted authorization', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 1)
    assert.equal(f.state.views.length, 0)
    f.state.settings.monitoring = false
    f.refreshPluginBackgrounds()
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 0)
    f.state.settings.monitoring = true
    f.state.persistent = false
    f.state.temporary = true
    f.refreshPluginBackgrounds()
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 0)
    assert.deepEqual(await f.searchAll('fixture'), [{ pluginId: ID, items: [] }])
    assert.equal(f.state.views.length, 0)
  } finally { f.disposePluginBackgrounds() }
})

test('a subscription quota failure does not block other backgrounds and can retry on refresh', async () => {
  const f = await fixture()
  try {
    const other = structuredClone(f.state.descriptors[0])
    other.id = 'com.github.eNest.fixture-background'
    other.manifest.id = other.id
    f.state.descriptors.push(other)
    f.state.rejectSubscriptions = 1
    assert.doesNotThrow(() => f.startPluginBackgrounds())
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 1)
    assert.equal(f.state.warnings.length, 1)
    f.refreshPluginBackgrounds()
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 2)
    assert.equal(f.state.views.length, 0)
  } finally { f.disposePluginBackgrounds() }
})

test('stop tombstones reject stale native callbacks and ordinary refresh or Quick cannot resurrect them', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    const stale = f.state.subscriptions[0]
    f.stopPluginBackground(ID, 'performance end')
    f.refreshPluginBackgrounds()
    await stale.publish({ revision: 1, text: 'synthetic only' })
    await f.searchAll('fixture')
    assert.equal(stale.current(), false)
    assert.equal(f.state.views.length, 0)
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 0)
    f.state.blocked = true
    assert.throws(() => f.callPluginBackground(ID, 'history.query', []), /blocked/)
    f.state.blocked = false
    f.refreshPluginBackgrounds()
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 0)
    const call = f.callPluginBackground(ID, 'history.query', [], { timeoutMs: 600000 })
    const contents = await ready(f)
    respond(f, contents, { records: [] })
    assert.deepEqual(await call, { records: [] })
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 1)
  } finally { f.disposePluginBackgrounds() }
})

test('an enable cycle or new build clears only that stopped declaration', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    f.stopPluginBackground(ID)
    f.state.descriptors[0].enabled = false
    f.refreshPluginBackgrounds()
    f.state.descriptors[0].enabled = true
    f.refreshPluginBackgrounds()
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 1)
    f.stopPluginBackground(ID)
    f.state.descriptors[0].buildRevision = 'two'
    f.refreshPluginBackgrounds()
    assert.equal(f.state.subscriptions.filter(value => value.active).length, 1)
    assert.equal(f.state.views.length, 0)
  } finally { f.disposePluginBackgrounds() }
})

test('a short Quick deadline does not kill an in-flight cold migration or enqueue every keystroke', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    const search = f.searchAll('fixture')
    const contents = await ready(f)
    assert.equal(contents.sent[0].kind, 'search')
    await f.advance(1500)
    assert.deepEqual(await search, [{ pluginId: ID, items: [] }])
    assert.equal(contents.isDestroyed(), false)
    assert.equal(f.getBackgroundDiagnostics()[0].pending, 1)
    assert.deepEqual(await f.searchAll('different'), [{ pluginId: ID, items: [] }])
    assert.equal(contents.sent.length, 1)
    respond(f, contents, [{ id: 'fixture-entry', title: 'Fixture result' }])
    await tick()
    assert.equal(f.getBackgroundDiagnostics()[0].completed, 1)
    await f.advance(30000)
    assert.equal(contents.isDestroyed(), true)
  } finally { f.disposePluginBackgrounds() }
})

test('failed native event ACK propagates for retry and retiring the view rejects its pending work', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    const publish = f.state.subscriptions[0].publish({ revision: 1, text: 'synthetic only' })
    const failed = assert.rejects(publish, /fixture persistence/)
    const contents = await ready(f)
    respond(f, contents, 'fixture persistence failed', false)
    await failed
    const call = f.callPluginBackground(ID, 'history.query', [])
    const retired = assert.rejects(call, /fixture revoke/)
    await tick()
    f.stopPluginBackground(ID, 'fixture revoke')
    await retired
    assert.equal(contents.isDestroyed(), true)
    assert.equal(f.getBackgroundDiagnostics().length, 0)
  } finally { f.disposePluginBackgrounds() }
})

test('host requests enforce frame ownership, aggregate byte quotas, defaults, and cancellation', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    const call = f.callPluginBackground(ID, 'history.query', [])
    const callFailure = assert.rejects(call, /fixture stop/)
    const contents = await ready(f)
    const host = f.state.handlers.get('host')
    assert.throws(() => host({ sender: contents, senderFrame: { url: contents.mainFrame.url } }, { method: 'settings.get', args: [] }), /Foreign/)
    const settings = await host(eventFor(contents), { method: 'settings.get', args: [] })
    assert.deepEqual(settings, { monitoring: true, historyLimit: 200 })
    let release
    f.state.readGate = new Promise(resolve => { release = resolve })
    const first = host(eventFor(contents), { method: 'private.readDocument', args: ['x'.repeat(1400)] })
    const firstFailure = assert.rejects(first, /retired/)
    await assert.rejects(host(eventFor(contents), { method: 'private.readDocument', args: ['y'.repeat(1400)] }), /quota/)
    f.stopPluginBackground(ID, 'fixture stop')
    release()
    await Promise.all([firstFailure, callFailure])
  } finally { f.disposePluginBackgrounds() }
})

test('legacy host transfer requires declared permission and persists only a host-derived allowance', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    const call = f.callPluginBackground(ID, 'history.query', [])
    const contents = await ready(f)
    const host = (method, args) => f.state.handlers.get('host')(eventFor(contents), { method, args })
    await host('legacy.read', ['clipboard-history-v1'])
    assert.equal(f.state.allowances.length, 1)
    assert.equal(f.state.allowances[0].bytes, 1234)
    await host('legacy.commit', ['clipboard-history-v1', 'a'.repeat(64)])
    respond(f, contents, null)
    await call
    f.stopPluginBackground(ID)
    assert.throws(() => f.state.legacyGuards[0](), /retired/)
  } finally { f.disposePluginBackgrounds() }
  const unprivileged = await fixture()
  try {
    const manifest = unprivileged.state.descriptors[0].manifest
    manifest.background.events = []
    manifest.background.eventSettings = {}
    manifest.permissions = []
    unprivileged.startPluginBackgrounds()
    const call = unprivileged.callPluginBackground(ID, 'fixture.read', [])
    const contents = await ready(unprivileged)
    await assert.rejects(unprivileged.state.handlers.get('host')(eventFor(contents), { method: 'legacy.read', args: ['clipboard-history-v1'] }), /declared history/)
    respond(unprivileged, contents, null)
    await call
  } finally { unprivileged.disposePluginBackgrounds() }
})

test('source preview backgrounds require a matching bounded built manifest and never use the source protocol mapping', async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'enest-background-build-fixture-'))
  try {
    const descriptor = f.state.descriptors[0]
    descriptor.rootPath = directory
    descriptor.dev = true
    f.state.devSource = true
    assert.throws(() => f.requiredBackgroundPermissions(ID), /matching built output/)
    await mkdir(join(directory, 'dist', 'assets'), { recursive: true })
    await writeFile(join(directory, 'dist', 'plugin.json'), JSON.stringify(descriptor.manifest))
    await writeFile(join(directory, 'dist', 'assets', 'background.html'), '<!doctype html><title>fixture</title>')
    assert.deepEqual(f.requiredBackgroundPermissions(ID), ['clipboard.history'])
    f.startPluginBackgrounds()
    const call = f.callPluginBackground(ID, 'history.query', [])
    const contents = await ready(f)
    await f.state.protocols[0]({ url: contents.mainFrame.url })
    assert.deepEqual(f.state.resolvedFiles[0], { root: join(directory, 'dist'), path: 'assets/background.html', source: false })
    respond(f, contents, null)
    await call
    f.stopPluginBackground(ID)
    descriptor.buildRevision = 'mismatched-build'
    await writeFile(join(directory, 'dist', 'plugin.json'), JSON.stringify({ ...descriptor.manifest, version: 'old' }))
    assert.throws(() => f.requiredBackgroundPermissions(ID), /matching built output/)
    await writeFile(join(directory, 'dist', 'plugin.json'), ' '.repeat(1024 * 1024 + 1))
    assert.throws(() => f.requiredBackgroundPermissions(ID), /matching built output/)
  } finally { f.disposePluginBackgrounds(); await rm(directory, { recursive: true, force: true }) }
})

test('idle generations reuse a per-plugin Session while retired nonce handlers lose all authority', async () => {
  const f = await fixture()
  try {
    f.startPluginBackgrounds()
    const first = f.callPluginBackground(ID, 'history.query', [])
    const oldContents = await ready(f), isolated = f.state.views[0].session, oldHandler = isolated.handler
    respond(f, oldContents, null)
    await first
    await f.advance(30000)
    assert.equal(oldContents.isDestroyed(), true)
    assert.equal(isolated.handler, null)
    assert.equal(isolated.request, null)
    assert.equal(isolated.downloads.size, 0)
    assert.deepEqual(isolated.cleared, [new URL(oldContents.mainFrame.url).origin === 'null'
      ? oldContents.mainFrame.url.split('/').slice(0, 3).join('/') : new URL(oldContents.mainFrame.url).origin])
    const second = f.callPluginBackground(ID, 'history.query', [])
    const newContents = await ready(f)
    assert.equal(f.state.sessions.size, 1)
    assert.equal(f.state.views[1].session, isolated)
    assert.notEqual(newContents.mainFrame.url, oldContents.mainFrame.url)
    assert.equal(isolated.downloads.size, 1)
    assert.equal((await oldHandler({ url: oldContents.mainFrame.url })).status, 403)
    assert.equal((await isolated.handler({ url: oldContents.mainFrame.url })).status, 403)
    respond(f, newContents, null)
    await second
  } finally { f.disposePluginBackgrounds() }
})
