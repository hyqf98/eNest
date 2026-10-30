import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  stdin: { contents: `export * from '@shared/pluginTextInput'; export { collectPluginFeatureIssues } from '@shared/pluginCommands'; export { rankDefaultQuickCatalog } from '@renderer/themes/default/quick/searchPolicy';`, resolveDir: root },
  tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false, platform: 'node', format: 'esm'
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const prefix = { type: 'text', trigger: 'prefix' }

test('prefix input is explicit or inferred only from a non-excluding text consumer', () => {
  assert.equal(api.resolvePluginFeatureInput({ cmds: ['format'] }), undefined)
  assert.equal(api.resolvePluginFeatureInput({ cmds: ['format', { type: 'regex', label: 'Format', match: '/x/' }] }), undefined)
  assert.equal(api.resolvePluginFeatureInput({ cmds: ['format', { type: 'over', label: 'Format', exclude: '/x/' }] }), undefined)
  assert.deepEqual(api.resolvePluginFeatureInput({ cmds: ['format', { type: 'over', label: 'Format' }] }), prefix)
  assert.deepEqual(api.resolvePluginFeatureInput({ cmds: ['format'], input: prefix }), prefix)
  assert.deepEqual(api.resolvePluginFeatureInput({ cmds: ['format', { type: 'over', label: 'Format' }], input: { type: 'text', trigger: 'none' } }), { type: 'text', trigger: 'none' })
})

test('a literal prefix consumes only the trigger and preserves original body text', () => {
  assert.deepEqual(api.buildPluginTextInput('fy Hello  World\n', ['fy', 'translate'], prefix), {
    text: 'Hello  World\n', query: { raw: 'fy Hello  World\n', trigger: 'fy' }
  })
  assert.deepEqual(api.buildPluginTextInput('  ＦＹ\thello', ['fy'], prefix), {
    text: 'hello', query: { raw: '  ＦＹ\thello', trigger: 'ＦＹ' }
  })
  assert.deepEqual(api.buildPluginTextInput('翻译 你好', ['翻译'], prefix), {
    text: '你好', query: { raw: '翻译 你好', trigger: '翻译' }
  })
})

test('the longest matching multi-word alias wins without interpreting expressions', () => {
  assert.deepEqual(api.matchPluginTextPrefix('open   note\tKeep Me', ['open', 'open note']), { trigger: 'open   note', text: 'Keep Me' })
  assert.deepEqual(api.matchPluginTextPrefix('a+b body', ['a+b']), { trigger: 'a+b', text: 'body' })
  assert.equal(api.matchPluginTextPrefix('aaab body', ['a+b']), undefined)
})

test('name-only, missing boundaries and explicit none keep legacy whole-query semantics', () => {
  for (const raw of ['fy', 'fy ', 'fyhello', 'body fy hello']) {
    assert.deepEqual(api.buildPluginTextInput(raw, ['fy'], prefix), { text: raw, query: { raw } })
  }
  assert.deepEqual(api.buildPluginTextInput('fy hello', ['fy'], { type: 'text', trigger: 'none' }), {
    text: 'fy hello', query: { raw: 'fy hello' }
  })
  assert.equal(api.buildPluginTextInput('fy hello', ['fy'], undefined), undefined)
  assert.equal(api.buildPluginTextInput('  ', ['fy'], prefix), undefined)
})

test('host-derived query input stays bounded and does not accept renderer metadata', () => {
  const input = api.buildPluginTextInput(`fy ${'x'.repeat(5000)}`, ['fy'], prefix)
  assert.equal(input.query.raw.length, api.PLUGIN_TEXT_QUERY_MAX_LENGTH)
  assert.equal(input.text.length, api.PLUGIN_TEXT_QUERY_MAX_LENGTH - 3)
  assert.deepEqual(Object.keys(input).sort(), ['query', 'text'])
})

test('explicit prefix outranks learned names and survives media long-text suppression', () => {
  const catalog = [
    { id: 'preferred', kind: 'plugin', title: 'fy hello', aliases: ['fy hello'], preferred: true },
    { id: 'text', kind: 'plugin', title: 'Text', aliases: ['fy'], textInput: prefix }
  ]
  assert.equal(api.rankDefaultQuickCatalog(catalog, 'fy hello')[0].id, 'text')
  assert.equal(api.rankDefaultQuickCatalog(catalog, `fy ${'hello '.repeat(20)}`, undefined, 60, new Set(), new Set(), true)[0].id, 'text')
  assert.deepEqual(api.rankDefaultQuickCatalog([{ ...catalog[1], textInput: undefined }], 'fy hello'), [])
})

test('manifest validator rejects malformed input declarations and unknown fields', () => {
  const validate = input => api.collectPluginFeatureIssues([{ code: 'main', cmds: ['text'], input }])
  assert.deepEqual(validate(prefix), [])
  assert.deepEqual(validate({ type: 'text', trigger: 'none' }), [])
  for (const input of [null, [], {}, { type: 'file', trigger: 'prefix' }, { type: 'text', trigger: 'fuzzy' }, { ...prefix, payload: 'untrusted' }]) {
    assert.match(validate(input).join('\n'), /features\[0\]\.input/)
  }
})
