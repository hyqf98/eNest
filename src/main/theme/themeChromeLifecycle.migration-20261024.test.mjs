import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const tick = () => new Promise(resolve => setImmediate(resolve))
const mockSource = `
import {EventEmitter} from 'node:events';
export const ThemeChromeChannels={Snapshot:'snapshot',Ready:'ready',Action:'action',Changed:'changed'};
export const state={source:'fixture.provider-a',themeId:'theme-a',entry:'assets/chrome.html',build:'one',enabled:true,sessions:new Map(),views:[],handlers:new Map(),readGate:null,readCount:0};
export const realpath=async value=>value;
export const pluginRegistry={getAssetRootPath:id=>'/fixture/'+id,getBuildRevision:()=>state.build,isEnabled:()=>state.enabled,getManifest:()=>({})};
const chrome=()=>({version:1,classic:{entry:state.entry},rail:{entry:state.entry},dock:{entry:state.entry}});
export const appearanceService={getAppearance:()=>({theme:{source:state.source,id:state.themeId,version:1},chrome:chrome()})};
export const themePackRegistry={get:()=>({source:state.source,chrome:chrome()})};
export const getMainWindow=()=>({isFocused:()=>true});
export const resolvePreload=name=>'/fixture/'+name;
export const sendShellEvent=()=>{};
export const logInfo=()=>{};export const logWarn=()=>{};
export const THEME_CHROME_SCHEME='enest-chrome';
export const chromeAssetPath=value=>typeof value==='string'&&!value.includes('..');
export const chromeAssetUrl=(key,entry)=>'enest-chrome://'+key+'/'+entry;
export const parseChromeAssetUrl=(raw,key)=>{const url=new URL(raw);return url.protocol==='enest-chrome:'&&url.hostname===key&&!url.search&&!url.hash?url.pathname.slice(1):null};
export const chromeAssetResponse=(request,status,body)=>new Response(body,{status});
export const readChromeAsset=async()=>{state.readCount++;if(state.readGate)await state.readGate;return Buffer.from('<!doctype html><title>fixture</title>')};
export const ipcMain={handle:(name,handler)=>state.handlers.set(name,handler)};
export const pluginHost={hasShellTab:()=>true};
export const navigateWorkspace=async()=>{};export const openShellSettings=()=>{};
export const session={fromPartition:key=>{if(!state.sessions.has(key)){const value=new EventEmitter();Object.assign(value,{key,request:null,handler:null,cleared:[],setPermissionRequestHandler(fn){this.permissionRequest=fn},setPermissionCheckHandler(fn){this.permissionCheck=fn},clearStorageData(options){this.cleared.push(options);return Promise.resolve()}});value.webRequest={onBeforeRequest:fn=>{value.request=fn}};value.protocol={handle:(_scheme,fn)=>{value.handler=fn},unhandle:()=>{value.handler=null}};state.sessions.set(key,value)}return state.sessions.get(key)}};
export class WebContentsView{constructor(options){const contents=new EventEmitter();Object.assign(contents,{id:state.views.length+1,session:options.webPreferences.session,mainFrame:{url:'',detached:false},destroyed:false,isDestroyed(){return this.destroyed},setWebRTCIPHandlingPolicy(){},setWindowOpenHandler(){},send(){},loadURL(url){this.mainFrame.url=url;return Promise.resolve()},close(){if(this.destroyed)return;this.destroyed=true;this.emit('destroyed')}});this.webContents=contents;state.views.push(this)}setBackgroundColor(){}setVisible(value){this.visible=value}getVisible(){return this.visible}}
`

async function fixture() {
  const mocks = new Set(['fixture', 'electron', 'node:fs/promises', '@shared/types/themeChrome', '@main/plugin/PluginRegistry',
    '@main/window/createShellWindow', '@main/logs/logService', './appearanceService', './themePacks', './themeChromeAssets',
    '@main/plugin/PluginHost', '@main/ipc/shellHandlers'])
  const result = await build({
    stdin: { contents: `export * from './src/main/theme/themeChromeSurface.ts';export {state} from 'fixture';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'chrome-session-fixture', setup(api) {
      api.onResolve({ filter: /.*/ }, ({ path }) => mocks.has(path) ? { path: 'fixture', namespace: 'fixture' } : null)
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mockSource, loader: 'js' }))
    } }],
  })
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
  const surfaces = []
  const open = (part = 'classic') => {
    const surface = new api.ThemeChromeSurface(part, api.selectThemeChrome(part), {
      state: () => ({ view: 'home', tabStyle: 'classic', activeTabId: null, animationLevel: 'low', theme: { mode: 'light', tokens: {} }, tabs: [], contribEntries: [] }),
      active: () => true, expand() {}, changed() {}, failed() {},
    })
    surfaces.push(surface)
    return surface
  }
  return { ...api, open, close: () => surfaces.forEach(surface => surface.dispose()) }
}

test('real chrome asset URLs isolate generations by origin and preserve canonical local-only validation', async () => {
  const result = await build({ entryPoints: ['src/main/theme/themeChromeAssets.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node', alias: { '@shared': resolve('src/shared') } })
  const assets = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const first = 'a'.repeat(48), second = 'b'.repeat(48)
  const url = assets.chromeAssetUrl(first, 'assets/chrome.html')
  assert.equal(new URL(url).hostname, first)
  assert.notEqual(new URL(url).host, new URL(assets.chromeAssetUrl(second, 'assets/chrome.html')).host)
  assert.equal(assets.parseChromeAssetUrl(url, first), 'assets/chrome.html')
  for (const denied of [assets.chromeAssetUrl(second, 'assets/chrome.html'), url + '?q=1', url + '#fragment',
    `enest-chrome://surface/${first}/assets/chrome.html`, `enest-chrome://${first}/assets%2fchrome.html`,
    `enest-chrome://${first}/plugin.json`]) assert.equal(assets.parseChromeAssetUrl(denied, first), null)
  const policy = assets.chromeAssetResponse(new Request(url), 200, 'fixture', 'assets/chrome.html').headers.get('Content-Security-Policy')
  assert.match(policy, /script-src 'self'/)
  assert.match(policy, /connect-src 'self'/)
  assert.doesNotMatch(policy, /https?:|unsafe-eval|\*/)
})

