import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const output=await build({entryPoints:['src/main/plugin/marketClient.ts'],tsconfig:'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'logs',setup(b){b.onResolve({filter:/^@main\/logs\/logService$/},()=>({path:'logs',namespace:'mock'}));b.onResolve({filter:/^@main\/proxy\/proxyService$/},()=>({path:'proxy',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},({path})=>({contents:path==='proxy'?'export const getActiveProxy=()=>({type:"none"});':'export const logInfo=()=>{};export const logWarn=()=>{};'}))}}]})
const {fetchMarketReadme}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
const resourceBundle = await build({ stdin: { contents: `export * from '@main/plugin/catalogResources';export * from '@main/plugin/marketResources';`, resolveDir: process.cwd() }, tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node' })
const { MarketResourceCache, registeredCatalogUrl, remoteCatalogResources, CATALOG_IMAGE_LIMIT } = await import('data:text/javascript;base64,' + Buffer.from(resourceBundle.outputFiles[0].text).toString('base64'))
test('market README uses registered descriptors, versioned cache and the bounded resource fetcher', async t => {
  const resource = version => ({ source: 'remote', kind: 'readme', pluginId: 'com.github.eNest.anything', version,
    url: `https://github.com/hyqf98/eNest_plugin/releases/download/v1/anything%40${version}-README.md` })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('# Readme', { headers: { 'content-type': 'text/plain' } }) })
  assert.equal(await fetchMarketReadme(resource('1.0.0')), '# Readme')
  assert.equal(await fetchMarketReadme(resource('1.0.0')), '# Readme')
  assert.equal(calls, 1)
  assert.equal(await fetchMarketReadme(resource('2.0.0')), '# Readme')
  assert.equal(calls, 2)
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.alloc(512 * 1024 + 1), { headers: { 'content-type': 'text/plain' } }))
  await assert.rejects(fetchMarketReadme(resource('3.0.0')), /byte limit/)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  await assert.rejects(fetchMarketReadme(resource('4.0.0')), /404/)
  await assert.rejects(fetchMarketReadme({ ...resource('5.0.0'), url: 'http://127.0.0.1/README.md' }), /invalid/)
})

const imageResource = (suffix = 'icon.svg', version = '1.0.0') => ({ source: 'remote', kind: 'image', pluginId: 'com.github.eNest.anything', version,
  url: `https://github.com/hyqf98/eNest_plugin/releases/download/v1/anything%40${version}-${suffix}` })
const svgResponse = () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })

test('catalog entry URLs are official HTTPS repo/plugin slots, not arbitrary URLs or private addresses', () => {
  const resource = imageResource()
  assert.ok(registeredCatalogUrl(resource.url, resource.pluginId, resource.version, resource.kind))
  for (const url of [
    'http://github.com/hyqf98/eNest_plugin/releases/download/v1/anything%401.0.0-icon.svg',
    'https://user:secret@github.com/hyqf98/eNest_plugin/releases/download/v1/anything%401.0.0-icon.svg',
    'https://github.com:8443/hyqf98/eNest_plugin/releases/download/v1/anything%401.0.0-icon.svg',
    'https://github.com/other/eNest_plugin/releases/download/v1/anything%401.0.0-icon.svg',
    'https://github.com/hyqf98/eNest_plugin/releases/download/v1/other%401.0.0-icon.svg',
    'https://github.com/hyqf98/eNest_plugin/releases/download/v1/anything%402.0.0-icon.svg',
    'https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/plugins/other/public/assets/market/icon.svg',
    'https://release-assets.githubusercontent.com/arbitrary/icon.svg', 'https://127.0.0.1/icon.svg',
    'https://[::1]/icon.svg', 'https://192.168.1.2/icon.svg', 'https://github.com.evil.example/icon.svg',
    resource.url + '?token=secret', resource.url + '#image', resource.url.replace('icon.svg', 'icon.html')
  ]) assert.equal(registeredCatalogUrl(url, resource.pluginId, resource.version, resource.kind), null, url)
  const mapped = remoteCatalogResources({ id: resource.pluginId, version: resource.version, icon: resource.url,
    screenshots: ['https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/plugins/anything/public/assets/market/screenshots/main.svg'] })
  assert.equal(mapped.icon.source, 'remote')
  assert.equal(mapped.screenshots.length, 1, 'SVG is allowed without broadening the URL entry boundary')
})

