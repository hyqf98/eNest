import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'

async function compiled(name, format = 'esm') {
  const source = await readFile(new URL(`../../../src/main/panel/${name}.ts`, import.meta.url), 'utf8')
  return (await transform(source, { loader: 'ts', format, target: 'node22' })).code
}

async function closeFixture() {
  return import(`data:text/javascript;base64,${Buffer.from(await compiled('panelClose')).toString('base64')}`)
}

async function loopFixture() {
  let now = 0
  let sequence = 0
  const timers = new Map()
  const module = { exports: {} }
  new vm.Script(await compiled('panelDragLoop', 'cjs')).runInNewContext({
    module, exports: module.exports,
    require: name => {
      assert.equal(name, 'node:perf_hooks')
      return { performance: { now: () => now } }
    },
    setTimeout: (callback, delay) => {
      const timer = { id: ++sequence, due: now + delay, callback, unref() {} }
      timers.set(timer.id, timer)
      return timer
    },
    clearTimeout: timer => timers.delete(timer.id)
  })
  return {
    ...module.exports,
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms
      for (;;) {
        const next = [...timers.values()].filter(timer => timer.due <= target).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        timers.delete(next.id)
        now = next.due
        next.callback()
      }
      now = target
    }
  }
}

test('panel close attempts every distinct plugin and reports exact failures', async () => {
  const { closePanelPluginRuntimes, PanelPluginCleanupError } = await closeFixture()
  const calls = []
  let finish
  const delayed = new Promise(resolve => { finish = resolve })
  const failure = new Error('backend exit not confirmed')
  const closing = closePanelPluginRuntimes(['a', 'b', 'a', 'c'], async id => {
    calls.push(id)
    if (id === 'a') throw failure
    if (id === 'b') await delayed
  })
  const rejected = assert.rejects(closing, error => {
    assert.ok(error instanceof PanelPluginCleanupError)
    assert.deepEqual(error.failures.map(item => item.pluginId), ['a'])
    assert.equal(error.failures[0].cause, failure)
    return true
  })
  await Promise.resolve()
  assert.deepEqual(calls, ['a', 'b', 'c'])
  finish()
  await rejected
})

test('successful panel closes resolve and synchronous throws still aggregate', async () => {
  const { closePanelPluginRuntimes } = await closeFixture()
  await closePanelPluginRuntimes(['a', 'b'], () => Promise.resolve())
  await assert.rejects(closePanelPluginRuntimes(['a', 'b'], () => { throw new Error('failed') }), error => error.failures.length === 2)
})

test('native drag advances without pointer IPC and stop releases its timer', async () => {
  const { PanelDragLoop, advance, pending } = await loopFixture()
  let ticks = 0
  const loop = new PanelDragLoop({ current: () => true, tick: () => { ticks++ }, cancel: () => assert.fail('unexpected cancellation') })
  loop.start()
  advance(100)
  assert.ok(ticks >= 6)
  assert.equal(pending(), 1)
  loop.stop()
  const endedAt = ticks
  advance(100)
  assert.equal(ticks, endedAt)
  assert.equal(pending(), 0)
})

test('heartbeats only renew liveness; expiry cancels once', async () => {
  const { PanelDragLoop, advance, pending } = await loopFixture()
  let ticks = 0
  let cancelled = 0
  const loop = new PanelDragLoop({ current: () => true, tick: () => { ticks++ }, cancel: () => { cancelled++ } })
  loop.start()
  advance(29000)
  const before = ticks
  loop.heartbeat()
  assert.equal(ticks, before)
  advance(2000)
  assert.equal(cancelled, 0)
  advance(30032)
  assert.equal(cancelled, 1)
  assert.equal(pending(), 0)
})

test('native retirement and geometry failure cancel without leaving a loop', async () => {
  for (const fail of [false, true]) {
    const { PanelDragLoop, advance, pending } = await loopFixture()
    let current = true
    let cancelled = 0
    const failure = new Error('window gone')
    const loop = new PanelDragLoop({ current: () => current, tick: () => { if (fail) throw failure }, cancel: error => {
      cancelled++
      if (fail) assert.equal(error, failure)
    } })
    loop.start()
    current = false
    advance(32)
    assert.equal(cancelled, 1)
    assert.equal(pending(), 0)
  }
})

test('native liveness checks cannot leave a live timer when the surface disappears', async () => {
  const { PanelDragLoop, pending } = await loopFixture()
  const failure = new Error('native surface destroyed')
  let cancelled = 0
  const loop = new PanelDragLoop({ current: () => { throw failure }, tick: () => assert.fail('unexpected frame'), cancel: error => {
    cancelled++
    assert.equal(error, failure)
  } })
  loop.start()
  assert.equal(cancelled, 1)
  assert.equal(pending(), 0)
})
