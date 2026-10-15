import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const result = await build({ entryPoints: ['src/main/dev/devPluginEntry.ts'], tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'installer', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onResolve({ filter: /^@main\/plugin\/PluginInstaller$/ }, () => ({ path: 'installer', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'electron' ? 'export const net={fetch:globalThis.fetch};' : `import {readFile} from 'node:fs/promises';import {join} from 'node:path';export const installFromDirectory=async path=>JSON.parse(await readFile(join(path,'plugin.json'),'utf8'));`, loader: 'js' }))
  } }] })
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

test('automatic development selection verifies server identity and falls back to its own built package', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-dev-entry-'))
  let content = '<html><title>Another product</title></html>'
  const server = createServer((_request, response) => { response.end(content) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  const manifest = { id: 'com.example.ssh', name: 'SSH', version: '1.0.0', main: 'index.html', development: { main: url } }
  try {
    await mkdir(join(dir, 'dist'))
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
    await writeFile(join(dir, 'dist/plugin.json'), JSON.stringify({ ...manifest, development: undefined }))
    const fallback = await api.resolveDevPluginEntry(dir)
    assert.equal(fallback.rootPath, join(dir, 'dist'))
    assert.equal(fallback.devSource, false)
    assert.equal(fallback.devUrl, undefined, 'unrelated servers must never receive the plugin bridge')
    content = JSON.stringify({ ...manifest, id: 'com.example.another' })
    assert.equal((await api.resolveDevPluginEntry(dir)).rootPath, join(dir, 'dist'))
    content = JSON.stringify(manifest)
    const matching = await api.resolveDevPluginEntry(dir)
    assert.equal(matching.rootPath, dir)
    assert.equal(matching.devUrl, url)
    assert.equal(matching.devSource, true)
    content = 'x'.repeat(66000)
    assert.equal(await api.matchesDevelopmentServer(url, manifest.id), false)
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }) }
})

test('offline automatic entries reject missing or stale distributions with a useful build instruction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-dev-entry-'))
  try {
    const manifest = { id: 'com.example.ssh', name: 'SSH', version: '1.0.0', main: 'index.html', development: { main: 'http://127.0.0.1:1/' } }
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
    await assert.rejects(api.resolveDevPluginEntry(dir), /开发服务未启动.*npm run build/)
    await mkdir(join(dir, 'dist'))
    await writeFile(join(dir, 'dist/plugin.json'), JSON.stringify({ ...manifest, version: '0.9.0' }))
    await assert.rejects(api.resolveDevPluginEntry(dir), /版本不一致.*npm run build/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('plain source projects and explicit entry overrides retain their supported workflows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-dev-entry-'))
  try {
    await writeFile(join(dir, 'plugin.json'), JSON.stringify({ id: 'com.example.plain', main: 'index.html', version: '1.0.0' }))
    assert.equal((await api.resolveDevPluginEntry(dir)).rootPath, dir)
    assert.equal((await api.resolveDevPluginEntry(dir, { url: '' })).devUrl, undefined)
    assert.equal((await api.resolveDevPluginEntry(dir, { url: 'http://127.0.0.1:1/' })).devUrl, 'http://127.0.0.1:1/')
    await mkdir(join(dir, 'dist'))
    await writeFile(join(dir, 'dist/plugin.json'), await readFile(join(dir, 'plugin.json')))
    assert.equal((await api.resolveDevPluginEntry(dir, { preview: 'dist' })).rootPath, join(dir, 'dist'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
