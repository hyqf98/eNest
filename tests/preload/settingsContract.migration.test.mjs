import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
const contractPath = resolve(root, 'src/shared/types/pluginApi.ts')
const sdkPath = resolve(root, 'eNest_plugin/packages/plugin-sdk/index.d.ts')

function compileConsumer(body) {
  const file = resolve(root, 'enest-settings-contract-fixture.ts')
  const source = `import type { EnestPluginApi, SettingsSectionContribution } from './eNest_plugin/packages/plugin-sdk/index';
declare const api: EnestPluginApi;
${body}`
  const options = {
    noEmit: true, strict: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts']
  }
  const host = ts.createCompilerHost(options)
  const originalSource = host.getSourceFile.bind(host)
  const originalRead = host.readFile.bind(host)
  const originalExists = host.fileExists.bind(host)
  // Keep the third-party consumer virtual: compiling it must not leave scratch files.
  host.getSourceFile = (name, languageVersion, ...rest) => name === file
    ? ts.createSourceFile(name, source, languageVersion, true)
    : originalSource(name, languageVersion, ...rest)
  host.readFile = name => name === file ? source : originalRead(name)
  host.fileExists = name => name === file || originalExists(name)
  const program = ts.createProgram([file, sdkPath], options, host)
  return ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

test('dynamic settings registration reuses the canonical section contract', () => {
  const source = ts.createSourceFile(contractPath, readFileSync(contractPath, 'utf8'), ts.ScriptTarget.Latest, true)
  const api = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'EnestPluginApi')
  assert.ok(api)
  const settings = api.members.find(node => node.name?.getText(source) === 'settings')
  const register = settings.type.members.find(node => node.name?.getText(source) === 'register')
  assert.equal(register.parameters[0].type.getText(source), 'SettingsSectionContribution')
})

test('the generated SDK accepts explicit dynamic theme opt-in without casts', () => {
  const diagnostics = compileConsumer(`
const section: SettingsSectionContribution = {
  id: 'display', title: 'Display', schemaVersion: '1',
  items: [
    { key: 'followTheme', type: 'switch', label: 'Follow theme', default: true, shareWithThemes: true },
    { key: 'privateValue', type: 'text', label: 'Private', shareWithThemes: false }
  ]
};
void api.settings.register(section);
void api.settings.register({
  id: 'direct', title: 'Direct literal',
  items: [{ key: 'density', type: 'number', label: 'Density', min: 1, max: 3, shareWithThemes: true }]
});`)
  assert.deepEqual(diagnostics, [])
})

test('dynamic theme opt-in remains a typed boolean rather than an untyped escape hatch', () => {
  const diagnostics = compileConsumer(`
void api.settings.register({
  id: 'invalid', title: 'Invalid',
  items: [{ key: 'density', type: 'number', label: 'Density', shareWithThemes: 'true' }]
});`)
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /not assignable to type 'boolean/)
})
