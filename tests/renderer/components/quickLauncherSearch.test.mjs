import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const directory = new URL('../../../src/renderer/components/', import.meta.url)
const compiled = new Map()
const turn = () => new Promise(resolve => setImmediate(resolve))
const command = (id, title, extra = {}) => ({ kind: 'plugin', id, title, subtitle: '', pluginId: 'fixture', code: id, ...extra })
const commands = [command('draw', '画板', { aliases: ['draw'] }), command('text', '翻译文本', { aliases: [], content: { type: 'over', minLength: 1 } }),
  command('index', '项目草稿', { entryId: 'draft', aliases: [] }), command('hidden', '仅接受内容', { aliases: [] }),
  command('notes', '便笺', { textInput: { type: 'text', trigger: 'prefix' } })]

async function fixture() {
  const slots = [], effects = [], timers = new Set(), requests = [], opened = []
  let cursor = 0, surface, shown, receiveEvent, resolveContext
  const memo = (factory, deps) => {
    const index = cursor++
    if (!slots[index] || deps.some((value, position) => !Object.is(value, slots[index].deps[position]))) slots[index] = { deps, value: factory() }
    return slots[index].value
  }
  const hooks = {
    lazy: () => 'DefaultQuickSurface', Suspense: 'Suspense', useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value } },
    useState(initial) {
      const index = cursor++, slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value }]
    },
    useEffect(effect, deps) {
      const index = cursor++, old = slots[index]
      if (!old || deps.some((value, position) => !Object.is(value, old.deps[position]))) {
        const slot = slots[index] = { deps }
        effects.push(() => { old?.cleanup?.(); slot.cleanup = effect() })
      }
    }
  }
  const shellApi = {
    onEvent(listener) { receiveEvent = listener; return () => { receiveEvent = undefined } },
    async quickInput() { return null },
    onQuickShown(listener) { shown = listener; return () => { shown = undefined } },
    quickInputContext: () => new Promise(resolve => { resolveContext = resolve }),
    async quickSearch(query, _limit, _kind, phase) {
      if (phase === 'providers') return new Promise(resolve => requests.push({ query, resolve }))
      return { items: phase === 'catalog' ? commands : [] }
    },
    async quickOpen(request) { opened.push(request); return { ok: true } }
  }
  const jsx = (type, props) => { if (type === 'DefaultQuickSurface') surface = props; return { type, props } }
  const theme = { source: 'enest.builtin', id: 'default' }
  const appearance = { theme, mode: 'light', animation: { effective: 'none' } }
  const modules = new Map(Object.entries({ react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx },
    '@shared/constants': { QUICK_BAR_AREA_H: 64, QUICK_CORNER_RADIUS: 18 }, '@shared/theme/builtinThemes': { DEFAULT_THEME_IDENTITY: theme },
    '@renderer/hooks/useAppearance': { useAppearanceStore: selector => selector({ appearance, hydrated: true }) },
    '@renderer/services/shellApi': { shellApi }, '@renderer/services/pluginWindowDrag': {}, './QuickThemeSurface': {},
    '@renderer/styles/plugin-window-drag.css': {}, './quickHost.css': {} }))
  const events = { addEventListener() {}, removeEventListener() {} }
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    const file = name.startsWith('@shared/') ? new URL(`../../../src/shared/${name.slice('@shared/'.length)}.ts`, import.meta.url).href
      : `${name}.${name === './QuickLauncherApp' ? 'tsx' : 'ts'}`
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(new URL(file, directory), 'utf8'), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
    }).outputText)
    const module = { exports: {} }
    runInNewContext(compiled.get(file), { module, exports: module.exports, require: load, crypto: { randomUUID }, AbortController,
      document: { ...events, hidden: false }, window: events, innerWidth: 720, innerHeight: 400, requestAnimationFrame: callback => callback(),
      setTimeout: callback => { timers.add(callback); return callback }, clearTimeout: callback => timers.delete(callback) })
    modules.set(name, module.exports)
    return module.exports
  }
  const { QuickLauncherApp } = load('./QuickLauncherApp')
  const render = () => { cursor = 0; QuickLauncherApp(); for (const apply of effects.splice(0)) apply() }
  const settle = async () => { render(); await turn(); render() }
  const send = request => surface.onAction(request)
  const act = async request => { const result = await send(request); await settle(); return result }
  await settle()
  return { act, send, opened, get state() { return surface.snapshot }, get gripIcon() { return surface.gripIcon },
    async emit(event) { receiveEvent(event); await settle() },
    async show() { shown(); await settle(); return async items => { resolveContext({ ok: true, items }); await turn(); await settle() } },
    item: title => surface.snapshot.catalog.find(item => item.title === title),
    publish: (...items) => act({ type: 'results', queryRevision: surface.snapshot.queryRevision, catalogRevision: surface.snapshot.catalogRevision,
      items: items.map(item => ({ id: item.id, group: 'display-group' })) }),
    startProviders(query) {
      const [timer] = timers
      assert.ok(timer); timers.delete(timer)
      const done = timer(), request = requests.at(-1)
      assert.equal(request.query, query)
      return async items => { request.resolve({ items }); await done; await settle() }
    }
  }
}

