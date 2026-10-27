import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { verifyShellBundleSource } from './after-pack.mjs'

async function source(relative) {
  const url = new URL(relative, import.meta.url)
  return ts.createSourceFile(url.pathname, await readFile(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

const main = await source('../../src/main/ipc/pluginHandlers.ts')
const tools = await source('../../src/main/ipc/pluginToolsHandlers.ts')

function declaration(file, name, predicate) {
  let found
  function visit(node) {
    if (predicate(node) && node.name?.getText(file) === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, `Missing production declaration: ${name}`)
  return found
}

function objectDeclaration(file, name) {
  const node = declaration(file, name, ts.isVariableDeclaration)
  assert.ok(node.initializer && ts.isObjectLiteralExpression(node.initializer), `${name} must remain an inspectable object`)
  return node.initializer
}

function propertyName(property) {
  assert.ok(property.name && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)), 'Computed permission keys require an explicit audit')
  return property.name.text
}

function methodCases(file, fn) {
  const cases = []
  function visit(node) {
    if (ts.isSwitchStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === 'method') {
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue
        assert.ok(ts.isStringLiteral(clause.expression), 'Computed dispatch cases require an explicit audit')
        cases.push(clause.expression.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(fn)
  return cases
}

const toolPermissions = objectDeclaration(tools, 'PLUGIN_TOOL_PERMISSIONS')
const toolMethods = toolPermissions.properties.map(propertyName)
const dispatch = declaration(main, 'dispatch', ts.isFunctionDeclaration)
const dispatchTool = declaration(tools, 'dispatchPluginTool', ts.isFunctionDeclaration)
const asObj = declaration(main, 'asObj', ts.isFunctionDeclaration)

function executable(parts, globals = {}) {
  // Only extract current production declarations; no Electron/OS operation is loaded.
  const compiled = ts.transpileModule(parts.join('\n'), {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  assert.deepEqual(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [], [])
  const context = vm.createContext({ exports: {}, ...globals })
  vm.runInContext(compiled.outputText, context, { timeout: 1000 })
  return context
}

const toolTableSource = `const PLUGIN_TOOL_PERMISSIONS = ${toolPermissions.getText(tools)};`

test('every tool permission is implemented once without a shadowed main dispatch case', () => {
  assert.equal(new Set(toolMethods).size, toolMethods.length)
  assert.deepEqual([...methodCases(tools, dispatchTool)].sort(), [...toolMethods].sort())
  const shadowed = methodCases(main, dispatch).filter(method => toolMethods.includes(method))
  assert.deepEqual(shadowed, [])
  const guard = dispatch.body.statements[0]
  assert.ok(ts.isIfStatement(guard))
  assert.ok(ts.isBinaryExpression(guard.expression) && guard.expression.operatorToken.kind === ts.SyntaxKind.InKeyword)
  assert.equal(guard.expression.left.getText(main), 'method')
  assert.equal(guard.expression.right.getText(main), 'PLUGIN_TOOL_PERMISSIONS')
  const last = guard.thenStatement.statements.at(-1)
  assert.ok(ts.isReturnStatement(last) && ts.isCallExpression(last.expression))
  assert.equal(last.expression.expression.getText(main), 'dispatchPluginTool')
})

test('main permissions inherit tool permissions without stale duplicate overrides', () => {
  const permissions = objectDeclaration(main, 'METHOD_PERMISSION')
  const inherited = permissions.properties.filter(ts.isSpreadAssignment)
  assert.equal(inherited.filter(item => item.expression.getText(main) === 'PLUGIN_TOOL_PERMISSIONS').length, 1)
  const shadowed = permissions.properties.filter(item => !ts.isSpreadAssignment(item))
    .map(propertyName).filter(method => toolMethods.includes(method))
  assert.deepEqual(shadowed, [])
  const context = executable([toolTableSource, `globalThis.permissions = ${permissions.getText(main)};`])
  assert.equal(context.permissions['shell.saveFile'], 'fs.write')
  assert.equal(context.permissions['shell.saveTextFile'], 'fs.write')
  const identifiers = []
  function visit(node) { if (ts.isIdentifier(node)) identifiers.push(node.text); ts.forEachChild(node, visit) }
  visit(main)
  assert.equal(identifiers.includes('argNum'), false)
  assert.equal(identifiers.includes('acquireQuickInteraction'), false)
})

test('real main dispatcher forwards every declared tool method without replacing its arguments', async () => {
  const calls = [], result = { native: 'stubbed' }
  const context = executable([toolTableSource, asObj.getText(main), dispatch.getText(main), 'globalThis.invoke = dispatch;'], {
    dispatchPluginTool: async (...args) => { calls.push(args); return result }
  })
  for (const method of toolMethods) {
    const args = [{ marker: method }]
    assert.equal(await context.invoke('fixture.plugin', method, args, {}), result)
    assert.deepEqual(calls.at(-1), ['fixture.plugin', method, args])
    assert.equal(calls.at(-1)[2], args)
  }
  assert.equal(calls.length, toolMethods.length)
})

test('both save method names reach the same production save primitive through the real dispatch chain', async () => {
  const calls = [], result = { ok: true, path: '/fixture/export.txt' }
  const context = executable([toolTableSource, asObj.getText(main), dispatchTool.getText(tools), dispatch.getText(main), 'globalThis.invoke = dispatch;'], {
    savePluginFile: async (...args) => { calls.push(args); return result }
  })
  for (const method of ['shell.saveTextFile', 'shell.saveFile']) {
    const payload = { defaultName: 'fixture.txt', content: 'fixture', dataUrl: 'data:text/plain;base64,Zml4dHVyZQ==' }
    assert.equal(await context.invoke('fixture.plugin', method, [payload], {}), result)
    assert.equal(calls.at(-1)[0], 'fixture.plugin')
    assert.equal(calls.at(-1)[1], payload)
  }
  assert.equal(calls.length, 2)
})

test('the release guard rejects default usage policy only in native host bundles', () => {
  for (const marker of ['queryPreferences', 'recordQuickUse', 'QUICK_RECENT_MAX', 'touchRecent', 'withPreferences']) {
    assert.throws(() => verifyShellBundleSource('out/main/index.js', `const value = '${marker}'`), /Default Quick usage policy leaked/)
    assert.throws(() => verifyShellBundleSource('out\\main\\worker.cjs', `const value = '${marker}'`), /Default Quick usage policy leaked/)
    assert.doesNotThrow(() => verifyShellBundleSource('out/renderer/assets/DefaultQuickSurface.js', `const value = '${marker}'`))
  }
  assert.doesNotThrow(() => verifyShellBundleSource('out/main/index.js', 'const state = { revision: 1, value: null }'))
})
