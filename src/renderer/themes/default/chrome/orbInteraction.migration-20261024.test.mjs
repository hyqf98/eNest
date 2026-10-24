import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const compiled = new Map()
function sourceModule(file) {
  if (!compiled.has(file)) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      .replaceAll('import.meta.hot', 'window.__hot')
    compiled.set(file, ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText)
  }
  return compiled.get(file)
}

class SurfaceEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, bubbles: false, cancelable: true, defaultPrevented: false,
      propagationStopped: false, immediateStopped: false, target: null }, options)
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() { this.propagationStopped = true }
  stopImmediatePropagation() { this.immediateStopped = true; this.stopPropagation() }
}

class SurfaceTarget {
  listeners = new Map()
  addEventListener(type, callback, options = {}) {
    if (!callback || options.signal?.aborted) return
    const entries = this.listeners.get(type) ?? []
    if (entries.some(entry => entry.callback === callback)) return
    entries.push({ callback, once: options.once === true })
    this.listeners.set(type, entries)
    options.signal?.addEventListener('abort', () => this.removeEventListener(type, callback), { once: true })
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry.callback !== callback))
  }
  dispatchEvent(event) {
    event.target ??= this
    let current = this
    while (current) {
      event.currentTarget = current
      for (const entry of [...(current.listeners.get(event.type) ?? [])]) {
        if (entry.once) current.removeEventListener(event.type, entry.callback)
        entry.callback.call(current, event)
        if (event.immediateStopped) break
      }
      if (!event.immediateStopped) current[`on${event.type}`]?.call(current, event)
      if (!event.bubbles || event.propagationStopped) break
      current = current.parentNode
    }
    event.currentTarget = null
    return !event.defaultPrevented
  }
  emit(type, options = {}) { return this.dispatchEvent(new SurfaceEvent(type, options)) }
  listenerCount(type) { return (this.listeners.get(type) ?? []).length + (typeof this[`on${type}`] === 'function' ? 1 : 0) }
}

const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())

