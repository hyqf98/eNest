import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const bundle = await build({
  stdin: { resolveDir: root, contents: `
    export * from '@main/plugin/pluginIconArtwork';
    export * from '@shared/pluginIconArtwork';
    export { pluginAssetCache } from '@main/plugin/pluginFileResponse';
  ` },
  tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false, platform: 'node', format: 'esm'
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const id = 'com.enest.timestamp'
const transparent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <circle cx="16" cy="16" r="13" stroke="#e6edf7" stroke-width="2.4"/>
  <path d="M16 9v7l4.5 3" stroke="#e6edf7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
const dark = transparent.replace('\n', '\n  <rect width="32" height="32" rx="8" fill="#1c2330"/>\n')
const custom = dark.replace('#1c2330', '#219162')

test('both known legacy variants become the same color artwork; custom and third-party SVGs stay intact', () => {
  const artwork = api.upgradedBuiltinPluginIcon(id, transparent)
  assert.match(artwork, /fill="#527bc0"/)
  assert.equal(api.upgradedBuiltinPluginIcon(id, dark), artwork)
  assert.equal(api.upgradedBuiltinPluginIcon(id, dark.replaceAll('\n', '\r\n')), artwork)
  assert.equal(api.upgradedBuiltinPluginIcon(id, custom), undefined)
  assert.equal(api.upgradedBuiltinPluginIcon('com.example.timestamp', dark), undefined)
  assert.equal(api.upgradedBuiltinPluginIcon(id, artwork), undefined)
})

test('legacy protocol replies preserve HEAD, content length, conditional caching and package bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-legacy-icon-'))
  const path = join(directory, 'icon.svg')
  const url = `enest://plugin/${id}/assets/market/icon.svg`
  const options = { pluginId: id, root: directory, revision: 'fixture', dev: false, csp: "default-src 'none'" }
  try {
    await writeFile(path, dark)
    const response = await api.legacyPluginIconResponse(new Request(url), path, options)
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^image\/svg\+xml/)
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body)))
    assert.equal(response.headers.get('content-security-policy'), options.csp)
    const etag = response.headers.get('etag')
    const head = await api.legacyPluginIconResponse(new Request(url, { method: 'HEAD' }), path, options)
    assert.equal(await head.text(), '')
    assert.equal(head.headers.get('etag'), etag)
    assert.equal(head.headers.get('content-length'), response.headers.get('content-length'))
    const cached = await api.legacyPluginIconResponse(new Request(url, { headers: { 'If-None-Match': `W/${etag}` } }), path, options)
    assert.equal(cached.status, 304)
    assert.equal(cached.headers.get('content-length'), null)
    const stale = await api.legacyPluginIconResponse(new Request(url, { headers: { 'If-None-Match': 'W/"old-package-image"' } }), path, options)
    assert.equal(stale.status, 200)
    assert.equal(await readFile(path, 'utf8'), dark, 'compatibility must never rewrite a package')
    assert.ok(api.pluginAssetCache.getMetrics().hits > 0)
    assert.equal(await api.legacyPluginIconResponse(new Request(url.replace('icon.svg', 'custom.svg')), path, options), null)
    assert.equal(await api.legacyPluginIconResponse(new Request(url, { method: 'POST' }), path, options), null)
    await writeFile(path, custom)
    api.pluginAssetCache.invalidate(directory)
    assert.equal(await api.legacyPluginIconResponse(new Request(url), path, options), null)
  } finally {
    api.pluginAssetCache.invalidate(directory)
    await rm(directory, { recursive: true, force: true })
  }
})

test('remote compatibility is restricted to old official default icon paths and versions', () => {
  const urls = [
    `https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/plugins/${id}/icon.svg`,
    `https://github.com/hyqf98/eNest_plugin/releases/download/plugins-v1/${id}%401.0.0-icon.svg`,
    `https://raw.githubusercontent.com/hyqf98/eNest_plugin/main/${id}%401.0.0/assets/market/icon.svg`
  ]
  for (const url of urls) assert.match(api.resolveOfficialPluginIcon(id, '1.0.0', url), /^data:image\/svg\+xml,/)
  for (const url of [
    urls[0].replace('hyqf98', 'custom-owner'), urls[0].replace('/icon.svg', '/custom.svg'),
    urls[0].replace('raw.githubusercontent.com', 'example.com'), urls[0] + '?custom=1',
    `data:image/svg+xml,${encodeURIComponent(custom)}`, `enest://plugin/${id}/assets/market/icon.svg`
  ]) assert.equal(api.resolveOfficialPluginIcon(id, '1.0.0', url), url)
  assert.equal(api.resolveOfficialPluginIcon(id, '99.0.0', urls[0]), urls[0])
  assert.equal(api.resolveOfficialPluginIcon('com.example.timestamp', '1.0.0', urls[0]), urls[0])
})
