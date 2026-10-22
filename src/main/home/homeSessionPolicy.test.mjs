import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'enest-home-policy-'))
  const homeRoot = join(directory, 'provider')
  const catalogRoot = join(directory, 'catalog')
  await mkdir(join(homeRoot, 'homes'), { recursive: true })
  await mkdir(join(catalogRoot, 'assets'), { recursive: true })
  await writeFile(join(homeRoot, 'homes/dashboard.html'), '<!doctype html><script src="../app.js"></script>')
  await writeFile(join(homeRoot, 'app.js'), 'export const safe=true')
  await writeFile(join(homeRoot, 'other.html'), '<!doctype html>not the entry')
  await writeFile(join(catalogRoot, 'assets/icon.svg'), '<svg/>')
  await writeFile(join(catalogRoot, 'assets/README.md'), '# Public readme')
  await writeFile(join(catalogRoot, 'assets/shot.png'), 'PNG')
  await writeFile(join(catalogRoot, 'secret.txt'), 'private')
  await writeFile(join(directory, 'outside.js'), 'outside')
  await writeFile(join(directory, 'public.woff2'), 'FONT')
  await writeFile(join(directory, 'public.mp4'), 'MEDIA')
  await symlink(join(directory, 'outside.js'), join(homeRoot, 'escape.js'))
  const page = {
    rootPath: homeRoot,
    entryPath: join(homeRoot, 'homes/dashboard.html'),
    contribution: { source: 'com.github.eNest.provider', id: 'dashboard', version: 1, entry: 'homes/dashboard.html', variants: ['ink'] }
  }
  globalThis.homePolicyFixture = {
    page, sessions: [], enabled: true,
    publicManifest: { icon: 'assets/icon.svg', market: { readme: 'assets/README.md', screenshots: ['assets/shot.png'] } }
  }
  const adapters = {
    fixture: `export const state=globalThis.homePolicyFixture;`,
    '@main/theme/appearanceResources': `export const resolveAppearanceResource=async(kind,id)=>{
      if(id!==${JSON.stringify('a'.repeat(64))}+(kind==='media'?'.mp4':''))return null;
      return {path:${JSON.stringify(directory)}+'/public.'+(kind==='font'?'woff2':'mp4'),root:${JSON.stringify(directory)},mime:kind==='font'?'font/woff2':'video/mp4'}
    };`,
    electron: `import {state} from 'fixture'; export const session={fromPartition:(partition,options)=>{
      const item={partition,options,protocol:{handle:(scheme,handler)=>{item.scheme=scheme;item.handler=handler},unhandle:()=>{item.unhandled=true}},
        webRequest:{onBeforeRequest:handler=>{item.request=handler}},setPermissionRequestHandler:handler=>{item.permission=handler},
        setPermissionCheckHandler:handler=>{item.check=handler},setDevicePermissionHandler:handler=>{item.device=handler},on:()=>{},removeListener:()=>{},
        closeAllConnections:async()=>{item.connectionsClosed=true},clearStorageData:async()=>{item.storageCleared=true}};
      state.sessions.push(item);return item}};`,
    '@main/plugin/PluginRegistry': `import {state} from 'fixture';
      import {localCatalogResources,remoteCatalogResources} from '@main/plugin/catalogResources';
      export const pluginRegistry={
      getCatalogResources:id=>id!=='com.github.eNest.catalog'?{screenshots:[]}:state.remote?remoteCatalogResources(state.remote):localCatalogResources({id,version:'1.0.0',...state.publicManifest},state.publicRoot??${JSON.stringify(catalogRoot)},state.devSource?'dev':'preview',state.devSource===true),
      getAssetManifest:id=>id==='com.github.eNest.catalog'?state.publicManifest:null,
      getAssetRootPath:id=>id==='com.github.eNest.catalog'?(state.publicRoot??${JSON.stringify(catalogRoot)}):null,
      get:id=>id==='com.github.eNest.catalog'?{id,dev:state.devSource===true,devSource:state.devSource===true}:null,
      getInstalledDescriptors:()=>[{id:state.page.contribution.source,enabled:state.enabled}],
      getManifest:()=>({contributes:{homePages:[state.page.contribution]}})
    };`
  }
  const output = await build({
    stdin: { contents: `export * from '@main/home/homeSessionPolicy';export {state} from 'fixture';export const nonce=${Math.random()}`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`,
    plugins: [{ name: 'home-session-fixture', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    } }]
  })
  const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
  return { ...api, page, cleanup: async () => { await rm(directory, { recursive: true, force: true }); delete globalThis.homePolicyFixture } }
}

test('Home protocol serves only its entry/assets and exact public manifest slots', async () => {
  const api = await fixture()
  try {
    const read = url => api.serveHomeResource(api.page, new Request(url))
    const entry = await read(api.homeEntryUrl(api.page))
    assert.equal(entry.status, 200)
    assert.match(await entry.text(), /doctype/)
    assert.match(entry.headers.get('Content-Security-Policy'), /frame-src 'none'/)
    assert.match(entry.headers.get('Content-Security-Policy'), /script-src 'self'/)
    assert.equal(entry.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(await (await read('enest-home://surface/app.js')).text(), 'export const safe=true')
    assert.equal((await read('enest-home://surface/other.html')).status, 403)
    assert.equal((await read('enest-home://surface/escape.js')).status, 404)
    assert.equal((await read('file:///private/secret.txt')).status, 403)
    assert.equal((await read('enest-home://surface/%2fprivate.js')).status, 403)
    assert.equal((await read('enest-home://surface/app.js?path=/private')).status, 403)
    assert.equal((await api.serveHomeResource(api.page, { url: 'enest-home://user:password@surface/app.js', method: 'GET' })).status, 403)
    assert.equal((await read('enest-home://catalog/com.github.eNest.catalog/icon')).headers.get('Content-Type'), 'image/svg+xml')
    assert.equal(await (await read('enest-home://catalog/com.github.eNest.catalog/readme')).text(), '# Public readme')
    assert.equal((await read('enest-home://catalog/com.github.eNest.catalog/screenshot/0')).status, 200)
    const font = await read(`enest-home://appearance/font/${'a'.repeat(64)}`)
    assert.equal(font.status, 200)
    assert.equal(font.headers.get('Content-Type'), 'font/woff2')
    assert.equal((await read(`enest-home://appearance/media/${'a'.repeat(64)}.mp4`)).status, 200)
    assert.equal((await read('enest-home://appearance/font/private.ttf')).status, 404)
    for (const path of ['secret.txt', 'assets/README.md', 'screenshot/8', 'screenshot/00']) {
      assert.equal((await read(`enest-home://catalog/com.github.eNest.catalog/${path}`)).status, 404)
    }
    api.state.publicManifest.icon = '../outside.js'
    assert.equal((await read('enest-home://catalog/com.github.eNest.catalog/icon')).status, 404)
    api.state.enabled = false
    assert.equal((await read(api.homeEntryUrl(api.page))).status, 403)
  } finally { await api.cleanup() }
})

