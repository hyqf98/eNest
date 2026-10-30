import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = await build({
  entryPoints: [root + 'src/renderer/components/quickPluginInputSession.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm'
})
const { QuickPluginInputSession } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
const state = (patch = {}) => ({ pluginId: 'translate', generation: 7, value: 'hello', placeholder: 'Translate text', ...patch })

test('restoring the same plugin keeps its input and buffers typing until its generation is confirmed', () => {
  const session = new QuickPluginInputSession()
  session.restore('translate')
  session.receive(state())
  const revision = session.restore('translate')
  assert.equal(session.snapshot.status, 'hydrating')
  assert.equal(session.snapshot.input.generation, 7)
  assert.equal(session.snapshot.value, 'hello')
  assert.equal(session.activeInput, null)
  assert.deepEqual(session.change('hello world'), { target: 'plugin' })
  assert.equal(session.snapshot.value, 'hello world')
  assert.deepEqual(session.receive(state(), revision), {
    accepted: true,
    message: { pluginId: 'translate', generation: 7, type: 'change', value: 'hello world' }
  })
  assert.equal(session.activeInput.value, 'hello world')
})

test('typing is never a request to leave unsupported or failed plugin input', () => {
  const session = new QuickPluginInputSession()
  const first = session.restore('translate')
  session.change('draft')
  assert.deepEqual(session.receive(null, first), { accepted: true })
  assert.equal(session.snapshot.status, 'unsupported')
  assert.deepEqual(session.change('search something else'), { target: 'ignored' })
  const retry = session.restore('translate')
  assert.equal(session.fail(retry), true)
  assert.equal(session.snapshot.status, 'failed')
  assert.deepEqual(session.change('still not global search'), { target: 'ignored' })
  session.restore(null)
  assert.deepEqual(session.change('global search'), { target: 'search' })
})

test('a fresh plugin may receive buffered text but a replacement runtime cannot inherit an old draft', () => {
  const session = new QuickPluginInputSession()
  const first = session.restore('translate')
  session.change('first input')
  assert.equal(session.receive(state(), first).message.value, 'first input')
  const next = session.restore('translate')
  session.change('old incarnation draft')
  assert.deepEqual(session.receive(state({ generation: 8, value: 'new runtime' }), next), { accepted: true })
  assert.equal(session.snapshot.value, 'new runtime')
})

test('native input events supersede pending snapshots without dropping the buffered edit', () => {
  const session = new QuickPluginInputSession()
  const pending = session.restore('translate')
  session.change('latest')
  assert.equal(session.receive(state()).message.value, 'latest')
  assert.deepEqual(session.receive(state({ value: 'stale' }), pending), { accepted: false })
  assert.equal(session.fail(pending), false)
  assert.equal(session.snapshot.value, 'latest')
  assert.equal(session.change('forwarded').message.generation, 7)
})

test('explicit exit, same-plugin reentry and plugin replacement fence older hydration replies', () => {
  const session = new QuickPluginInputSession()
  const old = session.restore('translate')
  session.change('old session')
  session.restore(null)
  const next = session.restore('translate')
  assert.equal(session.snapshot.value, '')
  assert.deepEqual(session.receive(state(), old), { accepted: false })
  session.receive(state({ value: 'new session' }), next)
  session.restore('calculator')
  assert.equal(session.snapshot.value, '')
  assert.deepEqual(session.receive(state()), { accepted: false })
})
