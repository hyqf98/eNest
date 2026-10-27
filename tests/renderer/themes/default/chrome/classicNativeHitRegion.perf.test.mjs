import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import postcss from 'postcss'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')

function render({ ready = false, tabStyle = 'classic', autoHide = false, revealed = false } = {}) {
  const module = { exports: {} }
  const imports = {
    react: { useEffect() {}, useLayoutEffect() {}, useRef: current => ({ current }), useState: () => [ready, () => {}] },
    gsap: {}, '@renderer/themes/default/chrome/TabStrip': { TabStrip() {} }, '@renderer/services/shellApi': { shellApi: {} },
    '@renderer/hooks/useAnimationLevel': { useAnimationLevel: () => ({ level: 'low' }), useReducedMotion: () => false },
    '@renderer/hooks/useAppearance': { useAppearanceStore: select => select({ appearance: { layout: { tabStyle } } }) },
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
  return module.exports.TitleBar({ autoHide, revealed })
}

function children(tree) { return tree.props.children.filter(Boolean) }
function hitRegion(tree) { return children(tree).find(child => child.props.className === 'titlebar-custom-chrome-hit-region') }

test('only an acknowledged classic surface gets a live no-drag region outside hidden fallback and animated header', () => {
  assert.equal(hitRegion(render()), undefined)
  assert.equal(hitRegion(render({ ready: true, tabStyle: 'orb' })), undefined)
  for (const autoHide of [false, true]) for (const revealed of [false, true]) {
    const tree = render({ ready: true, autoHide, revealed }), hit = hitRegion(tree)
    assert.ok(hit)
    assert.equal(hit.type, 'div')
    assert.equal(hit.props['aria-hidden'], 'true')
    assert.equal(hit.props.hidden, undefined)
    assert.equal(hit.props.inert, undefined)
    assert.equal(hit.props.tabIndex, undefined)
    const header = children(tree)[0], [traffic, tabs] = header.props.children
    assert.equal(header.type, 'header')
    assert.equal(traffic.props.className, 'traffic')
    assert.equal(traffic.props.children.length, 3, 'window controls remain untouched')
    assert.match(tabs.props.className, /is-replaced/)
    assert.ok(children(tree).includes(hit), 'native hit region must be a sibling, not a hidden or transformed header descendant')
    if (autoHide) assert.equal(children(tree)[1].props.className, 'titlebar-hotzone', 'preserve the existing header + hotzone adjacent-selector contract')
  }
})

test('transparent hit geometry matches native classic bounds without removing traffic or trailing move regions', () => {
  const css = postcss.parse(read('src/renderer/styles/app.css'))
  let rule, titlebar
  css.walkRules(current => {
    if (current.selector === '.titlebar-custom-chrome-hit-region') rule = current
    if (current.selector === '.titlebar' && current.nodes.some(node => node.prop === '-webkit-app-region')) titlebar = current
  })
  assert.ok(rule && titlebar)
  const props = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
  assert.equal(props.position, 'absolute')
  assert.equal(props.top, '0')
  assert.equal(props.height, 'var(--titlebar-h)')
  assert.equal(props.background, 'transparent')
  assert.equal(props['pointer-events'], 'none', 'the native surface owns input; no privileged shell click forwarding')
  assert.equal(props['-webkit-app-region'], 'no-drag')
  assert.equal(props.visibility, undefined, 'hidden regions would be removed from the native drag exclusion')
  assert.equal(props.opacity, undefined)
  const native = read('src/main/window/orbRailViews.ts').match(/classicView\.setBounds\(\{ x:\s*(\d+), y:\s*0, width:\s*Math\.max\(1, bounds\.width\s*-\s*(\d+)\), height:\s*TITLEBAR_HEIGHT/)
  assert.ok(native, 'update the exclusion geometry when the host native bounds contract changes')
  assert.equal(Number.parseInt(props.left), Number(native[1]))
  assert.equal(Number.parseInt(props.right), Number(native[2]) - Number(native[1]))
  assert.equal(titlebar.nodes.find(node => node.prop === '-webkit-app-region').value, 'drag')
})

test('fallback restoration removes the extra exclusion and never adds a high-privilege input bridge', () => {
  assert.ok(hitRegion(render({ ready: true })))
  assert.equal(hitRegion(render({ ready: false })), undefined)
  const source = read('src/renderer/layout/TitleBar.tsx')
  assert.doesNotMatch(source, /sendInputEvent|executeJavaScript|dispatchMouse|enestChrome\.dispatch/)
})
