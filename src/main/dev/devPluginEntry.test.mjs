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
    b.onResolve({ filter: /^@main\/window\/createShellWindow$/ }, () => ({ path: 'shellwin', namespace: 'fixture' }))
    b.onResolve({ filter: /^@main\/logs\/logService$/ }, () => ({ path: 'logs', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      electron: 'export const net={fetch:globalThis.fetch};',
      shellwin: 'export const sendShellEvent=()=>{};',
      logs: 'export const logInfo=()=>{};export const logWarn=()=>{};'
    }[path] ?? `import {readFile} from 'node:fs/promises';import {join} from 'node:path';export const installFromDirectory=async path=>JSON.parse(await readFile(join(path,'plugin.json'),'utf8'));`, loader: 'js' }))
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
    await assert.rejects(api.resolveDevPluginEntry(dir), /开发服务未启动/)
    await mkdir(join(dir, 'dist'))
    await writeFile(join(dir, 'dist/plugin.json'), JSON.stringify({ ...manifest, version: '0.9.0' }))
    await assert.rejects(api.resolveDevPluginEntry(dir), /版本不一致/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('offline error hints carry the resolved command labels from package.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-dev-entry-'))
  try {
    const manifest = { id: 'com.example.pnpmplug', name: 'PNPM', version: '1.0.0', main: 'index.html', development: { main: 'http://127.0.0.1:1/' } }
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
    await writeFile(join(dir, 'pnpm-lock.yaml'), '')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }))
    // 端口 1 无人监听：拉起失败冷却内直接回退并提示解析出的命令
    await assert.rejects(api.resolveDevPluginEntry(dir), /pnpm run dev/)
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

test('prod mode loads the built artifact through the install path; missing artifacts report build-command gaps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-dev-entry-'))
  try {
    const manifest = { id: 'com.example.ssh', name: 'SSH', version: '1.0.0', main: 'index.html' }
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
    // 无构建命令且无产物：错误指向构建命令缺失，而不是写死的 npm
    await assert.rejects(api.resolveDevPluginEntry(dir, { mode: 'prod' }), /构建命令/)
    // 现成且版本一致的产物直接按正式安装路径加载，不触发构建
    await mkdir(join(dir, 'dist'))
    await writeFile(join(dir, 'dist/plugin.json'), JSON.stringify(manifest))
    const prod = await api.resolveDevPluginEntry(dir, { mode: 'prod' })
    assert.equal(prod.rootPath, join(dir, 'dist'))
    assert.equal(prod.devSource, false)
    assert.equal(prod.devUrl, undefined)
    assert.equal(prod.mode, 'prod')
    // 旧字段 preview:'dist' 等价 mode:'prod'
    assert.equal((await api.resolveDevPluginEntry(dir, { preview: 'dist' })).mode, 'prod')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('enest.output overrides the artifact directory in prod mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-dev-entry-'))
  try {
    const manifest = { id: 'com.example.out', name: 'OUT', version: '1.0.0', main: 'index.html' }
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' }, enest: { output: 'build-out' } }))
    await mkdir(join(dir, 'build-out'))
    await writeFile(join(dir, 'build-out/plugin.json'), JSON.stringify(manifest))
    const prod = await api.resolveDevPluginEntry(dir, { mode: 'prod' })
    assert.equal(prod.rootPath, join(dir, 'build-out'))
    assert.equal(prod.plan.build.label, 'npm run build')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
