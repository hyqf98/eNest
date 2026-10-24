import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const THEME = 'fixture.theme', PLUGIN = 'fixture.business'
const generation = 'fixture_generation_0123456789'
const tick = () => new Promise(resolve => setImmediate(resolve))

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-settings-fixture-'))
  await mkdir(join(directory, 'assets'))
  await writeFile(join(directory, 'assets', 'settings.html'), '<!doctype html><html><body>fixture settings</body></html>')
  await writeFile(join(directory, 'assets', 'style.css'), 'body{color:rgb(1,2,3)}')
  await writeFile(join(directory, 'assets', 'other.html'), '<!doctype html><title>not the selected entry</title>')
  const sources = `
export const IpcChannels={ThemeSettingsConfig:'config',ThemeSettingsSnapshot:'snapshot',ThemeSettingsActive:'active',ThemeSettingsAction:'action',ShellEvent:'shell-event'};
export const state={root:${JSON.stringify(directory)},theme:${JSON.stringify(THEME)},plugin:${JSON.stringify(PLUGIN)},build:'one',themeEnabled:true,pluginEnabled:true,visible:true,focused:true,destroyed:false,handlers:new Map(),protocol:null,modalResult:true,modalCount:0,writes:[],bridgeWrites:[],events:[],backgroundRefreshes:0,appearanceWrites:[],generalWrites:[],all:{general:{locale:'zh-CN',closeBehavior:'minimize-tray',notifyPosition:'bottom-right',proxy:{secret:'FIXTURE_PRIVATE_PROXY'}},plugins:{${JSON.stringify(PLUGIN)}:{safe:true,level:3,hiddenSwitch:true,password:'FIXTURE_PRIVATE_PASSWORD',permissionGrants:{'backend.node':'allow'}}}},sections:[{pluginId:${JSON.stringify(PLUGIN)},id:'settings',title:'Fixture settings',items:[{key:'safe',type:'switch',label:'Safe public switch',default:false,shareWithThemes:true},{key:'level',type:'number',label:'Safe level',default:3,min:0,max:10,shareWithThemes:true},{key:'hiddenSwitch',type:'switch',label:'Private switch',default:false},{key:'password',type:'text',label:'Private password',default:'FIXTURE_PRIVATE_DEFAULT'},{key:'permissionGrants',type:'switch',label:'Reserved',default:false,shareWithThemes:true}]}]};
export const appearance={theme:{source:state.theme,id:'fixture',version:'1.0.0'},mode:'light',tokens:{accent:'#123456'},fonts:{body:'serif',heading:'serif',mono:'monospace',cjk:'serif',latin:'serif',scale:1},components:{controlRadius:8,cardRadius:12,panelRadius:16,borderWidth:1},animation:{effective:'low'}};
export const pack={source:state.theme,id:'fixture',schemaVersion:2,settingsPage:{version:1,entry:'assets/settings.html'},settings:{groups:[]}};
export const themeProfileKey=theme=>theme.source+'/'+theme.id;
export const isPluginSettingKey=value=>typeof value==='string'&&!!value&&!['permissionGrants','__proto__','prototype','constructor'].includes(value);
export const isPluginAssetPath=value=>typeof value==='string'&&!!value&&!value.startsWith('/')&&!value.includes('..')&&!value.includes('\\\\')&&!value.includes('\\0');
export const parseThemeColor=value=>/^#[a-f0-9]{6}$/i.test(value);
export const pluginRegistry={getAssetRootPath:()=>state.root,getBuildRevision:()=>state.build,isEnabled:id=>id===state.theme?state.themeEnabled:state.pluginEnabled,onInstalledChanged:fn=>{state.registryListener=fn;return()=>{}},getInstalledDescriptors:()=>[{id:state.theme,enabled:state.themeEnabled,manifest:{name:'Fixture theme'}},{id:state.plugin,enabled:state.pluginEnabled,manifest:{name:'Fixture business'}}]};
export const settingsStore={getAll:()=>state.all,getAppearanceSettings:()=>({profiles:{}}),setPluginSetting:async(id,key,value)=>{state.writes.push({id,key,value});state.all.plugins[id][key]=value},commitGeneralPreferences:patch=>{state.generalWrites.push(patch);Object.assign(state.all.general,patch)}};
export const pluginSettingsBridge={listAll:()=>state.sections,isWritableKey:(id,key)=>state.sections.some(section=>section.pluginId===id&&section.items.some(item=>item.key===key&&item.type!=='page')),set:(id,key,value)=>state.bridgeWrites.push({id,key,value})};
export const pluginHost={sendEvent:(id,event)=>state.events.push({id,event})};
export const refreshPluginBackgrounds=()=>{state.backgroundRefreshes++};
export const openNativeModal=async()=>{state.modalCount++;return state.modalResult};
export const getMainWindow=()=>({isDestroyed:()=>state.destroyed,isVisible:()=>state.visible,isFocused:()=>state.focused});
export const sendShellEvent=event=>state.events.push({shell:true,event});
export const handleShellIpc=(channel,handler)=>state.handlers.set(channel,handler);
export const appearanceService={getAppearance:()=>appearance,subscribeAppearance:fn=>{state.appearanceListener=fn;return()=>{}},updateThemeProfile:patch=>state.appearanceWrites.push(patch)};
export const themePackRegistry={list:()=>[pack]};
export const publicAppearance=value=>({mode:value.mode,tokens:value.tokens,fonts:{},components:{},animation:'low',resources:{fonts:[]}});
export const broadcastPluginLocale=()=>{};
`
  const mocks = new Set(['fixture', '@shared/types/ipc', '@shared/theme/appearance', '@shared/pluginSettingsKeys', '@shared/pluginContract', '@shared/theme/colors',
    '@main/plugin/PluginRegistry', '@main/settings/SettingsStore', '@main/settings/PluginSettingsBridge', '@main/plugin/PluginHost', '@main/plugin/pluginBackgroundRuntime',
    '@main/window/modalSurface', '@main/window/createShellWindow', '@main/ipc/ipcSecurity', './appearanceService', './themePacks', './quickThemeProtocol', '@main/ipc/pluginHandlers'])
  const result = await build({
    stdin: { contents: `export * from './src/main/theme/themeSettingsSurface.ts';export {state,appearance,pack} from 'fixture';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'theme-settings-fixture', setup(api) {
      api.onResolve({ filter: /.*/ }, ({ path }) => mocks.has(path) ? { path: 'fixture', namespace: 'fixture' } : null)
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: sources, loader: 'js' }))
    } }]
  })
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
  const contents = Object.assign(new EventEmitter(), {
    id: 71, mainFrame: { frameTreeNodeId: 10, url: 'enest-shell://fixture' }, focusedFrame: null,
    session: { protocol: { handle(_scheme, handler) { api.state.protocol = handler } } },
    isDestroyed: () => api.state.destroyed, send() {}, setWindowOpenHandler(handler) { this.popupPolicy = handler }
  })
  api.registerThemeSettingsPolicy(contents)
  api.registerThemeSettingsHandlers()
  const config = await api.getThemeSettingsConfig()
  assert.ok(config, 'synthetic built theme entry must be loadable')
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const invoke = (channel, ...args) => api.state.handlers.get(channel)(event, ...args)
  const activate = (active = true, nextGeneration = generation) => {
    contents.focusedFrame = { parent: contents.mainFrame, detached: false, frameTreeNodeId: 11, url: `${config.url}#generation=${nextGeneration}` }
    return invoke('active', { key: config.key, active, generation: nextGeneration, bounds: { x: 0, y: 0, width: 500, height: 400 } })
  }
  const gesture = () => contents.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter', isAutoRepeat: false, isComposing: false })
  activate()
  return { ...api, config, directory, contents, invoke, activate, gesture, cleanup: async () => { contents.emit('destroyed'); await rm(directory, { recursive: true, force: true }) } }
}
const pluginField = (f, label) => f.invoke('snapshot', f.config.key).groups.flatMap(group => group.fields).find(field => field.label === label)

test('theme snapshots expose only explicit safe plugin fields, never raw private settings or reserved grants', async () => {
  const f = await fixture()
  try {
    const snapshot = f.invoke('snapshot', f.config.key), serialized = JSON.stringify(snapshot)
    const rows = snapshot.groups.filter(group => group.id.startsWith('plugin:')).flatMap(group => group.fields)
    assert.deepEqual(rows.map(row => row.label), ['Safe public switch', 'Safe level'])
    assert.ok(rows.every(row => row.confirmation === true))
    assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.id)))
    assert.equal(serialized.includes('FIXTURE_PRIVATE'), false)
    assert.equal(serialized.includes('permissionGrants'), false)
    assert.equal(serialized.includes(f.directory), false)
    f.state.sections[0].items[0].shareWithThemes = false
    assert.equal(pluginField(f, 'Safe public switch'), undefined)
  } finally { await f.cleanup() }
})

