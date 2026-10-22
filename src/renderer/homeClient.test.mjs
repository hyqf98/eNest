import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const controllerBundle = await build({
  entryPoints: [join(root, 'src/renderer/themes/default/WorkspaceController.ts')],
  bundle: true, write: false, platform: 'browser', format: 'cjs', tsconfig: join(root, 'tsconfig.web.json'),
})
const workspaceBundle = await build({
  stdin: { contents: `export {DefaultWorkspace,workspacePluginPresentation} from '@renderer/themes/default/DefaultWorkspace';export {DefaultThemeBackground} from '@renderer/themes/default/DefaultThemeBackground'`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  tsconfig: join(root, 'tsconfig.web.json'), loader: { '.css': 'empty' },
})

function snapshot(revision = 1, generation = 1, theme = 'default') {
  return { generation, appearance: {
    version: 2, revision, theme: { source: 'enest.builtin', id: theme, name: theme, version: 3, legacy: false },
    requestedMode: 'light', mode: 'light', tokens: { '--bg': '#f6f6f4', '--text': '#292c2e' },
    fonts: { body: 'sans-serif', heading: 'sans-serif', mono: 'monospace', scale: 1 },
    components: { controlRadius: 10, cardRadius: 18, panelRadius: 24, borderWidth: 1 },
    notifications: { layout: 'card', accent: 'stripe', radius: 16, borderWidth: 1, density: 1, shadow: 'soft' },
    background: { media: null, effect: 'none', texture: 'none', intensity: 1, speed: 1, direction: 0 },
    layout: { variant: 'default', tabStyle: 'classic', density: 1, gap: 16, sidebarWidth: 280, contentWidth: 1020, columns: 3 },
    animation: { requested: 'medium', effective: 'medium', continuous: true },
  } }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

function fixture(overrides = {}, callbacks = {}) {
  const appearanceListeners = new Set(), commandListeners = new Set()
  const order = [], acks = [], ready = [], actions = [], appearances = [], configs = []
  const bridge = {
    onAppearance: listener => { order.push('subscribeAppearance'); appearanceListeners.add(listener); return () => appearanceListeners.delete(listener) },
    onCommand: listener => { order.push('subscribeCommand'); commandListeners.add(listener); return () => commandListeners.delete(listener) },
    getAppearance: async () => { order.push('getAppearance'); return snapshot() },
    getConfig: async () => ({ locale: 'zh-CN', installedFirst: true, offline: false, warmInstall: false, revision: 1 }),
    getCatalog: async () => ({ revision: 1, items: [{ pluginId: 'todos', name: 'Todos', installed: true, enabled: true, category: '效率' }] }),
    getDetail: async pluginId => ({ pluginId, name: pluginId, installed: true }),
    search: async () => ({ revision: 1, items: [] }),
    refresh: async () => ({ revision: 2, items: [] }),
    action: async request => { actions.push(request); return { ok: true } },
    ackNavigation: async payload => { acks.push(payload) },
    ready: async payload => { order.push('ready'); ready.push(payload) },
    ...overrides,
  }
  const module = { exports: {} }
  vm.runInNewContext(controllerBundle.outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout, AbortController, TextDecoder,
    fetch: overrides.fetch ?? (() => { throw Error('Unexpected README request') }),
  })
  const controller = module.exports.createDefaultWorkspaceController(bridge, {
    applyAppearance: value => appearances.push(value), applyConfig: value => configs.push(value), ...callbacks,
  })
  return { controller, bridge, order, acks, ready, actions, appearances, configs, appearanceListeners, commandListeners,
    push: value => appearanceListeners.forEach(listener => listener(value)),
    command: value => [...commandListeners].forEach(listener => listener(value)),
    state: () => controller.getState(), dispose: controller.dispose,
  }
}
const navigation = (page, requestId = page, extra = {}) => ({ type: 'navigate', route: { page, ...extra }, requestId, generation: 1, revision: 1 })

function uiModule() {
  const module = { exports: {} }
  vm.runInNewContext(workspaceBundle.outputFiles[0].text, {
    module, exports: module.exports, require, console,
    document: { hidden: false, hasFocus: () => true }, window: { matchMedia: () => ({ matches: false }) },
    setTimeout, clearTimeout, URL, performance,
  })
  return module.exports
}

// This is a bundle boundary check, not just a source-level import assertion.
test('default Workspace retains no shell API, host state, mock data or privileged settings in its dependency graph', async () => {
  const result = await build({ entryPoints: [join(root, 'src/renderer/homeClient.ts')],
    bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
    tsconfig: join(root, 'tsconfig.web.json'), loader: { '.css': 'empty' },
  })
  const inputs = Object.keys(result.metafile.inputs)
  assert.deepEqual(inputs.filter(path => /services\/(?:shellApi|mock|notifyService|confirmAction)|stores\/shellStore|pages\/SettingsPage|hooks\/useAppearance\.ts/.test(path)), [])
  for (const name of ['DefaultWorkspace', 'DefaultThemeBackground', 'DefaultBackgroundEffect', 'WorkspaceController']) {
    assert.ok(inputs.some(path => path.includes(`/themes/default/${name}.`)), name)
  }
  const entry = await readFile(join(root, 'src/renderer/homeClient.ts'), 'utf8')
  assert.match(entry, /releaseAppearanceResources\(\)/)
  assert.match(entry, /@renderer\/styles\/app.css/)
  assert.doesNotMatch(entry, /styles\/home.css/)
})

test('subscriptions precede all reads and a late initial snapshot cannot replace a newer generation', async () => {
  const pending = deferred()
  const context = fixture({ getAppearance: () => { context.order.push('getAppearance'); return pending.promise } })
  const started = context.controller.start()
  assert.deepEqual(context.order.slice(0, 3), ['subscribeAppearance', 'subscribeCommand', 'getAppearance'])
  context.push(snapshot(12, 3, 'studio-board'))
  pending.resolve(snapshot(10, 2))
  await started
  assert.equal(context.state().appearance.appearance.revision, 12)
  assert.equal(context.state().runtimeGeneration, 3)
  assert.equal(context.appearances.at(-1).appearance.theme.id, 'studio-board')
  assert.equal(context.order.at(-1), 'ready')
  assert.deepEqual([...context.ready[0].routes], ['catalog', 'installed', 'detail'])
  context.dispose()
})

test('hidden Workspace initialization renders no preparing screen but retains actual load failures', async () => {
  const context = fixture({ getAppearance: async () => { throw Error('Unavailable') } })
  const { DefaultWorkspace } = uiModule()
  try {
    assert.equal(renderToStaticMarkup(createElement(DefaultWorkspace, { controller: context.controller })), '')
    await context.controller.start()
    const failed = renderToStaticMarkup(createElement(DefaultWorkspace, { controller: context.controller }))
    assert.match(failed, /role="alert"/)
    assert.match(failed, /工作区暂时无法启动/)
    assert.doesNotMatch(failed, /Preparing eNest|正在准备/)
  } finally { context.dispose() }
})

test('hidden prewarm keeps both paint barriers and reuses the initial catalog at handoff', async () => {
  const bootPaint = deferred(), routePaint = deferred(), reads = []
  let paints = 0
  const context = fixture({
    getAppearance: async () => { reads.push('appearance'); return snapshot() },
    getConfig: async () => { reads.push('config'); return { locale: 'zh-CN', revision: 1 } },
    getCatalog: async () => { reads.push('catalog'); return { revision: 1, items: [] } },
  }, { afterPaint: () => ++paints === 1 ? bootPaint.promise : routePaint.promise })
  try {
    const start = context.controller.start()
    await nextTurn()
    assert.equal(context.ready.length, 0, 'boot readiness requires the initial paint')
    bootPaint.resolve()
    await start
    assert.equal(context.ready.length, 1)
    context.command(navigation('catalog', 'startup-catalog'))
    await nextTurn()
    assert.equal(context.acks.length, 0, 'the route ACK still requires its own paint')
    routePaint.resolve()
    await nextTurn()
    assert.equal(context.acks[0].requestId, 'startup-catalog')
    assert.equal(context.acks[0].ok, true)
    assert.deepEqual(reads, ['appearance', 'config', 'catalog'], 'handoff does not repeat the startup reads')
  } finally { context.dispose() }
})

test('appearance changes preserve query/category/results and only apply rendering data', async () => {
  const context = fixture()
  await context.controller.start()
  context.controller.queueSearch('draft query')
  context.controller.setCategory('效率')
  await context.controller.runSearch()
  const results = context.state().results
  context.push(snapshot(2, 1, 'studio-board'))
  context.push(snapshot(3, 1, 'compact-library'))
  assert.equal(context.state().query, 'draft query')
  assert.equal(context.state().category, '效率')
  assert.equal(context.state().results, results)
  assert.equal(context.state().route.page, 'catalog')
  context.dispose()
})

test('the default theme renders the original page/search/catalog/card hierarchy and floating settings entry', async () => {
  const context = fixture()
  await context.controller.start()
  const { DefaultWorkspace } = uiModule()
  const html = renderToStaticMarkup(createElement(DefaultWorkspace, { controller: context.controller }))
  for (const marker of ['page page-home', 'home-scroll', 'market-page-heading', 'market-search-header', 'search-wrap', 'home-toolbar', 'market-category-list', 'grid market-grid', 'data-plugin-card', 'card-actions', 'bottom-bar', 'float-btn']) assert.ok(html.includes(marker), marker)
  assert.doesNotMatch(html, /home-atmosphere|home-brand|home-nav-masthead|home-card-main|workspace-route-nav|选择主题/)
  context.dispose()
})

test('pure presentation drops host roots, asset URLs, private launch data and executable contribution payloads', () => {
  const { workspacePluginPresentation } = uiModule()
  const value = workspacePluginPresentation({ pluginId: 'todos', name: 'Todos', installed: true,
    rootPath: '/private', assetUrl: 'https://private', devUrl: 'http://localhost', pluginLaunch: { token: 'secret' },
    contributes: { homeCards: [{ code: 'private' }] }, featured: true, packageSize: 2048 })
  assert.equal(value.id, 'todos')
  assert.equal(value.packageSize, 2048)
  for (const key of ['rootPath', 'assetUrl', 'devUrl', 'pluginLaunch', 'contributes']) assert.equal(key in value, false)
})

test('five original GPU presets remain the default plugin rendering engine', () => {
  const { DefaultThemeBackground } = uiModule()
  for (const effect of ['fold', 'aurora', 'orbit', 'ripple', 'tunnel']) {
    const appearance = snapshot().appearance
    appearance.background.effect = effect
    const html = renderToStaticMarkup(createElement(DefaultThemeBackground, { appearance, paused: false }))
    assert.match(html, /background-effect/)
    assert.match(html, new RegExp(`data-background-effect="${effect}"`))
  }
})

test('clearing or composing a query invalidates in-flight results and never reuses stale handles', async () => {
  const pending = deferred()
  const context = fixture({ search: () => pending.promise })
  await context.controller.start()
  context.controller.queueSearch('old query')
  const searching = context.controller.runSearch()
  context.controller.queueSearch('中文', 'all', true)
  pending.resolve({ revision: 2, items: [{ handle: 'stale', title: 'Stale' }] })
  await searching
  assert.equal(context.state().results, undefined)
  assert.equal(context.state().searching, false)
  context.controller.queueSearch('')
  assert.equal(context.state().query, '')
  context.dispose()
})

test('late details cannot replace a newer detail request', async () => {
  const first = deferred(), second = deferred()
  const context = fixture({ getDetail: id => id === 'first' ? first.promise : second.promise })
  await context.controller.start()
  const firstLoad = context.controller.showDetail('first'), secondLoad = context.controller.showDetail('second')
  second.resolve({ pluginId: 'second', name: 'Second' }); await secondLoad
  first.resolve({ pluginId: 'first', name: 'First' }); await firstLoad
  assert.equal(context.state().detail.pluginId, 'second')
  context.dispose()
})

test('detail navigation acknowledges only after loading and the React paint barrier', async () => {
  const loading = deferred(), paint = deferred()
  let waitForPaint = false
  const context = fixture({ getDetail: () => loading.promise }, { afterPaint: () => waitForPaint ? paint.promise : Promise.resolve() })
  await context.controller.start(); waitForPaint = true
  context.command(navigation('detail', 'detail-1', { pluginId: 'todos' }))
  await nextTurn()
  assert.equal(context.acks.length, 0)
  assert.equal(context.state().detail, null, 'navigation stays pending until the descriptor resolves')
  loading.resolve({ pluginId: 'todos', name: 'Todos', installed: true })
  await nextTurn(); assert.equal(context.acks.length, 0)
  paint.resolve(); await nextTurn()
  assert.equal(context.acks[0].ok, true)
  assert.equal(context.acks[0].requestId, 'detail-1')
  context.command({ type: 'visibility', visible: true, revision: 1 })
  assert.equal(context.state().visible, true)
  context.command({ type: 'visibility', visible: false, revision: 1 })
  assert.equal(context.state().visible, false)
  context.dispose()
})

test('superseded navigation and teardown never acknowledge or retain an obsolete detail', async () => {
  for (const target of ['catalog', 'dispose', 'openMarket']) {
    const pending = deferred()
    const context = fixture({ getDetail: () => pending.promise })
    await context.controller.start()
    context.command(navigation('detail', 'old-detail', { pluginId: 'todos' }))
    await nextTurn()
    const detail = context.state().detail
    if (target === 'dispose') context.dispose()
    else if (target === 'openMarket') context.command({ type: 'openMarket', generation: 1, revision: 1 })
    else context.command(navigation('catalog', 'new-catalog'))
    pending.resolve({ pluginId: 'todos', name: 'Todos', installed: true })
    await nextTurn()
    assert.ok(!context.acks.some(ack => ack.requestId === 'old-detail'))
    if (target !== 'dispose') { assert.equal(context.state().detail, detail); context.dispose() }
  }
})

test('wrong generations/stale revisions do not navigate or acknowledge; a descriptor failure NACKs', async () => {
  const context = fixture({ getDetail: async () => { throw Error('Unavailable') } })
  await context.controller.start()
  for (const [generation, revision] of [[0, 1], [2, 1], [1, 0]]) context.command({ ...navigation('installed'), generation, revision })
  await nextTurn()
  assert.equal(context.state().route.page, 'catalog')
  assert.equal(context.acks.length, 0)
  context.command(navigation('detail', 'failed', { pluginId: 'missing' }))
  await nextTurn()
  assert.equal(context.acks[0].ok, false)
  context.dispose()
})

test('an unknown detail rejects its route instead of displaying a fake success page', async () => {
  const context = fixture({ getDetail: async () => null })
  await context.controller.start()
  context.command(navigation('detail', 'missing', { pluginId: 'missing' }))
  await nextTurn()
  assert.equal(context.acks[0].ok, false)
  assert.equal(context.state().detail, null)
  context.dispose()
})

test('README reads only exact host catalog slots; navigation aborts and ignores late content', async () => {
  const pending = deferred()
  let signal, requests = 0
  const context = fixture({
    getDetail: async id => ({ pluginId: id, name: id, readmeUrl: id === 'first' ? `enest-home://catalog/${id}/readme` : 'https://example.com/README.md' }),
    fetch: async (_url, options) => { requests++; signal = options.signal; return pending.promise },
  })
  await context.controller.start()
  context.command(navigation('detail', 'first-detail', { pluginId: 'first' })); await nextTurn()
  assert.equal(context.state().detailReadme.status, 'loading')
  context.command(navigation('detail', 'second-detail', { pluginId: 'second' })); await nextTurn()
  assert.equal(signal.aborted, true)
  assert.equal(context.state().detailReadme.status, 'error')
  assert.equal(requests, 1)
  pending.resolve(new Response('# Stale first README'))
  await nextTurn()
  assert.equal(context.state().detail.pluginId, 'second')
  assert.equal(context.state().detailReadme.text, undefined)
  context.dispose()
})

test('management is host-owned and refreshes metadata without remounting the dialog or leaking bridge responses', async () => {
  const context = fixture({ getDetail: async pluginId => ({ pluginId, name: 'Updated', installed: true, enabled: false }) })
  await context.controller.start()
  context.command(navigation('detail', 'detail', { pluginId: 'todos' })); await nextTurn()
  await context.controller.manage({ type: 'setPluginEnabled', pluginId: 'todos', enabled: false }, 'todos')
  assert.equal(context.actions[0].type, 'setPluginEnabled')
  assert.equal(context.state().detail.enabled, false)
  assert.equal(context.state().route.page, 'detail')
  assert.equal(context.state().busy.size, 0)
  context.dispose()
  assert.equal(context.appearanceListeners.size, 0)
  assert.equal(context.commandListeners.size, 0)
})