test('resource fetch manually validates redirects and sends no credentials; GitHub SVG text gets a host MIME', async () => {
  const calls = []
  const cache = new MarketResourceCache(async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/file?signature=public' } })
    return new Response('<svg/>', { headers: { 'content-type': 'text/plain', 'set-cookie': 'private=1', location: 'https://untrusted.example/' } })
  })
  const result = await cache.get(imageResource())
  assert.equal(result.mime, 'image/svg+xml')
  assert.equal(new TextDecoder().decode(result.body), '<svg/>')
  assert.equal(calls.length, 2)
  for (const { options } of calls) {
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.deepEqual(options.headers, { Accept: 'image/svg+xml' })
    assert.ok(options.signal instanceof AbortSignal)
  }
  for (const location of ['http://github.com/hyqf98/eNest_plugin/a.svg', 'https://127.0.0.1/private', 'https://evil.githubusercontent.com/a.svg',
    'https://user:password@objects.githubusercontent.com/a.svg', 'https://github.com/another/repo/a.svg']) {
    let requests = 0
    const denied = new MarketResourceCache(async () => { requests++; return new Response(null, { status: 302, headers: { location } }) })
    await assert.rejects(denied.get(imageResource()), /redirect/)
    assert.equal(requests, 1, 'a rejected redirect must never be fetched')
  }
  let requests = 0
  const loop = new MarketResourceCache(async () => { requests++; return new Response(null, { status: 302, headers: { location: imageResource().url } }) })
  await assert.rejects(loop.get(imageResource()), /redirect/)
  assert.equal(requests, 5)
})

test('resource images reject HTML and type confusion while both byte limits apply to streamed bodies', async () => {
  for (const [contentType, body, resource] of [
    ['text/html', '<svg/>', imageResource()],
    ['image/svg+xml', '<!doctype html><html>not svg</html>', imageResource()],
    ['image/png', '<!doctype html><html>not png</html>', imageResource('icon.png')],
    ['application/octet-stream', '<svg/>', imageResource()]
  ]) {
    const cache = new MarketResourceCache(async () => new Response(body, { headers: { 'content-type': contentType } }))
    await assert.rejects(cache.get(resource), /content type|image body/)
  }
  for (const [resource, maximum, contentType] of [
    [imageResource('icon.png'), CATALOG_IMAGE_LIMIT, 'image/png'],
    [{ ...imageResource('README.md'), kind: 'readme' }, 512 * 1024, 'text/plain']
  ]) {
    let cancelled = false
    const cache = new MarketResourceCache(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(maximum)); controller.enqueue(new Uint8Array(1)) },
      cancel() { cancelled = true }
    }), { headers: { 'content-type': contentType } }))
    await assert.rejects(cache.get(resource), /byte limit/)
    assert.equal(cancelled, true)
    const header = new MarketResourceCache(async () => new Response('', { headers: { 'content-type': contentType, 'content-length': String(maximum + 1) } }))
    await assert.rejects(header.get(resource), /byte limit/)
  }
})

test('resource cache deduplicates concurrent requests, bounds active fetches and keys by version', async () => {
  let calls = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const cache = new MarketResourceCache(async () => { calls++; await gate; return svgResponse() })
  const first = cache.get(imageResource()), second = cache.get(imageResource())
  assert.equal(first, second)
  release(); await Promise.all([first, second])
  await cache.get(imageResource()); assert.equal(calls, 1)
  await cache.get(imageResource('icon.svg', '2.0.0')); assert.equal(calls, 2)
  let active = 0, maximum = 0
  const gates = []
  const bounded = new MarketResourceCache(async () => {
    active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => gates.push(resolve))
    active--; return svgResponse()
  })
  const tasks = Array.from({ length: 8 }, (_, index) => bounded.get(imageResource('icon.svg', `${index}.0.0`)))
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  assert.equal(maximum, 4)
  while (gates.length || bounded.pending.size) {
    for (const done of gates.splice(0)) done()
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }
  await Promise.all(tasks)
  assert.equal(maximum, 4)
})

