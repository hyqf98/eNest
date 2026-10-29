// Run: node --test tests/main/plugin/marketMetadata.test.mjs
// Bundle the real TypeScript registry and protocol with in-memory Electron/store adapters.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  electron: `
    let handler;
    export const protocol = { handle: (_scheme, value) => { handler = value } };
    export const session = { fromPartition: () => ({ protocol }) };
    export const app = { getAppPath: () => '/fixture', isPackaged: false };
    export const protocolRequest = (url) => handler(new Request(url));
  `,
  '@main/paths/pathsService': `export const getAppPaths = () => ({ plugins: '/fixture', root: '/fixture' }); export const defaultDataRoot = () => '/fixture'; export const getAppPathsRoot = () => '/fixture';`,
  '@main/plugin/PluginInstaller': `import {readFile} from 'node:fs/promises'; import {join} from 'node:path'; export const installFromDirectory = async root => JSON.parse(await readFile(join(root,'plugin.json'),'utf8')); export const installFromFolder = async () => null; export const installFromZip = async () => null; export const withInstallLock = async (_id, action) => action(); export const beginPluginInstall = () => 1;`,
  '@main/proxy/proxyService': `export const getActiveProxy = () => ({type:'none'});`,
  '@main/plugin/pluginEnabledStore': `
    export const disabled = new Set();
    export const isEnabledSync = (id) => !disabled.has(id);
    export const loadDisabledIds = async () => {};
    export const persistPluginEnabled = async (id, enabled) => enabled ? disabled.delete(id) : disabled.add(id);
  `,
  '@main/plugin/PermissionService': `export const permissionService = { cancelFor() {} };`,
  '@main/contrib/ContributionRegistry': `export const contributionRegistry = { registerManifestContributes() {}, unregisterBySource() {}, listSlot: () => [] };`,
  '@main/logs/logService': `export const logInfo = () => {}; export const logWarn = () => {};`,
  '@main/window/createShellWindow': `export const sendShellEvent = () => {};`,
  '@main/settings/SettingsStore': `export const settingsStore = { getTheme: () => ({}), getAll: () => ({ general: {} }), getPluginAppearance: () => ({}) };`,
  '@main/theme/resolveThemeCss': `export const resolveThemeTokens = () => ({}); export const themeTokensToCss = () => '';`
}
const bundle = await build({
  stdin: {
    contents: `
      export * from '@main/plugin/marketMetadata';
      export { PluginRegistry, pluginRegistry } from '@main/plugin/PluginRegistry';
      export { initPluginProtocol } from '@main/plugin/pluginProtocol';
      export { protocolRequest } from 'electron';
      export { disabled } from '@main/plugin/pluginEnabledStore';
    `,
    resolveDir: projectRoot
  },
  tsconfig: join(projectRoot, 'tsconfig.node.json'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'test-adapters',
    setup(builder) {
      builder.onResolve({ filter: /^(electron|@main\/)/ }, ({ path }) => path in adapters ? { path, namespace: 'adapter' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    }
  }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const rawUrl = 'https://raw.githubusercontent.com/owner/repo/main/registry.json'
const releaseBase = 'https://github.com/owner/repo/releases/latest/download/'
const manifest = {
  id: 'com.test.example', name: 'Example', version: '1.0.0', main: 'index.html',
  market: { screenshots: ['assets/market/screenshots/home.png'] }
}
const entry = {
  id: manifest.id, name: manifest.name, version: '2.0.0', category: '设计', featured: true,
  screenshots: ['https://cdn.example.com/cover.png'], icon: 'icons/example.svg', installs: 1500
}
const remote = (data = entry) => api.parseRemoteMarket({ plugins: [data] }, rawUrl, releaseBase)[0]

test('真实市场字段透传，缺失统计不显示零；安装包大小与摘要版本一致', () => {
  const parsed = remote({ ...entry, installs: undefined, author: undefined, tags: [' JSON ', 'JSON', 42, '', '格式化'], asset: { size: 12345 } })
  assert.deepEqual(parsed.tags, ['JSON', '格式化'])
  assert.equal(parsed.packageSize, 12345)
  assert.equal(parsed.installs, '')
  assert.equal(parsed.author, '')
  for (const size of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '123']) {
    assert.equal(remote({ ...entry, asset: { size } }).packageSize, undefined)
  }
  const installed = { ...api.remoteToSummary(parsed, true), installed: true, version: '1.0.0', tags: ['本地版本标签'] }
  const merged = api.mergeMarketMetadata(installed, parsed)
  assert.deepEqual(merged.tags, installed.tags)
  assert.equal(merged.packageSize, undefined, 'newer remote package size must not describe an installed older version')
})

test('catalog resources select dev, installed then remote without borrowing missing local slots', () => {
  const id = 'com.github.eNest.anything'
  const registry = new api.PluginRegistry()
  registry.remoteMarket = [{ id, version: '2.0.0', icon: 'https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/plugins/anything/public/assets/market/icon.svg',
    readmeUrl: 'https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/plugins/anything/public/assets/market/README.md',
    screenshots: ['https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/plugins/anything/public/assets/market/screenshots/main.png'] }]
  assert.equal(registry.getCatalogResources(id).icon.source, 'remote')
  const local = version => ({ manifest: { id, name: 'Anything', version, icon: 'assets/market/icon.svg', market: { screenshots: [] } }, version, rootPath: '/fixture/' + version })
  registry.installed.set(id, local('1.1.0'))
  assert.equal(registry.getCatalogResources(id).icon.source, 'installed')
  assert.equal(registry.getCatalogResources(id).readme, undefined)
  assert.deepEqual(registry.getCatalogResources(id).screenshots, [])
  registry.dev.set(id, { id, rootPath: '/fixture/source', devSource: true })
  registry.devManifests.set(id, local('1.2.0').manifest)
  assert.equal(registry.getCatalogResources(id).icon.source, 'dev')
  assert.equal(registry.getCatalogResources(id).icon.devSource, true)
  registry.devManifests.delete(id)
  assert.deepEqual(registry.getCatalogResources(id), { screenshots: [] }, 'an incomplete dev source must not silently borrow installed/remote media')
})

test('生产目录不补造 mock 插件或元数据，离线保留已安装插件和已验证目录', async () => {
  const registry = new api.PluginRegistry()
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.get('com.github.eNest.translate'), null)
  const local = { ...manifest, id: 'com.github.eNest.translate', name: '本地翻译' }
  registry.installed.set(local.id, { manifest: local, rootPath: '/fixture/local', version: local.version })
  assert.equal(registry.get(local.id).author, '')
  assert.equal(registry.get(local.id).description, '')
  assert.equal(registry.get(local.id).installs, '')
  registry.remoteMarket = [remote()]
  registry.remoteFetchedAt = Date.now() - 10_000
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('offline fixture') }
  try {
    const status = await registry.getMarketStatus(true)
    assert.equal(status.state, 'offline')
    assert.equal(status.catalogCount, 1)
    assert.ok(status.fetchedAt)
    assert.equal(registry.get(local.id).installed, true)
    assert.equal(registry.get(local.id).rootPath, '/fixture/local')
    assert.equal(registry.list().length, 2)
  } finally { globalThis.fetch = originalFetch }
})

test('raw、Release 与自托管索引按来源目录解析相对图片', () => {
  assert.equal(api.resolveRegistryImageUrl('icons/test.svg', rawUrl), 'https://raw.githubusercontent.com/owner/repo/main/icons/test.svg')
  assert.equal(api.resolveRegistryImageUrl('cover.png', `${releaseBase}registry.json`, true), `${releaseBase}cover.png`)
  assert.equal(api.resolveRegistryImageUrl('./plugins/test/首页.png', 'https://host.example/market/registry.json', true), 'https://host.example/market/plugins/test/%E9%A6%96%E9%A1%B5.png')
  assert.equal(api.resolveRegistryImageUrl('https://cdn.example.com/image?id=1', rawUrl, true), 'https://cdn.example.com/image?id=1')
  assert.equal(api.resolveRegistryImageUrl('http://legacy.example/cover.jpg', rawUrl, true), 'http://legacy.example/cover.jpg')
})

test('截图拒绝越界、危险协议、凭据和非图片相对路径', () => {
  for (const value of ['../cover.png', '%2e%2e/cover.png', '/cover.png', '//host/cover.png', 'a\\cover.png', 'javascript:alert(1)', 'file:///cover.png', 'data:image/png;base64,AA', 'https://user:secret@example.com/image', 'cover.svg', 'cover.html', 42, null]) {
    assert.equal(api.resolveRegistryImageUrl(value, rawUrl, true), undefined, String(value))
  }
})

test('非法截图元数据不会阻断列表，去重保序且最多保留 8 张', () => {
  const screenshots = ['a.png', 42, 'javascript:x', 'a.png', 'b.png', ...Array.from({ length: 12 }, (_, i) => `${i}.webp`)]
  const parsed = remote({ ...entry, screenshots, featured: 'true' })
  assert.equal(parsed.screenshots.length, 8)
  assert.deepEqual(parsed.screenshots.slice(0, 2), [new URL('a.png', rawUrl).href, new URL('b.png', rawUrl).href])
  assert.equal(parsed.featured, false)
  assert.deepEqual(remote({ ...entry, screenshots: {} }).screenshots, [])
  assert.deepEqual(api.parseRemoteMarket({ plugins: [null, {}, 42] }, rawUrl, releaseBase), [])
})

test('旧索引缺省无截图，包下载使用显式发布 URL', () => {
  const legacy = { id: 'com.test.old', name: 'Old', version: '1.0.0' }
  assert.deepEqual(remote(legacy).screenshots, [])
  assert.equal(remote(legacy).featured, false)
  const asset = { name: 'test@1.0.0.enestplugin', url: 'https://github.com/owner/repo/releases/download/v1/test.enestplugin' }
  assert.equal(remote({ ...legacy, asset }).assetUrl, asset.url)
})

test('manifest 截图来自插件根，开发服务器地址不影响静态截图', () => {
  assert.deepEqual(api.manifestScreenshots({ ...manifest, development: { main: 'http://localhost:5173/app/' } }), [
    `enest://plugin/${manifest.id}/assets/market/screenshots/home.png`
  ])
  assert.deepEqual(api.manifestScreenshots({ ...manifest, market: { screenshots: ['assets/market/screenshots/首页 1.png', 'https://cdn.example.com/image?size=large'] } }), [
    `enest://plugin/${manifest.id}/assets/market/screenshots/%E9%A6%96%E9%A1%B5%201.png`
  ])
})

