import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../../../src/renderer/components/SettingsSurfaceController.tsx', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const config = { key: 'a'.repeat(64), url: `enest-settings://surface/${'a'.repeat(64)}/assets/settings.html` }
const snapshot = revision => ({ version: 1, revision, locale: 'en-US', appearance: {}, groups: [], nativeSections: [] })
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]

function fixture(initialTab = 'general') {
  const state = { config, snapshot: snapshot(1), configReads: 0, listeners: new Set(), active: [], actions: [], accepted: true, timers: new Map(), channels: [], failures: 0, native: [], refreshes: 0 }
  const store = { settingsTab: initialTab, setSettingsTab(value) { this.settingsTab = value } }
  const events = () => {
    const callbacks = new Map()
    return { addEventListener(type, fn) { if (!callbacks.has(type)) callbacks.set(type, new Set()); callbacks.get(type).add(fn) },
      removeEventListener(type, fn) { callbacks.get(type)?.delete(fn) }, emit(type, value) { for (const fn of [...callbacks.get(type) ?? []]) fn(value) },
      count(type) { return callbacks.get(type)?.size ?? 0 } }
  }
  const window = { ...events(), setTimeout(fn, ms) { const id = Symbol(); state.timers.set(id, { fn, ms }); return id }, clearTimeout(id) { state.timers.delete(id) } }
  const frame = { ...events(), style: {}, contentWindow: { sent: [], postMessage(message, origin, ports) { this.sent.push({ message, origin, ports }) } }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 500, height: 400 }) }
  class Port {
    onmessage = null; onmessageerror = null; closed = false; sent = []
    start() {}
    close() { this.closed = true }
    postMessage(data) { if (this.closed) throw new Error('fixture closed port'); this.sent.push(data); this.other.onmessage?.({ data, ports: [] }) }
  }
  class MessageChannel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); this.port1.other = this.port2; this.port2.other = this.port1; state.channels.push(this) }
  }
  let slots = [], cursor = 0, effects = []
  const changed = (old, next) => !old || !next || old.length !== next.length || old.some((value, index) => value !== next[index])
  const hooks = {
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }] },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: initial } }; return slots[index].value },
    useCallback(callback, deps) { const index = cursor++; if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: callback, deps }; return slots[index].value },
    useEffect(callback, deps) { const index = cursor++; if (!slots[index]) slots[index] = {}; const slot = slots[index]; if (changed(slot.deps, deps)) { slot.deps = deps; effects.push(() => { slot.cleanup?.(); slot.cleanup = callback() }) } },
    lazy() { return 'DefaultSettingsPage' }, Suspense: 'Suspense'
  }
  hooks.useLayoutEffect = hooks.useEffect
  const useShellStore = selector => selector(store)
  useShellStore.getState = () => store
  const shellApi = {
    async getThemeSettingsConfig() { state.configReads++; return state.config }, async getThemeSettingsSnapshot() { return state.snapshot },
    async setThemeSettingsActive(value) { state.active.push(value); return state.accepted },
    async dispatchThemeSettingsAction(key, action) { state.actions.push({ key, action }); return state.actionResult ?? { ok: true } },
    onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener) }
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@renderer/components/ui/Button': { Button: 'Button' }, '@renderer/hooks/useI18n': { useI18n: () => ({ locale: 'en-US', t: value => value }) },
    '@renderer/services/shellApi': { shellApi }, '@renderer/stores/shellStore': { useShellStore }, './settingsSurface.css': {}
  }
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(`${source}\nexport {SettingsFrame,readAction};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, require: name => { if (!(name in imports)) throw new Error(`Unexpected fixture dependency ${name}`); return imports[name] },
      window, MessageChannel, ResizeObserver: class { observe() {} disconnect() {} }, crypto: { randomUUID }, performance, console })
  const api = module.exports
  const render = (Component = api.SettingsSurfaceController, props) => {
    cursor = 0; effects = []
    const tree = Component(props)
    if (tree?.type === 'iframe') tree.props.ref.current = frame
    for (const run of effects) run()
    return tree
  }
  const cleanup = () => { for (const slot of slots) slot?.cleanup?.(); slots = [] }
  const connect = tree => {
    const generation = new URL(tree.props.src).hash.slice('#generation='.length)
    window.emit('message', { source: frame.contentWindow, origin: 'null', ports: [], data: { type: 'enest-settings:connect', key: config.key, generation } })
    return { generation, channel: state.channels.at(-1) }
  }
  return { ...api, state, store, shellApi, frame, window, render, cleanup, connect }
}

test('the built-in/native fallback remains reachable and explicit plugin navigation overrides the theme even for the same tab', async () => {
  const f = fixture('p:fixture.plugin')
  try {
    f.render(); await tick()
    let tree = f.render()
    assert.ok(nodes(tree).some(node => node.type === 'DefaultSettingsPage'))
    nodes(tree).find(node => node.type === 'Button' && node.props.children === 'Back to theme settings').props.onClick()
    await tick(); tree = f.render()
    assert.ok(nodes(tree).some(node => node.type === f.SettingsFrame))
    for (const listener of f.state.listeners) listener({ type: 'plugin-open-settings', pluginId: 'fixture.plugin' })
    tree = f.render()
    assert.ok(nodes(tree).some(node => node.type === 'DefaultSettingsPage'))
    assert.equal(f.store.settingsTab, 'p:fixture.plugin')
    f.state.config = null
    for (const listener of f.state.listeners) listener({ type: 'theme-packs-changed' })
    await tick(); tree = f.render()
    assert.ok(nodes(tree).some(node => node.type === 'DefaultSettingsPage'))
  } finally { f.cleanup() }
})

test('public settings invalidation fetches a fresh whitelist snapshot without receiving private values', async () => {
  const f = fixture()
  try {
    f.render(); await tick(); f.render()
    f.state.snapshot = snapshot(2)
    for (const listener of f.state.listeners) listener({ type: 'plugin-settings-changed', pluginId: 'fixture.plugin' })
    await tick()
    const frame = nodes(f.render()).find(node => node.type === f.SettingsFrame)
    assert.equal(frame.props.snapshot.revision, 2)
    assert.equal(f.state.configReads, 2)
  } finally { f.cleanup() }
  assert.equal(f.state.listeners.size, 0)
})

test('opaque-origin iframe handshake requires the exact source and generation, and disposal closes the only port', async () => {
  const f = fixture()
  const props = { config, snapshot: snapshot(1), onNative: value => f.state.native.push(value), refresh: async () => { f.state.refreshes++ }, onFailure: () => { f.state.failures++ } }
  try {
    let tree = f.render(f.SettingsFrame, props)
    assert.equal(tree.props.sandbox, 'allow-scripts')
    assert.equal(tree.props['aria-hidden'], true)
    f.window.emit('message', { source: {}, origin: 'null', ports: [], data: { type: 'enest-settings:connect', key: config.key, generation: 'forged' } })
    assert.equal(f.state.channels.length, 0)
    const { generation, channel } = f.connect(tree)
    assert.equal(f.frame.contentWindow.sent[0].origin, '*')
    assert.equal(channel.port1.sent[0].type, 'state')
    channel.port2.postMessage({ type: 'ready', generation })
    await tick(); tree = f.render(f.SettingsFrame, props)
    assert.equal(tree.props['aria-hidden'], false)
    assert.equal(f.state.active.at(-1).active, true)
    f.cleanup()
    assert.equal(channel.port1.closed, true)
    assert.equal(channel.port1.onmessage, null)
    assert.equal(f.window.count('message'), 0)
    assert.equal(f.state.timers.size, 0)
    assert.equal(f.state.active.at(-1).active, false)
  } finally { f.cleanup() }
})

test('host activation rejection, duplicate navigation and an absent ready ACK fail closed into the native fallback', async () => {
  for (const reason of ['denied', 'navigation', 'timeout']) {
    const f = fixture(), props = { config, snapshot: snapshot(1), onNative() {}, refresh: async () => {}, onFailure: () => { f.state.failures++ } }
    try {
      const tree = f.render(f.SettingsFrame, props)
      if (reason === 'denied') {
        f.state.accepted = false
        const { generation, channel } = f.connect(tree)
        channel.port2.postMessage({ type: 'ready', generation })
        await tick()
      } else if (reason === 'navigation') { f.frame.emit('load'); f.frame.emit('load') }
      else for (const timer of [...f.state.timers.values()]) timer.fn()
      assert.equal(f.state.failures, 1, reason)
      assert.equal(f.frame.style.visibility, 'hidden')
      assert.equal(f.frame.style.pointerEvents, 'none')
      assert.equal(f.state.active.at(-1).active, false)
    } finally { f.cleanup() }
  }
})

test('late action replies after unmount cannot reopen native settings or refresh the retired surface', async () => {
  const f = fixture(), props = { config, snapshot: snapshot(1), onNative: value => f.state.native.push(value), refresh: async () => { f.state.refreshes++ }, onFailure: () => { f.state.failures++ } }
  try {
    let finish
    f.state.actionResult = new Promise(resolve => { finish = resolve })
    const tree = f.render(f.SettingsFrame, props), { generation, channel } = f.connect(tree)
    channel.port2.postMessage({ type: 'ready', generation })
    await tick()
    channel.port2.postMessage({ type: 'action', id: 'one', generation, action: { type: 'native', section: 'general' } })
    assert.equal(f.state.actions.length, 1)
    f.cleanup()
    finish({ ok: true, nativeSection: 'general' })
    await tick()
    assert.equal(f.state.native.length, 0)
    assert.equal(f.state.refreshes, 0)
    assert.equal(f.readAction({ type: 'openExternal', url: 'https://example.test' }), null)
  } finally { f.cleanup() }
})