class SurfaceElement extends SurfaceTarget {
  constructor(document, tagName = 'div') {
    super()
    this.ownerDocument = document
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = new Map()
    this.style = { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } }
    this.className = ''
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ') },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' ') },
      toggle: (name, force) => {
        const next = force ?? !this.classList.contains(name)
        if (next) this.classList.add(name)
        else this.classList.remove(name)
        return next
      },
    }
  }
  get id() { return this.getAttribute('id') ?? '' }
  set id(value) { this.setAttribute('id', value) }
  get parentElement() { return this.parentNode instanceof SurfaceElement ? this.parentNode : null }
  get inert() { return this.attributes.has('inert') }
  set inert(value) { this.toggleAttribute('inert', Boolean(value)) }
  get src() { return this.getAttribute('src') ?? '' }
  set src(value) { this.setAttribute('src', value) }
  getAttribute(name) {
    if (name === 'class') return this.className
    if (name.startsWith('data-')) return this.dataset[dataKey(name)] ?? null
    return this.attributes.get(name) ?? null
  }
  hasAttribute(name) { return this.getAttribute(name) !== null }
  setAttribute(name, value) {
    if (name === 'class') this.className = String(value)
    else if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value)
    else this.attributes.set(name, String(value))
    if (name === 'inert') this.ownerDocument.inertWrites.push({ element: this, activeElement: this.ownerDocument.activeElement })
  }
  removeAttribute(name) {
    if (name.startsWith('data-')) delete this.dataset[dataKey(name)]
    else this.attributes.delete(name)
  }
  toggleAttribute(name, force = this.getAttribute(name) === null) {
    if (force) this.setAttribute(name, '')
    else this.removeAttribute(name)
    return force
  }
  appendChild(child) { return this.insertBefore(child, null) }
  insertBefore(child, reference) {
    child.remove()
    const index = reference === null ? this.children.length : this.children.indexOf(reference)
    assert.notEqual(index, -1, 'DOM insertion reference must belong to its parent')
    this.children.splice(index, 0, child)
    child.parentNode = this
    return child
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1)
    this.parentNode = null
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); children.forEach(child => this.appendChild(child)) }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false }
  matches(selector) {
    return selector.split(',').some(part => {
      const simple = part.trim()
      if (simple.startsWith('#')) return this.id === simple.slice(1)
      if (simple.startsWith('.')) return simple.slice(1).split('.').every(name => this.classList.contains(name))
      const attribute = simple.match(/^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/)
      if (attribute) return attribute[2] === undefined ? this.getAttribute(attribute[1]) !== null : this.getAttribute(attribute[1]) === attribute[2]
      return this.tagName.toLowerCase() === simple.toLowerCase()
    })
  }
  closest(selector) { for (let node = this; node instanceof SurfaceElement; node = node.parentNode) if (node.matches(selector)) return node; return null }
  querySelectorAll(selector) {
    const matches = []
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) matches.push(child); visit(child) } }
    visit(this)
    return matches
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  set innerHTML(markup) {
    this.replaceChildren()
    const stack = [this]
    // Parse real renderer markup, rather than manufacturing the nodes its handlers expect.
    for (const token of String(markup).matchAll(/<\/?[a-z][^>]*>/gi)) {
      if (token[0].startsWith('</')) { stack.pop(); continue }
      const tag = token[0].match(/^<([\w-]+)/)[1]
      const child = this.ownerDocument.createElement(tag)
      const attributes = token[0].slice(tag.length + 1, -1).replace(/\/$/, '')
      for (const match of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        child.setAttribute(match[1], match[2] ?? match[3] ?? match[4] ?? '')
      }
      stack.at(-1).appendChild(child)
      if (!/\/>$/.test(token[0]) && !['img', 'input', 'br', 'hr'].includes(tag)) stack.push(child)
    }
  }
  getBoundingClientRect() { return { left: 0, right: 84, top: 300, bottom: 460, width: 84, height: 160 } }
  focus() {
    if (this.closest('[inert]') || this.ownerDocument.activeElement === this) return
    const old = this.ownerDocument.activeElement
    this.ownerDocument.activeElement = this
    old?.emit('blur', { relatedTarget: this })
    old?.emit('focusout', { relatedTarget: this, bubbles: true })
    this.emit('focus', { relatedTarget: old })
    this.emit('focusin', { relatedTarget: old, bubbles: true })
  }
  click(detail = 1) { this.emit('click', { bubbles: true, detail }) }
  decode() { return Promise.resolve() }
}

function fakeClock() {
  let now = 0, next = 0
  const timers = new Map()
  return {
    timers,
    setTimeout(callback, delay = 0) { const id = ++next; timers.set(id, { callback, due: now + Math.max(0, delay) }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        const pending = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
        if (!pending) break
        const [id, timer] = pending
        now = timer.due
        timers.delete(id)
        timer.callback()
      }
      now = end
    },
  }
}

const hostState = (part = 'rail') => ({ view: 'home', tabStyle: part === 'rail' ? 'orb' : 'classic', activeTabId: null,
  animationLevel: 'low', theme: { mode: 'light', tokens: {} }, profile: null,
  tabs: [{ id: 'tab-one', pluginId: 'plugin-one', title: 'One', color: '#123', glyph: '1' }],
  contribEntries: [{ id: 'entry-one', pluginId: 'plugin-one', title: 'Entry', color: '#123', glyph: 'E', openCode: 'new' }],
})

