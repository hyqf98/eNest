import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, new URL("../../../src/renderer/layout/", import.meta.url)), 'utf8')
function compile(source) {
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    reportDiagnostics: true,
  })
  assert.deepEqual((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
    .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])
  return new Function('require', 'module', 'exports', 'window', result.outputText)
}
function load(compiled, imports = {}, window) {
  const module = { exports: {} }
  compiled(id => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`)
    return imports[id]
  }, module, module.exports, window)
  return module.exports
}
const source = read('./TitleBar.tsx')
const ast = ts.createSourceFile('TitleBar.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
const component = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'TitleBar')
assert.ok(component?.body)
const names = binding => ts.isIdentifier(binding) ? [binding.text] : binding.elements.flatMap(e => ts.isBindingElement(e) ? names(e.name) : [])
const bindings = ['headerRef', 'level', 'reducedMotion', 'callbacks', 'shown', 'motion', 'motionContext']
const statements = component.body.statements.filter(s =>
  (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => names(d.name).some(name => bindings.includes(name)))) ||
  (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(ast) === 'useLayoutEffect') ||
  (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.left.getText(ast) === 'callbacks.current'))
assert.equal(statements.length, bindings.length + 3, 'extract both real motion effects and current callbacks')
// Only hook plumbing is replaced. No JSX, hover timers or native runtime is evaluated.
const renderMotion = compile([
  ...ast.statements.filter(s => ts.isImportDeclaration(s) && ['react', 'gsap', '@renderer/hooks/useAnimationLevel', '@renderer/gsap/marketMotion'].includes(s.moduleSpecifier.text)).map(s => s.getText(ast)),
  'export function render({ autoHide = false, revealed = false, onReveal, onCollapse, onMotionStart, onMotionComplete } = {}) {',
  ...statements.map(s => s.getText(ast)),
  'return { headerRef, motionContext }',
  '}',
].join('\n'))
const mathModule = compile(read('../gsap/marketMotion.ts'))
const tokens = load(compile(read('../gsap/motionTokens.ts')))
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

function fixture(t, options = {}) {
  const state = { level: 'medium', reducedMotion: false, ...options }
  const node = { opacity: 0.75, y: 3 }, completed = [], events = [], tweens = [], mathCalls = []
  const props = { autoHide: true, revealed: false, onMotionStart: () => events.push('start'), onMotionComplete: shown => completed.push(shown) }
  const slots = []
  let index, pending, refs, unmounted = false, renders = 0
  const hooks = {
    useRef(value) { return slots[index++] ??= { current: value } },
    useLayoutEffect(effect, deps) {
      const slot = index++
      if (!equalDeps(slots[slot]?.deps, deps)) pending.push({ slot, effect, deps })
    },
  }
  let context
  // fromTo is intentionally absent, so any reset-from-state regression throws.
  const gsap = {
    defaults() {},
    context(run, scope) {
      assert.equal(scope, node)
      const initial = { ...node }
      context = { reverted: false, add: fn => fn(), revert() {
        events.push('revert'); context.reverted = true; Object.assign(node, initial)
      } }
      run(); return context
    },
    set(target, vars) { events.push('set'); Object.assign(target, vars) },
    to(target, vars) {
      assert.equal(target, node)
      const tween = { vars, start: { ...target }, killed: false, done: false,
        kill() { tween.killed = true; events.push('kill') },
        complete() {
          if (tween.killed || tween.done) return
          tween.done = true
          Object.assign(target, { opacity: vars.opacity, y: vars.y })
          vars.onComplete?.()
        },
      }
      events.push('to'); tweens.push(tween)
      if (vars.duration === 0) tween.complete()
      return tween
    },
  }
  const math = load(mathModule, { gsap, '@renderer/gsap/motionTokens': tokens }, { matchMedia: () => ({ matches: state.reducedMotion }) })
  const { render } = load(renderMotion, {
    react: hooks, gsap,
    '@renderer/hooks/useAnimationLevel': { useAnimationLevel: () => ({ level: state.level }), useReducedMotion: () => state.reducedMotion },
    '@renderer/gsap/marketMotion': Object.fromEntries(['d', 'dy', 'ease'].map(name => [name, value => {
      mathCalls.push([name, value]); return math[name](value)
    }])),
  })
  const unmount = () => {
    if (unmounted) return
    unmounted = true; slots.forEach(slot => slot.cleanup?.())
  }
  t.after(unmount)
  return {
    node, state, props, events, tweens, completed, mathCalls, unmount,
    get latest() { return tweens.at(-1) },
    get context() { return context },
    get refs() { return refs },
    render() {
      assert.equal(unmounted, false)
      assert.ok(++renders <= 12, 'fixture render limit')
      math.applyLevelToDefaults(state.level)
      index = 0; pending = []
      refs = render(props)
      refs.headerRef.current = node
      pending.forEach(({ slot }) => slots[slot]?.cleanup?.())
      pending.forEach(({ slot, effect, deps }) => { slots[slot] = { deps, cleanup: effect() } })
    },
  }
}
const target = tween => [tween.vars.opacity, tween.vars.y, tween.vars.duration, tween.vars.ease]

test('medium uses real d/dy/ease for opacity/y targets and reports false/true completion', t => {
  const f = fixture(t)
  f.render()
  assert.deepEqual(f.latest.start, { opacity: 0, y: -12 })
  assert.deepEqual(target(f.latest), [0, -12, 0.28, 'power2.inOut'])
  assert.equal(f.latest.vars.overwrite, true)
  assert.deepEqual(f.completed, [])
  f.latest.complete()
  assert.deepEqual(f.completed, [false])
  f.mathCalls.length = 0
  f.props.revealed = true; f.render()
  assert.deepEqual(target(f.latest), [1, 0, 0.28, 'expo.out'])
  assert.deepEqual(f.mathCalls, [['d', 0.23], ['ease', 'power3.out']])
  f.latest.complete()
  f.mathCalls.length = 0
  f.props.revealed = false; f.render()
  assert.deepEqual(f.mathCalls, [['dy', 12], ['d', 0.18], ['ease', 'power2.inOut']])
  f.latest.complete()
  assert.deepEqual(f.completed, [false, true, false])
})

test('retarget kills before onMotionStart/to, starts at current values and does not revert or set again', t => {
  const f = fixture(t)
  f.props.revealed = true; f.render()
  const entering = f.latest
  Object.assign(f.node, { opacity: 0.6, y: -4 })
  const before = f.events.length
  f.props.revealed = false; f.render()
  const exiting = f.latest, retarget = f.events.slice(before)
  assert.equal(entering.killed, true)
  assert.equal(retarget[0], 'kill')
  assert.ok(retarget.indexOf('kill') < retarget.indexOf('start'))
  assert.ok(retarget.indexOf('start') < retarget.indexOf('to'))
  assert.deepEqual(exiting.start, { opacity: 0.6, y: -4 })
  Object.assign(f.node, { opacity: 0.3, y: -8 })
  f.props.revealed = true; f.render()
  assert.equal(exiting.killed, true)
  assert.deepEqual(f.latest.start, { opacity: 0.3, y: -8 })
  assert.equal(f.events.filter(e => e === 'set').length, 1)
  assert.equal(f.context.reverted, false)
  entering.complete(); exiting.complete()
  assert.deepEqual(f.completed, [])
  f.latest.complete()
  assert.deepEqual(f.completed, [true])
})

test('callback-only rerender uses the current callback without killing or restarting motion', t => {
  const f = fixture(t), received = []
  f.props.revealed = true; f.render()
  f.props.onMotionComplete = shown => received.push(shown)
  f.props.onMotionStart = () => assert.fail('callback-only rerender must not restart motion')
  f.render()
  assert.equal(f.tweens.length, 1)
  assert.equal(f.latest.killed, false)
  f.latest.complete()
  assert.deepEqual(received, [true])
  assert.deepEqual(f.completed, [])
})

test('unmount kills pending tween, reverts context and cannot report a completed exit', t => {
  const f = fixture(t)
  f.render()
  const before = f.events.length
  f.unmount(); f.latest.complete()
  assert.equal(f.events[before], 'kill')
  assert.ok(f.events.slice(before).includes('revert'))
  assert.equal(f.context.reverted, true)
  assert.equal(f.refs.motionContext.current, undefined)
  assert.deepEqual(f.node, { opacity: 0.75, y: 3 })
  assert.deepEqual(f.completed, [])
})

test('high and live level changes retarget using real motion tokens', t => {
  const f = fixture(t)
  f.props.revealed = true; f.render()
  const previous = f.latest
  f.state.level = 'high'; f.render()
  assert.equal(previous.killed, true)
  assert.deepEqual(target(f.latest), [1, 0, 0.23 * 1.15, 'power3.out'])
  f.props.revealed = false; f.render()
  assert.deepEqual(target(f.latest), [0, -(12 * 1.1), 0.22, 'power2.inOut'])
})

for (const [level, reducedMotion] of [['low', false], ['low', true], ['medium', true], ['high', true]]) {
  test(`${level}, reduced=${reducedMotion}: zero displacement/duration and synchronous completion both ways`, t => {
    const f = fixture(t, { level, reducedMotion })
    f.render()
    assert.deepEqual(f.latest.start, { opacity: 0, y: 0 })
    assert.deepEqual(target(f.latest).slice(0, 3), [0, 0, 0])
    assert.deepEqual(f.completed, [false])
    f.props.revealed = true; f.render()
    assert.deepEqual(target(f.latest).slice(0, 3), [1, 0, 0])
    assert.deepEqual(f.completed, [false, true])
  })
}

test('enabling reduced motion kills an active tween and completes without transitionend', t => {
  const f = fixture(t)
  f.render()
  const previous = f.latest
  f.state.reducedMotion = true; f.render()
  assert.equal(previous.killed, true)
  assert.deepEqual(target(f.latest).slice(0, 3), [0, 0, 0])
  assert.deepEqual(f.completed, [false])
})

test('disabled auto-hide remains shown even when revealed is false', t => {
  const f = fixture(t)
  f.props.autoHide = false; f.render()
  assert.deepEqual(f.latest.start, { opacity: 1, y: 0 })
  assert.deepEqual(target(f.latest).slice(0, 2), [1, 0])
  f.latest.complete()
  assert.deepEqual(f.completed, [true])
})

test('native handoff keeps 8/36, readiness gating and hidden-completion guards (static contract)', () => {
  const shellSource = read('./ShellLayout.tsx')
  const shell = ts.createSourceFile('ShellLayout.tsx', shellSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const fn = shell.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'ShellLayout')
  const binding = name => fn.body.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => names(d.name).includes(name)))?.getText(shell)
  const sync = binding('syncTitlebarHeight')
  assert.ok(sync)
  assert.match(read('../../shared/constants.ts'), /TITLEBAR_HEIGHT\s*=\s*36/)
  assert.match(read('../../shared/constants.ts'), /TITLEBAR_REVEAL_HEIGHT\s*=\s*8/)
  assert.match(sync, /version\s*!==\s*layoutVersion\.current/)
  assert.match(sync, /await shellApi\.setPluginTopInset\?\.\(TITLEBAR_HEIGHT - height\)/)
  assert.ok(sync.indexOf('await shellApi') < sync.indexOf('setTitlebarHeight(height)'))
  assert.match(sync, /setNativeTitlebarReady\(height === TITLEBAR_HEIGHT\)/)
  assert.match(binding('revealed'), /titleBarRevealed && nativeTitlebarReady/)
  assert.match(binding('revealTitlebar'), /layoutVersion\.current\+\+/)
  assert.match(binding('onTitlebarMotionStart'), /layoutVersion\.current\+\+; motionHidden\.current = false/)
  assert.match(binding('onTitlebarMotionComplete'), /motionHidden\.current = !shown/)
  assert.match(binding('onTitlebarMotionComplete'), /!shown && requested\.current\.autoHide && !requested\.current\.revealed/)
  assert.match(shellSource, /if \(!autoHide \|\| titleBarRevealed\) syncTitlebarHeight\(TITLEBAR_HEIGHT\)/)
  assert.match(shellSource, /else if \(motionHidden\.current\) syncTitlebarHeight\(TITLEBAR_REVEAL_HEIGHT\)/)
})
