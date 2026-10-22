import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function fixture({ firstRun = false, search = '', delaySettings = false, delaySession = false } = {}) {
  let cursor = 0, dirty = true, tree
  const hooks = [], calls = [], navigation = [], settingsRead = deferred(), sessionRestore = deferred(), listeners = new Map()
  const identity = { source: 'enest.builtin', id: 'default' }
  const settings = { general: firstRun ? {} : { sessionTabs: [{ pluginId: 'saved' }] } }
  const appearance = {
    appearance: { theme: identity, mode: 'light', layout: { tabStyle: 'orb' } }, hydrated: false,
    hydrate: async () => { calls.push(['appearance']); appearance.hydrated = true; dirty = true },
  }
  const shell = {
    view: 'home',
    hydrateSessionTabs: async ids => { calls.push(['restore', ids]); if (delaySession) await sessionRestore.promise },
    applyTabStyle: style => calls.push(['tab-style', style]),
    setNativeChromeSyncEnabled: enabled => calls.push(['native-chrome', enabled]),
    applyView: view => { shell.view = view; calls.push(['apply-view', view]); dirty = true },
    setView: () => { throw Error('Startup must await navigation, not fire-and-forget setView') },
  }
  const i18n = { hydrate: async () => calls.push(['locale']) }
  const api = {
    getSettings: () => { calls.push(['settings']); return delaySettings ? settingsRead.promise : Promise.resolve(settings) },
    hidePlugins: async () => calls.push(['hide-plugins']),
    setHomeVisible: async visible => calls.push(['visible', visible]),
    navigateWorkspace: route => { calls.push(['navigate', route]); const request = deferred(); navigation.push(request); return request.promise },
  }
  const react = {
    useState(initial) {
      const index = cursor++
      hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, value => {
        const next = typeof value === 'function' ? value(hooks[index].value) : value
        if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index] },
    useEffect(effect, deps) {
      const index = cursor++, old = hooks[index]
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        hooks[index] = { deps, effect, pending: true, cleanup: old?.cleanup }
      }
    },
  }
  const jsx = (type, props) => ({ type, props })
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@renderer/hooks/useAppearanceSync': { useAppearanceSync() {} },
    '@renderer/hooks/useI18n': { useI18n: () => i18n },
    '@renderer/hooks/useAppearance': { useAppearanceStore: Object.assign(selector => selector(appearance), { getState: () => appearance }) },
    '@renderer/stores/shellStore': { useShellStore: Object.assign(selector => selector(shell), { getState: () => shell }) },
    '@renderer/gsap/marketMotion': { initMotion() {} },
    '@renderer/services/shellApi': { shellApi: api },
    '@renderer/components/ui/Button': { Button: 'Button' },
  }
  for (const [path, name] of [
    ['layout/ShellLayout', 'ShellLayout'], ['components/NotificationHost', 'NotificationHost'],
    ['components/Splash', 'Splash'], ['components/QuickLauncherApp', 'QuickLauncherApp'],
    ['components/AppBackground', 'AppBackground'],
  ]) imports[`@renderer/${path}`] = { [name]: name }
  const window = {
    location: { search }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'window', 'document', 'HTMLElement', source)(id => {
    assert.ok(imports[id], id); return imports[id]
  }, module, module.exports, window, { activeElement: null }, class {})
  const render = () => {
    cursor = 0; dirty = false; tree = module.exports.default()
    for (const hook of hooks) if (hook.pending) {
      hook.pending = false; hook.cleanup?.(); hook.cleanup = hook.effect()
    }
  }
  const find = type => {
    const visit = node => {
      if (!node || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(visit).find(Boolean)
      return node.type === type ? node : visit(node.props?.children)
    }
    return visit(tree)
  }
  return {
    calls, navigation, settingsRead, settings, sessionRestore, find,
    async flush() {
      for (let count = 0; count < 20; count++) { if (dirty) render(); await turn(); if (!dirty) return }
      throw Error('Startup render did not settle')
    },
    replayEffects() { for (const hook of hooks) if (hook.effect) { hook.cleanup?.(); hook.cleanup = hook.effect() } },
    close() { for (const hook of hooks) hook.cleanup?.() },
  }
}

