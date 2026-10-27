import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { build } from 'esbuild'

const read = file => readFileSync(fileURLToPath(new URL(file, new URL("../../../src/renderer/services/", import.meta.url))), 'utf8')
const readPreview = file => readFileSync(new URL(file, new URL('../../fixtures/browser-preview/', import.meta.url)), 'utf8')
function adapters() {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read('./shellApiAdapters.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, console })
  return module.exports
}

test('native adapter is complete and never silently falls back to preview', async () => {
  const { createNativeShellApi, SHELL_API_METHODS } = adapters()
  const calls = []
  const native = { getPlugins() { calls.push(this === native); return Promise.resolve(['native']) },
    onEvent(listener) { listener({ type: 'native-fixture' }); return () => calls.push('unsubscribe') } }
  const api = createNativeShellApi(native)
  assert.deepEqual(await api.getPlugins(), ['native'])
  const events = [], off = api.onEvent(value => events.push(value))
  off()
  assert.deepEqual(calls, [true, 'unsubscribe'])
  assert.equal(events[0].type, 'native-fixture')
  await assert.rejects(api.getSettings(), /getSettings/)
  await assert.rejects(api.setProxy({ type: 'system' }), /setProxy/)
  await assert.rejects(api.getThemeSettingsConfig(), /getThemeSettingsConfig/)
  assert.throws(() => api.closeWindow(), /closeWindow/)
  assert.throws(() => api.getPathForFile({}), /getPathForFile/)
  const source = ts.createSourceFile('shellApi.ts', read('./shellApi.ts'), ts.ScriptTarget.Latest, true)
  const contract = source.statements.find(item => ts.isInterfaceDeclaration(item) && item.name.text === 'ShellApi')
  assert.deepEqual([...SHELL_API_METHODS].sort(), contract.members.map(item => item.name.getText(source)).sort())
})

test('preview loader is single-flight and pending subscriptions are cancelable before hydration', async () => {
  const { createLazyPreviewShellApi } = adapters()
  let loads = 0, resolveLoad
  const listeners = new Set(), events = [], canceled = []
  const mock = { onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async getPlugins() { return ['fixture'] }, async setSettings(value) { for (const listener of listeners) listener(value) } }
  const api = createLazyPreviewShellApi(() => { loads++; return new Promise(resolve => { resolveLoad = resolve }) }, { close() {} })
  assert.equal(loads, 0)
  assert.equal(api.getPathForFile({}), '')
  assert.equal(loads, 0, 'pure preview geometry does not initialize registry/icons')
  const offCanceled = api.onEvent(event => canceled.push(event))
  offCanceled()
  const off = api.onEvent(event => events.push(event))
  const write = api.setSettings({ type: 'settings-fixture' })
  const read = api.getPlugins()
  await Promise.resolve()
  assert.equal(loads, 1)
  resolveLoad(mock)
  await write
  assert.deepEqual(await read, ['fixture'])
  assert.deepEqual(events, [{ type: 'settings-fixture' }], 'early subscribers attach before writes publish')
  assert.deepEqual(canceled, [])
  off()
  assert.equal(listeners.size, 0)
  await api.setSettings({ type: 'after-unsubscribe' })
  assert.equal(events.length, 1)
  assert.equal(loads, 1)
})

test('native static module graph has no mock registry or icon import and uses no top-level await', () => {
  const source = ts.createSourceFile('shellApi.ts', read('./shellApi.ts'), ts.ScriptTarget.Latest, true)
  const runtimeImports = source.statements.filter(item => ts.isImportDeclaration(item) && !item.importClause?.isTypeOnly)
    .map(item => item.moduleSpecifier.text)
  assert.deepEqual(runtimeImports, ['./shellApiAdapters'])
  assert.match(read('./shellApi.ts'), /import\('@test\/fixtures\/browser-preview\/mockShellApi'\)/)
  assert.doesNotMatch(read('./shellApi.ts'), /\.\.\.mockApi|createMockApi\(\)\s*\nconst rawShell|from ['"].*mockData/)
  assert.match(readPreview('./mockShellApi.ts'), /from '\.\/mockData'/)
  assert.match(readPreview('./mockData.ts'), /from '\.\/mockPluginIcon'/)
  assert.ok(!source.statements.some(item => ts.isExpressionStatement(item) && ts.isAwaitExpression(item.expression)))
})

test('release renderer omits preview registry and fails closed when preload is missing', async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('../../../src/renderer/services/shellApi.ts', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'releaseApi',
    target: 'es2022', minify: true, metafile: true, define: { 'import.meta.env.DEV': 'false' } })
  const emitted = Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs))
    .filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path)
  assert.ok(!emitted.some(path => /fixtures\/browser-preview/.test(path)), emitted.join('\n'))
  const environment = { window: {} }
  vm.runInNewContext(result.outputFiles[0].text, environment)
  assert.equal(environment.releaseApi.isMockShell, false)
  await assert.rejects(environment.releaseApi.shellApi.getPlugins(), /getPlugins/)
  assert.throws(() => environment.releaseApi.shellApi.onEvent(() => {}), /onEvent/)
})