test('resources use a 10 second abort deadline, expire cached bytes and bound pending/entry counts', async t => {
  const originalTimeout = AbortSignal.timeout
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadlines.push(milliseconds); return originalTimeout(milliseconds) })
  let calls = 0
  const cache = new MarketResourceCache(async () => { calls++; return svgResponse() })
  await cache.get(imageResource())
  const now = Date.now()
  const originalNow = Date.now
  t.mock.method(Date, 'now', () => now + 300_001)
  await cache.get(imageResource())
  assert.equal(calls, 2)
  t.mock.method(Date, 'now', originalNow)
  for (let index = 0; index < 65; index++) await cache.get(imageResource('icon.svg', `${index}.0.0`))
  assert.equal(cache.cache.size, 64)
  assert.ok(deadlines.every(value => value === 10_000))
  let release
  const gate = new Promise(resolve => { release = resolve })
  const bounded = new MarketResourceCache(async () => { await gate; return svgResponse() })
  const pending = Array.from({ length: 128 }, (_, index) => bounded.get(imageResource('icon.svg', `${index}.0.0`)))
  await assert.rejects(bounded.get(imageResource('icon.svg', '128.0.0')), /queue is full/)
  release()
  await Promise.all(pending)
  assert.equal(bounded.pending.size, 0)
})

test('resource LRU has a total byte budget, bounded entries and no retained failed fills', async () => {
  let calls = 0
  const body = new Uint8Array(CATALOG_IMAGE_LIMIT)
  body.set([137, 80, 78, 71, 13, 10, 26, 10])
  const cache = new MarketResourceCache(async () => { calls++; return new Response(body, { headers: { 'content-type': 'image/png' } }) })
  for (let index = 0; index < 3; index++) await cache.get(imageResource('icon.png', `${index}.0.0`))
  assert.equal(cache.cache.size, 2)
  assert.equal(cache.bytes, 32 * 1024 * 1024)
  await cache.get(imageResource('icon.png', '0.0.0'))
  assert.equal(calls, 4, 'least-recently-used body was evicted')
  const rejected = new MarketResourceCache(async () => new Response('<html/>', { headers: { 'content-type': 'image/svg+xml' } }))
  await assert.rejects(rejected.get(imageResource()))
  assert.equal(rejected.cache.size, 0); assert.equal(rejected.pending.size, 0); assert.equal(rejected.bytes, 0)
})

const downloadBundle = await build({ entryPoints: ['src/main/plugin/marketClient.ts'], tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'download-fixture', setup(b) {
  b.onResolve({ filter: /^@main\/logs\/logService$/ }, () => ({ path: 'logs', namespace: 'fixture' }))
  b.onResolve({ filter: /^node:os$/ }, () => ({ path: 'os', namespace: 'fixture' }))
  b.onResolve({ filter: /^@main\/proxy\/proxyService$/ }, () => ({ path: 'proxy', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, x => ({ contents: x.path === 'logs' ? 'export const logInfo=()=>{};export const logWarn=()=>{};' : x.path === 'proxy' ? 'export const getActiveProxy=()=>({type:"none"});' : 'export const tmpdir=()=>globalThis.__marketDownloadTemp;' }))
} }] })
const { downloadPluginPackage, MAX_PLUGIN_PACKAGE_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(downloadBundle.outputFiles[0].text).toString('base64'))
async function downloadFixture(t, work) {
  const dir = await mkdtemp(join(tmpdir(), 'enest-market-download-test-'))
  globalThis.__marketDownloadTemp = dir
  try { await work(dir) } finally { await rm(dir, { recursive: true, force: true }); delete globalThis.__marketDownloadTemp }
}
function streamingResponse(chunks, contentLength = null) {
  const control = { reads: 0, cancelled: false, released: false }
  const iterator = chunks[Symbol.iterator]()
  return { control, response: { ok: true, headers: { get: () => contentLength }, body: { getReader: () => ({
    read: async () => { control.reads++; return iterator.next() }, cancel: async () => { control.cancelled = true }, releaseLock: () => { control.released = true }
  }) } } }
}

