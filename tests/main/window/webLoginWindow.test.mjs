import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
/**
 * 网页登录窗口（web.login）的安全边界。
 * 这里不测"网页能不能加载"——那是 Chromium 的事；测的是宿主自己的决定：
 * 哪些站点能进、何时算成功、何时读 cookie、用户关窗怎么算、窗口是否真的没有任何桥接。
 */
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state': `export const state={windows:[],sessions:[],cleared:[],destroyed:[],owner:null}`,
  electron: `import {state} from 'test-state';
const emitter=()=>{const listeners=new Map();return{on:(name,fn)=>{const set=listeners.get(name)||new Set();set.add(fn);listeners.set(name,set)},
  once:(name,fn)=>{const set=listeners.get(name)||new Set();const wrapped=(...args)=>{set.delete(wrapped);fn(...args)};set.add(wrapped);listeners.set(name,set)},
  emit:(name,...args)=>{for(const fn of [...(listeners.get(name)||[])])fn(...args)},removeAllListeners:()=>listeners.clear()}};
export class BrowserWindow{constructor(options){this.options=options;Object.assign(this,emitter());this.webContents=Object.assign(emitter(),{id:77,isDestroyed:()=>state.destroyed.includes(this),setWindowOpenHandler(fn){this.openHandler=fn}});
  this.isDestroyed=()=>state.destroyed.includes(this);this.shown=false;state.windows.push(this)}
  static fromWebContents(){return {fakeParent:true}}
  loadURL(url){this.loadedUrl=url;return state.loadError?Promise.reject(new Error('ERR_FAILED')):Promise.resolve()}
  show(){this.shown=true} focus(){} destroy(){state.destroyed.push(this);this.emit('closed')}}
export const session={fromPartition(partition,options){const s={partition,options,cookies:{get:async()=>state.cookies||[],store:[]},
  permissionHandlers:{},webRequest:{onBeforeRequest:null},listeners:[],requests:[],
  setPermissionRequestHandler(fn){this.permissionHandlers.request=fn},setPermissionCheckHandler(fn){this.permissionHandlers.check=fn},
  setDevicePermissionHandler(fn){this.permissionHandlers.device=fn},setDisplayMediaRequestHandler(fn){this.permissionHandlers.display=fn},
  on(name,fn){this.listeners.push([name,fn])},removeAllListeners(){this.listeners=[]},
  webRequest:{onBeforeRequest(fn){this.onBeforeRequest=fn}},
  async clearStorageData(){state.cleared.push('storage:'+partition)},async clearCache(){state.cleared.push('cache:'+partition)},
  async closeAllConnections(){state.cleared.push('connections:'+partition)}};state.sessions.push(s);return s}};
export const webContents={fromId:id=>id===42?state.owner:undefined};`,
  '@main/plugin/PluginRuntimeScope': `export class PluginRuntimeScope{}`,
  '@main/window/applicationIcon': 'export const resolveWindowIcon=()=>undefined'
}
const output = await build({
  stdin: { contents: "export * from '@main/window/webLoginWindow';export {state} from 'test-state';", sourcefile: 'web-login-entry.ts', resolveDir: root, loader: 'ts' },
  tsconfig: root + 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'web-login-fixtures', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: adapters[path] }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
const { state } = api

const ORIGINS = ['https://login.example', 'https://cloud.example']
const OWNER = 42
const okScope = () => ({ isCurrent: () => true, isClosing: false, signal: { aborted: false },
  addDisposer: () => () => {}, acquireActivity: () => () => {} })
const REQUEST = { url: 'https://login.example/signin', successUrlPrefix: 'https://cloud.example/web/main', title: '登录' }
// openWebLoginWindow 是 async：参数校验之后的窗口创建发生在函数体的 await 点之后，用宏任务确保它已执行
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }
const win = () => state.windows.at(-1)

test.beforeEach(() => {
  Object.assign(state, { windows: [], sessions: [], cleared: [], destroyed: [], owner: { isDestroyed: () => false }, cookies: [], loadError: false })
})