test('the grip gets its package icon immediately; the theme gets only published bytes', async () => {
  const quick = await fixture(), pluginId = 'fixture', title = '剪贴板'
  const packageIcon = `enest://plugin/${pluginId}/assets/market/icon.svg`
  await quick.emit({ type: 'quick-plugin-mode', mode: { pluginId, title, packageIcon } })
  assert.equal(quick.gripIcon, packageIcon)
  assert.equal(quick.state.plugin.icon, undefined)
  assert.ok(!JSON.stringify(quick.state.plugin).includes(packageIcon))
  const icon = 'data:image/svg+xml;base64,PHN2Zy8+'
  await quick.emit({ type: 'quick-plugin-presentation', pluginId, presentation: { title, packageIcon, icon } })
  assert.equal(quick.gripIcon, packageIcon)
  assert.equal(quick.state.plugin.icon, icon)
  await quick.emit({ type: 'quick-plugin-presentation', pluginId, presentation: { title, glyph: '★' } })
  assert.equal(quick.gripIcon, undefined)
  assert.equal(quick.state.plugin.icon, undefined)
  assert.equal(quick.state.plugin.glyph, '★')
})

test('the default follows the first current result until the user selects a visible handle', async () => {
  const quick = await fixture()
  const contextReply = await quick.show()
  await quick.act({ type: 'query', query: '画板' })
  const draw = quick.item('画板'), text = quick.item('翻译文本')
  assert.deepEqual(Array.from(quick.item('项目草稿').aliases), ['项目草稿'])
  assert.deepEqual(Array.from(quick.item('仅接受内容').aliases), [])
  assert.deepEqual(Array.from(quick.item('便笺').aliases), ['便笺'])
  assert.equal(quick.item('便笺').textInput.trigger, 'none')
  await quick.publish(text)
  await quick.publish(draw, text)
  assert.equal(quick.state.selectedId, draw.id)
  await quick.publish(text)
  await quick.act({ type: 'select', id: text.id })
  await quick.publish(draw, text)
  await contextReply([])
  assert.equal(quick.state.selectedId, text.id)
  assert.equal((await quick.send({ type: 'key', key: 'Enter' })).ok, true)
  assert.equal(quick.opened.at(-1).payload, '画板')
  await quick.send({ type: 'select', id: draw.id })
  assert.equal((await quick.send({ type: 'key', key: 'Enter' })).ok, true)
  assert.equal(quick.opened.at(-1).code, 'draw')
  await quick.publish(text)
  await quick.publish(draw, text)
  assert.equal(quick.state.selectedId, draw.id)
  await quick.act({ type: 'select', id: text.id })
  await quick.act({ type: 'query', query: '画' })
  await quick.publish(draw, text)
  assert.equal(quick.state.selectedId, draw.id)
})

test('late providers cannot replace a newer query and an empty same-query retry leaves no stale handles', async () => {
  const quick = await fixture()
  await quick.act({ type: 'query', query: '旧' })
  const oldReply = quick.startProviders('旧')
  await quick.act({ type: 'query', query: '画板' })
  const reply = quick.startProviders('画板')
  await reply([command('record', '新记录', { group: 'provider', payload: { historyId: 'fixture-record' } })])
  const draw = quick.item('画板'), record = quick.item('新记录')
  await quick.publish(draw, record)
  await quick.act({ type: 'select', id: record.id })
  await oldReply([command('record', '旧记录', { group: 'provider' })])
  assert.equal(quick.item('旧记录'), undefined)
  assert.equal(quick.item('新记录').id, record.id)
  assert.equal(quick.state.selectedId, record.id)
  assert.equal(record.payload, undefined)
  assert.equal((await quick.send({ type: 'key', key: 'Enter' })).ok, true)
  assert.equal(quick.opened.at(-1).payload.historyId, 'fixture-record')
  await quick.act({ type: 'composition', active: true })
  assert.equal(quick.item('新记录'), undefined)
  assert.equal(quick.state.selectedId, draw.id)
  assert.equal((await quick.send({ type: 'open', id: record.id })).ok, false)
  await quick.act({ type: 'composition', active: false })
  await quick.startProviders('画板')([])
  assert.deepEqual(Array.from(quick.state.items, item => item.id), [draw.id])
  assert.equal((await quick.send({ type: 'select', id: record.id })).ok, false)
  assert.equal(quick.opened.length, 1)
})
