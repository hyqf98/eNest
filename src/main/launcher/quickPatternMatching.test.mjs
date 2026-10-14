// Run: node --test src/main/launcher/quickPatternMatching.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
async function fixture(t) {
  const result = await build({
    stdin: {
      contents: `export * from '@main/launcher/quickPatternMatching'; export const nonce=${Math.random()}`,
      resolveDir: root
    },
    bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: root + 'tsconfig.node.json',
    plugins: [{ name: 'logs', setup(builder) {
      builder.onResolve({ filter: /^@main\/logs\/logService$/ }, () => ({ path: 'logs', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const logWarn=()=>{}' }))
    } }]
  })
  const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
  t.after(() => api.disposeQuickPatternMatching())
  return api
}
const regex = (key, source, flags = '') => ({ key, type: 'regex', source, flags, minLength: 1 })

test('worker preserves flags, resets stateful regexes and applies inclusive length/exclude rules', async t => {
  const api = await fixture(t)
  const rules = [
    regex(1, '^a', 'gi'), regex(2, '^a', 'y'),
    { key: 3, type: 'over', minLength: 3, maxLength: 3 },
    { key: 4, type: 'over', source: 'ABC', flags: 'i', minLength: 1 },
    { key: 5, type: 'over', minLength: 4, maxLength: 5 }
  ]
  for (let i = 0; i < 2; i++) {
    assert.deepEqual([...await api.matchQuickPatterns(rules, 'abc')], [1, 2, 3])
  }
  assert.deepEqual([...await api.matchQuickPatterns(rules, 'ABC')], [1, 3])
  assert.deepEqual([...await api.matchQuickPatterns(rules, '')], [])
})

test('runaway regex leaves the main event loop responsive, preserves earlier matches and worker recovers', async t => {
  const api = await fixture(t)
  assert.deepEqual([...await api.matchQuickPatterns([regex(1, '^warm$')], 'warm')], [1])
  let mainTimerRan = false
  const pulse = setTimeout(() => { mainTimerRan = true }, 10)
  const started = performance.now()
  const matches = await api.matchQuickPatterns([regex(2, '^a'), regex(3, '(a+)+$')], 'a'.repeat(40) + '!')
  clearTimeout(pulse)
  assert.equal(mainTimerRan, true)
  assert.ok(performance.now() - started < 2_000, 'the timed out expression is terminated promptly')
  assert.deepEqual([...matches], [2])
  assert.deepEqual([...await api.matchQuickPatterns([regex(4, '^recovered$')], 'recovered')], [4])
})

test('aborting a pending expression settles it with no stale matches and allows the next query', async t => {
  const api = await fixture(t), controller = new AbortController()
  const pending = api.matchQuickPatterns([regex(1, '(a+)+$')], 'a'.repeat(40) + '!', controller.signal)
  controller.abort()
  assert.deepEqual([...await pending], [])
  assert.deepEqual([...await api.matchQuickPatterns([regex(2, '^new$')], 'new')], [2])
  assert.deepEqual([...await api.matchQuickPatterns([regex(3, '^new$')], 'new', controller.signal)], [])
})

test('shutdown drains pending worker work and prevents worker recreation', async t => {
  const api = await fixture(t)
  const pending = api.matchQuickPatterns([regex(1, '(a+)+$')], 'a'.repeat(40) + '!')
  await api.disposeQuickPatternMatching()
  assert.deepEqual([...await pending], [])
  assert.deepEqual([...await api.matchQuickPatterns([regex(2, '^after$')], 'after')], [])
  await api.disposeQuickPatternMatching()
})
