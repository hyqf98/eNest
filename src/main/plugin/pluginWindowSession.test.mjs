import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const source = fileURLToPath(new URL('./pluginWindowSession.ts', import.meta.url))
const compiled = await build({ entryPoints: [source], tsconfig: fileURLToPath(new URL('../../../tsconfig.node.json', import.meta.url)), bundle: true, write: false, format: 'esm', platform: 'node' })
const { PluginWindowSession } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

test('new windows merge into saved sessions before renderer hydration without losing startup tabs', () => {
  const writes = []
  const session = new PluginWindowSession(() => ({ sessionTabs: [{ pluginId: 'old', title: 'Old' }], sessionActivePluginId: 'old' }), value => writes.push(value))
  session.retain('detached', 'Detached'); session.focus('detached'); session.flush()
  assert.deepEqual(writes, [{ sessionTabs: [{ pluginId: 'old', title: 'Old' }, { pluginId: 'detached', title: 'Detached' }], sessionActivePluginId: 'detached' }])
  session.retain('detached', 'Detached'); session.flush()
  assert.equal(writes.length, 1, 'unchanged native window state does not schedule storage writes')
  session.prepareShutdown()
})

test('reorder and true close persist once, app shutdown freezes the retained snapshot', () => {
  const writes = []
  const session = new PluginWindowSession(() => ({ sessionTabs: [] }), value => writes.push(value))
  for (const id of ['a', 'b', 'c']) session.retain(id, id)
  session.reorder('c', 0); session.focus('b'); session.remove('b'); session.prepareShutdown()
  assert.deepEqual(writes, [{ sessionTabs: [{ pluginId: 'c', title: 'c' }, { pluginId: 'a', title: 'a' }], sessionActivePluginId: '' }])
  session.remove('a'); session.retain('new', 'New'); session.focus('c'); session.flush()
  assert.equal(writes.length, 1)
})

test('shell ordering uses shell slots and does not mistake a visible index for global session index', () => {
  const writes = []
  const session = new PluginWindowSession(() => ({ sessionTabs: ['a', 'detached', 'b', 'quick', 'c'].map(pluginId => ({ pluginId })) }), value => writes.push(value))
  session.orderShell(['c', 'a', 'b']); session.prepareShutdown()
  assert.deepEqual(writes[0].sessionTabs.map(tab => tab.pluginId), ['c', 'detached', 'a', 'quick', 'b'])
})

const history = { mode: 'quick', bounds: { x: -420, y: 80, width: 720, height: 580 }, maximized: false, minimized: true, alwaysOnTop: true }

test('window history survives title retention and all snapshots own their nested geometry', () => {
  const saved = { pluginId: 'mini', title: 'Old', detached: structuredClone(history) }, writes = []
  const session = new PluginWindowSession(() => ({ sessionTabs: [saved] }), value => writes.push(value))
  const first = session.get('mini')
  first.detached.bounds.x = 999; saved.detached.bounds.width = 1
  session.retain('mini', 'Renamed'); session.flush()
  assert.deepEqual(writes[0].sessionTabs[0], { pluginId: 'mini', title: 'Renamed', detached: history })
  writes[0].sessionTabs[0].detached.bounds.height = 1
  assert.deepEqual(session.get('mini').detached, history)
  session.setDetached('mini', structuredClone(history)); session.flush()
  assert.equal(writes.length, 1, 'identical geometry does not cause a write')
  const moved = structuredClone(history); moved.bounds.x = 150
  session.setDetached('mini', moved); moved.bounds.x = 500
  session.prepareShutdown()
  assert.equal(writes.at(-1).sessionTabs[0].detached.bounds.x, 150)
  session.setDetached('mini', history); session.clearDetached('mini'); session.flush()
  assert.equal(writes.length, 2, 'shutdown freezes geometry as well as tabs')
})

test('invalid saved history falls back to shell and invalid updates preserve the last valid geometry', () => {
  const writes = []
  const session = new PluginWindowSession(() => ({ sessionTabs: [
    { pluginId: 'bad-mode', detached: { ...history, mode: 'popup' } },
    { pluginId: 'bad-size', detached: { ...history, bounds: { ...history.bounds, width: Infinity } } },
    { pluginId: 'mini', detached: history }
  ] }), value => writes.push(value))
  assert.equal(session.get('bad-mode').detached, undefined)
  assert.equal(session.get('bad-size').detached, undefined)
  session.setDetached('mini', { ...history, bounds: { ...history.bounds, x: NaN } })
  assert.deepEqual(session.get('mini').detached, history)
  session.clearDetached('mini'); session.flush()
  assert.equal(session.get('mini').detached, undefined)
  assert.equal(writes[0].sessionTabs.find(tab => tab.pluginId === 'mini').detached, undefined)
  session.prepareShutdown()
})
