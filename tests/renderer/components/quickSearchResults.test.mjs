import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const load = async file => {
  const source = readFileSync(new URL(file, new URL('../../../src/renderer/themes/default/quick/', import.meta.url)), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}
const { getQuickSearchResults: results } = await load('./searchResults.ts')
const { groupQuickCommands, moveQuickGridSelection: move, quickSelectionIndex } = await load('./grid.ts')
const command = (id, extra = {}) => ({ id, title: id, subtitle: '', kind: 'plugin', ...extra })
const commands = (count, extra = {}) => Array.from({ length: count }, (_, i) => command(String(i), extra))
const group = items => groupQuickCommands(items, true, 16)

for (const columns of [1, 4, 6, 8]) {
  test(`search folds to two actual rows at ${columns} columns and preserves real item indices`, () => {
    const items = commands(25)
    const groups = group(items)
    const folded = results(groups, columns, true, false)
    assert.equal(folded.visibleItems.length, columns * 2)
    assert.equal(folded.overflowCount, 25 - columns * 2)
    for (const entry of folded.groups) entry.items.forEach((item, i) => {
      assert.equal(item, items[entry.offset + i])
      assert.equal(item, folded.visibleItems[entry.offset + i])
    })
    assert.deepEqual(groups[0].items, items, 'folding must not mutate ranked source groups')
    const expanded = results(groups, columns, true, true)
    assert.equal(expanded.groups, groups)
    assert.deepEqual(expanded.visibleItems, items)
    assert.equal(expanded.overflowCount, folded.overflowCount, 'collapse remains available')
  })
}

test('short groups each start a new row; only the last visible group can be truncated', () => {
  const items = [command('first'), ...commands(10, { group: 'match' }), command('provider', { group: 'provider' })]
  const folded = results(group(items), 4, true, false)
  assert.deepEqual(folded.groups.map(entry => entry.items.length), [1, 4])
  assert.deepEqual(folded.groups.map(entry => entry.offset), [0, 1])
  assert.deepEqual(folded.visibleItems, items.slice(0, 5))
  assert.equal(folded.overflowCount, 7)
  const shortGroups = results(group([command('a'), command('b', { group: 'match' }), command('c')]), 8, true, false)
  assert.deepEqual(shortGroups.visibleItems.map(item => item.id), ['a', 'b'])
  assert.equal(shortGroups.overflowCount, 1, 'three short groups still occupy three rows')
})

test('filter precedes folding; home, empty and exact two-row results have no disclosure', () => {
  const filtered = commands(24).map((item, i) => ({ ...item, kind: i % 2 ? 'app' : 'plugin' })).filter(item => item.kind === 'app')
  const folded = results(group(filtered), 4, true, false)
  assert.deepEqual(folded.visibleItems.map(item => item.id), ['1', '3', '5', '7', '9', '11', '13', '15'])
  assert.equal(folded.overflowCount, 4)
  for (const count of [0, 1, 8]) {
    const small = results(group(commands(count)), 4, true, false)
    assert.equal(small.visibleItems.length, count)
    assert.equal(small.overflowCount, 0)
  }
  const homeGroups = groupQuickCommands([command('action', { kind: 'action' }), ...commands(24)], false, 16)
  const home = results(homeGroups, 4, false, false)
  assert.equal(home.groups, homeGroups)
  assert.equal(home.visibleItems.length, 16, 'leave the existing recent/pinned home limit alone')
  assert.equal(home.overflowCount, 0)
  assert.deepEqual(results([], 4, true, true).visibleItems, [], 'native plugin mode supplies no result groups')
})

test('expanded result projections preserve selection after directory changes', () => {
  const initial = commands(18)
  const withProviders = [...initial, command('live', { group: 'provider' })]
  const withContent = [command('content', { group: 'match' }), ...withProviders]
  for (const items of [initial, withProviders, withContent]) {
    const expanded = results(group(items), 4, true, true)
    assert.deepEqual(expanded.visibleItems, items)
    assert.equal(expanded.visibleItems[quickSelectionIndex(expanded.visibleItems, '17')].id, '17')
  }
  const expanded = results(group(withContent), 4, true, true)
  assert.equal(expanded.visibleItems.at(-1).id, 'live')
  const narrowed = results(group(withContent), 1, true, true)
  assert.deepEqual(narrowed.visibleItems, expanded.visibleItems, 'responsive resize must not collapse an expanded search')
})

test('keyboard navigation cannot reach folded commands and can reach every expanded command', () => {
  const items = [command('first'), ...commands(12, { group: 'match' })]
  const folded = results(group(items), 4, true, false)
  const hiddenIds = new Set(items.slice(folded.visibleItems.length).map(item => item.id))
  for (let index = 0; index < folded.visibleItems.length; index++) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']) {
      const next = move(index, folded.groups.map(entry => entry.items.length), 4, key)
      assert.ok(folded.visibleItems[next])
      assert.equal(hiddenIds.has(folded.visibleItems[next].id), false)
    }
  }
  assert.ok(quickSelectionIndex(folded.visibleItems, '11', 12) < folded.visibleItems.length, 'stale selection clamps to visible items')
  const expanded = results(group(items), 4, true, true)
  let index = 0
  const visited = new Set()
  for (let step = 0; step < items.length; step++) {
    visited.add(expanded.visibleItems[index].id)
    index = move(index, expanded.groups.map(entry => entry.items.length), 4, 'Tab')
  }
  assert.deepEqual(visited, new Set(items.map(item => item.id)))
})

test('component wiring resets only the query/filter scope and exposes an accessible Button outside the listbox', () => {
  const app = readFileSync(new URL('../../../src/renderer/components/QuickLauncherApp.tsx', import.meta.url), 'utf8')
  assert.match(app, /previous\.query === query && previous\.kind === kind/)
  assert.match(app, /setResultsExpanded\(false\)[\s\S]*?setIndex\(0\)[\s\S]*?\}, \[query, kind\]\)/)
  assert.match(app, /new ResizeObserver\(scheduleMeasure\)/)
  assert.match(app, /getComputedStyle\(grid\)\.gridTemplateColumns/)
  assert.match(app, /\[pluginMode, searching, shown, visibleItems\.length, columns, resultsExpanded, overflowCount\]/)
  assert.match(app, /getQuickSearchResults\(allGroups, columns, searching, resultsExpanded\)/)
  assert.match(app, /showResults \? groupQuickCommands\(items/)
  assert.match(app, /onClick=\{\(\) => void openItem\(cmd\)\}/)
  assert.match(app, /moveQuickGridSelection\(activeIndex, groups\.map\(group => group\.items\.length\), columns/)
  assert.match(app, /openItem\(visibleItems\[activeIndex\]/)
  assert.match(app, /<\/div>\)\}\s*<\/div>\s*\{searching && overflowCount > 0 && <div className="quick-results-disclosure">/)
  assert.match(app, /<Button ref=\{moreButtonRef\}[\s\S]*?aria-expanded=\{resultsExpanded\} aria-controls="quick-results"/)
  assert.match(app, /event\.key === 'Tab' && moreButtonRef\.current/)
  assert.match(app, /更多 \$\{overflowCount\}/)
})
