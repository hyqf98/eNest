import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { build } from 'esbuild'
import postcss from 'postcss'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')

function loadApi(window = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read('src/renderer/themes/default/chrome/api.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, window, require(name) { throw Error(`Unexpected adapter dependency ${name}`) } })
  return module.exports
}

test('chrome presentation has one theme owner without retired compatibility entries', () => {
  assert.equal(existsSync(join(root, 'src/renderer/layout/TabStrip.tsx')), false)
  assert.match(read('src/renderer/layout/TitleBar.tsx'), /import \{ TabStrip \} from '@renderer\/themes\/default\/chrome\/TabStrip'/)
  assert.match(read('src/renderer/themes/default/chrome/TabStrip.tsx'), /export function TabStrip\(/)
  assert.match(read('src/renderer/orb-overlay.ts'), /import '@renderer\/themes\/default\/chrome\/orb'/)
  assert.doesNotMatch(read('src/renderer/orb-overlay.ts'), /function |getElementById/)
  assert.equal(existsSync(join(root, 'src/renderer/orb-overlay.css')), false)
  assert.match(read('src/renderer/themes/default/chrome/orb.ts'), /import '\.\/orb\.css'/)
})

test('default tab presentation retains home, activation, close, lazy and crash states', () => {
  const actions = []
  const state = { view: 'plugin', activeTabId: 'tab-one',
    tabs: [
      { id: 'tab-one', pluginId: 'one', title: 'One', badge: '3', glyph: 'O' },
      { id: 'tab-two', pluginId: 'two', title: 'Two', lazy: true },
      { id: 'tab-three', pluginId: 'three', title: 'Three', crashed: true },
    ], goHome: () => actions.push('home'), activateTab: id => actions.push(`activate:${id}`), closeTab: id => actions.push(`close:${id}`),
  }
  const module = { exports: {} }
  const imports = {
    react: { useEffect() {}, useMemo: create => create(), useRef: initial => ({ current: initial }) },
    gsap: {}, '@renderer/stores/shellStore': { useShellStore: selector => selector(state) },
    '@renderer/gsap/marketMotion': { animateTabIn() {} },
    '@renderer/components/icons': { HouseIcon() {}, RotateCwIcon() {}, XIcon() {} },
    '@renderer/components/PluginIcon': { PluginIcon() {} }, '@shared/constants': { PLUGIN_ICON_DISPLAY_TAB: 20 },
    '@renderer/services/pluginWindowDrag': { bindPluginDragSource() {}, bindPluginDropTarget() {} },
    './api': loadApi(),
  }
  vm.runInNewContext(ts.transpileModule(read('src/renderer/themes/default/chrome/TabStrip.tsx'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, require(name) {
    if (name in imports) return imports[name]
    if (name === 'react/jsx-runtime') return require(name)
    if (name.endsWith('.css')) return {}
    throw Error(`Unexpected tab dependency ${name}`)
  } })
  const tree = module.exports.TabStrip(), scroller = tree.props.children[0]
  const [home, tabs] = scroller.props.children
  assert.equal(tree.props.className, 'tab-strip')
  assert.equal(tree.props.children[1].props.className, 'titlebar-drag-fill')
  home.props.onClick()
  assert.match(tabs[0].props.className, /active/)
  assert.match(tabs[1].props.className, /lazy/)
  assert.match(tabs[2].props.className, /crashed/)
  assert.equal(tabs[0].props['data-plugin-id'], 'one')
  tabs[1].props.onClick()
  const close = tabs[0].props.children.find(child => child?.props?.className === 'close')
  close.props.onClick({ stopPropagation: () => actions.push('stop') })
  assert.deepEqual(actions, ['home', 'activate:tab-two', 'stop', 'close:tab-one'])
})

test('theme-owned tab CSS retains geometry and power policy without global duplicated tab paint', () => {
  const theme = postcss.parse(read('src/renderer/themes/default/chrome/classicTabs.css'))
  const rules = new Map()
  theme.walkRules(rule => rules.set(rule.selector, rule.toString()))
  for (const selector of ['.tab-strip', '.tab-strip-scroll', '.titlebar-drag-fill', '.home-tab,\n.tab', '.tab.lazy', '.tab.crashed']) {
    assert.ok(rules.has(selector), selector)
  }
  assert.match(rules.get('.tab.lazy'), /opacity:\s*0.62/)
  assert.doesNotMatch(theme.toString(), /tab-lazy-pulse|animation:.*infinite/)
  assert.match(theme.toString(), /@media \(max-width: 520px\)/)
  assert.match(theme.toString(), /data-anim="high"/)
  const shell = postcss.parse(read('src/renderer/styles/app.css'))
  const duplicated = []
  shell.walkRules(rule => { if (rule.selectors.some(selector => /^(?:\.tab(?:\s|\.|:|$)|\.tab-strip|\.home-tab)/.test(selector))) duplicated.push(rule.selector) })
  assert.deepEqual(duplicated, [])
  assert.match(shell.toString(), /titlebar-autohide:not\(\.is-revealed\)/, 'host still owns titlebar visibility')
})

test('native orb entry resolves theme-owned JS/CSS and keeps restricted chrome and drag bridges', async () => {
  const result = await build({ absWorkingDir: root, entryPoints: ['src/renderer/orb-overlay.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', metafile: true, outdir: join(root, '.chrome-in-memory-only'),
    tsconfig: join(root, 'tsconfig.web.json'), alias: { '@renderer': join(root, 'src/renderer') },
  })
  const inputs = Object.keys(result.metafile.inputs)
  for (const file of ['api.ts', 'orb.ts', 'orb.css']) assert.ok(inputs.includes(`src/renderer/themes/default/chrome/${file}`), file)
  assert.ok(result.outputFiles.some(output => output.path.endsWith('.css')), 'CSS imports must resolve, not just be ignored in a JS graph check')
  assert.deepEqual(inputs.filter(path => /services\/shellApi|stores\/shellStore|components\/SettingsSurfaceController|themes\/default\/settings\/DefaultSettingsPage|components\/QuickLauncherApp/.test(path)), [])
  const orb = read('src/renderer/themes/default/chrome/orb.ts')
  assert.doesNotMatch(orb, /window\.enestShell|shell\?\.|dataset\.openCode/)
  assert.match(orb, /chrome\.getSnapshot\(/)
  assert.match(orb, /chrome\.onSnapshot\(/)
  assert.match(orb, /chrome\.ready\(/)
  const adapter = read('src/renderer/themes/default/chrome/api.ts')
  for (const action of ['getOrbState', 'onOrbEvent', 'setOrbRailExpanded', 'goHome', 'activatePlugin', 'closePlugin', 'openPlugin', 'setShellView']) {
    assert.ok(adapter.includes(action), action)
  }
  assert.match(orb, /bindPluginDragSource/)
  assert.match(orb, /bindPluginDropTarget/)
  assert.match(orb, /pagehide.*disposeDrag/)
  assert.match(read('src/renderer/themes/default/chrome/orb.css'), /prefers-reduced-motion/)
})

test('restricted chrome bridge takes priority without inspecting privileged builtin bridges', async () => {
  const actions = [], received = []
  const snapshot = { version: 1, surface: 'rail', tabs: [] }
  const bridge = { getSnapshot: async () => snapshot, onSnapshot(listener) { listener(snapshot); return () => actions.push('off') },
    dispatch: async action => { actions.push(action.type) }, ready: async () => { actions.push('ready') } }
  const api = loadApi({ enestChrome: bridge, get enestShell() { throw Error('Privileged bridge accessed') } }).createDefaultChromeApi('rail')
  assert.equal(api, bridge)
  assert.equal(await api.getSnapshot(), snapshot)
  const off = api.onSnapshot(state => received.push(state))
  await api.dispatch({ type: 'home' })
  await api.ready()
  off()
  assert.deepEqual(received, [snapshot])
  assert.deepEqual(actions, ['home', 'ready', 'off'])
})

const legacyState = (overrides = {}) => ({ view: 'home', tabStyle: 'orb', activeTabId: null, animationLevel: 'low',
  theme: { mode: 'dark', tokens: { '--ink': '#fff' }, appearance: { font: { family: 'Example' } } },
  profile: { name: 'Account', avatar: 'data:image/png;base64,AA' },
  tabs: [{ id: 't1', pluginId: 'p1', title: 'One', glyph: '1', color: '#123', lazy: true }],
  contribEntries: [{ id: 'entry', pluginId: 'p1', title: 'Entry', glyph: 'E', color: '#123', openCode: 'new' }], ...overrides })

test('trusted adapter preserves appearance/profile and never replaces a newer push with a stale initial read', async () => {
  let listener, resolveRead, unsubscribed = 0
  const shell = { getOrbState: () => new Promise(resolve => { resolveRead = resolve }),
    onOrbEvent(receive) { listener = receive; return () => { listener = undefined; unsubscribed++ } } }
  const api = loadApi({ enestShell: shell }).createDefaultChromeApi('rail')
  const received = []
  const off = api.onSnapshot(state => received.push(state))
  const pending = api.getSnapshot()
  const latest = legacyState({ activeTabId: 't1' })
  listener({ type: 'orb-state', state: latest })
  resolveRead(legacyState({ animationLevel: 'high' }))
  const result = await pending
  assert.equal(result.activeTabId, 't1')
  assert.equal(result.animationLevel, 'low')
  assert.equal(result.profile, latest.profile)
  assert.equal(result.theme, latest.theme)
  assert.equal(result.tabs[0].lazy, true)
  assert.equal(result.contribEntries[0].openCode, undefined, 'DOM receives contribution identity, not launch authority')
  assert.equal(received.length, 1)
  off()
  assert.equal(unsubscribed, 1)
  assert.equal(listener, undefined)
})

test('trusted adapter dispatches same actions and resolves contributions only from current host state', async () => {
  const calls = []
  let state = legacyState()
  const shell = { getOrbState: async () => state, goHome: async () => calls.push(['home']),
    setShellView: async view => calls.push(['view', view]), activatePlugin: async id => calls.push(['activate', id]),
    closePlugin: async id => calls.push(['close', id]), setOrbRailExpanded: async expanded => calls.push(['expand', expanded]),
    openPlugin: async (id, enter) => calls.push(['open', id, enter]) }
  const windows = { command: async command => { calls.push(['windows', command]); return { ok: true } } }
  const api = loadApi({ enestShell: shell, enestWindows: windows }).createDefaultChromeApi('rail')
  for (const action of [{ type: 'home' }, { type: 'settings' }, { type: 'activate', tabId: 't1' },
    { type: 'close', tabId: 't1' }, { type: 'expand', expanded: true }, { type: 'contribution', id: 'entry' },
    { type: 'detach', tabId: 't1' }, { type: 'reorder', tabId: 't1', index: 0 }]) await api.dispatch(action)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['home'], ['view', 'settings'], ['activate', 't1'], ['close', 't1'], ['expand', true],
    ['open', 'p1', { code: 'new' }], ['windows', { action: 'detach', pluginId: 'p1' }],
    ['windows', { action: 'dock', pluginId: 'p1', target: 'shell', index: 0 }]])
  state = legacyState({ contribEntries: [] })
  await assert.rejects(api.dispatch({ type: 'contribution', id: 'entry', pluginId: 'other', code: 'untrusted' }), /Unknown chrome contribution/)
  await assert.rejects(api.dispatch({ type: 'detach', tabId: 'other' }), /Unknown chrome tab/)
  await assert.rejects(api.dispatch({ type: 'reorder', tabId: 't1', index: 99 }), /Invalid chrome tab index/)
  assert.equal(calls.length, 8)
})

test('inline classic adapter retains store action and notification behavior without shell IPC duplication', async () => {
  const calls = []
  const api = loadApi({ enestShell: { goHome() { throw Error('Duplicate shell navigation') }, activatePlugin() { throw Error('Bypassed store') } } })
    .createDefaultChromeApi('classic', { home: () => calls.push('home'), settings: () => calls.push('settings'),
      activate: id => calls.push(`activate:${id}`), close: id => calls.push(`close:${id}`) })
  for (const action of [{ type: 'home' }, { type: 'settings' }, { type: 'activate', tabId: 't1' }, { type: 'close', tabId: 't1' }]) await api.dispatch(action)
  assert.deepEqual(calls, ['home', 'settings', 'activate:t1', 'close:t1'])
  await api.ready()
})

test('classic replacement hides only the mounted tab fallback after host ACK and restores it on failure', () => {
  let ready = false, listener, unsubscribed = 0
  const effects = [], layoutEffects = [], module = { exports: {} }
  const imports = {
    react: { useEffect: effect => effects.push(effect), useLayoutEffect: effect => layoutEffects.push(effect),
      useRef: current => ({ current }), useState: () => [ready, value => { ready = value }] },
    gsap: {}, '@renderer/themes/default/chrome/TabStrip': { TabStrip() {} },
    '@renderer/services/shellApi': { shellApi: { onEvent(receive) { listener = receive; return () => { unsubscribed++ } } } },
    '@renderer/hooks/useAnimationLevel': { useAnimationLevel: () => ({ level: 'low' }), useReducedMotion: () => false },
    '@renderer/hooks/useAppearance': { useAppearanceStore: select => select({ appearance: { layout: { tabStyle: 'classic' } } }) },
    '@renderer/stores/shellStore': { useShellStore: select => select({ view: 'home', tabs: [] }) },
    '@renderer/gsap/marketMotion': {}, './titlebarHover': { createTitlebarHover: () => ({}) },
  }
  vm.runInNewContext(ts.transpileModule(read('src/renderer/layout/TitleBar.tsx'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, require(name) {
    if (name in imports) return imports[name]
    if (name === 'react/jsx-runtime') return require(name)
    throw Error(`Unexpected titlebar dependency ${name}`)
  } })
  const render = () => {
    const tree = module.exports.TitleBar({})
    const header = tree.props.children[0], [traffic, tabs] = header.props.children
    assert.equal(traffic.props.className, 'traffic', 'native window buttons stay mounted')
    assert.equal(tabs.props.children.type, imports['@renderer/themes/default/chrome/TabStrip'].TabStrip, 'fallback is never unmounted')
    return tabs
  }
  assert.equal(render().props['aria-hidden'], undefined)
  const off = effects.find(effect => effect.toString().includes('theme-chrome-status'))()
  listener({ type: 'appearance-changed', appearance: { chrome: { classic: {} } } })
  assert.equal(ready, false, 'manifest declarations cannot suppress fallback before a usable custom frame')
  listener({ type: 'theme-chrome-status', surface: 'classic', ready: true })
  const hidden = render()
  assert.match(hidden.props.className, /is-replaced/)
  assert.equal(hidden.props['aria-hidden'], true)
  const attributes = []
  hidden.ref.current = { toggleAttribute: (...args) => attributes.push(args) }
  layoutEffects.at(-1)()
  assert.deepEqual(attributes, [['inert', true]])
  listener({ type: 'theme-chrome-status', surface: 'classic', ready: false })
  const restored = render()
  assert.doesNotMatch(restored.props.className, /is-replaced/)
  assert.equal(restored.props['aria-hidden'], undefined)
  restored.ref.current = { toggleAttribute: (...args) => attributes.push(args) }
  layoutEffects.at(-1)()
  assert.deepEqual(attributes.at(-1), ['inert', false])
  off()
  assert.equal(unsubscribed, 1)
  assert.match(read('src/renderer/styles/app.css'), /\.titlebar-default-tabs\.is-replaced\s*\{[^}]*visibility:\s*hidden/)
})