test('selected settings assets reuse canonical bounded reads and reject alternate HTML, symlinks, source and traversal', async () => {
  const f = await fixture()
  try {
    const request = (url, method = 'GET') => f.state.protocol({ url, method })
    const response = await request(f.config.url)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Security-Policy'), /sandbox allow-scripts/)
    assert.match(response.headers.get('Content-Security-Policy'), /frame-src 'none'/)
    assert.match(await response.text(), /__bridge\.js/)
    const base = f.config.url.slice(0, f.config.url.lastIndexOf('/') + 1)
    assert.equal((await request(`${base}style.css`)).status, 200)
    assert.equal((await request(`${base}other.html`)).status, 403)
    assert.equal((await request(f.config.url, 'POST')).status, 403)
    assert.equal(await (await request(f.config.url, 'HEAD')).text(), '')
    await writeFile(join(f.directory, 'outside.json'), '{"fixture":"not a served symlink target"}')
    await symlink('../outside.json', join(f.directory, 'assets', 'linked.json'))
    assert.equal((await request(`${base}linked.json`)).status, 403)
    const root = f.config.url.split('/').slice(0, 4).join('/')
    for (const path of ['backend/config.json', 'src/private.js', 'plugin.json', 'assets/%2e%2e%2foutside.json']) {
      assert.equal((await request(`${root}/${path}`)).status, 403)
    }
    const bridge = await request(`${root}/__bridge.js`)
    const source = await bridge.text()
    assert.equal(bridge.status, 200)
    assert.match(source, /enestSettings/)
    assert.doesNotMatch(source, /enestQuick/)
  } finally { await f.cleanup() }
})