async function fixture(t, part = 'rail') {
  const document = new SurfaceTarget(), window = new SurfaceTarget(), clock = fakeClock()
  let focused = true
  document.hasFocus = () => focused
  document.inertWrites = []
  document.createElement = tag => new SurfaceElement(document, tag)
  document.documentElement = document.createElement('html')
  document.documentElement.parentNode = document
  document.body = document.createElement('body')
  document.documentElement.appendChild(document.body)
  document.activeElement = document.body
  const root = document.createElement('div'), outside = document.createElement('button')
  root.id = 'orb-root'
  document.body.appendChild(root)
  document.body.appendChild(outside)
  document.getElementById = id => document.documentElement.querySelector(`#${id}`)
  const calls = [], subscriptions = new Set(), hotDisposers = [], drag = { bound: 0, disposed: 0 }
  let lastSubscription
  window.location = { search: `?part=${part}&anim=low&theme=light` }
  window.matchMedia = () => ({ matches: false })
  window.setTimeout = clock.setTimeout
  window.clearTimeout = clock.clearTimeout
  window.__hot = { dispose(callback) { hotDisposers.push(callback) } }
  window.enestShell = {
    getOrbState: async () => hostState(part),
    onOrbEvent(callback) { subscriptions.add(callback); lastSubscription = callback; return () => subscriptions.delete(callback) },
    setOrbRailExpanded: async value => { calls.push(['expand', value]) },
    goHome: async () => { calls.push(['home']) },
    setShellView: async view => { calls.push(['view', view]) },
    activatePlugin: async id => { calls.push(['activate', id]) },
    closePlugin: async id => { calls.push(['close', id]) },
    openPlugin: async id => { calls.push(['open', id]) },
  }
  const environment = { window, document, URLSearchParams, Element: SurfaceElement, HTMLElement: SurfaceElement,
    HTMLButtonElement: SurfaceElement, Node: SurfaceElement, Event: SurfaceEvent, FocusEvent: SurfaceEvent,
    MouseEvent: SurfaceEvent, KeyboardEvent: SurfaceEvent, AbortController,
    Image: class extends SurfaceElement { constructor() { super(document, 'img') } },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, queueMicrotask,
  }
  const load = (file, imports = {}) => {
    const module = { exports: {} }
    vm.runInNewContext(sourceModule(file), { ...environment, module, exports: module.exports, require(id) {
      if (id.endsWith('.css')) return {}
      if (id in imports) return imports[id]
      throw new Error(`Unexpected orb dependency ${id}`)
    } }, { filename: file })
    return module.exports
  }
  const api = load('./api.ts')
  load('./orb.ts', {
    './api': api,
    '@renderer/icons.paths': { LUCIDE_PATHS: { user: '', house: '', x: '' }, lucideSvgMarkup: () => '<svg></svg>' },
    '@renderer/gsap/marketMotion': { applyLevelToDefaults() {} },
    '@renderer/services/appearanceDom': { applyAppearanceToDom() {} },
    '@renderer/services/pluginWindowDrag': {
      bindPluginDragSource() { drag.bound++; return () => { drag.disposed++ } },
      bindPluginDropTarget() { drag.bound++; return { refresh() {}, dispose() { drag.disposed++ } } },
    },
  })
  t.after(() => window.emit('pagehide'))
  await new Promise(setImmediate)
  return { document, window, root, outside, clock, calls, subscriptions, drag,
    handle: document.getElementById('orb-handle'), panel: document.getElementById('orb-panel'),
    emitStaleSnapshot: state => lastSubscription({ type: 'orb-state', state }),
    hotDispose: () => hotDisposers.forEach(dispose => dispose()),
    blur: () => { focused = false; window.emit('blur') },
  }
}

function assertExpanded(f, expanded) {
  assert.equal(f.root.classList.contains('expanded'), expanded)
  assert.equal(f.panel.inert, !expanded, 'hidden navigation must leave the focus/interaction tree')
  assert.equal(f.panel.getAttribute('aria-hidden'), String(!expanded))
  assert.equal(f.handle.getAttribute('aria-expanded'), String(expanded))
}