test('包内图标和中文截图按磁盘原名编码读取，不接受远程或编码绕过路径', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'enest-market-encoding-'))
  const id = 'com.test.encoding'
  const screenshot = 'assets/market/screenshots/主界面 1.png'
  const icon = 'assets/market/icon.svg'
  const localManifest = { ...manifest, id, icon, market: { screenshots: [screenshot] } }
  try {
    await mkdir(join(rootPath,'assets/market/screenshots'), {recursive:true})
    await writeFile(join(rootPath, screenshot), 'image')
    await writeFile(join(rootPath, icon), '<svg/>')
    api.pluginRegistry.installed.set(id, { manifest: localManifest, rootPath, version: '1.0.0' })
    api.initPluginProtocol()
    const summary = api.pluginRegistry.get(id)
    assert.equal(await (await api.protocolRequest(summary.icon)).text(), '<svg/>')
    assert.equal(await (await api.protocolRequest(summary.screenshots[0])).text(), 'image')
    assert.deepEqual(api.manifestScreenshots({...localManifest,market:{screenshots:['https://cdn.example/image.png','assets/market/screenshots/%2e%2e/secret.png']}}),[])
  } finally {
    api.pluginRegistry.installed.delete(id)
    await rm(rootPath, { recursive: true, force: true })
  }
})

