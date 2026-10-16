import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
const output=await build({entryPoints:['src/main/plugin/marketClient.ts'],tsconfig:'tsconfig.node.json',bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'logs',setup(b){b.onResolve({filter:/^@main\/logs\/logService$/},()=>({path:'logs',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const logInfo=()=>{};export const logWarn=()=>{};'}))}}]})
const {fetchMarketReadme}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'))
test('market README fetching is bounded, caches version URLs and reports failed downloads',async()=>{
 let calls=0
 const server=createServer((req,res)=>{calls++;if(req.url==='/big'){res.end(Buffer.alloc(512*1024+1));return}if(req.url==='/missing'){res.writeHead(404);res.end();return}res.end('# '+req.url)})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${server.address().port}`
 try{
  assert.equal(await fetchMarketReadme(base+'/1.0.md'),'# /1.0.md');assert.equal(await fetchMarketReadme(base+'/1.0.md'),'# /1.0.md');assert.equal(calls,1)
  assert.equal(await fetchMarketReadme(base+'/2.0.md'),'# /2.0.md');assert.equal(calls,2)
  await assert.rejects(fetchMarketReadme(base+'/big'),/512 KiB/)
  await assert.rejects(fetchMarketReadme(base+'/missing'),/404/)
  await assert.rejects(fetchMarketReadme('file:///private/README.md'),/invalid/)
 }finally{await new Promise(resolve=>server.close(resolve))}
})

const downloadBundle = await build({ entryPoints: ['src/main/plugin/marketClient.ts'], tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'download-fixture', setup(b) {
  b.onResolve({ filter: /^@main\/logs\/logService$/ }, () => ({ path: 'logs', namespace: 'fixture' }))
  b.onResolve({ filter: /^node:os$/ }, () => ({ path: 'os', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, x => ({ contents: x.path === 'logs' ? 'export const logInfo=()=>{};export const logWarn=()=>{};' : 'export const tmpdir=()=>globalThis.__marketDownloadTemp;' }))
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
