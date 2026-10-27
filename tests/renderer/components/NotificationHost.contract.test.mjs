import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const cardSource = readFileSync(new URL('../../../src/renderer/components/NotificationHost.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(cardSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText

function fixture() {
  const slots = [], pending = [], timers = new Map(), calls = { enter: 0, cancel: 0, sanitized: 0, dismissed: [] }
  let cursor = 0, timerId = 0, now = 0
  const changed = (previous, next) => !previous || previous.length !== next.length || previous.some((value, i) => !Object.is(value, next[i]))
  const memo = (factory, dependencies) => {
    const index = cursor++
    if (!slots[index] || changed(slots[index].dependencies, dependencies)) slots[index] = { dependencies, value: factory() }
    return slots[index].value
  }
  const hooks = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value } },
    useState(value) { const index = cursor++; slots[index] ??= { value }; return [slots[index].value, value => { slots[index].value = value }] },
    useMemo: memo,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useEffect(effect, dependencies) {
      const index = cursor++
      if (!slots[index] || changed(slots[index].dependencies, dependencies)) pending.push(() => {
        slots[index]?.cleanup?.()
        slots[index] = { dependencies, cleanup: effect() }
      })
    }
  }
  const jsx = (type, props, key) => ({ type, props, key })
  const imports = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '@shared/notification': { safeNotificationLink: value => value.startsWith('https://') ? value : undefined },
    '@renderer/services/notifyService': { notifyStore() {} },
    '@renderer/services/notificationContent': { sanitizeNotificationHtml() { calls.sanitized++; return '<p>Safe body</p>' } },
    '@renderer/gsap/marketMotion': { notifyIn() { calls.enter++ }, notifyOut: async () => {}, cancelNotifyMotion() { calls.cancel++ } },
    './MarkdownView': { MarkdownView() {} },
    '@renderer/styles/notification.css': {}
  }
  const document = { hidden: false, documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} }
  const window = {
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'document', 'window', 'performance', compiled)(name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`)
    return imports[name]
  }, module, module.exports, document, window, { now: () => now })
  const dismiss = id => calls.dismissed.push(id)
  const render = item => {
    cursor = 0
    const tree = module.exports.NotificationCard({ item, onDismiss: dismiss })
    tree.props.ref.current ??= {}
    while (pending.length) pending.shift()()
    return tree
  }
  return { calls, document, timers, render, advance: value => { now += value } }
}

function descendants(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...[node.props?.children].flat().flatMap(descendants)]
}

test('theme and mode refreshes retain a notification card clock, sanitizer result and enter animation', async () => {
  const f = fixture()
  const item = { id: 42, title: 'Saved', source: 'Host-owned plugin name', body: '<p>Safe body</p>', format: 'html', position: 'bottom-right', level: 'success', duration: 5000 }
  const first = f.render(item)
  const initialTimer = [...f.timers.entries()][0]
  f.advance(1200)
  for (const mode of ['dark', 'light']) {
    for (const layout of ['card', 'compact', 'banner']) {
      f.document.documentElement.dataset.theme = mode
      f.document.documentElement.dataset.notificationLayout = layout
      const refreshed = f.render({ ...item })
      assert.equal(refreshed.props.ref, first.props.ref)
      assert.deepEqual([...f.timers.keys()], [initialTimer[0]], 'appearance does not restart the timer')
    }
  }
  assert.equal(f.calls.enter, 1)
  assert.equal(f.calls.cancel, 0)
  assert.equal(f.calls.sanitized, 1)
  first.props.onMouseEnter()
  f.render(item)
  assert.equal(f.timers.size, 0)
  f.advance(1000)
  first.props.onMouseLeave()
  const resumed = f.render(item)
  assert.equal([...f.timers.values()][0].delay, 3800, 'hover resumes the remaining clock after a theme change')
  const nodes = descendants(resumed)
  assert.equal(nodes.find(node => node.props?.className === 'notify-source').props.children, item.source)
  assert.equal(nodes.find(node => node.props?.className === 'notify-rich').props.dangerouslySetInnerHTML.__html, '<p>Safe body</p>')
  const close = nodes.find(node => node.props?.className === 'notify-close')
  assert.equal(close.type, 'button')
  assert.equal(close.props['aria-label'], '关闭通知')
  close.props.onClick()
  await Promise.resolve()
  assert.deepEqual(f.calls.dismissed, [42])
})

test('theme styling consumes all standard notification fields without hiding host identity or controls', () => {
  const css = readFileSync(new URL('../../../src/renderer/styles/notification.css', import.meta.url), 'utf8')
  const overlayCss = readFileSync(new URL('../../../src/renderer/notification-overlay.css', import.meta.url), 'utf8')
  for (const property of ['radius', 'border-width', 'density']) assert.ok(css.includes(`var(--appearance-notification-${property}`))
  for (const selector of ["data-notification-layout='compact'", "data-notification-layout='banner'", "data-notification-accent='icon'", "data-notification-accent='none'", "data-notification-shadow='none'", "data-notification-shadow='raised'"]) assert.ok(css.includes(selector), selector)
  assert.match(css, /box-shadow: var\(--notify-shadow-soft\)/)
  assert.doesNotMatch(overlayCss, /box-shadow:/, 'native overlays must not mask theme-owned shadows')
  assert.doesNotMatch(css, /\.(?:notify-close|notify-source)\s*\{[^}]*display:\s*none/)
  assert.match(cardSource, /sanitizeNotificationHtml\(item\.body\)/)
  assert.match(cardSource, /safeNotificationLink\(anchor\.getAttribute/)
  assert.match(cardSource, /NotificationCard key=\{item\.id\}/)
  const overlay = readFileSync(new URL('../../../src/renderer/notification-overlay.tsx', import.meta.url), 'utf8')
  assert.match(overlay, /applyAppearanceToDom\(next\.appearance\)/)
  assert.match(overlay, /NotificationCard key=\{item\.id\}/)
  assert.doesNotMatch(overlay, /key=\{[^}]*appearance/)
})