test('已安装插件 list/get 保留市场分类、推荐、截图与更新提示', () => {
  const registry = new api.PluginRegistry()
  registry.remoteMarket = [remote()]
  registry.installed.set(manifest.id, { manifest, rootPath: '/fixture/plugin', version: manifest.version })
  const summary = registry.get(manifest.id)
  assert.deepEqual(registry.list().find((item) => item.id === manifest.id), summary)
  assert.equal(summary.version, '1.0.0')
  assert.equal(summary.latestVersion, '2.0.0')
  assert.equal(summary.category, '设计')
  assert.equal(summary.featured, true)
  assert.equal(summary.installs, '1.5k')
  assert.deepEqual(summary.screenshots, [`enest://plugin/${manifest.id}/assets/market/screenshots/home.png`])
  assert.equal(summary.rootPath, '/fixture/plugin')
})

test('无截图旧索引安装后使用 manifest 截图与本地分类', () => {
  const registry = new api.PluginRegistry()
  const local = { ...manifest, category: '媒体', market: { ...manifest.market, featured: true } }
  registry.installed.set(manifest.id, { manifest: local, rootPath: '/fixture/plugin', version: manifest.version })
  assert.equal(registry.get(manifest.id).category, '媒体')
  assert.equal(registry.get(manifest.id).featured, true)
  registry.remoteMarket = [remote({ ...entry, screenshots: undefined })]
  assert.deepEqual(registry.get(manifest.id).screenshots, [`enest://plugin/${manifest.id}/assets/market/screenshots/home.png`])
})

test('开发插件注册返回值与 list/get 一致，优先本地截图并保留 HMR URL', () => {
  const registry = new api.PluginRegistry()
  registry.remoteMarket = [remote()]
  const summary = registry.addDevPlugin({
    ...api.remoteToSummary(remote(), true), version: '1.0.0', dev: true,
    rootPath: '/fixture/source', devUrl: 'http://localhost:5173/', installs: 'dev'
  }, manifest)
  assert.deepEqual(summary, registry.get(manifest.id))
  assert.deepEqual(summary, registry.list().find((item) => item.id === manifest.id))
  assert.deepEqual(summary.screenshots, [`enest://plugin/${manifest.id}/assets/market/screenshots/home.png`])
  assert.equal(summary.devUrl, 'http://localhost:5173/')
  assert.equal(summary.installs, 'dev')
})

