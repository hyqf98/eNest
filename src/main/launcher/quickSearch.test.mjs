// Run: node --test src/main/launcher/quickSearch.test.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state': `export const state = { handlers: new Map(), events: [], opened: [], manifests: [], apps: [], cache: null, recent: [], queryPreferences:[], scans: 0, hidden: 0, focused: 0, launchError: '', launched: [], aliases: {}, launchModes: {}, providers:[], providerQueries:[], providerFn:null };`,
  electron: `import { state } from 'test-state'; export const ipcMain = { handle: (id, handler) => state.handlers.set(id, handler), on() {} }; export const shell = { openExternal: async () => {} };`,
  PluginRegistry: `import { state } from 'test-state'; export const pluginRegistry = { list: () => state.manifests.map(m => ({ ...m, installed: true, rootPath: '/plugins/'+m.id })), getManifest: id => state.manifests.find(m => m.id === id), get: id => state.manifests.find(m => m.id === id), getInstalledRevision: () => JSON.stringify(state.manifests), getInstalledDescriptors: () => state.manifests.map(m => ({ id: m.id, manifest: m, rootPath: '/plugins/'+m.id, enabled: m.enabled !== false })) };`,
  appScanner: `import { state } from 'test-state'; export const getCachedApps = () => state.cache; export const scanApplications = async () => { state.scans++; await Promise.resolve(); return state.cache = { apps: state.apps, complete: true, errors: [] }; };`,
  appLauncher: `import { state } from 'test-state'; export const getAppIconDataUrl = async path => {state.iconCalls++;return state.iconFn?state.iconFn(path):'icon:'+path}; export const launchLocalApp = async path => { if(state.launchError) throw new Error(state.launchError); state.launched.push(path); };`,
  quickProviders: `import {state} from 'test-state';export const queryQuickProviders = async (query,signal) => {state.providerQueries.push(query);return state.providerFn?state.providerFn(query,signal):state.providers};`,
  PluginHost: `import { state } from 'test-state'; export const pluginHost = { getPlacement: () => ({kind:'quick'}), openPlugin: async (...args) => { state.opened.push(args); return 't-'+args[0]; }, getQuickPlugin: () => null, dismissQuickPlugin: id => state.events.push(['dismiss',id]), pinToShell: id => state.events.push(['pin',id]) };`,
  quickInputService: `export const getQuickInputState=()=>null; export const handleQuickInput=()=>false;`,
  createQuickWindow: `export const getQuickWindow=()=>({webContents:{id:1}}); import { state } from 'test-state'; export const hideQuickWindow = () => state.hidden++; export const setQuickContentHeight = () => {}; export const toggleQuickWindow = () => {};`,
  createShellWindow: `import { state } from 'test-state'; export const sendShellEvent = event => state.events.push(event); export const getMainWindow = () => ({ isDestroyed: () => false, isMinimized: () => false, show: () => state.shown++, focus: () => state.focused++ });`,
  pluginLaunchHotkeys: `import {state} from 'test-state'; export const getPluginLaunchAliases = id => state.aliases?.[id] ?? []; export const getPluginLaunchAliasRevision = () => JSON.stringify(state.aliases ?? {}); export const resolveLaunchMode = id => state.launchModes?.[id];`,
  PluginRuntimeScope: `import { state } from 'test-state'; export const getRuntimeScope = id => state.scopeMissing ? null : ({ isCurrent: () => true, isClosing: false, owner: { generation: 7, pluginId: id }, addDisposer: fn => { state.scopeDisposers = (state.scopeDisposers ?? []).concat([fn]) } });`,
  pluginLauncher: `import {state} from 'test-state';export async function launchPlugin({pluginId,mode,source,enter}){if(source!=='quick')throw Error('wrong launch source');const container=mode??state.launchModes[pluginId]??'quick';state.opened.push([pluginId,enter,{container}]);if(container==='shell'){state.hidden++;state.focused++}return {ok:true}}`,
  quickInputContext: `import { state } from 'test-state';
    export const buildQuickEnterInput = async (pluginId, selection) => {
      if (!selection) return undefined
      state.contextBuilds = (state.contextBuilds ?? []).concat([selection])
      return { ...(selection.text ? { text: selection.text } : {}), ...(selection.imageIds?.length ? { images: selection.imageIds.map(() => ({ dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 })) } : {}), ...(selection.fileIds?.length ? { files: selection.fileIds.map(() => ({ handleId: 'h', path: '/tmp/x', name: 'x', size: 1, kind: 'file' })) } : {}) }
    }
    export const listQuickInputContext = () => state.contextItems ?? []
    export const readClipboardIntoContext = async () => { state.clipboardReads = (state.clipboardReads ?? 0) + 1; return state.clipboardAdded ?? [] }
    export const removeQuickInputContext = (id) => { state.contextRemoved = (state.contextRemoved ?? 0) + 1; if (id) state.contextItems = (state.contextItems ?? []).filter(item => item.id !== id); else state.contextItems = []; return state.contextItems ?? [] }
    export const rememberQuickEnterInput = (pluginId) => { state.contextIssued = pluginId }
    export const forgetQuickEnterInput = () => { state.contextIssued = null }
    export const clearQuickInputContext = () => { state.contextItems = []; state.contextCleared = (state.contextCleared ?? 0) + 1 }
    export const hasQuickImageContext = () => (state.contextItems ?? []).length > 0
    export const addQuickImage = () => null
    export const addQuickFiles = async () => []
    export const readQuickEnterInput = () => null`,
  quickHotkey: `export const saveQuickHotkeys = value => value; export const getQuickHotkeyConfig = () => ({}); export const probeHotkey = () => ({});`,
  SettingsStore: `import { state } from 'test-state'; export const settingsStore = {
    getPluginLaunchSettings: () => ({}), getPluginLaunchConfig: () => undefined, getPluginLaunchRevision: () => 0,
    getQuickLauncherSettings:()=>({recent:state.recent,queryPreferences:state.queryPreferences}),
    recordQuickUse:(id,query,limit)=>{const count=state.recent.find(item=>item.id===id)?.count??0;state.recent=[{id,ts:Date.now(),count:count+1},...state.recent.filter(item=>item.id!==id)].slice(0,limit);if(query)state.queryPreferences=[{query:query.normalize('NFKC').trim().toLowerCase(),id}]},
    getAll: () => ({ general: { quickLauncher: { recent: state.recent } } }), setAll: async value => { state.recent = value.general.quickLauncher.recent; }
  };`,
  logService: `export const logInfo = () => {}; export const logError = () => {}; export const logWarn = () => {};`
}
const bundled = await build({
  stdin: { contents: `export * from '@main/launcher/commandIndex'; export * from '@main/ipc/quickHandlers'; export * from '@shared/search'; export { IpcChannels } from '@shared/types/ipc'; export {state} from 'test-state'; export {registerTrustedSurface} from '@main/ipc/ipcSecurity';`, resolveDir: root },
  tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false, platform: 'node', format: 'esm',
  loader: { '.css': 'text' },
  plugins: [{ name: 'adapters', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => {
      const name = path.split('/').at(-1)
      return name in adapters ? { path: name, namespace: 'adapter' } : undefined
    })
    builder.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
const { state } = api
api.registerQuickHandlers()
const trusted = new EventEmitter();trusted.id=1;trusted.mainFrame={url:'file:///fixture/quick.html'};trusted.isDestroyed=()=>false;trusted.setWindowOpenHandler=()=>{}
api.registerTrustedSurface(trusted,'quick',trusted.mainFrame.url)
const event={sender:trusted,senderFrame:trusted.mainFrame}
const open = request => state.handlers.get(api.IpcChannels.QuickOpen)(event, request)
const fixturePlugin = (id, form = 'panel', extra = {}) => ({ id, form, name: id, main: 'index.html', version: '1', ...extra })

test.beforeEach(() => {
  Object.assign(state, { events: [], opened: [], manifests: [], apps: [], cache: null, recent: [], queryPreferences:[], scans: 0, hidden: 0, shown: 0, focused: 0, launchError: '', launched: [], aliases: {}, launchModes: {}, providers:[], providerQueries:[], providerFn:null,iconCalls:0,iconFn:null })
})

test('首次查询等待扫描，英文应用别名可以找到简名应用', async () => {
  state.apps = [{ name: 'Code', alias: 'Visual Studio Code', path: '/Applications/Code.app' }]
  const results = await api.searchQuickCommands('visual studio')
  assert.equal(state.scans, 1)
  assert.equal(results[0].path, '/Applications/Code.app')
  assert.equal(results[0].icon, 'icon:/Applications/Code.app')
})

test('首页与Quick统一处理全角、大写和多词，插件id与命令别名可搜索', async () => {
  state.manifests = [fixturePlugin('enest.ssh', 'panel', { name: 'SSH 终端', description: '远程开发工具', features: [{ code: 'connect', cmds: ['ssh', '连接服务器'] }] })]
  assert.equal(api.normalizeSearchText(' ＳＳＨ　终端  '), 'ssh 终端')
  assert.equal(api.matchesSearchTerms('SSH 终端 远程开发工具 enest.ssh', '  ＳＳＨ   开发'), true)
  assert.equal((await api.searchQuickCommands(' ＳＳＨ '))[0].code, 'connect')
  assert.equal((await api.searchQuickCommands('enest.ssh'))[0].pluginId, 'enest.ssh')
  assert.equal((await api.searchQuickCommands('SSH 终端'))[0].pluginId, 'enest.ssh')
  assert.equal((await api.searchQuickCommands('远程开发')).length, 0, 'descriptions are not name commands')
})

test('空查询提供大/小插件和应用，禁用插件不作为可执行结果', async () => {
  state.manifests = [fixturePlugin('SSH'), fixturePlugin('剪贴板', 'mini'), fixturePlugin('disabled', 'panel', { enabled: false })]
  state.apps = [{ name: 'Finder', path: '/Finder.app' }]
  const results = await api.searchQuickCommands('')
  assert.ok(results.some(item => item.pluginId === 'SSH'))
  assert.ok(results.some(item => item.pluginId === '剪贴板'))
  assert.ok(results.some(item => item.path === '/Finder.app'))
  assert.ok(!results.some(item => item.pluginId === 'disabled'))
  assert.ok(results.every(item => item.kind !== 'action'))
})

test('类别在截断之前过滤，应用不会被大量插件挤出结果', async () => {
  state.manifests = Array.from({ length: 80 }, (_, index) => fixturePlugin('plugin'+index))
  state.apps = [{ name: 'Safari', path: '/Safari.app' }, { name: 'Terminal', path: '/Terminal.app' }]
  const results = await api.searchQuickCommands('', 2, [], 'app')
  assert.deepEqual(results.map(item => item.title), ['Safari', 'Terminal'])
  const actions = await api.searchQuickCommands('', 2, [], 'action')
  assert.equal(actions.length, 2)
  assert.ok(actions.every(item => item.kind === 'action'))
})

test('最近项优先且不重复，非法limit限制在合理范围', async () => {
  state.apps = [{ name: 'Safari', path: '/Safari.app' }, { name: 'Terminal', path: '/Terminal.app' }]
  const recent = [{ id: 'app:/Terminal.app', ts: Date.now(), count: 3 }]
  const results = await api.searchQuickCommands('', 20, recent)
  assert.equal(results[0].title, 'Terminal')
  assert.equal(results.filter(item => item.title === 'Terminal').length, 1)
  assert.equal((await api.searchQuickCommands('', -2)).length, 1)
})

test('Quick默认嵌入插件，显式启动配置及主窗入口打开桌面', async () => {
  state.manifests = [fixturePlugin('clip', 'mini'), fixturePlugin('ssh')]
  assert.equal((await open({ kind: 'plugin', pluginId: 'clip' })).ok, true)
  assert.deepEqual(state.opened[0][2], { container: 'quick' })
  assert.equal(state.hidden, 0)
  state.launchModes.ssh = 'shell'
  await open({ kind: 'plugin', pluginId: 'ssh', code: 'connect' })
  assert.deepEqual(state.opened[1], ['ssh', { code: 'connect' }, { container: 'shell' }])
  assert.equal(state.focused, 1)
  await open({ kind: 'plugin', pluginId: 'clip', container: 'shell' })
  assert.deepEqual(state.opened[2][2], { container: 'shell' })
})

test('应用失败保留Quick并返回错误，成功才收起和记录最近使用', async () => {
  state.launchError = '应用已被移动'
  assert.deepEqual(await open({ kind: 'app', path: '/Missing.app' }), { ok: false, error: '应用已被移动' })
  assert.equal(state.hidden, 0)
  assert.equal(state.recent.length, 0)
  state.launchError = ''
  assert.equal((await open({ kind: 'app', path: '/Safari.app' })).ok, true)
  assert.equal(state.hidden, 1)
  assert.equal(state.recent[0].id, 'app:/Safari.app')
})

test('重新扫描不把用户踢出快捷窗口或聚焦主窗', async () => {
  assert.equal((await open({ kind: 'action', action: 'refresh-apps' })).ok, true)
  assert.equal(state.scans, 1)
  assert.equal(state.hidden, 0)
  assert.equal(state.focused, 0)
})

test('Quick Escape hides only Quick and plugin Escape returns home without opening main', async () => {
  assert.equal((await state.handlers.get(api.IpcChannels.QuickHide)(event)).ok, true)
  assert.equal(state.hidden, 1)
  assert.equal(state.shown, 0)
  assert.equal(state.focused, 0)
  assert.deepEqual(state.events, [])

  assert.equal((await open({ kind: 'plugin-escape', pluginId: 'clip' })).ok, true)
  assert.equal(state.hidden, 1, 'plugin Escape returns home rather than dismissing Quick')
  assert.equal(state.shown, 0)
  assert.equal(state.focused, 0)
  assert.deepEqual(state.events, [['dismiss', 'clip']])
})

test('explicit Quick settings and market actions still show and focus the desktop', async () => {
  for (const [action, view] of [['open-settings', 'settings'], ['open-market', 'home']]) {
    assert.equal((await open({ kind: 'action', action })).ok, true)
    assert.deepEqual(state.events.at(-1), { type: 'quick-open-view', view })
  }
  assert.equal(state.hidden, 2)
  assert.equal(state.shown, 2)
  assert.equal(state.focused, 2)
})


test('静态命令只在安装元数据或启动别名变化时重建，查询不污染缓存', async () => {
  state.manifests = [fixturePlugin('cache.plugin', 'panel', { name: '缓存插件' })]
  const before = api.getCommandCacheMetrics()
  const first = api.buildPluginCommands()
  const built = api.getCommandCacheMetrics()
  assert.equal(built.builds, before.builds + 1)
  assert.equal(built.misses, before.misses + 1)
  assert.equal(built.entries, first.length)
  assert.equal(built.snapshotCapacity, 1)
  assert.equal(api.buildPluginCommands(), first)
  assert.equal(api.getCommandCacheMetrics().hits, built.hits + 1)
  const sampled = api.getCommandCacheMetrics()
  assert.deepEqual(api.getCommandCacheMetrics(), sampled)
  await api.searchQuickCommands('缓存')
  assert.equal(api.buildPluginCommands(), first)
  state.aliases = { 'cache.plugin': ['my-alias'] }
  assert.notEqual(api.buildPluginCommands(), first)
  assert.equal((await api.searchQuickCommands('my-alias'))[0].pluginId, 'cache.plugin')
  state.manifests = []
  assert.deepEqual(api.buildPluginCommands(), [])
})

test('每个feature选择最准确的字符串cmd，后面的精确别名胜过前缀且只返回一次', async () => {
  state.manifests = [fixturePlugin('helpers', 'panel', {name:'工具',features:[{code:'help',cmds:['helpful','help','help page']}]})]
  const results=await api.searchQuickCommands('help')
  assert.equal(results.length,1)
  assert.equal(results[0].title,'help')
  assert.equal(results[0].keywordHit,'help')
  assert.equal(results[0].id,'plugin:helpers:help')
  assert.equal(results[0].group,'best')
})

test('中文全拼和首字母、英文词首缩写可搜；描述和任意子序列不制造噪声', async () => {
  state.manifests=[fixturePlugin('database', 'panel', {name:'数据工具',description:'unrelated-description',features:[{code:'db',cmds:['数据库管理']}]})]
  state.apps=[{name:'Visual Studio Code',path:'/Code.app'}]
  for(const query of ['shujuku','sjk','数据库']) assert.equal((await api.searchQuickCommands(query))[0].code,'db',query)
  assert.equal((await api.searchQuickCommands('vsc'))[0].path,'/Code.app')
  assert.deepEqual(await api.searchQuickCommands('unrelated-description'),[])
  assert.deepEqual(await api.searchQuickCommands('vsdc'),[])
})

test('精确优于前缀、前缀优于包含；命中占比和应用权重只细分非精确项', async () => {
  state.manifests=[fixturePlugin('finder-tools','panel',{features:[
    {code:'exact',cmds:['find']},{code:'prefix',cmds:['finder']},{code:'contains',cmds:['xx find']}
  ]})]
  state.apps=[{name:'finder',path:'/Finder.app'}]
  const results=await api.searchQuickCommands('find')
  assert.equal(results[0].code,'exact')
  assert.equal(results[1].kind,'app')
  assert.equal(results[2].code,'prefix')
  assert.equal(results[3].code,'contains')
})

test('插件名称和用户别名进入首个字符串feature，纯内容feature获得名称回退行', async () => {
  state.manifests=[fixturePlugin('tools','panel',{name:'工具集合',features:[
    {code:'content',cmds:[{type:'regex',label:'处理数字',match:'/^\\d+$/'}]},
    {code:'first',cmds:['第一工具']},{code:'second',cmds:['第二工具']}
  ]}),fixturePlugin('content-only','panel',{name:'纯内容插件',features:[{code:'only',cmds:[{type:'regex',label:'数字',match:'/^\\d+$/'}]}]})]
  state.aliases={tools:['my-tools']}
  for(const query of ['工具集合','my-tools','tools']) {
    const hits=(await api.searchQuickCommands(query)).filter(item=>item.pluginId==='tools')
    assert.deepEqual(hits.map(item=>item.code),['first'])
  }
  // 无字符串指令的插件不再隐身：首个 feature 行承载名称/用户别名，作为普通入口可搜。
  const contentOnly=(await api.searchQuickCommands('纯内容插件')).filter(item=>item.pluginId==='content-only')
  assert.deepEqual(contentOnly.map(item=>item.code),['only'])
  const empty=await api.searchQuickCommands('')
  assert.ok(empty.every(item=>item.code!=='content'))
  assert.ok(empty.some(item=>item.code==='only'&&item.pluginId==='content-only'))
  assert.ok((await api.searchQuickCommands('第二工具')).some(item=>item.code==='second'))
})

test('regex和over保留原文载荷与flags，长度边界包含，名称搜索超过32字符停止', async () => {
  const raw=' AbC '+ 'x'.repeat(40)+'\n'
  state.manifests=[fixturePlugin('content','panel',{name:'内容工具',features:[
    {code:'regex',cmds:[{type:'regex',label:'正则处理',match:'/abc/gi',minLength:3}]},
    {code:'over',cmds:[{type:'over',label:'文本处理',minLength:3,maxLength:100}]},
    {code:'name',cmds:[raw.trim()]}
  ]})]
  for(let i=0;i<2;i++) {
    const results=await api.searchQuickCommands(raw)
    assert.deepEqual(results.map(item=>item.group),['match','recommendation'])
    assert.deepEqual(results.map(item=>item.type),['regex','over'])
    assert.ok(results.every(item=>item.payload===raw))
  }
})

test('over默认范围和exclude均生效，regex别名字段可用，同feature按best、match、recommendation去重', async () => {
  state.manifests=[fixturePlugin('content','panel',{features:[
    {code:'combined',cmds:['abc',{type:'regex',label:'正则',regex:'/abc/'},{type:'over',label:'兜底'}]},
    {code:'bounded',cmds:[{type:'over',label:'短文本',minLength:3,maxLength:5,exclude:'/^skip$/i'}]}
  ]})]
  const best=await api.searchQuickCommands('abc')
  assert.deepEqual(best.filter(item=>item.code==='combined').map(item=>item.group),['best'])
  const content=await api.searchQuickCommands('zabc')
  assert.deepEqual(content.filter(item=>item.code==='combined').map(item=>item.group),['match'])
  for(const query of ['abc','abcde']) assert.ok((await api.searchQuickCommands(query)).some(item=>item.code==='bounded'))
  for(const query of ['ab','abcdef','SKIP']) assert.ok(!(await api.searchQuickCommands(query)).some(item=>item.code==='bounded'))
  assert.ok(!(await api.searchQuickCommands('x'.repeat(10001))).some(item=>item.code==='combined'))
})

test('同词偏好只置顶当前best候选，不能使不匹配或内容匹配项越过best组', async () => {
  state.manifests=[fixturePlugin('alpha','panel',{features:[{code:'exact',cmds:['help']},{code:'prefix',cmds:['helper']},{code:'regex',cmds:[{type:'regex',label:'匹配',match:'/help/'}]}]})]
  assert.equal((await api.searchQuickCommands('help',20,[],undefined,'plugin:alpha:prefix'))[0].code,'prefix')
  assert.equal((await api.searchQuickCommands('help',20,[],undefined,'plugin:alpha:regex'))[0].code,'exact')
  assert.equal((await api.searchQuickCommands('help',20,[],undefined,'missing'))[0].code,'exact')
})

test('静态检索不等待动态provider，后续phase独立返回provider组并取消旧查询', async () => {
  state.manifests=[fixturePlugin('provider','panel',{features:[{code:'find',cmds:['search']}]})]
  state.providerFn=(_query,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}))
  const indexed=await api.searchQuickCommands('search',20,[],undefined,undefined,'static')
  assert.equal(indexed[0].group,'best')
  assert.deepEqual(state.providerQueries,[])
  const waiting=api.searchQuickCommands('search',20,[],undefined,undefined,'providers')
  await api.searchQuickCommands('new query',20,[],undefined,undefined,'static')
  assert.deepEqual(await waiting,[])
  state.providerFn=null
  const payload={path:'/Mixed Case/File.md',position:{line:23},query:'  Search\n'}
  state.providers=[{pluginId:'provider',providerId:'find',items:[{id:'1',title:'Dynamic result',code:'find',payload}]}]
  const supplied=await api.searchQuickCommands('search',20,[],undefined,undefined,'providers')
  assert.equal(supplied[0].group,'provider')
  assert.deepEqual(supplied[0].payload,payload)
  await open({...supplied[0],query:'search'})
  assert.deepEqual(state.opened[0][1],{code:'find',type:'text',payload})
})

test('Quick IPC传递匹配类型和原始payload，并使用窄设置快照读取同词偏好', async () => {
  const raw='  Preserve CASE\n'
  await open({kind:'plugin',pluginId:'tool',code:'process',type:'regex',payload:raw,query:'preserve'})
  assert.deepEqual(state.opened[0][1],{code:'process',type:'regex',payload:raw})
  state.manifests=[fixturePlugin('tool','panel',{features:[{code:'first',cmds:['help']},{code:'last',cmds:['helper']}]})]
  state.queryPreferences=[{query:'help',id:'plugin:tool:last'}]
  const result=await state.handlers.get(api.IpcChannels.QuickSearch)(event,{query:' ＨＥＬＰ ',phase:'static'})
  assert.equal(result.items[0].code,'last')
})

test('按名称或别名打开插件也把当前输入文本交给插件（zTools 对齐）', async () => {
  state.manifests=[fixturePlugin('translate','panel',{features:[{code:'main',cmds:['翻译','translate']}]})]
  await open({kind:'plugin',pluginId:'translate',code:'main',query:' 你好 '})
  assert.deepEqual(state.opened[0][1],{code:'main',type:'text',payload:'你好'})
  await open({kind:'plugin',pluginId:'translate',code:'main',query:'   '})
  assert.deepEqual(state.opened[1][1],{code:'main'},'空白输入不产生载荷')
  await open({kind:'plugin',pluginId:'translate',query:'x'.repeat(5_000)})
  assert.equal(state.opened[2][1].payload.length,4_096,'输入文本有界透传')
})

test('粘贴上下文按不透明 id 组装进 enter.input 并在启动后消费', async () => {
  state.manifests=[fixturePlugin('image-tools','panel',{features:[{code:'main',cmds:['图片']}]})]
  await open({kind:'plugin',pluginId:'image-tools',code:'main',query:'压缩',input:{imageIds:['img-1'],fileIds:['file-1'],text:'压缩'}})
  const enter=state.opened[0][1]
  assert.equal(enter.payload,'压缩')
  assert.deepEqual(enter.input,{text:'压缩',images:[{dataUrl:'data:image/png;base64,AA',width:1,height:1}],files:[{handleId:'h',path:'/tmp/x',name:'x',size:1,kind:'file'}]})
  assert.equal(state.contextIssued,'image-tools','启动成功后记录本实例输入上下文')
  assert.equal(state.contextRemoved,1,'上下文随启动消费清空')
  await open({kind:'plugin',pluginId:'image-tools',code:'main'})
  assert.equal(state.opened[1][1].input,undefined,'无上下文请求不产生 input')
})

test('quick:input-context 仅服务 Quick 表面并维护宿主列表', async () => {
  const handler=state.handlers.get(api.IpcChannels.QuickInputContext)
  state.contextItems=[{id:'a',kind:'image',thumbnail:'data:image/png;base64,AA'}]
  assert.deepEqual((await handler(event,{operation:'list'})).items,state.contextItems)
  state.clipboardAdded=[{id:'b',kind:'file',name:'x.txt'}]
  const read=await handler(event,{operation:'read-clipboard'})
  assert.equal(state.clipboardReads,1)
  assert.equal(read.ok,true)
  assert.deepEqual((await handler(event,{operation:'clear',id:'a'})).items.map(item=>item.id),['b'])
  assert.equal((await handler(event,null)).ok,false)
  assert.equal((await handler({sender:{id:99}}, {operation:'list'})).ok,false)
})

test('首阶段不等待内容匹配或应用图标，enriched补全且不取消并行provider', async () => {
  state.manifests=[fixturePlugin('typed','panel',{features:[{code:'match',cmds:[{type:'regex',label:'Match text',match:'/code/'}]}]})]
  state.apps=[{name:'Code',path:'/Code.app'}]
  let resolveIcon, providerSignal, markIconStarted
  const iconStarted=new Promise(resolve=>{markIconStarted=resolve})
  state.iconFn=()=>new Promise(resolve=>{resolveIcon=resolve;markIconStarted()})
  state.providerFn=(_query,signal)=>{providerSignal=signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}))}
  const initial=await api.searchQuickCommands('code',20,[],undefined,undefined,'static')
  assert.deepEqual(initial.map(item=>item.group),['best'])
  assert.equal(initial[0].icon,undefined)
  assert.equal(state.iconCalls,0)
  assert.equal(state.providerQueries.length,0)
  const providers=api.searchQuickCommands('code',20,[],undefined,undefined,'providers')
  const enrichment=api.searchQuickCommands('code',20,[],undefined,undefined,'enriched')
  await iconStarted
  assert.equal(providerSignal.aborted,false)
  assert.equal(state.providerQueries.length,1)
  resolveIcon('enriched-icon')
  const full=await enrichment
  assert.deepEqual(full.map(item=>item.group),['best','match'])
  assert.equal(full[0].icon,'enriched-icon')
  await api.searchQuickCommands('next',20,[],undefined,undefined,'static')
  assert.equal(providerSignal.aborted,true)
  assert.deepEqual(await providers,[])
  const home=await api.searchQuickCommands('',20,[],undefined,undefined,'static')
  assert.equal(home.length,1)
  assert.equal(state.iconCalls,1,'the blank first phase also avoids icon I/O')
})

test('新输入取消尚未返回的enriched结果', async () => {
  state.apps=[{name:'Code',path:'/Code.app'}]
  let resolveIcon, markIconStarted
  const iconStarted=new Promise(resolve=>{markIconStarted=resolve})
  state.iconFn=()=>new Promise(resolve=>{resolveIcon=resolve;markIconStarted()})
  await api.searchQuickCommands('code',20,[],undefined,undefined,'static')
  const old=api.searchQuickCommands('code',20,[],undefined,undefined,'enriched')
  await iconStarted
  const next=await api.searchQuickCommands('nothing',20,[],undefined,undefined,'static')
  assert.deepEqual(next,[])
  resolveIcon('stale-icon')
  assert.deepEqual(await old,[])
})

test('应用加权不会让去空白匹配越过字符串精确匹配', async () => {
  state.manifests=[fixturePlugin('exact','panel',{features:[{code:'match',cmds:['findme']} ]})]
  state.apps=[{name:'find me',path:'/Find Me.app'}]
  const results=await api.searchQuickCommands('findme',20,[],undefined,undefined,'static')
  assert.equal(results[0].pluginId,'exact')
  assert.equal(results[1].kind,'app')
})
