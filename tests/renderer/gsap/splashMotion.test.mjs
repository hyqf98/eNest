import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const { gsap } = createRequire(import.meta.url)('gsap')
const source = ts.transpileModule(readFileSync(new URL('../../../src/renderer/themes/default/motion/splashMotion.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function fixture(t, { ready, level = 'medium', hidden = false } = {}) {
  const document = new EventTarget()
  document.hidden = hidden
  const listeners = new Set()
  const add = document.addEventListener.bind(document)
  const remove = document.removeEventListener.bind(document)
  document.addEventListener = (type, listener) => { listeners.add(listener); add(type, listener) }
  document.removeEventListener = (type, listener) => { listeners.delete(listener); remove(type, listener) }
  const mark = {}
  const root = { autoAlpha: 1, querySelector: () => mark, querySelectorAll: () => [] }
  const wordChars = Array.from({ length: 5 }, () => ({ autoAlpha: 1, y: 0 }))
  const sub = { autoAlpha: 1, y: 0 }
  const rendered = []
  const timelines = []
  let completed = 0
  let disposed = 0
  const imports = {
    gsap: { default: { ...gsap, timeline(options) {
      const timeline = gsap.timeline(options)
      timelines.push(timeline)
      return timeline
    } } },
    '@renderer/gsap/marketMotion': { d: value => value, dy: value => value, ease: value => value },
    '@renderer/themes/default/motion/logoAssembly': { createLogoAssembly: () => ({
      render: (age, reduced) => rendered.push({ age, reduced }), dispose: () => disposed++,
    }) },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'document', source)(id => imports[id], module, module.exports, document)
  const playback = module.exports.playSplash({ root, wordChars, sub }, () => completed++, level, 'fold', ready)
  gsap.ticker.sleep()
  t.after(() => { playback(); gsap.ticker.sleep() })
  return {
    playback, root, wordChars, sub, rendered, timelines, listeners,
    get timeline() { return timelines[0] },
    get completed() { return completed },
    get disposed() { return disposed },
    setHidden(value) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')) },
    advance() { timelines[0].render(timelines[0].duration(), false, false); gsap.ticker.sleep() },
  }
}

test('startup assembles the original logo once and holds it until the workspace is ready', t => {
  const f = fixture(t, { ready: false })
  f.advance()
  assert.equal(f.timeline.paused(), true)
  assert.equal(f.completed, 0)
  assert.equal(f.root.autoAlpha, 1)
  assert.ok(f.wordChars.every(char => char.autoAlpha === 1))
  assert.equal(f.sub.autoAlpha, 1)
  assert.equal(f.rendered.at(-1).age, 2.3)
  const gateTime = f.timeline.time()
  const renderCount = f.rendered.length
  f.playback.setReady(true)
  assert.equal(f.timeline.paused(), false)
  assert.equal(f.timeline.time(), gateTime, 'release continues at the exit instead of replaying the intro')
  assert.equal(f.rendered.length, renderCount)
  assert.equal(f.timelines.length, 1)
  f.advance()
  assert.equal(f.completed, 1)
  assert.equal(f.root.autoAlpha, 0)
  f.playback.setReady(true)
  assert.equal(f.completed, 1)
})

test('visibility changes cannot bypass the workspace-ready gate', t => {
  const f = fixture(t, { ready: false })
  f.advance()
  f.setHidden(true)
  f.setHidden(false)
  assert.equal(f.timeline.paused(), true)
  assert.equal(f.root.autoAlpha, 1)
  assert.equal(f.completed, 0)
  f.setHidden(true)
  f.playback.setReady(true)
  assert.equal(f.timeline.paused(), true, 'a hidden ready workspace does not consume the exit animation')
  f.setHidden(false)
  assert.equal(f.timeline.paused(), false)
  f.advance()
  assert.equal(f.completed, 1)
})

test('low animation also retains its completed logo while waiting', t => {
  const f = fixture(t, { ready: false, level: 'low' })
  assert.deepEqual(f.rendered, [{ age: 2.3, reduced: true }])
  f.advance()
  assert.equal(f.timeline.paused(), true)
  assert.equal(f.root.autoAlpha, 1)
  assert.equal(f.completed, 0)
  f.playback.setReady(true)
  f.advance()
  assert.equal(f.completed, 1)
})

test('default-ready callers keep the original complete animation and visibility pause', t => {
  const f = fixture(t, { hidden: true })
  assert.equal(f.timeline.paused(), true)
  f.setHidden(false)
  assert.equal(f.timeline.paused(), false)
  f.advance()
  assert.equal(f.completed, 1)
  assert.equal(f.root.autoAlpha, 0)
})

test('unmount during the gate disposes the timeline and prevents a late readiness callback', t => {
  const f = fixture(t, { ready: false })
  f.advance()
  assert.equal(f.listeners.size, 1)
  f.playback()
  f.playback()
  f.playback.setReady(true)
  f.setHidden(false)
  assert.equal(f.completed, 0)
  assert.equal(f.disposed, 1)
  assert.equal(f.listeners.size, 0)
  assert.equal(gsap.globalTimeline.getChildren().includes(f.timeline), false)
  assert.equal(f.root.autoAlpha, 1)
  assert.ok(f.wordChars.every(char => char.autoAlpha === 1 && char.y === 0))
})
