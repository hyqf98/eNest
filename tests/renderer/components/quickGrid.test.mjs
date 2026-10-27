import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../../../src/renderer/themes/default/quick/grid.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText
const { groupQuickCommands, moveQuickGridSelection: move, quickSelectionIndex } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const command = (id, extra = {}) => ({ id, title: id, subtitle: '', kind: 'plugin', ...extra })

test('common grid preserves app/plugin rank and caps the visible entries at two rows', () => {
  const items = [command('action', { kind: 'action' }), ...Array.from({ length: 25 }, (_, i) => command(String(i), { kind: i % 2 ? 'app' : 'plugin' }))]
  const groups = groupQuickCommands(items, false, 16)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].title, '常用')
  assert.equal(groups[0].items.length, 16)
  assert.deepEqual(groups[0].items.map(item => item.id), Array.from({ length: 16 }, (_, i) => String(i)))
})

test('search grouping never rearranges backend ranking, including repeated groups', () => {
  const items = [command('a'), command('b', { group: 'best' }), command('c', { group: 'match' }), command('d', { group: 'recommendation' }), command('e', { group: 'best' }), command('f', { group: 'provider' })]
  const groups = groupQuickCommands(items, true, 16)
  assert.deepEqual(groups.flatMap(group => group.items), items)
  assert.deepEqual(groups.map(group => group.offset), [0, 2, 3, 4, 5])
  assert.deepEqual(groups.map(group => group.title), ['最佳搜索结果', '最佳匹配', '匹配推荐', '最佳搜索结果', '插件搜索结果'])
  assert.equal(new Set(groups.map(group => group.id)).size, groups.length)
})

test('Tab and horizontal arrows cycle across all groups', () => {
  assert.equal(move(2, [3, 9], 8, 'Tab'), 3)
  assert.equal(move(11, [3, 9], 8, 'Tab'), 0)
  assert.equal(move(0, [3, 9], 8, 'Tab', true), 11)
  assert.equal(move(3, [3, 9], 8, 'ArrowLeft'), 2)
  assert.equal(move(2, [3, 9], 8, 'ArrowRight'), 3)
  assert.equal(move(0, [3, 9], 8, 'ArrowLeft'), 11)
  assert.equal(move(11, [3, 9], 8, 'ArrowRight'), 0)
})

test('vertical movement follows visual rows and clamps columns across short groups', () => {
  // Rows: [0,1,2] / [3..10] / [11,12] / [13..20].
  assert.equal(move(2, [3, 10, 8], 8, 'ArrowDown'), 5)
  assert.equal(move(8, [3, 10, 8], 8, 'ArrowUp'), 2)
  assert.equal(move(10, [3, 10, 8], 8, 'ArrowDown'), 12)
  assert.equal(move(12, [3, 10, 8], 8, 'ArrowDown'), 14)
  assert.equal(move(20, [3, 10, 8], 8, 'ArrowDown'), 2)
  assert.equal(move(0, [3, 10, 8], 8, 'ArrowUp'), 13)
})

test('responsive column counts, empty groups and stale selection remain navigable', () => {
  assert.equal(move(3, [0, 16], 4, 'ArrowDown'), 7)
  assert.equal(move(5, [16], 6, 'ArrowDown'), 11)
  assert.equal(move(11, [16], 6, 'ArrowDown'), 15)
  assert.equal(move(99, [16], 6, 'Tab'), 0)
  assert.equal(move(2, [], 8, 'ArrowDown'), 0)
})
test('selection follows stable command identity and clamps a missing item', () => {
  const result = [command('content'), command('name'), command('live', { group: 'provider' })]
  assert.equal(quickSelectionIndex(result, 'name', 0), 1)
  assert.equal(quickSelectionIndex(result, 'live', 1), 2)
  assert.equal(quickSelectionIndex(result, 'missing', 8), 2)
  assert.equal(quickSelectionIndex([], 'selected', 3), 0)
})
