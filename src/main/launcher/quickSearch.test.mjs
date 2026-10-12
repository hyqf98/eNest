// Run: node --test src/main/launcher/quickSearch.test.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state': `export const state = { handlers: new Map(), events: [], opened: [], manifests: [], apps: [], cache: null, recent: [], scans: 0, hidden: 0, focused: 0, launchError: '', launched: [] };`,
  electron: `import { state } from 'test-state'; export const ipcMain = { handle: (id, handler) => state.handlers.set(id, handler), on() {} };`,
  PluginRegistry: `import { state } from 'test-state'; export const pluginRegistry = { list: () => state.manifests.map(m => ({ ...m, installed: true, rootPath: '/plugins/'+m.id })), getManifest: id => state.manifests.find(m => m.id === id), get: id => state.manifests.find(m => m.id === id) };`,
  appScanner: `import { state } from 'test-state'; export const getCachedApps = () => state.cache; export const scanApplications = async () => { state.scans++; await Promise.resolve(); return state.cache = { apps: state.apps, complete: true, errors: [] }; };`,
  appLauncher: `import { state } from 'test-state'; export const getAppIconDataUrl = async path => 'icon:'+path; export const launchLocalApp = async path => { if(state.launchError) throw new Error(state.launchError); state.launched.push(path); };`,
  clipboardHistory: `export const searchHistory = async () => [];`,
  quickProviders: `export const queryQuickProviders = async () => [];`,
  PluginHost: `import { state } from 'test-state'; export const pluginHost = { openPlugin: async (...args) => { state.opened.push(args); return 't-'+args[0]; }, getQuickPlugin: () => null, dismissQuickPlugin: id => state.events.push(['dismiss',id]), pinToShell: id => state.events.push(['pin',id]) };`,
  createQuickWindow: `import { state } from 'test-state'; export const hideQuickWindow = () => state.hidden++; export const setQuickContentHeight = () => {}; export const toggleQuickWindow = () => {};`,
  createShellWindow: `import { state } from 'test-state'; export const sendShellEvent = event => state.events.push(event); export const getMainWindow = () => ({ isDestroyed: () => false, isMinimized: () => false, show() {}, focus: () => state.focused++ });`,
  quickHotkey: `export const applyQuickHotkeys = value => value; export const getQuickHotkeyConfig = () => ({}); export const probeHotkey = () => ({});`,
  SettingsStore: `import { state } from 'test-state'; export const settingsStore = { getAll: () => ({ general: { quickLauncher: { recent: state.recent } } }), setAll: async value => { state.recent = value.general.quickLauncher.recent; } };`,
  logService: `export const logInfo = () => {}; export const logError = () => {}; export const logWarn = () => {};`
}
const bundled = await build({
  stdin: { contents: `export * from '@main/launcher/commandIndex'; export * from '@main/ipc/quickHandlers'; export * from '@shared/search'; export { IpcChannels } from '@shared/types/ipc'; export {state} from 'test-state';`, resolveDir: root },
  tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false, platform: 'node', format: 'esm',
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
const open = request => state.handlers.get(api.IpcChannels.QuickOpen)(null, request)
const fixturePlugin = (id, form = 'panel', extra = {}) => ({ id, form, name: id, main: 'index.html', version: '1', ...extra })

test.beforeEach(() => {
  Object.assign(state, { events: [], opened: [], manifests: [], apps: [], cache: null, recent: [], scans: 0, hidden: 0, focused: 0, launchError: '', launched: [] })
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
  assert.equal((await api.searchQuickCommands('SSH 开发'))[0].pluginId, 'enest.ssh')
})

test('空查询提供大/小插件和应用，禁用插件不作为可执行结果', async () => {
  state.manifests = [fixturePlugin('SSH'), fixturePlugin('剪贴板', 'mini'), fixturePlugin('disabled', 'panel', { enabled: false })]
  state.apps = [{ name: 'Finder', path: '/Finder.app' }]
  const results = await api.searchQuickCommands('')
  assert.ok(results.some(item => item.pluginId === 'SSH' && item.form === 'panel'))
  assert.ok(results.some(item => item.pluginId === '剪贴板' && item.form === 'mini'))
  assert.ok(results.some(item => item.path === '/Finder.app'))
  assert.ok(!results.some(item => item.pluginId === 'disabled'))
})

test('类别在截断之前过滤，应用不会被大量插件挤出结果', async () => {
  state.manifests = Array.from({ length: 80 }, (_, index) => fixturePlugin('plugin'+index))
  state.apps = [{ name: 'Safari', path: '/Safari.app' }, { name: 'Terminal', path: '/Terminal.app' }]
  const results = await api.searchQuickCommands('', 2, [], 'app')
  assert.deepEqual(results.map(item => item.title), ['Safari', 'Terminal'])
  assert.ok((await api.searchQuickCommands('', 2, [], 'action')).every(item => item.kind === 'action'))
})

test('最近项优先且不重复，非法limit限制在合理范围', async () => {
  state.apps = [{ name: 'Safari', path: '/Safari.app' }, { name: 'Terminal', path: '/Terminal.app' }]
  const recent = [{ id: 'app:/Terminal.app', ts: Date.now(), count: 3 }]
  const results = await api.searchQuickCommands('', 20, recent)
  assert.equal(results[0].title, 'Terminal')
  assert.equal(results.filter(item => item.title === 'Terminal').length, 1)
  assert.equal((await api.searchQuickCommands('', -2)).length, 1)
})

test('mini默认嵌Quick，panel打开并聚焦桌面，显式主窗入口仍有效', async () => {
  state.manifests = [fixturePlugin('clip', 'mini'), fixturePlugin('ssh')]
  assert.equal((await open({ kind: 'plugin', pluginId: 'clip' })).ok, true)
  assert.deepEqual(state.opened[0][2], { container: 'quick' })
  assert.equal(state.hidden, 0)
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
