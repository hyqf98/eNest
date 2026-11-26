import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  stdin: { contents: `export * from '@shared/pluginTextInput'; export { publicLaunchAliases } from '@shared/search'; export { collectPluginFeatureIssues } from '@shared/pluginCommands'; export { rankDefaultQuickCatalog } from '@renderer/themes/default/quick/searchPolicy'; export { asQuickNameMatch, quickNameRow } from '@renderer/themes/default/quick/catalogPolicy';`, resolveDir: root },
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

test('both launch directories expose the same bounded, untruncated aliases, never system paths', () => {
  const aliases = Array.from({ length: 105 }, (_, index) => `keyword ${index}`)
  assert.deepEqual(api.publicLaunchAliases([' /private/file', 'C:\\file', '\\\\server\\file', 'line\nbreak',
    'x'.repeat(257), ' keyword 0 ', '', ...aliases]), aliases.slice(0, 100))
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

test('the same query separates drawing entry names, text consumers and a plugin-returned history preview', () => {
  const catalog = [
    { id: 'desktop', kind: 'plugin', title: '桌面标注', aliases: ['桌面画板'] },
    { id: 'board', kind: 'plugin', title: '画板', aliases: ['draw'] },
    { id: 'translate', kind: 'plugin', title: '翻译文本', content: { type: 'over', minLength: 1 } },
    { id: 'record', kind: 'plugin', title: '一条历史预览', provider: true }
  ]
  const rank = matches => api.rankDefaultQuickCatalog(catalog, '画板', null, 60, matches).map(item => [item.title, item.group])
  const named = [['画板', 'best'], ['桌面标注', 'best']]
  assert.deepEqual(rank(new Set()), [...named, ['一条历史预览', 'provider']])
  assert.deepEqual(rank(new Set(['translate'])), [...named, ['翻译文本', 'recommendation'], ['一条历史预览', 'provider']])
})

test('worker and synchronous ranking find display titles, aliases and mixed terms without minting prefix triggers', async () => {
  const catalog = [
    { id: 'draw', kind: 'plugin', title: '桌面画板', aliases: ['canvas tool', 'scratch'], textInput: prefix },
    { id: 'content-only', kind: 'plugin', title: '桌面画板', aliases: [], textInput: prefix },
    { id: 'title-only', kind: 'plugin', title: '便笺', textInput: prefix },
    { id: 'no-prefix', kind: 'plugin', title: '快捷操作', aliases: ['quick'], textInput: { type: 'text', trigger: 'none' } },
    { id: 'capture', kind: 'plugin', title: '截图', aliases: ['截屏', 'screenshot', 'jt'] },
    { id: 'full', kind: 'plugin', title: '全屏截图', aliases: ['fullscreen'], preferred: true },
    { id: 'diff', kind: 'plugin', title: '文本对比', aliases: ['db'] },
    { id: 'todo', kind: 'plugin', title: '待办清单', aliases: ['db'], preferred: true }
  ]
  const bundle = await build({ entryPoints: [join(root, 'src/renderer/themes/default/quick/nameSearchWorker.ts')],
    tsconfig: join(root, 'tsconfig.web.json'), bundle: true, write: false, platform: 'browser', format: 'iife' })
  let response
  const self = { postMessage: message => { response = message } }
  runInNewContext(bundle.outputFiles[0].text, { self })
  const rows = catalog.map(api.quickNameRow)
  const preferred = catalog.flatMap((item, index) => item.preferred ? [index] : [])
  self.onmessage({ data: { id: 0, query: '', filter: null, preferred: [], index: { upsert: rows, remove: [], order: rows.map(row => row.key) } } })
  for (const [query, expected] of [
    ['画板', [['draw', '桌面画板', false]]], ['zmhb', [['draw', '桌面画板', false]]],
    ['ＳＣＲＡＴＣＨ', [['draw', '桌面画板', false]]], ['画板 scratch', [['draw', '桌面画板', false]]],
    ['canvas   tool\t原 文', [['draw', '桌面画板', true]]], ['桌面画板 原文', []], ['zmhb 原文', []],
    ['便笺', [['title-only', '便笺', false]]], ['便笺 原文', []], ['quick 原文', []],
    ['ＪＴ', [['capture', '截图', false], ['full', '全屏截图', false]]], ['jietu', [['capture', '截图', false], ['full', '全屏截图', false]]],
    ['screenshot', [['capture', '截图', false]]], ['截屏', [['capture', '截图', false]]], ['qpjt', [['full', '全屏截图', false]]],
    ['db', [['todo', '待办清单', false], ['diff', '文本对比', false]]]
  ]) {
    self.onmessage({ data: { id: 1, query, filter: null, preferred } })
    const matches = Array.from(response.hits, hit => api.asQuickNameMatch(catalog[hit.index], hit.prefix))
    assert.deepEqual(matches.map(item => [item.id, item.title, Boolean(item.prefix)]), expected, `worker: ${query}`)
    assert.deepEqual(api.rankDefaultQuickCatalog(catalog, query).map(item => [item.id, item.title, Boolean(item.prefix)]), expected, `sync: ${query}`)
  }
  assert.deepEqual(api.buildPluginTextInput('桌面画板 原文', catalog[0].aliases, prefix), { text: '桌面画板 原文', query: { raw: '桌面画板 原文' } })
})

test('manifest validator rejects malformed input declarations and unknown fields', () => {
  const validate = input => api.collectPluginFeatureIssues([{ code: 'main', cmds: ['text'], input }])
  assert.deepEqual(validate(prefix), [])
  assert.deepEqual(validate({ type: 'text', trigger: 'none' }), [])
  for (const input of [null, [], {}, { type: 'file', trigger: 'prefix' }, { type: 'text', trigger: 'fuzzy' }, { ...prefix, payload: 'untrusted' }]) {
    assert.match(validate(input).join('\n'), /features\[0\]\.input/)
  }
})
