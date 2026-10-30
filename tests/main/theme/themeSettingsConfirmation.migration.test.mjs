import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import vm from 'node:vm'

async function source() {
  const result = await build({
    entryPoints: ['src/main/theme/quickThemeBridge.ts'], bundle: true, write: false, format: 'esm', platform: 'node'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

function frame(script, kind = 'settings') {
  const events = new Map(), timers = new Map(), sent = []
  let now = 0, nextTimer = 0
  const key = 'a'.repeat(64), generation = 'fixture_generation_0123456789'
  const parent = { postMessage() {} }
  const window = {
    parent,
    addEventListener(name, listener) { events.set(name, listener) },
    removeEventListener(name, listener) { if (events.get(name) === listener) events.delete(name) },
  }
  const port = { postMessage(message) { sent.push(message) }, start() {}, close() { this.closed = true } }
  vm.runInNewContext(script, {
    window, location: { pathname: `/${key}/assets/settings.html`, hash: `#generation=${generation}` },
    URLSearchParams, structuredClone,
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, at: now + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  events.get('message')({ source: parent, data: { type: `enest-${kind}:port`, key, generation }, ports: [port] })
  const api = window[kind === 'settings' ? 'enestSettings' : 'enestQuick']
  api.ready()
  return {
    api, port, sent,
    async advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() }
      await Promise.resolve(); await Promise.resolve()
    },
    respond(result) {
      const request = sent.findLast(message => message.type === 'action')
      port.onmessage?.({ data: { type: 'action-result', generation, id: request.id, result } })
    },
    receive(message) { port.onmessage?.({ data: { ...message, generation } }) },
    close() { events.get('pagehide')() },
  }
}

test('a settings action waits for a slow native confirmation rather than reporting a false timeout', async () => {
  const { SETTINGS_THEME_BRIDGE_SOURCE } = await source()
  const f = frame(SETTINGS_THEME_BRIDGE_SOURCE)
  let result
  const pending = f.api.action({ type: 'set', fieldId: 'b'.repeat(64), value: true }).then(value => { result = value })
  await f.advance(60_000)
  assert.equal(result, undefined, 'waiting for user confirmation must not report a failure before a possible commit')
  f.respond({ ok: true })
  await pending
  assert.equal(result.ok, true)
  f.close()
})

test('a settings cancellation settles only on the host response and retired frames ignore late success', async () => {
  const { SETTINGS_THEME_BRIDGE_SOURCE } = await source()
  const cancelled = frame(SETTINGS_THEME_BRIDGE_SOURCE)
  const pendingCancel = cancelled.api.action({ type: 'set', fieldId: 'b'.repeat(64), value: false })
  await cancelled.advance(60_000)
  cancelled.respond({ ok: false, error: 'cancelled' })
  assert.equal((await pendingCancel).error, 'cancelled')
  cancelled.close()

  const retired = frame(SETTINGS_THEME_BRIDGE_SOURCE)
  const pending = retired.api.action({ type: 'set', fieldId: 'b'.repeat(64), value: true })
  retired.close()
  const result = await pending
  assert.equal(result.ok, false)
  assert.match(result.error, /Settings surface closed/)
  assert.equal(retired.port.closed, true)
  retired.respond({ ok: true })
  assert.equal(result.ok, false)
})

test('host-settled settings requests remain bounded and Quick retains its existing deadline', async () => {
  const { SETTINGS_THEME_BRIDGE_SOURCE, QUICK_THEME_BRIDGE_SOURCE } = await source()
  const settings = frame(SETTINGS_THEME_BRIDGE_SOURCE)
  const pending = Array.from({ length: 64 }, () => settings.api.action({ type: 'native', section: 'general' }))
  assert.equal((await settings.api.action({ type: 'native', section: 'general' })).ok, false)
  settings.close()
  assert.ok((await Promise.all(pending)).every(result => !result.ok))

  const quick = frame(QUICK_THEME_BRIDGE_SOURCE, 'quick')
  const result = quick.api.action({ type: 'query', query: 'fixture' })
  await quick.advance(10_001)
  assert.match((await result).error, /Quick action timed out/)
  quick.close()
})

test('focus subscriptions are generated only for Quick while Settings retains its state channel', async () => {
  const { SETTINGS_THEME_BRIDGE_SOURCE, QUICK_THEME_BRIDGE_SOURCE } = await source()
  assert.doesNotMatch(SETTINGS_THEME_BRIDGE_SOURCE, /focusListeners|onFocus|message\.type === 'focus'/)
  const settings = frame(SETTINGS_THEME_BRIDGE_SOURCE)
  const quick = frame(QUICK_THEME_BRIDGE_SOURCE, 'quick')
  try {
    assert.deepEqual(Object.keys(settings.api).sort(), ['action', 'getState', 'onState', 'ready'])
    const states = [], focuses = []
    const offState = settings.api.onState(state => states.push(state))
    const pendingState = settings.api.getState()
    settings.receive({ type: 'focus', selectAll: true })
    assert.equal(states.length, 0)
    settings.receive({ type: 'state', state: { version: 1, revision: 4 } })
    assert.deepEqual(await pendingState, { version: 1, revision: 4 })
    assert.equal(states.length, 1)
    offState()

    const offFocus = quick.api.onFocus(request => focuses.push(request))
    quick.receive({ type: 'focus', selectAll: true })
    quick.receive({ type: 'focus', selectAll: false })
    assert.deepEqual(focuses, [{ selectAll: true }, { selectAll: false }])
    offFocus()
    quick.receive({ type: 'focus', selectAll: true })
    assert.equal(focuses.length, 2)
  } finally {
    settings.close()
    quick.close()
  }
})
