import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../../../../src/renderer/themes/default/fileSearchKeys.ts', import.meta.url), 'utf8')
const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } })
const { resolveFileSearchKey } = await import(`data:text/javascript;base64,${Buffer.from(result.outputText).toString('base64')}`)

test('late file rows never change mixed Enter; focus enters the file section only by explicit navigation', () => {
  const mixed = { filesOnly: false, count: 3, index: 0, regularCount: 2, regularIndex: 0 }
  assert.equal(resolveFileSearchKey('Enter', mixed), undefined)
  assert.equal(resolveFileSearchKey('Enter', { ...mixed, regularCount: 0 }), undefined)
  assert.equal(resolveFileSearchKey('ArrowDown', mixed), undefined)
  assert.deepEqual(resolveFileSearchKey('ArrowDown', { ...mixed, regularCount: 0 }), { action: 'focus', index: 0 })
  assert.equal(resolveFileSearchKey('Tab', mixed), undefined)
  assert.deepEqual(resolveFileSearchKey('Tab', { ...mixed, regularIndex: 1 }), { action: 'focus', index: 0 })
})

test('the Files filter owns arrows and Enter, without consuming modified or empty selection keys', () => {
  const files = { filesOnly: true, count: 3, index: 0 }
  assert.deepEqual(resolveFileSearchKey('ArrowUp', files), { action: 'select', index: 2 })
  assert.deepEqual(resolveFileSearchKey('Enter', { ...files, index: 2 }), { action: 'open', index: 2 })
  assert.equal(resolveFileSearchKey('Enter', { ...files, count: 0 }), undefined)
  assert.equal(resolveFileSearchKey('Enter', { ...files, modified: true }), undefined)
})