test('chrome reuses one partition per provider and part instead of one per activation', async () => {
  const f = await fixture()
  try {
    const urls = new Set()
    for (let index = 0; index < 6; index++) {
      const surface = f.open()
      urls.add(surface.view.webContents.mainFrame.url)
      surface.dispose()
    }
    assert.equal(f.state.sessions.size, 1)
    assert.equal(urls.size, 6, 'each activation must retain its own unguessable asset origin')
    f.open('rail').dispose()
    f.state.source = 'fixture.provider-b'
    f.open().dispose()
    assert.equal(f.state.sessions.size, 3, 'different providers and parts never share a partition')
  } finally { f.close() }
})

test('retirement removes session closures and retains deny-by-default permissions', async () => {
  const f = await fixture()
  try {
    const surface = f.open(), contents = surface.view.webContents, isolated = contents.session
    const origin = contents.mainFrame.url.split('/').slice(0, 3).join('/')
    assert.equal(isolated.listenerCount('will-download'), 1)
    surface.dispose()
    assert.equal(contents.isDestroyed(), true)
    assert.equal(isolated.request, null)
    assert.equal(isolated.handler, null)
    assert.equal(isolated.listenerCount('will-download'), 0)
    assert.equal(isolated.permissionCheck(), false)
    let allowed
    isolated.permissionRequest(null, 'clipboard-read', value => { allowed = value })
    assert.equal(allowed, false)
    assert.deepEqual(isolated.cleared, [{ origin }])
  } finally { f.close() }
})

test('a replacement owns the stable session and retired callbacks cannot resurrect the old origin', async () => {
  const f = await fixture()
  try {
    const old = f.open(), contents = old.view.webContents, isolated = contents.session
    const oldUrl = contents.mainFrame.url, oldRequest = isolated.request, oldProtocol = isolated.handler
    let release
    f.state.readGate = new Promise(resolve => { release = resolve })
    const response = oldProtocol(new Request(oldUrl))
    await tick()
    assert.equal(f.state.readCount, 1)
    const next = f.open(), nextHandler = isolated.handler, nextRequest = isolated.request
    assert.equal(old.current(), false)
    assert.equal(next.current(), true)
    assert.equal(f.state.sessions.size, 1)
    assert.notEqual(next.view.webContents.mainFrame.url, oldUrl)
    let cancelled
    oldRequest({ url: oldUrl, method: 'GET', resourceType: 'mainFrame', webContentsId: contents.id, frame: contents.mainFrame }, value => { cancelled = value.cancel })
    assert.equal(cancelled, true)
    release()
    assert.equal((await response).status, 403)
    old.dispose()
    assert.equal(isolated.handler, nextHandler)
    assert.equal(isolated.request, nextRequest)
    assert.equal(isolated.listenerCount('will-download'), 1)
    assert.equal((await nextHandler(new Request(oldUrl))).status, 403)
    assert.equal((await nextHandler(new Request(next.view.webContents.mainFrame.url))).status, 200)
  } finally { f.close() }
})

test('disposing a previous provider cannot clear or detach a different provider session', async () => {
  const f = await fixture()
  try {
    const old = f.open(), previous = old.view.webContents.session
    f.state.source = 'fixture.provider-b'
    const next = f.open(), current = next.view.webContents.session
    const handler = current.handler
    old.dispose()
    assert.notEqual(previous, current)
    assert.equal(current.handler, handler)
    assert.equal(current.listenerCount('will-download'), 1)
    assert.deepEqual(current.cleared, [])
    assert.equal(next.current(), true)
  } finally { f.close() }
})