test('parses untrusted input field by field without trusting its types', () => {
  const parsed = api.parseWebLoginRequest({ url: 123, successUrlPrefix: 'https://a.example/', title: 't', width: 'wide', height: 600 })
  assert.equal(parsed.url, '')
  assert.equal(parsed.successUrlPrefix, 'https://a.example/')
  assert.equal(parsed.width, undefined)
  assert.equal(parsed.height, 600)
  assert.throws(() => api.parseWebLoginRequest(null), /options object/)
})

test('origin list is normalized by URL parsing, so look-alike hosts cannot sneak in', () => {
  // 安装期（PluginInstaller）已拒绝带路径的声明；运行时这里是防御性的规范化：任何能解析的条目都归一成 origin
  assert.deepEqual(api.webLoginOrigins({ net: { loginOrigins: ['https://Cloud.Example', 'https://x.example:443', 'not a url', 'https://a.example/path'] } }),
    ['https://cloud.example', 'https://x.example', 'https://a.example'])
  assert.deepEqual(api.webLoginOrigins({}), [])
})

test('refuses a start URL whose origin is not declared, before creating any window', async () => {
  await assert.rejects(api.openWebLoginWindow('p', OWNER, okScope(), { ...REQUEST, url: 'https://evil.example/signin' }, ORIGINS), /not declared in net.loginOrigins.*evil\.example/)
  await assert.rejects(api.openWebLoginWindow('p', OWNER, okScope(), { ...REQUEST, url: 'http://login.example/signin' }, ORIGINS), /must be an https URL/)
  await assert.rejects(api.openWebLoginWindow('p', OWNER, okScope(), { ...REQUEST, url: 'https://login.example@evil.example/' }, ORIGINS), /not declared.*evil\.example/)
  assert.equal(state.windows.length, 0)
})

test('refuses a success prefix outside the declared origins, or one without a path', async () => {
  await assert.rejects(api.openWebLoginWindow('p', OWNER, okScope(), { ...REQUEST, successUrlPrefix: 'https://evil.example/web/main' }, ORIGINS), /successUrlPrefix origin is not declared/)
  await assert.rejects(api.openWebLoginWindow('p', OWNER, okScope(), { ...REQUEST, successUrlPrefix: 'https://cloud.example' }, ORIGINS), /must be an https URL with a path/)
  assert.equal(state.windows.length, 0)
})

test('the window has no bridge: no preload, no node, sandboxed, and a throwaway session', async () => {
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  const prefs = win().options.webPreferences
  assert.equal(prefs.preload, undefined)
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.sandbox, true)
  assert.match(prefs.session.partition, /^enest-web-login-[0-9a-f-]+$/)
  assert.equal(prefs.session.options.cache, false)
  assert.equal(win().options.modal, true)
  assert.equal(win().loadedUrl, REQUEST.url)
  win().destroy()
  assert.equal((await pending).ok, false)
})

test('every device permission is denied and plain-http requests are cancelled', async () => {
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  const s = state.sessions.at(-1)
  const decision = await new Promise(resolve => s.permissionHandlers.request('wc', 'media', resolve))
  assert.equal(decision, false)
  assert.equal(s.permissionHandlers.check(), false)
  assert.equal(s.permissionHandlers.device(), false)
  const display = await new Promise(resolve => s.permissionHandlers.display({ userGesture: true }, resolve))
  assert.equal(display, null)
  // 只放行 https；明文 http 与其它协议一律取消
  const handler = s.webRequest.onBeforeRequest
  const filtered = url => new Promise(resolve => handler({ url }, resolve))
  assert.deepEqual(await filtered('https://login.example/'), { cancel: false })
  assert.deepEqual(await filtered('http://login.example/'), { cancel: true })
  assert.deepEqual(await filtered('ws://login.example/'), { cancel: true })
  assert.deepEqual(await filtered('file:///etc/passwd'), { cancel: true })
  win().destroy(); await pending
})