test('禁用插件仍能读静态图片，执行摘要不暴露 rootPath，协议拒绝越界', async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'enest-market-test-'))
  const id = 'com.test.disabled'
  try {
    await mkdir(join(rootPath,'assets/market/screenshots'),{recursive:true})
    await writeFile(join(rootPath, 'assets/market/screenshots/cover.png'), 'image fixture')
    api.pluginRegistry.installed.set(id, { manifest: { ...manifest, id }, rootPath, version: '1.0.0' })
    api.disabled.add(id)
    assert.equal(api.pluginRegistry.get(id).rootPath, undefined)
    assert.equal(api.pluginRegistry.getRootPath(id), rootPath)
    api.initPluginProtocol()
    const response = await api.protocolRequest(`enest://plugin/${id}/assets/market/screenshots/cover.png`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'image/png')
    assert.equal(await response.text(), 'image fixture')
    assert.equal((await api.protocolRequest(`enest://plugin/${id}/%2e%2e%2foutside.png`)).status, 403)
  } finally {
    api.disabled.delete(id)
    api.pluginRegistry.installed.delete(id)
    await rm(rootPath, { recursive: true, force: true })
  }
})

test('分类集合以 registry 声明为准，未声明时回落本地枚举', () => {
  // registry 声明自定义分类：仓库配置即市场分类，含白名单外新分类
  const declared = api.parseRemoteMarket(
    { categories: ['效率', 'AI 工具', '游戏'], plugins: [{ id: 'a.b', name: 'A', version: '1.0.0', category: 'AI 工具' }, { id: 'a.c', name: 'C', version: '1.0.0', category: '效率' }, { id: 'a.d', name: 'D', version: '1.0.0', category: '不存在的' }] },
    rawUrl, releaseBase
  )
  assert.equal(declared[0].category, 'AI 工具')
  assert.equal(declared[1].category, '效率')
  assert.equal(declared[2].category, '其它')
  // 未声明 categories：回落本地枚举，白名单外分类归"其它"
  const fallback = api.parseRemoteMarket(
    { plugins: [{ id: 'a.b', name: 'A', version: '1.0.0', category: 'AI 工具' }, { id: 'a.c', name: 'C', version: '1.0.0', category: '设计' }] },
    rawUrl, releaseBase
  )
  assert.equal(fallback[0].category, '其它')
  assert.equal(fallback[1].category, '设计')
  // 空 categories 数组同样回落
  const empty = api.parseRemoteMarket({ categories: [], plugins: [entry] }, rawUrl, releaseBase)
  assert.equal(empty[0].category, '设计')
})

test('published README attachments resolve from the registry while installed versions keep their own resources',()=>{
 const parsed=remote({...entry,readmeUrl:'example@2.0.0-README.md',readmeImages:{'./screenshots/one.png':'example@2.0.0-screenshot-1.png','../secret.png':'secret.png','bad.png':'file:///secret'}})
 assert.equal(parsed.readmeUrl,new URL('example%402.0.0-README.md',rawUrl).href)
 assert.deepEqual({...parsed.readmeImages},{'screenshots/one.png':new URL('example%402.0.0-screenshot-1.png',rawUrl).href})
 const local={...api.remoteToSummary(parsed,true),installed:true,version:'1.0.0',readmeUrl:'enest://plugin/test/assets/market/README.md'}
 const merged=api.mergeMarketMetadata(local,parsed)
 assert.equal(merged.readmeUrl,local.readmeUrl);assert.equal(merged.readmeImages,undefined)
})

test('malformed remote entries cannot become filesystem identities or break the entire market', () => {
  const parsed = api.parseRemoteMarket({ plugins: [
    { ...entry, id: '../outside' },
    { ...entry, id: 'enest.builtin' },
    { ...entry, id: 'com.valid', version: '../../outside' },
    { ...entry, id: 'com.empty', name: ' ' },
    { ...entry, id: 'com.numeric', category: 42 },
    { ...entry, id: 'com.object', category: { trim: 'not a function' } },
    entry
  ] }, rawUrl, releaseBase)
  assert.deepEqual(parsed.map(item => item.id), ['com.numeric', 'com.object', entry.id])
  assert.deepEqual(parsed.map(item => item.category), ['其它', '其它', entry.category])
})
