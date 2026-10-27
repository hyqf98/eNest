import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const read = file => readFileSync(new URL(file, root), 'utf8')
const parse = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
function load(file, imports) {
  const output = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(name => {
    if (Object.hasOwn(imports, name)) return imports[name]
    if (name.startsWith('node:')) return require(name)
    throw Error(`Unexpected dependency: ${name}`)
  }, module, module.exports)
  return module.exports
}
function registration() {
  const calls = []
  const api = load('src/main/plugin/pluginProtocol.ts', {
    electron: { protocol: { registerSchemesAsPrivileged: schemes => calls.push(schemes) } },
    '@shared/constants': load('src/shared/constants.ts', {}),
    '@shared/types/plugin': {}, '@main/paths/pathsService': {}, '@main/settings/SettingsStore': {},
    '@main/plugin/PluginRegistry': {}, '@main/theme/resolveThemeCss': {}, '@main/theme/appearanceResources': {},
    '@main/theme/quickThemeProtocol': { QUICK_THEME_PROTOCOL: 'enest-quick' },
    './pluginFileResponse': {}, './pluginPaths': {}, './pluginSessionPolicy': {},
  })
  api.registerSchemesAsPrivileged()
  return calls
}
function callsIn(source) {
  const calls = []
  function visit(node) {
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}
const common = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }

test('one registration retains all four schemes and their original privileges', () => {
  const calls = registration()
  assert.equal(calls.length, 1)
  assert.deepEqual(Object.fromEntries(calls[0].map(row => [row.scheme, row.privileges])), {
    enest: { ...common, stream: true, codeCache: true },
    'enest-quick': common,
    'enest-home': common,
    'enest-chrome': common,
  })
  assert.equal(new Set(calls[0].map(row => row.scheme)).size, 4)
})

test('production bootstrap has exactly one Electron registration and invokes it before ready', () => {
  const nativeCalls = []
  for (const path of readdirSync(new URL('src/main/', root), { recursive: true })) {
    if (!path.endsWith('.ts') || /\.(?:test|native-bench)\./.test(path)) continue
    const file = `src/main/${path}`
    for (const call of callsIn(parse(file))) {
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'registerSchemesAsPrivileged') nativeCalls.push(file)
    }
  }
  assert.deepEqual(nativeCalls, ['src/main/plugin/pluginProtocol.ts'])
  const entry = parse('src/main/index.ts'), calls = callsIn(entry)
  const registrationCalls = calls.filter(call => ts.isIdentifier(call.expression) && call.expression.text === 'registerSchemesAsPrivileged')
  assert.equal(registrationCalls.length, 1)
  assert.ok(ts.isExpressionStatement(registrationCalls[0].parent) && registrationCalls[0].parent.parent === entry)
  const ready = calls.find(call => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'whenReady')
  assert.ok(ready && registrationCalls[0].pos < ready.pos)
})

test('the unified call cannot overwrite plugin secure/fetch/CORS flags with home/chrome-only flags', () => {
  // Electron 44.4.3 electron_api_protocol.cc builds these lists per call, then
  // AppendSwitchASCII replaces each Chromium command-line switch value.
  const rendererFlags = new Map()
  const apply = schemes => {
    for (const flag of ['secure', 'supportFetchAPI', 'corsEnabled']) {
      const schemesWithFlag = schemes.filter(row => row.privileges[flag]).map(row => row.scheme)
      if (schemesWithFlag.length) rendererFlags.set(flag, schemesWithFlag)
    }
  }
  const [schemes] = registration()
  apply(schemes.filter(row => ['enest', 'enest-quick'].includes(row.scheme)))
  apply(schemes.filter(row => ['enest-home', 'enest-chrome'].includes(row.scheme)))
  assert.equal(rendererFlags.get('secure').includes('enest'), false, 'the old split registration loses plugin secure context')
  assert.equal(rendererFlags.get('supportFetchAPI').includes('enest'), false, 'the old split registration loses plugin fetch')
  rendererFlags.clear()
  apply(schemes)
  for (const flag of ['secure', 'supportFetchAPI', 'corsEnabled']) {
    assert.deepEqual(rendererFlags.get(flag), ['enest', 'enest-quick', 'enest-home', 'enest-chrome'])
  }
})