test('configuration and Home prepare overlap the splash; reveal waits for navigation and animation', async () => {
  const f = fixture({ delaySettings: true })
  try {
    await f.flush()
    assert.deepEqual(f.calls.filter(call => ['settings', 'appearance'].includes(call[0])), [['settings'], ['appearance']])
    assert.equal(f.find('Splash').props.ready, false, 'hydrated appearance shows the animation while settings are pending')
    assert.equal(f.find('AppBackground'), undefined)
    assert.equal(f.find('section'), undefined, 'no secondary startup/preparing page')
    f.replayEffects()
    assert.equal(f.calls.filter(call => call[0] === 'settings').length, 1, 'StrictMode reuses the pending settings read')
    f.settingsRead.resolve(f.settings)
    await f.flush()
    assert.equal(f.navigation.length, 1, 'Home navigation begins before splash finishes')
    assert.equal(f.find('Splash').props.ready, false)
    assert.equal(f.find('ShellLayout'), undefined)
    assert.deepEqual(f.calls.find(call => call[0] === 'restore'), ['restore', ['saved']])
    assert.equal(f.calls.find(call => call[0] === 'tab-style'), undefined, 'native rail creation waits for ShellLayout')
    assert.ok(!f.calls.some(call => call[0] === 'visible' && call[1]))
    f.navigation[0].resolve()
    await f.flush()
    assert.equal(f.find('Splash').props.ready, true)
    assert.equal(f.find('ShellLayout'), undefined)
    f.find('Splash').props.onDone()
    await f.flush()
    assert.ok(f.find('ShellLayout'))
    assert.deepEqual(f.calls.filter(call => call[0] === 'visible').at(-1), ['visible', true])
    assert.equal(f.navigation.length, 1, 'handoff does not replay navigation')
  } finally { f.close() }
})

test('skipping splash still waits for the native ready/ACK promise', async () => {
  const f = fixture({ search: '?splash=none', delaySession: true })
  try {
    await f.flush()
    assert.equal(f.find('Splash'), undefined)
    assert.equal(f.find('section'), undefined)
    assert.equal(f.find('ShellLayout'), undefined)
    f.navigation[0].resolve()
    await f.flush()
    assert.ok(f.find('ShellLayout'), 'slow detached-window restoration must not delay the ready Home')
    f.sessionRestore.resolve()
  } finally { f.close() }
})

test('a first run without any setup marker starts Home directly and still waits for its ACK', async () => {
  const f = fixture({ firstRun: true })
  try {
    await f.flush()
    assert.equal(Object.hasOwn(f.settings.general, 'themeSetupComplete'), false)
    assert.equal(f.navigation.length, 1, 'a fresh installation does not wait for theme selection or confirmation')
    assert.deepEqual(f.calls.find(call => call[0] === 'navigate'), ['navigate', { page: 'catalog' }])
    assert.deepEqual(f.calls.find(call => call[0] === 'restore'), ['restore', []])
    assert.equal(f.find('section'), undefined)
    assert.equal(f.find('Button'), undefined)
    assert.equal(f.find('Splash').props.ready, false)
    f.find('Splash').props.onDone()
    await f.flush()
    assert.equal(f.find('ShellLayout'), undefined, 'finishing animation alone cannot bypass the route ACK')
    assert.ok(!f.calls.some(call => call[0] === 'visible' && call[1]))
    f.navigation[0].resolve()
    await f.flush()
    assert.ok(f.find('ShellLayout'))
    assert.deepEqual(f.calls.filter(call => call[0] === 'visible').at(-1), ['visible', true])
    assert.equal(f.navigation.length, 1)
  } finally { f.close() }
})

test('failed Home navigation exposes startup recovery and the reload button retries the ACK-gated handoff', async () => {
  const f = fixture({ firstRun: true })
  try {
    await f.flush()
    assert.equal(f.navigation.length, 1)
    f.navigation[0].reject(Error('route timeout'))
    await f.flush()
    assert.equal(f.find('section').props['aria-label'], '启动恢复')
    assert.equal(f.find('section').props.role, 'alert')
    assert.equal(f.find('p').props.children, '首页暂时无法打开，请重试。')
    assert.equal(f.find('Button').props.children, '重新加载')
    assert.ok(f.find('AppBackground'))
    assert.equal(f.find('Splash'), undefined)
    assert.equal(f.find('ShellLayout'), undefined)
    assert.ok(!f.calls.some(call => call[0] === 'visible' && call[1]))
    f.find('Button').props.onClick()
    await f.flush()
    assert.equal(f.calls.filter(call => call[0] === 'settings').length, 2, 'retry rereads startup settings')
    assert.equal(f.navigation.length, 2)
    assert.equal(f.find('section'), undefined)
    assert.equal(f.find('Splash').props.ready, false)
    assert.equal(f.find('ShellLayout'), undefined)
    f.navigation[1].resolve()
    await f.flush()
    assert.equal(f.find('Splash').props.ready, true)
    assert.equal(f.find('ShellLayout'), undefined, 'successful retry still waits for the launch animation')
    f.find('Splash').props.onDone()
    await f.flush()
    assert.ok(f.find('ShellLayout'))
    assert.deepEqual(f.calls.filter(call => call[0] === 'visible').at(-1), ['visible', true])
    assert.equal(f.navigation.length, 2, 'recovery does not navigate again during reveal')
  } finally { f.close() }
})

test('Quick does not read startup settings, create Home, or manipulate its visibility', async () => {
  const f = fixture({ search: '?surface=quick' })
  try {
    await f.flush()
    assert.ok(f.find('QuickLauncherApp'))
    assert.equal(f.navigation.length, 0)
    assert.deepEqual(f.calls.map(call => call[0]), ['appearance', 'locale'])
  } finally { f.close() }
})
