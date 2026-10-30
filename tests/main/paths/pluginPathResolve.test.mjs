import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

async function fixture(platform) {
  const home = platform === 'win32' ? 'C:\\Users\\Example' : '/Users/example'
  const data = platform === 'win32' ? 'D:\\eNest\\plugin-data' : '/data/plugin-data'
  const adapters = {
    'node:os': `export const homedir=()=>${JSON.stringify(home)};`,
    'node:fs': 'export const existsSync=()=>false;',
    './pluginPrivatePaths': `export const pluginDataDir=()=>${JSON.stringify(data)};`
  }
  const output = await build({
    entryPoints: ['src/main/plugin/pluginPathResolve.ts'], tsconfig: 'tsconfig.node.json', bundle: true,
    write: false, format: 'esm', platform: 'node', define: { 'process.platform': JSON.stringify(platform) },
    plugins: [{ name: 'plugin-path-resolve', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: plugin path inputs reuse local-path rejection and preserve filename spaces`, async () => {
    const { resolvePluginPath } = await fixture(platform)
    for (const input of ['mailto:x', 'file:/tmp/a', 'ssh:host', 'https://example.com', '~another/path', 'C:relative']) {
      assert.equal(resolvePluginPath('test.paths', { input }).path, null, input)
    }
    assert.equal(resolvePluginPath('test.paths', { input: './name with trailing space ' }).path,
      platform === 'win32' ? 'C:\\Users\\Example\\name with trailing space ' : '/Users/example/name with trailing space ')
    assert.equal(resolvePluginPath('test.paths', { input: '.', base: 'data' }).path,
      platform === 'win32' ? 'D:\\eNest\\plugin-data' : '/data/plugin-data')
    assert.equal(resolvePluginPath('test.paths', { input: '.', base: 'invalid' }).path, null)
    assert.equal(resolvePluginPath('test.paths', { input: '~' }).path,
      platform === 'win32' ? 'C:\\Users\\Example' : '/Users/example')
    assert.equal(resolvePluginPath('test.paths', { input: '~/../sibling' }).path,
      platform === 'win32' ? 'C:\\Users\\sibling' : '/Users/sibling')
    assert.equal(resolvePluginPath('test.paths', { input: '.' }).absolute, false)
    assert.equal(resolvePluginPath('test.paths', { input: '~' }).absolute, true)
    if (platform === 'win32') {
      const unc = resolvePluginPath('test.paths', { input: '\\\\server\\share\\file' })
      assert.equal(unc.path, '\\\\server\\share\\file')
      assert.equal(unc.absolute, true)
      const rooted = resolvePluginPath('test.paths', { input: '\\file', base: 'data' })
      assert.equal(rooted.path, 'D:\\file')
      assert.equal(rooted.absolute, false, 'root-relative inputs still inherit the selected base drive')
      const absolute = resolvePluginPath('test.paths', { input: 'C:/file', base: 'data' })
      assert.equal(absolute.path, 'C:\\file')
      assert.equal(absolute.absolute, true)
      assert.equal(resolvePluginPath('test.paths', { input: '\\\\?\\C:\\file' }).path, null)
      assert.equal(resolvePluginPath('test.paths', { input: '\\\\server' }).path, null)
    }
  })
}
