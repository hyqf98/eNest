import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const opacityProperty = '--appearance-tab-opacity'
const identity = { source: 'com.example.theme', id: 'custom' }
const componentNames = ['TopTabBarSection', 'TopTabBarControls', 'Field', 'Card']
const modules = ['TopTabBarSection.tsx', 'SettingsFields.tsx'].map(name => {
  const source = readFileSync(new URL(`../../../src/renderer/themes/default/settings/${name}`, import.meta.url), 'utf8')
  return ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
})
const declarations = modules.flatMap(ast => ast.statements.filter(node => ts.isFunctionDeclaration(node) && componentNames.includes(node.name?.text)))
assert.equal(declarations.length, componentNames.length, 'the tested settings components must exist')

// Execute the real private components without importing unrelated settings services or import.meta.
const compiled = ts.transpileModule([
  ...modules.flatMap(ast => ast.statements.filter(node => ts.isImportDeclaration(node) && node.importClause && node.moduleSpecifier.text !== './SettingsFields').map(node => node.getFullText(ast))),
  ...declarations.map(node => node.getFullText(node.getSourceFile()).replace(/\bexport (?=function )/, '')),
  'export { TopTabBarSection, TopTabBarControls }',
].join('\n'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function deferred() {
  let resolve, reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

const flushJobs = () => new Promise(resolve => setImmediate(resolve))
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))

/** Only hook lifecycles are mocked; tests explicitly rerender after store snapshots and async work. */
function hookFixture() {
  let rendering
  const hooks = {
    useState(initial) {
      const owner = rendering
      const slot = owner.slots[owner.index++] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [slot.value, update => {
        const next = typeof update === 'function' ? update(slot.value) : update
        if (!Object.is(next, slot.value)) { slot.value = next; owner.dirty = true }
      }]
    },
    useRef(initial) {
      return rendering.slots[rendering.index++] ??= { current: initial }
    },
    useCallback(callback, deps) {
      const index = rendering.index++
      const previous = rendering.slots[index]
      if (!previous || !equalDeps(previous.deps, deps)) rendering.slots[index] = { value: callback, deps }
      return rendering.slots[index].value
    },
    useEffect(effect, deps) {
      const owner = rendering
      const index = owner.index++
      const previous = owner.slots[index]
      if (!previous || !equalDeps(previous.deps, deps)) owner.effects.push(() => {
        previous?.cleanup?.()
        owner.slots[index] = { deps, cleanup: effect() }
      })
    },
  }
  return {
    hooks,
    mount(component, props) {
      const owner = { slots: [], index: 0, effects: [], dirty: false, unmounted: false }
      return {
        render() {
          assert.equal(owner.unmounted, false, 'cannot render an unmounted component')
          let tree
          let passes = 0
          do {
            assert.ok(++passes <= 10, 'hook fixture rerenders must settle')
            owner.index = 0; owner.effects = []; owner.dirty = false
            rendering = owner
            try { tree = component(props()) }
            finally { rendering = undefined }
            owner.effects.forEach(effect => effect())
          } while (owner.dirty)
          return tree
        },
        unmount() {
          if (owner.unmounted) return
          owner.unmounted = true
          owner.slots.forEach(slot => slot.cleanup?.())
        },
      }
    },
  }
}

function schemaFields(prefix = '') {
  return [
    { key: `${prefix}customTabMode`, label: 'Tab mode', type: 'select', default: 'classic', binding: { target: 'layout', key: 'tabStyle' }, options: [{ value: 'classic', label: 'Top' }, { value: 'orb', label: 'Orb' }] },
    { key: `${prefix}stripAlpha`, label: 'Opacity', type: 'slider', default: 1, min: 0, max: 1, step: 0.05, binding: { target: 'layout', key: 'tabOpacity' } },
    { key: `${prefix}hideStrip`, label: 'Auto-hide', type: 'switch', default: false, binding: { target: 'layout', key: 'tabAutoHide' } },
  ]
}

function themePack(theme, prefix = '') {
  const [style, ...chrome] = schemaFields(prefix)
  return {
    ...theme, version: 1,
    settings: { version: 1, groups: [{ id: 'mode', fields: [style] }, { id: 'chrome', fields: chrome }] },
  }
}

function fixture(t) {
  const lifecycle = hookFixture()
  const css = new Map([[opacityProperty, '1']])
  const writes = []
  const views = []
  let save = async () => {}
  let hydrate = async () => {}
  let hydrationCalls = 0
  const state = {
    hydrated: true,
    appearance: { revision: 1, theme: { ...identity }, layout: { tabStyle: 'classic', tabOpacity: 1, tabAutoHide: false } },
    profile: { identity: { ...identity }, values: {} },
    packs: [themePack({ source: 'another.provider', id: identity.id }, 'decoy_'), themePack(identity)],
    hydrate: async () => { hydrationCalls++; await hydrate() },
    updateThemeProfile: async patch => {
      writes.push(structuredClone(patch))
      await save(patch)
      const fields = activePack().settings.groups.flatMap(group => group.fields)
      const layout = { ...state.appearance.layout }
      for (const [key, value] of Object.entries(patch.values)) {
        const field = fields.find(candidate => candidate.key === key)
        assert.ok(field, `unknown schema key submitted: ${key}`)
        layout[field.binding.key] = value
      }
      state.profile = { ...state.profile, values: { ...state.profile.values, ...patch.values } }
      publishLayout(layout)
    },
  }
  const activePack = () => state.packs.find(pack => pack.source === state.profile.identity.source && pack.id === state.profile.identity.id)
  const publishLayout = layout => {
    state.appearance = { ...state.appearance, revision: state.appearance.revision + 1, layout: { ...state.appearance.layout, ...layout } }
    css.set(opacityProperty, String(state.appearance.layout.tabOpacity ?? 1))
  }
  const store = selector => selector(state)
  store.getState = () => state
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const imports = {
    react: lifecycle.hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '@renderer/hooks/useAppearance': { useAppearanceStore: store },
    '@renderer/hooks/useI18n': { useI18n: () => ({ locale: 'en-US', t: key => key }) },
    ...Object.fromEntries(['Button', 'Segmented', 'Slider', 'Switch'].map(name => [`@renderer/components/ui/${name}`, { [name]: name }])),
  }
  const module = { exports: {} }
  const document = { documentElement: { style: {
    setProperty: (key, value) => css.set(key, value),
    removeProperty: key => css.delete(key),
  } } }
  new Function('require', 'module', 'exports', 'document', compiled)(id => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`)
    return imports[id]
  }, module, module.exports, document)
  const mount = (name, props) => {
    const view = lifecycle.mount(module.exports[name], props)
    views.push(view)
    return view
  }
  t.after(() => views.forEach(view => view.unmount()))
  return {
    state, css, writes, activePack,
    get hydrationCalls() { return hydrationCalls },
    setSaveHandler(handler) { save = handler },
    setHydrateHandler(handler) { hydrate = handler },
    publishLayout,
    mountSection: () => mount('TopTabBarSection', () => ({})),
    mountControls: () => mount('TopTabBarControls', () => ({
      appearance: state.appearance, identity: state.profile.identity,
      fields: activePack().settings.groups.flatMap(group => group.fields),
    })),
    controlsNode: tree => findNode(tree, module.exports.TopTabBarControls),
    switchTheme(theme, opacity = 0.7) {
      state.profile = { identity: { ...theme }, values: {} }
      state.packs.push(themePack(theme))
      state.appearance = { ...state.appearance, theme: { ...theme } }
      publishLayout({ tabOpacity: opacity })
    },
  }
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
const findNode = (tree, type) => nodes(tree).find(node => node.type === type)
function control(tree, type) {
  const node = findNode(tree, type)
  assert.ok(node, `${type} control must be rendered`)
  return node.props
}
const percentage = tree => control(tree, 'output').children.join('')

test('hydration gates controls, reports failures and retries using the full profile identity', async t => {
  const f = fixture(t)
  f.state.hydrated = false
  f.setHydrateHandler(async () => { throw new Error('offline') })
  const section = f.mountSection()
  let tree = section.render()
  assert.equal(f.hydrationCalls, 1)
  assert.equal(f.controlsNode(tree), undefined, 'initial fallback appearance is not editable')
  assert.ok(nodes(tree).some(node => node.props.role === 'status'))
  await flushJobs()
  tree = section.render()
  f.setHydrateHandler(async () => { f.state.hydrated = true })
  control(tree, 'Button').onClick()
  section.render()
  await flushJobs()
  tree = section.render()
  assert.equal(f.hydrationCalls, 2)
  assert.deepEqual(f.controlsNode(tree).props.identity, identity)
  assert.equal(f.controlsNode(tree).props.fields[0].key, 'customTabMode', 'same ID from another source is not selected')
  assert.deepEqual(f.writes, [])
})

test('onValueChange only previews; onValueCommit saves custom schema keys and classic-only controls follow style', async t => {
  const f = fixture(t)
  const view = f.mountControls()
  for (const opacity of [0.65, 0.25, 0]) {
    control(view.render(), 'Slider').onValueChange([opacity])
    await flushJobs()
    const tree = view.render()
    assert.equal(percentage(tree), `${Math.round(opacity * 100)}%`)
    assert.equal(f.css.get(opacityProperty), String(opacity))
    assert.equal(control(tree, 'Slider').disabled, false)
    assert.deepEqual(f.writes, [], 'dragging must never persist')
    assert.equal(f.state.appearance.layout.tabOpacity, 1, 'preview does not mutate the confirmed snapshot')
  }
  assert.deepEqual([...f.css.keys()], [opacityProperty], 'preview changes only the background CSS variable')
  control(view.render(), 'Slider').onValueCommit([0])
  await flushJobs()
  assert.deepEqual(f.writes, [{ theme: identity, values: { stripAlpha: 0 } }])
  control(view.render(), 'Switch').onCheckedChange(true)
  await flushJobs()
  assert.deepEqual(f.writes[1], { theme: identity, values: { hideStrip: true } })
  control(view.render(), 'Segmented').onChange('orb')
  await flushJobs()
  const orb = view.render()
  assert.equal(findNode(orb, 'Slider'), undefined)
  assert.equal(findNode(orb, 'Switch'), undefined)
  assert.equal(control(orb, 'Segmented').value, 'orb')
  assert.deepEqual(f.writes[2], { theme: identity, values: { customTabMode: 'orb' } })
  control(orb, 'Segmented').onChange('classic')
  await flushJobs()
  assert.ok(findNode(view.render(), 'Slider'))
  assert.equal(control(view.render(), 'Switch').checked, true)
})

test('failed opacity commits restore the last confirmed value, including zero, and remain editable', async t => {
  const f = fixture(t)
  f.publishLayout({ tabOpacity: 0 })
  f.setSaveHandler(async () => { throw new Error('write failed') })
  const view = f.mountControls()
  control(view.render(), 'Slider').onValueChange([0.25])
  control(view.render(), 'Slider').onValueCommit([0.25])
  await flushJobs()
  const failed = view.render()
  assert.equal(f.css.get(opacityProperty), '0')
  assert.equal(percentage(failed), '0%')
  assert.equal(control(failed, 'Slider').disabled, false)
  assert.ok(nodes(failed).some(node => node.props.role === 'alert'))
  f.setSaveHandler(async () => {})
  control(failed, 'Slider').onValueCommit([0.5])
  await flushJobs()
  assert.equal(percentage(view.render()), '50%')
  assert.ok(!nodes(view.render()).some(node => node.props.role === 'alert'))
})

test('commits are serialized without disabling the slider or overwriting a newer draft', async t => {
  const f = fixture(t)
  const requests = []
  f.setSaveHandler(() => {
    const request = deferred()
    requests.push(request)
    return request.promise
  })
  const view = f.mountControls()
  control(view.render(), 'Slider').onValueCommit([0.6])
  await flushJobs()
  assert.equal(control(view.render(), 'Slider').disabled, false)
  control(view.render(), 'Slider').onValueChange([0.8])
  control(view.render(), 'Slider').onValueCommit([0.8])
  await flushJobs()
  assert.equal(f.writes.length, 1, 'second commit waits for the first')
  requests[0].resolve()
  await flushJobs()
  assert.equal(f.writes.length, 2)
  assert.equal(percentage(view.render()), '80%', 'older confirmation cannot clear the newer draft')
  assert.equal(f.css.get(opacityProperty), '0.8')
  requests[1].resolve()
  await flushJobs()
  assert.deepEqual(f.writes.map(patch => patch.values), [{ stripAlpha: 0.6 }, { stripAlpha: 0.8 }])
  assert.equal(percentage(view.render()), '80%')
  assert.equal(f.state.appearance.layout.tabOpacity, 0.8)
})

test('missing layout bindings cannot submit hardcoded keys even if disabled handlers are invoked', async t => {
  const f = fixture(t)
  const misleadingFields = schemaFields().map((field, index) => ({
    ...field,
    key: ['tabStyle', 'tabOpacity', 'tabAutoHide'][index],
    binding: { target: 'background', key: ['palette', 'opacity', 'effect'][index] },
  }))
  for (const fields of [[], misleadingFields]) {
    f.activePack().settings.groups = [{ id: 'unrelated', fields }]
    const view = f.mountControls()
    const tree = view.render()
    for (const name of ['Segmented', 'Slider', 'Switch']) assert.equal(control(tree, name).disabled, true, name)
    control(tree, 'Segmented').onChange('orb')
    control(tree, 'Slider').onValueChange([0.4])
    control(tree, 'Slider').onValueCommit([0.4])
    control(tree, 'Switch').onCheckedChange(true)
    await flushJobs()
    assert.deepEqual(f.writes, [], 'there is no fallback to tabStyle/tabOpacity/tabAutoHide keys')
    assert.equal(f.css.get(opacityProperty), '1')
    assert.ok(nodes(tree).some(node => node.type === 'p'), 'unsupported settings have an explanation')
    view.unmount()
  }
})

test('schema refresh remaps real keys, removed bindings do not save, and unavailable themes show a fallback', async t => {
  const f = fixture(t)
  const view = f.mountControls()
  const initial = view.render()
  for (const group of f.activePack().settings.groups) group.fields = group.fields.map(field => ({ ...field, key: `updated_${field.key}` }))
  control(initial, 'Slider').onValueCommit([0.5])
  await flushJobs()
  assert.deepEqual(f.writes, [{ theme: identity, values: { updated_stripAlpha: 0.5 } }])
  const stale = view.render()
  f.activePack().settings.groups = []
  control(stale, 'Slider').onValueCommit([0.3])
  await flushJobs()
  assert.equal(f.writes.length, 1, 'binding removed after render cannot be submitted')
  assert.equal(f.css.get(opacityProperty), '0.5')
  view.unmount()
  const section = f.mountSection()
  f.state.appearance = { ...f.state.appearance, theme: { source: 'unavailable', id: 'missing' } }
  assert.equal(f.controlsNode(section.render()), undefined, 'mismatched profile and appearance are not editable')
  f.state.packs = []
  const fallback = section.render()
  assert.equal(f.controlsNode(fallback), undefined)
  assert.ok(nodes(fallback).some(node => node.props.role === 'status'))
})

test('slider reads schema constraints and discards uncommitted CSS drafts on unmount or theme switch', t => {
  const f = fixture(t)
  const field = f.activePack().settings.groups.flatMap(group => group.fields).find(field => field.binding.key === 'tabOpacity')
  Object.assign(field, { min: 0.1, max: 0.9, step: 0.1 })
  const view = f.mountControls()
  const slider = control(view.render(), 'Slider')
  assert.deepEqual([slider.min, slider.max, slider.step], [0.1, 0.9, 0.1])
  slider.onValueChange([0.4])
  view.unmount()
  assert.equal(f.css.get(opacityProperty), '1', 'unmount restores the confirmed value')
  const section = f.mountSection()
  const previousKey = f.controlsNode(section.render()).key
  const oldView = f.mountControls()
  control(oldView.render(), 'Slider').onValueChange([0.3])
  f.switchTheme({ source: 'new.provider', id: 'custom' }, 0.7)
  assert.notEqual(f.controlsNode(section.render()).key, previousKey, 'source changes must remount controls')
  oldView.unmount()
  assert.equal(f.css.get(opacityProperty), '0.7', 'cleanup uses the new host snapshot, not the previous theme')
  const nextView = f.mountControls()
  assert.equal(percentage(nextView.render()), '70%')
  assert.deepEqual(f.writes, [], 'neither cleanup path persists an uncommitted gesture')
})

test('queued commits for a theme that became inactive are discarded', async t => {
  const f = fixture(t)
  const view = f.mountControls()
  control(view.render(), 'Slider').onValueCommit([0.5])
  f.switchTheme({ source: 'next.provider', id: 'other' }, 0.7)
  view.unmount()
  await flushJobs()
  assert.deepEqual(f.writes, [])
  assert.equal(f.css.get(opacityProperty), '0.7')
  assert.equal(f.state.appearance.layout.tabOpacity, 0.7)
})
