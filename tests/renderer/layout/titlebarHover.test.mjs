import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../../../src/renderer/layout/titlebarHover.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function fixture() {
  let time = 0
  let nextId = 0
  const jobs = new Map()
  const events = []
  const module = { exports: {} }
  new Function('module', 'exports', 'setTimeout', 'clearTimeout', source)(module, module.exports,
    (fn, delay) => { const id = ++nextId; jobs.set(id, { fn, at: time + delay }); return id },
    id => jobs.delete(id))
  const hover = module.exports.createTitlebarHover(() => events.push('reveal'), () => events.push('collapse'))
  return { hover, events, get jobs() { return jobs.size }, advance(ms) {
    time += ms
    for (const [id, job] of jobs) if (job.at <= time) { jobs.delete(id); job.fn() }
  } }
}

test('crossing the hotzone/header boundary within the fixed region never schedules collapse', () => {
  const api = fixture()
  api.hover.enter()
  api.advance(1000)
  assert.deepEqual(api.events, ['reveal'])
  assert.equal(api.jobs, 0)
})

test('brief boundary jitter cancels collapse and a real exit collapses once after the grace period', () => {
  const api = fixture()
  api.hover.enter()
  for (let index = 0; index < 6; index++) {
    api.hover.leave(); api.advance(100); api.hover.enter()
  }
  assert.equal(api.events.includes('collapse'), false)
  api.hover.leave()
  api.advance(319)
  assert.equal(api.events.includes('collapse'), false)
  api.advance(1)
  assert.equal(api.events.filter(event => event === 'collapse').length, 1)
  api.advance(1000)
  assert.equal(api.events.filter(event => event === 'collapse').length, 1)
})

test('keyboard focus holds the titlebar until both focus and pointer leave', () => {
  const api = fixture()
  api.hover.focus(true)
  api.hover.enter(); api.hover.leave(); api.advance(1000)
  assert.equal(api.events.includes('collapse'), false)
  api.hover.blur(); api.advance(320)
  assert.equal(api.events.at(-1), 'collapse')
})

test('pointer interaction clears the keyboard latch and focus movement within the titlebar preserves it', () => {
  const api = fixture()
  api.hover.focus(true); api.hover.focus(false)
  api.hover.leave(); api.advance(320)
  assert.equal(api.events.includes('collapse'), false)
  api.hover.pointerDown(); api.hover.leave(); api.advance(320)
  assert.equal(api.events.at(-1), 'collapse')
})

test('window blur resets immediately and disposal leaves no delayed state updates', () => {
  const api = fixture()
  api.hover.enter(); api.hover.leave(); api.hover.reset()
  assert.equal(api.jobs, 0)
  assert.equal(api.events.at(-1), 'collapse')
  api.hover.enter(); api.hover.leave(); api.hover.dispose()
  const count = api.events.length
  api.advance(1000)
  assert.equal(api.jobs, 0)
  assert.equal(api.events.length, count)
})
