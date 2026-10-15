import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const js = ts.transpileModule(readFileSync(new URL('./drivers/kafka.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function fixture() {
  let clock = 0, sequence = 0, eachMessage, rejectRun, disconnects = 0, seeks = 0
  const timers = new Map()
  const consumer = {
    async connect() {}, async subscribe() {},
    run(opts) { eachMessage = opts.eachMessage; return new Promise((_resolve, reject) => { rejectRun = reject }) },
    seek() { seeks++ }, async disconnect() { disconnects++ }
  }
  const handle = { runtime: { kafka: { consumer: () => consumer }, admin: { fetchTopicOffsets: async () => [{ partition: 0, high: '10', low: '0' }] } } }
  const module = { exports: {} }
  const setTimer = (fn, delay) => { const id = ++sequence; timers.set(id, { at: clock + delay, fn }); return id }
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', js)(
    name => name === 'kafkajs' ? { default: {} } : { unsupported() { throw new Error('unsupported') } },
    module, module.exports, setTimer, id => timers.delete(id)
  )
  return {
    timers, disconnects: () => disconnects, seeks: () => seeks,
    async start(input = {}) {
      const result = module.exports.kafkaDriver.messagesQuery(handle, { topic: 'fixture', from: 'latest', max: 50, ...input })
      while (!eachMessage) await Promise.resolve()
      return { result }
    },
    send: () => eachMessage({ topic: 'fixture', partition: 0, message: { value: Buffer.from('fixture'), timestamp: String(clock), offset: '1' } }),
    fail: () => rejectRun(new Error('synthetic run failure')),
    advance(to) {
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        clock = next[1].at; timers.delete(next[0]); next[1].fn()
      }
      clock = to
    }
  }
}

test('Kafka idle deadline resets on every message and all query timers are cleared', async () => {
  const f = fixture(), { result } = await f.start()
  let finished = false
  void result.then(() => { finished = true })
  for (const timestamp of [0, 1000, 2000]) { f.advance(timestamp); await f.send() }
  f.advance(2500)
  await Promise.resolve()
  assert.equal(finished, false, 'first message must not leave an old idle deadline')
  f.advance(4500)
  assert.equal((await result).length, 3)
  assert.equal(f.timers.size, 0)
  assert.equal(f.disconnects(), 1)
})

test('Kafka max-count completion cancels pending seek/timeout and ignores late messages', async () => {
  const f = fixture(), { result } = await f.start({ max: 1 })
  await f.send()
  await f.send()
  assert.equal((await result).length, 1)
  assert.equal(f.timers.size, 0)
  f.advance(20000)
  assert.equal(f.seeks(), 0)
  assert.equal(f.disconnects(), 1)
})

test('Kafka consumer failure rejects the query and clears every timer', async () => {
  const f = fixture(), { result } = await f.start()
  f.fail()
  await assert.rejects(result, /synthetic run failure/)
  assert.equal(f.timers.size, 0)
  assert.equal(f.disconnects(), 1)
})