test('remote catalog slots serve host-fetched bytes with fixed headers and cannot become URL relays', async t => {
  const api = await fixture()
  const base = 'https://github.com/hyqf98/eNest_plugin/releases/download/v1/'
  api.state.remote = { id: 'com.github.eNest.catalog', version: '1.0.0',
    icon: base + 'catalog%401.0.0-icon.svg', readmeUrl: base + 'catalog%401.0.0-README.md',
    screenshots: [base + 'catalog%401.0.0-screenshot-1.png'] }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    const readme = url.endsWith('.md')
    return new Response(readme ? '# Remote README' : '<svg/>', { headers: {
      'content-type': readme ? 'text/plain' : 'image/svg+xml',
      'set-cookie': 'untrusted=secret', location: 'https://outside.example'
    } })
  })
  try {
    const iconUrl = 'enest-home://catalog/com.github.eNest.catalog/icon'
    const icon = await api.serveHomeResource(api.page, new Request(iconUrl, { headers: { Cookie: 'private=1', Authorization: 'private', Origin: 'https://untrusted.example' } }))
    assert.equal(icon.status, 200)
    assert.equal(await icon.text(), '<svg/>')
    assert.equal(icon.headers.get('Content-Type'), 'image/svg+xml')
    assert.equal(icon.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(icon.headers.get('Access-Control-Allow-Origin'), 'enest-home://surface')
    assert.equal(icon.headers.get('Set-Cookie'), null)
    assert.equal(icon.headers.get('Location'), null)
    assert.doesNotMatch(icon.headers.get('Content-Security-Policy'), /https?:/)
    assert.deepEqual(calls[0].options.headers, { Accept: 'image/svg+xml' })
    const head = await api.serveHomeResource(api.page, new Request(iconUrl, { method: 'HEAD' }))
    assert.equal(head.status, 200); assert.equal(head.body, null); assert.equal(calls.length, 1)
    assert.equal(await (await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/readme'))).text(), '# Remote README')
    for (const path of ['icon?url=https://127.0.0.1/private', 'screenshot/8', 'https%3a%2f%2fexample.com', 'assets/market/icon.svg']) {
      const reply = await api.serveHomeResource(api.page, new Request(`enest-home://catalog/com.github.eNest.catalog/${path}`))
      assert.ok([403, 404].includes(reply.status))
    }
    assert.equal(calls.length, 2)
    api.state.remote = { ...api.state.remote, icon: 'https://127.0.0.1/private.svg' }
    assert.equal((await api.serveHomeResource(api.page, new Request(iconUrl))).status, 404)
    assert.equal(calls.length, 2)
  } finally { await api.cleanup() }
})

test('catalog rejects a remote resource completed after its selected version changes', async t => {
  const api = await fixture()
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  api.state.remote = { id: 'com.github.eNest.catalog', version: '1.0.0', icon: 'https://github.com/hyqf98/eNest_plugin/releases/download/v1/catalog%401.0.0-icon.svg' }
  t.mock.method(globalThis, 'fetch', async () => { started(); await new Promise(resolve => { release = resolve }); return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }) })
  try {
    const pending = api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/icon'))
    await waiting
    api.state.remote = null // a local preview/installation replaced the remote source
    release()
    assert.equal((await pending).status, 404)
  } finally { release?.(); await api.cleanup() }
})

