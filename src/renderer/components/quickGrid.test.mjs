import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('./quickGrid.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText
const { appendQuickProviders, groupQuickCommands, mergeQuickEnriched, moveQuickGridSelection: move, quickSelectionIndex } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
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

test('providers append unique results while preserving static identities and enter payload', () => {
  const initial = [command('a'), command('b')]
  const payload = { text: 'https://example.com', captures: ['example.com'] }
  const providers = [command('a'), command('c', { payload, type: 'regex' }), command('c'), command('d')]
  const result = appendQuickProviders(initial, providers)
  assert.deepEqual(result.map(item => item.id), ['a', 'b', 'c', 'd'])
  assert.equal(result[0], initial[0])
  assert.equal(result[1], initial[1])
  assert.equal(result[2].payload, payload)
  assert.equal(result[2].type, 'regex')
  assert.equal(result[2].group, 'provider')
  assert.equal(appendQuickProviders(initial, [command('a')]), initial)
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


test('enrichment updates icons and adds ranked content matches without dropping earlier providers', () => {
  const name = command('name', { icon: 'cached-icon', group: 'recommendation' })
  const provider = command('live', { group: 'provider', payload: { live: true } })
  const content = command('content', { group: 'match', type: 'regex', payload: { captures: ['value'] } })
  const result = mergeQuickEnriched([name, provider], [content, command('name', { icon: 'new-icon', group: 'recommendation' })])
  assert.deepEqual(result.map(item => item.id), ['content', 'name', 'live'])
  assert.equal(result[1].icon, 'new-icon')
  assert.equal(result[0].type, 'regex')
  assert.deepEqual(result[0].payload, { captures: ['value'] })
  assert.equal(result[2].group, 'provider')
  assert.deepEqual(result[2].payload, { live: true })
  assert.equal(quickSelectionIndex(result, 'name', 0), 1)
  assert.equal(quickSelectionIndex(result, 'live', 1), 2)
})

test('provider-first and enrichment-first completion produce identical unique commands', () => {
  const initial = [command('a')]
  const enriched = [command('content', { group: 'match' }), command('a', { icon: 'app-icon' })]
  const providers = [command('content', { group: 'provider', type: 'over', payload: 'provider-only', icon: 'provider-icon' }), command('live', { payload: 'live-data' }), command('live')]
  const providerFirst = mergeQuickEnriched(appendQuickProviders(initial, providers), enriched)
  const enrichmentFirst = appendQuickProviders(mergeQuickEnriched(initial, enriched), providers)
  assert.deepEqual(providerFirst, enrichmentFirst)
  assert.deepEqual(providerFirst.map(item => item.id), ['content', 'a', 'live'])
  assert.equal(providerFirst[0].group, 'match')
})

test('a backend limit cannot remove a usable selected name during enrichment', () => {
  const initial = [command('a', { icon: 'cached' }), command('b'), command('selected')]
  const enriched = [command('content', { group: 'match' }), command('a'), command('b'), command('b')]
  const result = mergeQuickEnriched(initial, enriched)
  assert.deepEqual(result.map(item => item.id), ['content', 'a', 'b', 'selected'])
  assert.equal(result[1].icon, 'cached', 'an absent icon must not clear a previously cached icon')
  assert.equal(quickSelectionIndex(result, 'selected', 2), 3)
  assert.equal(mergeQuickEnriched(initial, []), initial, 'an unavailable optional phase leaves commands usable')
  assert.equal(quickSelectionIndex([], 'selected', 3), 0)
})
