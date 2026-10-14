import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const adapters = {
  electron: `export const app = { getVersion: () => '0.1.0', getAppPath: () => '/fixture' };`,
  '@main/logs/logService': 'export const logInfo=()=>{}; export const logWarn=()=>{};'
}
const bundle = await build({
  stdin: { contents: `export * from '@shared/pluginCommands'; export { collectManifestIssues, installFromDirectory, isManifest } from '@main/plugin/PluginInstaller';`, resolveDir: root },
  tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const feature = (cmds, extra = {}) => [{ code: 'format', cmds, ...extra }]

test('command literals preserve escapes and flags and reject malformed or oversized patterns', () => {
  assert.deepEqual(api.parsePluginCommandPattern('/https?:\\/\\/example\\.com/i'), { source: 'https?:\\/\\/example\\.com', flags: 'i' })
  assert.deepEqual(api.parsePluginCommandPattern('/[a/b]+/gm'), { source: '[a/b]+', flags: 'gm' })
  for (const value of [null, 1, 'foo', '//', '/foo', '/foo/ii', '/foo/z', '/foo/uv', '/[/i', `/${'a'.repeat(2047)}/`]) {
    assert.equal(api.parsePluginCommandPattern(value), null, String(value))
  }
  assert.ok(api.parsePluginCommandPattern(`/${'a'.repeat(2046)}/`))
})

test('existing text commands and mixed regex/over features remain valid', () => {
  assert.deepEqual(api.collectPluginFeatureIssues(undefined), [])
  assert.deepEqual(api.collectPluginFeatureIssues([]), [])
  assert.deepEqual(api.collectPluginFeatureIssues(feature([
    '格式化', 'format',
    { type: 'regex', label: '识别网址', match: '/^https?:\\/\\//i', minLength: 8 },
    { type: 'regex', label: '兼容字段', regex: '/^[0-9]+$/', minLength: 0 },
    { type: 'regex', label: '主字段优先', match: '/first/', regex: '/second/' },
    { type: 'over', label: '翻译', exclude: '/^https?:/i', minLength: 1, maxLength: 10000 }
  ])), [])
})

test('invalid structures, duplicate feature identities and command typos report precise paths', () => {
  assert.match(api.collectPluginFeatureIssues({})[0], /features 必须是数组/)
  assert.match(api.collectPluginFeatureIssues([null])[0], /features\[0\]/)
  assert.match(api.collectPluginFeatureIssues([{ code: ' ', cmds: [] }]).join('\n'), /code/)
  assert.match(api.collectPluginFeatureIssues([...feature(['ok']), ...feature(['other'])]).join('\n'), /code 重复/)
  for (const cmd of ['', '  ', null, [], { type: 'img', label: '图片' }, { type: 'regex', label: '缺正则' }, { type: 'over', label: ' ' }, { type: 'over', label: '拼写错误', minLenght: 1 }]) {
    assert.match(api.collectPluginFeatureIssues(feature([cmd])).join('\n'), /features\[0\]\.cmds\[0\]/, JSON.stringify(cmd))
  }
})

test('length ranges are safe integers and include effective defaults', () => {
  for (const minLength of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.match(api.collectPluginFeatureIssues(feature([{ type: 'regex', label: 'x', match: '/x/', minLength }])).join('\n'), /minLength/)
  }
  for (const cmd of [
    { type: 'over', label: 'x', minLength: 8, maxLength: 7 },
    { type: 'over', label: 'x', minLength: 10001 },
    { type: 'over', label: 'x', maxLength: 0 },
    { type: 'over', label: 'x', exclude: '/[/' }
  ]) assert.notEqual(api.collectPluginFeatureIssues(feature([cmd])).length, 0)
  assert.deepEqual(api.collectPluginFeatureIssues(feature([{ type: 'over', label: 'x', minLength: 0, maxLength: 0 }])), [])
})

test('validation compiles patterns but never executes even a pathological expression', () => {
  const originalTest = RegExp.prototype.test
  const originalExec = RegExp.prototype.exec
  let issues
  try {
    RegExp.prototype.test = () => { throw new Error('validation must not match input') }
    RegExp.prototype.exec = () => { throw new Error('validation must not match input') }
    issues = api.collectPluginFeatureIssues(feature([
      { type: 'regex', label: '合法但昂贵', match: '/^(a+)+$/' },
      { type: 'over', label: '排除', exclude: '/(x|xx)+$/' }
    ]))
  } finally {
    RegExp.prototype.test = originalTest
    RegExp.prototype.exec = originalExec
  }
  assert.deepEqual(issues, [])
})

test('installation and lightweight manifest readers reject invalid commands before publishing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-command-manifest-'))
  const manifest = { id: 'com.test.commands', name: 'Commands', version: '1.0.0', main: 'index.html', features: feature([{ type: 'regex', label: '链接', match: '/^https?:/i' }]) }
  try {
    await writeFile(join(dir, 'index.html'), '<!doctype html>')
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest))
    assert.deepEqual(await api.installFromDirectory(dir), manifest)
    assert.equal(api.isManifest(manifest), true)
    const invalid = { ...manifest, features: feature([{ type: 'regex', label: '坏表达式', match: '/[/' }]) }
    assert.equal(api.isManifest(invalid), false)
    assert.match(api.collectManifestIssues(invalid, dir, '0.1.0').join('\n'), /com\.test\.commands: features\[0\]\.cmds\[0\]/)
    await writeFile(join(dir, 'plugin.json'), JSON.stringify(invalid))
    await assert.rejects(api.installFromDirectory(dir), /invalid plugin.json.*\n.*features\[0\]\.cmds\[0\]/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
