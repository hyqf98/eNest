import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const ipcFile = resolve(root, 'src/shared/types/ipc.ts')
const source = path => readFileSync(path, 'utf8')

test('channel literals have one source and the enumeration map only refers to those exports', () => {
  const file = ts.createSourceFile(ipcFile, source(ipcFile), ts.ScriptTarget.Latest, true)
  const values = new Map()
  let channels
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      if (declaration.name.text === 'IpcChannels') channels = declaration.initializer.expression
      else if (declaration.initializer && ts.isStringLiteral(declaration.initializer)) values.set(declaration.name.text, declaration.initializer.text)
    }
  }
  assert.ok(channels && ts.isObjectLiteralExpression(channels))
  assert.ok(values.size > 0)
  assert.equal(channels.properties.length, values.size)
  for (const property of channels.properties) {
    assert.ok(ts.isShorthandPropertyAssignment(property), 'the compatibility map must not duplicate channel literals')
    assert.ok(values.has(property.name.text), property.name.text)
  }
})

test('sandbox preloads access statically named channels instead of retaining the enumeration object', () => {
  const directory = resolve(root, 'src/preload')
  for (const name of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const path = resolve(directory, name), file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@shared/types/ipc') continue
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      assert.ok(bindings.elements.every(item => item.name.text !== 'IpcChannels'), name)
    }
  }
})

test('a two-channel sandbox preload stays one small CJS chunk with no unused channel catalog', async () => {
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    resolve: { alias: { '@shared': resolve(root, 'src/shared') } },
    build: {
      write: false, minify: 'oxc', target: 'node22',
      lib: { entry: resolve(root, 'src/preload/regionPreload.ts'), formats: ['cjs'], fileName: () => 'regionPreload.cjs' },
      rolldownOptions: { external: ['electron'], output: { codeSplitting: false } },
    },
  })
  const chunks = (Array.isArray(result) ? result.flatMap(item => item.output) : result.output).filter(item => item.type === 'chunk')
  assert.equal(chunks.length, 1)
  const code = chunks[0].code
  assert.ok(Buffer.byteLength(code) < 1_024, 'unused IPC names must not inflate tiny sandbox bridges')
  assert.match(code, /panel-region:confirm/)
  assert.match(code, /panel-region:cancel/)
  assert.doesNotMatch(code, /plugin-background:request|shell:get-settings|require\(["']\.\//)
})