test('writes require an actual direct-frame native gesture and consume it once', async () => {
  const f = await fixture()
  try {
    const snapshot = f.invoke('snapshot', f.config.key), field = snapshot.groups[0].fields[1]
    const action = { type: 'set', fieldId: field.id, value: 'quit' }
    assert.equal((await f.invoke('action', f.config.key, action)).ok, false)
    f.contents.focusedFrame.parent = { frameTreeNodeId: 999 }
    f.gesture()
    assert.equal((await f.invoke('action', f.config.key, action)).ok, false)
    f.activate(); f.gesture()
    assert.equal((await f.invoke('action', f.config.key, action)).ok, true)
    assert.equal((await f.invoke('action', f.config.key, action)).ok, false)
    assert.deepEqual(f.state.generalWrites, [{ closeBehavior: 'quit' }])
    f.state.focused = false; f.gesture()
    assert.equal((await f.invoke('action', f.config.key, action)).ok, false)
  } finally { await f.cleanup() }
})

test('another plugin setting requires native confirmation and cancellation writes nothing', async () => {
  const f = await fixture()
  try {
    const field = pluginField(f, 'Safe public switch'), action = { type: 'set', fieldId: field.id, value: false }
    f.state.modalResult = false; f.gesture()
    assert.equal((await f.invoke('action', f.config.key, action)).ok, false)
    assert.equal(f.state.modalCount, 1)
    assert.deepEqual(f.state.writes, [])
    f.state.modalResult = true; f.gesture()
    assert.equal((await f.invoke('action', f.config.key, action)).ok, true)
    assert.deepEqual(f.state.writes, [{ id: PLUGIN, key: 'safe', value: false }])
  } finally { await f.cleanup() }
})

test('revoking shareWithThemes while native confirmation is open prevents the late write', async () => {
  const f = await fixture()
  try {
    const field = pluginField(f, 'Safe public switch')
    let finish
    f.state.modalResult = new Promise(resolve => { finish = resolve })
    f.gesture()
    const action = f.invoke('action', f.config.key, { type: 'set', fieldId: field.id, value: false })
    await tick()
    f.state.sections[0].items[0].shareWithThemes = false
    finish(true)
    assert.equal((await action).ok, false)
    assert.deepEqual(f.state.writes, [])
    assert.deepEqual(f.state.bridgeWrites, [])
  } finally { await f.cleanup() }
})

test('schema changes during confirmation are revalidated, including the new numeric limits', async () => {
  const f = await fixture()
  try {
    const field = pluginField(f, 'Safe level')
    let finish
    f.state.modalResult = new Promise(resolve => { finish = resolve })
    f.gesture()
    const action = f.invoke('action', f.config.key, { type: 'set', fieldId: field.id, value: 9 })
    await tick()
    f.state.sections[0].items[1].max = 5
    finish(true)
    assert.equal((await action).ok, false)
    assert.deepEqual(f.state.writes, [])
  } finally { await f.cleanup() }
})

test('closing and reopening the iframe cannot lend a fresh surface lifetime to an old confirmation', async () => {
  const f = await fixture()
  try {
    const field = pluginField(f, 'Safe public switch')
    let finish
    f.state.modalResult = new Promise(resolve => { finish = resolve })
    f.gesture()
    const action = f.invoke('action', f.config.key, { type: 'set', fieldId: field.id, value: false })
    await tick()
    f.activate(false)
    f.activate(true, 'fixture_new_generation_0123456789')
    finish(true)
    assert.equal((await action).ok, false)
    assert.deepEqual(f.state.writes, [])
  } finally { await f.cleanup() }
})

test('theme build changes and disabled target plugins retire pending writes and old asset grants', async () => {
  const f = await fixture()
  try {
    const field = pluginField(f, 'Safe public switch')
    let finish
    f.state.modalResult = new Promise(resolve => { finish = resolve })
    f.gesture()
    const action = f.invoke('action', f.config.key, { type: 'set', fieldId: field.id, value: false })
    await tick()
    f.state.pluginEnabled = false
    f.state.build = 'new-build'
    f.state.registryListener?.()
    finish(true)
    assert.equal((await action).ok, false)
    assert.deepEqual(f.state.writes, [])
    assert.equal((await f.state.protocol({ url: f.config.url, method: 'GET' })).status, 403)
  } finally { await f.cleanup() }
})