test('catalog local resources enforce README/image budgets and reject symlink aliases', async () => {
  const api = await fixture()
  const catalogRoot = join(api.page.rootPath, '..', 'catalog')
  try {
    await writeFile(join(catalogRoot, 'assets/README.md'), Buffer.alloc(512 * 1024 + 1))
    assert.equal((await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/readme'))).status, 404)
    await writeFile(join(catalogRoot, 'assets/icon.svg'), Buffer.alloc(16 * 1024 * 1024 + 1))
    assert.equal((await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/icon'))).status, 404)
    await writeFile(join(catalogRoot, 'assets/README.md'), '# Small README')
    await symlink(join(catalogRoot, 'assets/README.md'), join(catalogRoot, 'assets/alias.md'))
    api.state.publicManifest.market.readme = 'assets/alias.md'
    assert.equal((await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/readme'))).status, 404)
  } finally { await api.cleanup() }
})

test('built-in HTML CSP agrees with the session policy for catalog icons, media, fonts and readmes', async () => {
  const api = await fixture()
  try {
    const html = await readFile(join(root, 'src/renderer/home.html'), 'utf8')
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
    assert.ok(meta, 'the development Home must retain its own restrictive CSP')
    const response = await api.serveHomeResource(api.page, new Request(api.homeEntryUrl(api.page)))
    const policy = response.headers.get('Content-Security-Policy')
    // Chromium intersects both policies; a stricter stale meta silently breaks local resources.
    assert.equal(meta, policy.replace("; frame-ancestors 'none'", ''))
    assert.match(meta, /img-src 'self' enest-home: data:/)
    assert.match(meta, /media-src enest-home:\/\/appearance/)
    assert.match(meta, /font-src 'self' enest-home:\/\/appearance/)
    assert.match(meta, /connect-src 'self' enest-home:\/\/catalog enest-home:\/\/appearance/)
    assert.equal(/https?:|\*/.test(meta), false, 'the resource fix must not enable outbound network')
  } finally { await api.cleanup() }
})

test('Home sessions are non-persistent and deny network, devices, file access and nested pages', async () => {
  const api = await fixture()
  try {
    const first = api.createHomeSession(api.page, 1)
    const second = api.createHomeSession(api.page, 1)
    assert.notEqual(first.partition, second.partition)
    assert.equal(first.partition.startsWith('persist:'), false)
    assert.deepEqual(first.options, { cache: false })
    assert.equal(first.check(), false)
    assert.equal(first.device(), false)
    let permission
    first.permission(null, 'clipboard-read', value => { permission = value })
    assert.equal(permission, false)
    const allowed = (url, resourceType = 'script') => {
      let result
      first.request({ url, resourceType }, value => { result = value })
      return result.cancel === false
    }
    assert.equal(allowed(api.homeEntryUrl(api.page), 'mainFrame'), true)
    assert.equal(allowed('enest-home://surface/app.js'), true)
    assert.equal(allowed('enest-home://catalog/com.github.eNest.catalog/icon', 'image'), true)
    assert.equal(allowed('data:image/svg+xml,<svg/>', 'image'), true)
    for (const url of ['file:///private/secret', 'https://example.com/', 'http://localhost:5555/', 'ws://localhost:5555/', 'enest://plugin/com.github.eNest.catalog/secret.txt']) {
      assert.equal(allowed(url), false)
    }
    assert.equal(allowed('enest-home://surface/app.js', 'mainFrame'), false)
    assert.equal(allowed(api.homeEntryUrl(api.page), 'subFrame'), false)
    assert.equal(allowed('enest-home://catalog/com.github.eNest.catalog/readme', 'subFrame'), false)
    await api.disposeHomeSession(first)
    assert.equal(first.unhandled, true)
    assert.equal(first.connectionsClosed, true)
    assert.equal(first.storageCleared, true)
    assert.equal(allowed(api.homeEntryUrl(api.page), 'mainFrame'), false)
    await api.disposeHomeSession(first)
  } finally { await api.cleanup() }
})

test('only built-in development Home can access the configured loopback origin', async () => {
  const api = await fixture()
  const previous = process.env.ELECTRON_RENDERER_URL
  process.env.ELECTRON_RENDERER_URL = 'http://127.0.0.1:5173'
  try {
    const builtin = { ...api.page, contribution: { ...api.page.contribution, source: 'enest.builtin' } }
    const ses = api.createHomeSession(builtin, 2)
    const allowed = (url, resourceType = 'script') => {
      let result
      ses.request({ url, resourceType }, value => { result = value })
      return result.cancel === false
    }
    assert.equal(allowed('http://127.0.0.1:5173/home.html', 'mainFrame'), true)
    assert.equal(allowed('http://127.0.0.1:5173/src/renderer/homeClient.ts'), true)
    assert.equal(allowed('ws://127.0.0.1:5173/', 'webSocket'), true)
    assert.equal(allowed('http://127.0.0.1:5173/settings.html', 'mainFrame'), false)
    assert.equal(allowed('http://127.0.0.1:5174/source.js'), false)
    assert.equal(allowed('http://localhost:5173/source.js'), false)
    const plugin = api.createHomeSession(api.page, 3)
    let pluginAllowed
    plugin.request({ url: 'http://127.0.0.1:5173/source.js', resourceType: 'script' }, value => { pluginAllowed = !value.cancel })
    assert.equal(pluginAllowed, false)
    const request = new Request('enest-home://catalog/com.github.eNest.catalog/readme', { headers: { Origin: 'https://untrusted.example' } })
    const builtinResource = await api.serveHomeResource(builtin, request)
    assert.equal(builtinResource.status, 200)
    assert.equal(builtinResource.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173')
    const pluginResource = await api.serveHomeResource(api.page, request)
    assert.equal(pluginResource.status, 200)
    assert.equal(pluginResource.headers.get('Access-Control-Allow-Origin'), 'enest-home://surface')
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = previous
    await api.cleanup()
  }
})

test('catalog CORS uses only the validated built-in development origin, not arbitrary configuration or request origins', async () => {
  const api = await fixture()
  const previous = process.env.ELECTRON_RENDERER_URL
  try {
    const builtin = { ...api.page, contribution: { ...api.page.contribution, source: 'enest.builtin' } }
    for (const [configured, expected] of [
      ['http://localhost:5173/nested/', 'http://localhost:5173'],
      ['https://[::1]:5173', 'https://[::1]:5173'],
      ['https://untrusted.example', 'enest-home://surface'],
      ['http://user:secret@127.0.0.1:5173', 'enest-home://surface'],
      ['file:///private/home.html', 'enest-home://surface'],
      ['', 'enest-home://surface'],
    ]) {
      process.env.ELECTRON_RENDERER_URL = configured
      const response = await api.serveHomeResource(builtin, new Request('enest-home://catalog/com.github.eNest.catalog/readme', { headers: { Origin: 'https://not-the-configured-origin.example' } }))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), expected)
    }
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = previous
    await api.cleanup()
  }
})

test('a source-preview plugin icon resolves through public/assets like the plugin protocol does', async () => {
  const api = await fixture()
  try {
    const sourceRoot = join(api.page.rootPath, '..', 'source-plugin')
    await mkdir(join(sourceRoot, 'public', 'assets'), { recursive: true })
    await writeFile(join(sourceRoot, 'public', 'assets', 'icon.svg'), '<svg id="source"/>')
    await writeFile(join(sourceRoot, 'public', 'assets', 'README.md'), '# Source README')
    await writeFile(join(sourceRoot, 'public', 'assets', 'shot.png'), 'PNG')
    // manifest 按打包布局声明 assets/*；源码态真实文件在 public/assets/*。
    api.state.publicManifest = { icon: 'assets/icon.svg', market: { readme: 'assets/README.md', screenshots: ['assets/shot.png'] } }
    api.state.publicRoot = sourceRoot
    api.state.devSource = true
    const response = await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/icon'))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '<svg id="source"/>')
    assert.equal(response.headers.get('Content-Type'), 'image/svg+xml')
    assert.equal(await (await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/readme'))).text(), '# Source README')
    assert.equal((await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/screenshot/0'))).status, 200)
    // 映射不等于放开目录：越界声明仍然被拒。
    api.state.publicManifest = { icon: '../outside.js' }
    assert.equal((await api.serveHomeResource(api.page, new Request('enest-home://catalog/com.github.eNest.catalog/icon'))).status, 404)
  } finally { await api.cleanup() }
})