test('package download preserves bytes and sha256, reports progress and cleans the caller-owned temporary directory', async t => downloadFixture(t, async dir => {
  const body = Buffer.from('fixture archive bytes'), stream = streamingResponse([body]), progress = []
  t.mock.method(globalThis, 'fetch', async () => stream.response)
  const result = await downloadPluginPackage('https://example.test/plugin.enestplugin', { pluginId: 'com.github.eNest.database', fileName: '../../escaped.zip', expectedSha256: createHash('sha256').update(body).digest('hex'), onProgress: value => progress.push(value) })
  assert.deepEqual(await readFile(result.path), body)
  assert.equal(dirname(dirname(result.path)), dir)
  assert.deepEqual(progress.at(-1), { percent: 100, received: body.length, total: body.length })
  assert.equal(stream.control.cancelled, true); assert.equal(stream.control.released, true)
  await result.cleanup(); assert.deepEqual(await readdir(dir), [])
}))

test('all plugin identities share the 256 MiB header limit and oversize downloads never open the response reader', async t => downloadFixture(t, async dir => {
  assert.equal(MAX_PLUGIN_PACKAGE_BYTES, 256 * 1024 * 1024)
  for (const pluginId of [undefined, 'com.github.eNest.database', 'com.github.eNest.dsh', 'com.test.other']) {
    let reads = 0, signal
    t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return { ok: true, headers: { get: () => String(MAX_PLUGIN_PACKAGE_BYTES + 1) }, body: { getReader: () => { reads++; throw Error('must reject before reading') } } } })
    await assert.rejects(downloadPluginPackage('https://example.test/plugin.enestplugin', { pluginId }), /package too large/)
    assert.equal(reads, 0); assert.equal(signal.aborted, true); assert.deepEqual(await readdir(dir), [])
  }
}))

test('streamed package data cannot bypass the 256 MiB cap without Content-Length and partial files are deleted', async t => downloadFixture(t, async dir => {
  const chunk = Buffer.alloc(1024 * 1024, 0x61), count = MAX_PLUGIN_PACKAGE_BYTES / chunk.length
  const stream = streamingResponse((function* () { for (let i=0; i<count; i++) yield chunk; yield Buffer.from([0]) })())
  let received = 0
  t.mock.method(globalThis, 'fetch', async () => stream.response)
  await assert.rejects(downloadPluginPackage('https://example.test/plugin.enestplugin', { onProgress: progress => { received = progress.received } }), /exceeded 268435456 bytes/)
  assert.equal(received, MAX_PLUGIN_PACKAGE_BYTES, 'the exact boundary is allowed before one more byte is rejected')
  assert.equal(stream.control.reads, count + 1); assert.equal(stream.control.cancelled, true); assert.equal(stream.control.released, true)
  assert.deepEqual(await readdir(dir), [])
}))

test('hash mismatch and interrupted streams remove partial package files without publishing completion', async t => downloadFixture(t, async dir => {
  const stream = streamingResponse([Buffer.from('bad digest')]), progress=[]
  t.mock.method(globalThis, 'fetch', async () => stream.response)
  await assert.rejects(downloadPluginPackage('https://example.test/plugin.enestplugin', { expectedSha256: '0'.repeat(64), onProgress: x=>progress.push(x) }), /sha256 mismatch/)
  assert.ok(progress.every(x=>x.percent < 100)); assert.deepEqual(await readdir(dir), [])
  const broken = streamingResponse((function* () { yield Buffer.from('partial'); throw Error('network interrupted') })())
  t.mock.method(globalThis, 'fetch', async () => broken.response)
  await assert.rejects(downloadPluginPackage('https://example.test/plugin.enestplugin'), /network interrupted/)
  assert.equal(broken.control.cancelled, true); assert.equal(broken.control.released, true); assert.deepEqual(await readdir(dir), [])
}))