test('collapsed rail is inert and every handle click expands through the real default adapter', async t => {
  for (const detail of [1, 0]) {
    const f = await fixture(t)
    assertExpanded(f, false)
    f.handle.click(detail)
    assertExpanded(f, true)
    assert.deepEqual(f.calls, [['expand', true]], detail === 0 ? 'native keyboard-generated clicks have detail zero' : 'pointer activation')
    if (detail === 0) assert.equal(f.document.activeElement, f.panel.querySelector('.orb-face'), 'keyboard/AX activation must not leave focus on the faded handle')
  }
})

test('Enter and Space default button clicks do not require a mousemove', async t => {
  for (const key of ['Enter', ' ']) {
    const f = await fixture(t)
    f.handle.focus()
    const down = new SurfaceEvent('keydown', { key, bubbles: true })
    const up = new SurfaceEvent('keyup', { key, bubbles: true })
    f.handle.dispatchEvent(down)
    if (key === 'Enter' && !down.defaultPrevented) f.handle.click(0)
    f.handle.dispatchEvent(up)
    if (key === ' ' && !down.defaultPrevented && !up.defaultPrevented) f.handle.click(0)
    // Model only browser button activation; this is not native keyboard/geometry acceptance.
    assertExpanded(f, true)
    assert.equal(f.document.activeElement, f.panel.querySelector('.orb-face'))
    assert.deepEqual(f.calls, [['expand', true]], `${JSON.stringify(key)} must not double-dispatch expansion`)
  }
})

test('panel focus survives pointer exit and leaving the rail starts the 260ms collapse delay', async t => {
  const f = await fixture(t)
  f.handle.click()
  const home = f.panel.querySelector('[data-home]'), tab = f.panel.querySelector('[data-activate]')
  home.focus()
  tab.focus()
  f.document.documentElement.emit('mousemove', { clientY: 10 })
  f.document.documentElement.emit('mouseleave')
  f.clock.advance(1000)
  assertExpanded(f, true)
  assert.equal(f.document.activeElement, tab)
  assert.deepEqual(f.calls, [['expand', true]])
  f.outside.focus()
  f.clock.advance(259)
  assertExpanded(f, true)
  f.clock.advance(1)
  assertExpanded(f, false)
  assert.equal(f.document.activeElement, f.outside, 'focusout must not steal focus back from its real destination')
  f.clock.advance(180)
  assert.deepEqual(f.calls, [['expand', true], ['expand', false]])
})

test('window blur permits collapse even when the unfocused document retains panel activeElement', async t => {
  const f = await fixture(t)
  f.handle.click(0)
  assert.ok(f.panel.contains(f.document.activeElement))
  const focusedNavigation = f.document.activeElement
  f.blur()
  f.clock.advance(259)
  assertExpanded(f, true)
  f.clock.advance(1)
  assertExpanded(f, false)
  assert.equal(f.document.activeElement, focusedNavigation, 'an unfocused native document must not steal focus back to its handle')
  f.clock.advance(180)
  assert.deepEqual(f.calls, [['expand', true], ['expand', false]])
})

test('hover entry still expands and pointer exit keeps both collapse and native-width delays', async t => {
  const f = await fixture(t)
  assertExpanded(f, false)
  f.document.documentElement.emit('mousemove', { clientY: 350 })
  assertExpanded(f, true)
  assert.deepEqual(f.calls, [['expand', true]])
  f.document.documentElement.emit('mouseleave')
  f.clock.advance(259)
  assertExpanded(f, true)
  f.clock.advance(1)
  assertExpanded(f, false)
  assert.deepEqual(f.calls, [['expand', true]], 'the native view stays wide until its collapse animation completes')
  f.clock.advance(179)
  assert.deepEqual(f.calls, [['expand', true]])
  f.clock.advance(1)
  assert.deepEqual(f.calls, [['expand', true], ['expand', false]])
})

