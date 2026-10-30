#!/usr/bin/env node
/** Static inventory only: never imports application code or executes test cases. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const exemptions = new Set()
const previewModule = '@test/fixtures/browser-preview/mockShellApi'
const previewLoader = 'src/renderer/services/shellApi.ts'
const isolationSites = new Map([
  ['src/main/index.ts', 'ENEST_TEST_USER_DATA'],
  ['src/main/paths/pathsService.ts', 'ENEST_TEST_DATA_ROOT'],
  ['src/main/paths/migrate.ts', 'ENEST_TEST_DATA_ROOT']
])
const testPath = /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|mocks?|browser-preview|preview)(?:\/|$)|(?:^|[./_-])(?:test|spec|fixture|smoke|probe|native-bench)(?:[./_-]|$)|(?:^|\/)(?:mock|fixture)[A-Z]|(?:Mock|Fixture)(?:\.|$)/
const testDependency = /^(?:node:)?(?:test|assert)(?:\/|$)|^(?:@playwright\/test|playwright(?:-core)?|vitest|@vitest\/[^/]+|jest|@jest\/[^/]+|mocha)(?:\/|$)/
const pluginDriver = /^(?:ssh2|mysql2?|pg|mongodb|redis|ioredis|mssql|oracledb)(?:\/|$)/
const scriptExtension = /\.(?:[cm]?[jt]sx?)$/
const sourceKey = path => relative(root, path).split(sep).join('/')

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      failures.push(`${sourceKey(path)}: symlink prevents a complete source inventory`)
      return []
    }
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function isDevCondition(node) {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'DEV'
    && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'env'
    && ts.isMetaProperty(node.expression.expression)
    && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.expression.name.text === 'meta'
}

function isDevPreviewImport(node, file) {
  if (file !== previewLoader || !ts.isCallExpression(node) || node.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isConditionalExpression(parent) && isDevCondition(parent.condition)
      && node.pos >= parent.whenTrue.pos && node.end <= parent.whenTrue.end) return true
  }
  return false
}

function moduleReference(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return node.moduleReference.expression
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
    || ts.isIdentifier(node.expression) && node.expression.text === 'require'
    || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'require' && node.expression.name.text === 'resolve')) return node.arguments[0]
  return undefined
}

function inspectSource(path) {
  const file = sourceKey(path)
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const fail = (node, reason) => failures.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${reason}`)
  for (const error of source.parseDiagnostics) failures.push(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`)
  function visit(node) {
    const reference = moduleReference(node)
    if (reference && ts.isStringLiteralLike(reference)) {
      const name = reference.text
      if (testDependency.test(name)) fail(node, `test dependency ${name}`)
      if (pluginDriver.test(name)) fail(node, `plugin-owned driver ${name}`)
      if (name.startsWith('@test/') || testPath.test(name)) {
        if (name === previewModule && isDevPreviewImport(node, file)) exemptions.add(`DEV-only dynamic preview import: ${file}`)
        else fail(node, `verification source import outside the DEV preview boundary: ${name}`)
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && /^(?:test|describe|it|suite|beforeEach|afterEach|beforeAll|afterAll)$/.test(node.expression.text)
      && node.arguments.some(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) fail(node, 'inline test callback')
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      const name = node.text
      if (/^ENEST_TEST_/.test(name)) {
        if (isolationSites.get(file) === name) exemptions.add(`Isolated-profile safety hook: ${file} (${name})`)
        else fail(node, `unreviewed test-environment hook ${name}`)
      }
      if (ts.isStringLiteralLike(node) && /^com\.github\.eNest\.(?!shell(?:\.|$))[a-zA-Z0-9-]+$/.test(name)) {
        if (file === 'src/main/clipboard/legacyClipboardMigration.ts' && name === 'com.github.eNest.clipboard') {
          exemptions.add(`Legacy data owner fence: ${file} (${name})`)
        } else fail(node, `plugin-specific identity literal ${name}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const sources = filesUnder(join(root, 'src'))
for (const path of sources) {
  const file = sourceKey(path)
  if (testPath.test(file)) failures.push(`${file}: verification file in src`)
  if (scriptExtension.test(path)) inspectSource(path)
}
console.log(`Inspected ${sources.length} physical src files (including hidden and ignored files).`)
for (const item of [...exemptions].sort()) console.log(`Retained: ${item}`)

if (process.argv.includes('--build-output')) {
  const output = join(root, 'out')
  if (!existsSync(output)) failures.push('out/: build output is missing; run the build before auditing it')
  else {
    const artifacts = filesUnder(output).filter(path => /\.(?:[cm]?js|html)$/.test(path))
    if (!artifacts.length) failures.push('out/: no executable artifacts found')
    for (const path of artifacts) {
      const file = sourceKey(path)
      const content = readFileSync(path, 'utf8')
      const leaked = /@test\/|tests\/fixtures\/|BrowserPreviewApp|enest-browser-preview-fixture|mockShellApi|mockPluginIcon|BUILTIN_PLUGIN_ICON_SVGS|enest\.installed\.v1|enest\.disabled\.v1|node:test|@playwright\/test|playwright-core/.exec(content)
      if (leaked) failures.push(`${file}: verification marker in production output (${leaked[0]})`)
      if (/^out\/preload\/.*\.cjs$/.test(file)) {
        for (const match of content.matchAll(/require\(["']([^"']+)["']\)/g)) {
          if (match[1] !== 'electron') failures.push(`${file}: sandbox preload depends on ${match[1]}`)
        }
      }
    }
    console.log(`Inspected ${artifacts.length} build artifacts for verification markers and preload dependencies.`)
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else console.log('Source boundaries passed. This is static evidence, not a test or runtime acceptance result.')