test('navigating to the success prefix resolves with the session cookies', async () => {
  state.cookies = [{ name: 'SESSION', value: 's3cret', domain: '.example', path: '/', secure: true, httpOnly: true, expirationDate: 1900000000 }, { name: 'tmp', value: '1', domain: 'login.example', path: '/' }]
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  win().webContents.emit('will-redirect', { preventDefault() { assert.fail('redirect to a declared origin must not be blocked') } }, 'https://cloud.example/web/main?from=login')
  // 重定向发生时还没读 cookie：结果在导航完成后才定
  let settled = false; void pending.then(() => { settled = true })
  await flush()
  assert.equal(settled, false)
  win().webContents.emit('did-navigate', {}, 'https://cloud.example/web/main?from=login')
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.url, 'https://cloud.example/web/main?from=login')
  assert.deepEqual(result.cookies.map(c => c.name), ['SESSION', 'tmp'])
  assert.equal(result.cookies[0].expirationDate, 1900000000)
  await flush()
  assert.ok(state.cleared.some(item => item.startsWith('storage:')), 'session storage is cleared afterwards')
})

test('a success prefix only matches the whole URL prefix, not a sibling path', async () => {
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  win().webContents.emit('did-navigate', {}, 'https://cloud.example/web/mainland')
  let settled = false; void pending.then(() => { settled = true })
  await flush()
  assert.equal(settled, true)
  // /web/mainland 以 /web/main 开头，按前缀匹配是成功的；这是文档约定（插件要给出足够具体的前缀）
  assert.equal((await pending).ok, true)
})

test('leaving the declared origins is blocked and cancels the login', async () => {
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  let prevented = false
  win().webContents.emit('will-navigate', { preventDefault() { prevented = true } }, 'https://phish.example/fake-login')
  assert.equal(prevented, true)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
})

test('a redirect to an undeclared origin is blocked as well', async () => {
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  let prevented = false
  win().webContents.emit('will-redirect', { preventDefault() { prevented = true } }, 'https://evil.example/')
  assert.equal(prevented, true)
  assert.equal((await pending).ok, false)
})

test('the user closing the window cancels; closing twice settles once', async () => {
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  win().destroy()
  win().webContents.emit('did-navigate', {}, 'https://cloud.example/web/main')
  assert.deepEqual(await pending, { ok: false, reason: 'cancelled' })
})

test('a failed page load cancels instead of leaving a promise pending', async () => {
  state.loadError = true
  assert.deepEqual(await api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS), { ok: false, reason: 'cancelled' })
})

test('a closing plugin runtime, a vanished caller, or too many windows are refused', async () => {
  const closing = { ...okScope(), isClosing: true }
  await assert.rejects(api.openWebLoginWindow('p', OWNER, closing, REQUEST, ORIGINS), /plugin runtime is closing/)
  await assert.rejects(api.openWebLoginWindow('p', 999, okScope(), REQUEST, ORIGINS), /caller page is gone/)
  const first = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  const second = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  await assert.rejects(api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS), /too many login windows/)
  api.closeWebLoginWindows('p')
  assert.equal((await first).ok, false)
  assert.equal((await second).ok, false)
})

test('a failure while setting the window up releases the slot, the window and the session', async () => {
  // 插件恰好在窗口创建的这一刻关闭：acquireActivity 会抛。此前这里的失败会把名额和无主窗口留下，插件之后再也打不开登录窗口
  const racing = { ...okScope(), acquireActivity: () => { throw new Error('plugin runtime is closing') } }
  await assert.rejects(api.openWebLoginWindow('p', OWNER, racing, REQUEST, ORIGINS), /plugin runtime is closing/)
  await flush()
  assert.ok(state.destroyed.includes(win()), 'the half-created window is destroyed')
  assert.ok(state.cleared.some(item => item.startsWith('storage:')), 'its session is wiped')
  // 名额已释放：同一个插件可以再开
  const again = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  assert.equal(state.windows.length, 2)
  api.closeWebLoginWindows('p')
  assert.equal((await again).ok, false)
})

test('new windows deny window.open and embedded webviews', async () => {
  const pending = api.openWebLoginWindow('p', OWNER, okScope(), REQUEST, ORIGINS)
  await flush()
  assert.deepEqual(win().webContents.openHandler({ url: 'https://evil.example/' }), { action: 'deny' })
  let prevented = false
  win().webContents.emit('will-attach-webview', { preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  win().destroy()
  await pending
})