test('navigation collapse returns panel focus to the handle before making the panel inert', async t => {
  const f = await fixture(t)
  f.handle.click()
  const tab = f.panel.querySelector('[data-activate]')
  tab.focus()
  f.document.inertWrites.length = 0
  tab.click(0)
  assertExpanded(f, false)
  assert.equal(f.document.activeElement, f.handle)
  const hidden = f.document.inertWrites.filter(write => write.element === f.panel)
  assert.ok(hidden.length > 0, 'collapse must apply inert, not only an opacity class')
  assert.ok(hidden.every(write => !f.panel.contains(write.activeElement)), 'panel must lose focus before inert is set')
  assert.deepEqual(f.calls, [['expand', true], ['activate', 'tab-one']])
  f.clock.advance(180)
  assert.deepEqual(f.calls.at(-1), ['expand', false])
})

test('artificial clicks on hidden panel actions cannot navigate, close or launch plugins', async t => {
  const f = await fixture(t)
  for (const selector of ['[data-home]', '[data-activate]', '[data-close]', '[data-contrib]', '[data-settings]']) {
    const button = f.panel.querySelector(selector)
    assert.ok(button, selector)
    // dispatchEvent deliberately bypasses the browser's native inert hit-test protection.
    button.emit('click', { bubbles: true, detail: 0 })
  }
  assertExpanded(f, false)
  assert.deepEqual(f.calls, [])
  assert.equal(f.panel.querySelectorAll('[data-activate]').length, 1, 'hidden close must not mutate local tab state either')
})

test('pagehide and HMR dispose remove pending timers, subscriptions and live interaction handlers', async t => {
  for (const kind of ['pagehide', 'hmr']) {
    const f = await fixture(t)
    f.handle.click()
    const oldHome = f.panel.querySelector('[data-home]')
    if (kind === 'pagehide') f.document.documentElement.emit('mouseleave')
    else { oldHome.focus(); oldHome.click() }
    assert.ok(f.clock.timers.size > 0, `${kind} fixture must own a pending close or native-width timer`)
    const before = f.calls.slice()
    if (kind === 'pagehide') f.window.emit('pagehide')
    else f.hotDispose()
    assert.equal(f.clock.timers.size, 0)
    assert.equal(f.subscriptions.size, 0)
    assert.equal(f.drag.disposed, f.drag.bound)
    assert.equal(f.window.listenerCount('blur'), 0)
    assert.equal(f.window.listenerCount('pagehide'), 0)
    for (const node of [f.root, f.document.documentElement]) {
      for (const event of ['click', 'mousemove', 'mouseleave', 'focusin', 'focusout']) {
        assert.equal(node.listenerCount(event), 0, `${kind}: stale ${event} listener`)
      }
    }
    f.handle.click()
    oldHome.emit('click', { bubbles: true })
    f.document.documentElement.emit('mousemove', { clientY: 350 })
    f.document.documentElement.emit('mouseleave')
    f.emitStaleSnapshot({ ...hostState(), tabs: [] })
    f.clock.advance(2000)
    assert.deepEqual(f.calls, before, `${kind}: retired DOM and delayed callbacks must not dispatch`)
    assert.equal(f.clock.timers.size, 0)
    f.window.emit('pagehide')
    f.hotDispose()
    assert.equal(f.drag.disposed, f.drag.bound, 'repeated teardown must remain idempotent')
  }
})

test('classic dock keeps settings navigation without rail expansion or hover handlers', async t => {
  const f = await fixture(t, 'dock')
  assert.equal(f.handle, null)
  assert.equal(f.panel, null)
  const settings = f.root.querySelector('[data-settings]')
  assert.ok(settings)
  settings.click()
  assert.deepEqual(f.calls, [['view', 'settings']])
  f.document.documentElement.emit('mousemove', { clientY: 350 })
  f.document.documentElement.emit('mouseleave')
  f.clock.advance(2000)
  assert.deepEqual(f.calls, [['view', 'settings']])
  assert.equal(f.drag.bound, 0)
  f.window.emit('pagehide')
  settings.click()
  assert.deepEqual(f.calls, [['view', 'settings']], 'retired dock handlers must also detach')
  assert.equal(f.subscriptions.size, 0)
})
