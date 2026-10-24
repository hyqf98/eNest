import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

async function fixture() {
  const sources = {
    fixture: `export const state={text:'initial',files:[],image:null,source:null,sourceGate:null,writeGate:null,writeFail:false,reads:0,clock:1700000000000,logs:[],timers:new Map(),writeCalls:[],activeWrites:0,peakWrites:0,imageDecodes:0,imageThrow:false};`,
    electron: `import {state} from 'fixture'; export class ClipboardItem { constructor(value){Object.assign(this,value)} }; export const clipboard={
      read:async()=>state.image?[{types:['image/png'],getType:async()=>new Blob([state.image],{type:'image/png'})}]:[],
      readText:async()=>{state.reads++;return state.text},
      writeText:async value=>{state.writeCalls.push(value);state.activeWrites++;state.peakWrites=Math.max(state.peakWrites,state.activeWrites);try{if(state.writeGate)await state.writeGate;if(state.writeFail)throw Error('fixture write failed');state.text=value;state.image=null;state.files=[]}finally{state.activeWrites--}},
      write:async items=>{state.image=Buffer.from(await items[0]['image/png'].arrayBuffer());state.text='';state.files=[]}
    }; export const nativeImage={createFromBuffer:buffer=>({isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>buffer}),createFromDataURL:url=>{state.imageDecodes++;if(state.imageThrow)throw Error('fixture image conversion failed');return{isEmpty:()=>false,getSize:()=>({width:1,height:1}),toPNG:()=>Buffer.from(url.split(',')[1],'base64')}}};`,
    native: `import {state} from 'fixture'; export const readNativeFiles=async()=>state.files; export const writeNativeFiles=async paths=>{state.files=paths;state.image=null;state.text=''}; export const nativeClipboardSource=async()=>{if(state.sourceGate)await state.sourceGate;return state.source}; export const isNativeClipboardBusy=()=>false;`,
    logs: `import {state} from 'fixture'; export const logWarn=(_source,message)=>state.logs.push(message);`
  }
  const result = await build({
    stdin: { contents: `export * from './src/main/clipboard/clipboardNativeEvents.ts';export {state} from 'fixture';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'fixture', setup(api) {
      api.onResolve({ filter: /^(fixture|electron)$|\/nativeClipboard$|^@main\/logs\/logService$/ }, ({ path }) => ({ path: path.endsWith('/nativeClipboard') ? 'native' : path === '@main/logs/logService' ? 'logs' : path, namespace: 'fixture' }))
      api.onLoad({ filter: /clipboardNativeEvents\.ts$/ }, ({ path }) => ({ contents: `import {state as fixtureState} from 'fixture';
        const Date={now:()=>fixtureState.clock};
        const setInterval=(callback,ms)=>{const token={unref(){}};fixtureState.timers.set(token,{callback,ms});return token};
        const clearInterval=token=>fixtureState.timers.delete(token);
        ${readFileSync(path, 'utf8')}`, loader: 'ts' }))
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: sources[path], loader: 'js' }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('one native observer seeds the current value and publishes changes without owning history', async () => {
  const f = await fixture(), events = []
  const off = f.subscribeClipboardChanges({ current: () => true, publish: value => events.push(value) })
  try {
    await tick(); await tick()
    assert.equal(events.length, 0)
    f.state.text = 'external fixture copy'
    await f.pollClipboardChanges()
    await f.pollClipboardChanges()
    assert.equal(events.length, 1)
    assert.equal(events[0].text, 'external fixture copy')
    assert.equal(typeof events[0].revision, 'number')
  } finally { off() }
})

test('unsubscribe invalidates a native read waiting for source metadata', async () => {
  const f = await fixture(), events = []
  const off = f.subscribeClipboardChanges({ current: () => true, publish: value => events.push(value) })
  await tick(); await tick()
  let resume
  f.state.sourceGate = new Promise(resolve => { resume = resolve })
  f.state.text = 'late fixture copy'
  const capture = f.pollClipboardChanges()
  await tick(); off(); resume(); await capture
  assert.equal(events.length, 0)
})

test('queued sensitive writes invalidate pending snapshots and are not reintroduced by observation', async () => {
  const f = await fixture(), events = []
  const off = f.subscribeClipboardChanges({ current: () => true, publish: value => events.push(value) })
  try {
    await tick(); await tick()
    let resume
    f.state.sourceGate = new Promise(resolve => { resume = resolve })
    f.state.text = 'synthetic credential'
    const capture = f.pollClipboardChanges()
    await tick()
    await f.writeClipboardText('synthetic credential', { excludeFromHistory: true })
    resume(); await capture; f.state.sourceGate = null
    await f.pollClipboardChanges()
    assert.equal(events.length, 0)
    f.state.text = 'ordinary external fixture'
    await f.pollClipboardChanges()
    assert.deepEqual(events.map(value => value.text), ['ordinary external fixture'])
  } finally { off() }
})

test('image and files writes share the same no-feedback barrier and failed writes recover', async () => {
  const f = await fixture(), events = []
  const off = f.subscribeClipboardChanges({ current: () => true, publish: value => events.push(value) })
  try {
    await tick(); await tick()
    await f.writeClipboardImage('data:image/png;base64,ZmFrZS1pbWFnZQ==')
    await f.pollClipboardChanges()
    await f.writeClipboardFiles(['/fixture/synthetic.txt'])
    await f.pollClipboardChanges()
    assert.equal(events.length, 0)
    f.state.writeFail = true
    await assert.rejects(f.writeClipboardText('failed'), /fixture write failed/)
    f.state.writeFail = false
    await f.writeClipboardText('recovered')
    await f.pollClipboardChanges()
    assert.equal(events.length, 0)
  } finally { off() }
})

test('a rejected consumer ACK retries the retained snapshot without blocking native reads or adding timers', async () => {
  const f = await fixture(), events = []
  let fail = true
  const off = f.subscribeClipboardChanges({ current: () => true, publish: value => { if (fail) throw new Error('fixture persistence failed'); events.push(value) } })
  try {
    await tick(); await tick()
    f.state.text = 'retry external copy'
    await f.pollClipboardChanges()
    fail = false
    f.state.clock += 500
    await f.pollClipboardChanges()
    assert.equal(events.length, 1)
    assert.equal(f.state.timers.size, 1)
    assert.equal([...f.state.timers.values()][0].ms, 500)
  } finally { off() }
})

test('a slow consumer cannot block other consumers or the single 500ms native observer', async () => {
  const f = await fixture(), slow = [], fast = []
  let release, running = 0, peak = 0
  const gate = new Promise(resolve => { release = resolve })
  const offSlow = f.subscribeClipboardChanges({ current: () => true, publish: async value => {
    running++; peak = Math.max(peak, running); slow.push(value.text)
    if (value.text === 'first') await gate
    running--
  } })
  const offFast = f.subscribeClipboardChanges({ current: () => true, publish: value => fast.push(value.text) })
  try {
    await tick()
    for (const text of ['first', 'second', 'third']) { f.state.text = text; await f.pollClipboardChanges(); await tick() }
    assert.deepEqual(fast, ['first', 'second', 'third'])
    assert.deepEqual(slow, ['first'])
    assert.equal(f.state.timers.size, 1)
    release(); await tick()
    assert.deepEqual(slow, ['first', 'second', 'third'])
    assert.equal(peak, 1)
  } finally { release(); offSlow(); offFast() }
})

test('per-consumer queue keeps at most eight events including its in-flight call and drops only oldest waiting items', async () => {
  const f = await fixture(), events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const off = f.subscribeClipboardChanges({ current: () => true, publish: async value => {
    events.push(value.text)
    if (value.text === 'PRIVATE_0') await gate
  } })
  try {
    await tick()
    for (let index = 0; index < 10; index++) { f.state.text = `PRIVATE_${index}`; await f.pollClipboardChanges() }
    assert.deepEqual(events, ['PRIVATE_0'])
    release(); await tick()
    assert.deepEqual(events, ['PRIVATE_0', ...Array.from({ length: 7 }, (_, index) => `PRIVATE_${index + 3}`)])
    assert.match(f.state.logs.join('\n'), /reason=queue-limit/)
    assert.equal(f.state.logs.join('').includes('PRIVATE_'), false)
  } finally { release(); off() }
})

test('8MiB native PNGs fit a consumer budget but in-flight plus pending and global retained bytes remain capped', async () => {
  const f = await fixture(), events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const offs = Array.from({ length: 6 }, (_, index) => f.subscribeClipboardChanges({ current: () => true, publish: async value => {
    events.push({ index, revision: value.revision }); await gate
  } }))
  let offNew
  try {
    await tick()
    f.state.image = Buffer.alloc(8 * 1024 * 1024, 1)
    await f.pollClipboardChanges()
    assert.equal(events.length, 5)
    assert.match(f.state.logs.join('\n'), /reason=global-limit/)
    f.state.image = Buffer.alloc(8 * 1024 * 1024, 2)
    await f.pollClipboardChanges()
    assert.equal(events.length, 5)
    assert.match(f.state.logs.join('\n'), /reason=queue-limit/)
    offs.forEach(off => off())
    const fresh = []
    offNew = f.subscribeClipboardChanges({ current: () => true, publish: value => fresh.push(value.revision) })
    await tick()
    f.state.image = Buffer.alloc(8 * 1024 * 1024, 3)
    await f.pollClipboardChanges()
    assert.equal(fresh.length, 0, 'retired in-flight calls still consume their global reservation')
    release(); await tick()
    f.state.image = Buffer.alloc(8 * 1024 * 1024, 4)
    await f.pollClipboardChanges()
    assert.equal(fresh.length, 1)
    assert.equal(events.length, 5, 'retired queues must not restart after late ACKs')
  } finally { release(); offs.forEach(off => off()); offNew?.() }
})

test('failed delivery has only three attempts and a content-free discard log, then later changes still flow', async () => {
  const f = await fixture(), events = []
  let attempts = 0
  const off = f.subscribeClipboardChanges({ current: () => true, publish: value => {
    if (value.text === 'PRIVATE_FAILURE') { attempts++; throw new Error('PRIVATE_PATH /secret') }
    events.push(value.text)
  } })
  try {
    await tick()
    f.state.text = 'PRIVATE_FAILURE'
    await f.pollClipboardChanges()
    for (let index = 0; index < 5; index++) { f.state.clock += 500; await f.pollClipboardChanges() }
    assert.equal(attempts, 3)
    assert.match(f.state.logs.join('\n'), /reason=delivery-failed/)
    assert.equal(f.state.logs.join('').includes('PRIVATE'), false)
    f.state.text = 'after failure'
    await f.pollClipboardChanges()
    assert.deepEqual(events, ['after failure'])
  } finally { off() }
})

test('revocation drops waiting deliveries and a late ACK cannot recreate a retired subscription', async () => {
  const f = await fixture(), events = []
  let allowed = true, release
  const gate = new Promise(resolve => { release = resolve })
  const off = f.subscribeClipboardChanges({ current: () => allowed, publish: async value => { events.push(value.text); await gate } })
  try {
    await tick()
    f.state.text = 'in flight'; await f.pollClipboardChanges()
    f.state.text = 'waiting'; await f.pollClipboardChanges()
    allowed = false; await f.pollClipboardChanges()
    assert.equal(f.state.timers.size, 0)
    release(); await tick()
    f.state.clock += 500; await f.pollClipboardChanges()
    assert.deepEqual(events, ['in flight'])
    assert.equal(f.state.timers.size, 0)
  } finally { release(); off() }
})

test('slow native metadata remains single-flight even though consumer delivery no longer holds the poll lock', async () => {
  const f = await fixture(), events = []
  const off = f.subscribeClipboardChanges({ current: () => true, publish: value => events.push(value.text) })
  let release
  try {
    await tick()
    f.state.sourceGate = new Promise(resolve => { release = resolve })
    f.state.text = 'metadata wait'
    const first = f.pollClipboardChanges()
    await tick()
    const reads = f.state.reads
    await f.pollClipboardChanges(); await f.pollClipboardChanges()
    assert.equal(f.state.reads, reads)
    release(); await first
    assert.deepEqual(events, ['metadata wait'])
    assert.equal(f.state.timers.size, 1)
  } finally { release?.(); off() }
})

test('native writes have one in-flight operation and at most sixteen retained jobs', async () => {
  const f = await fixture()
  let release
  f.state.writeGate = new Promise(resolve => { release = resolve })
  const pending = Array.from({ length: 16 }, (_, index) => f.writeClipboardText(`write-${index}`))
  try {
    await assert.rejects(f.writeClipboardText('over count'), /queue limit/)
    await tick()
    assert.deepEqual(f.state.writeCalls, ['write-0'])
    release(); await Promise.all(pending); await tick()
    assert.equal(f.state.peakWrites, 1)
    assert.equal(f.state.writeCalls.length, 16)
    await f.writeClipboardText('after drain')
    assert.equal(f.state.text, 'after drain')
  } finally { release(); await Promise.allSettled(pending) }
})

test('global write bytes include pending plus in-flight text and reject images before conversion when full', async () => {
  const f = await fixture()
  let release
  f.state.writeGate = new Promise(resolve => { release = resolve })
  const payload = 'x'.repeat(8 * 1024 * 1024)
  const pending = Array.from({ length: 8 }, () => f.writeClipboardText(payload))
  try {
    await assert.rejects(f.writeClipboardText('one byte over budget'), /queue limit/)
    await assert.rejects(f.writeClipboardImage('data:image/png;base64,ZmFrZQ=='), /queue limit/)
    assert.equal(f.state.imageDecodes, 0)
    release(); await Promise.all(pending); await tick()
    await f.writeClipboardImage('data:image/png;base64,ZmFrZQ==')
    assert.equal(f.state.imageDecodes, 1)
    assert.equal(f.state.peakWrites, 1)
  } finally { release(); await Promise.allSettled(pending) }
})

test('queued cancellation immediately frees its payload but native in-flight cancellation never overlaps another write', async () => {
  const f = await fixture(), active = new AbortController()
  let release
  f.state.writeGate = new Promise(resolve => { release = resolve })
  const first = f.writeClipboardText('in flight', {}, active.signal)
  const firstFailure = assert.rejects(first, /fixture active cancel/)
  await tick()
  try {
    for (let index = 0; index < 40; index++) {
      const cancelled = new AbortController()
      const pending = f.writeClipboardText('must never reach OS', {}, cancelled.signal)
      const rejected = assert.rejects(pending, /fixture queued cancel/)
      cancelled.abort(new Error('fixture queued cancel'))
      await rejected
    }
    active.abort(new Error('fixture active cancel')); await firstFailure
    const next = f.writeClipboardText('after cancelled native operation')
    await tick()
    assert.deepEqual(f.state.writeCalls, ['in flight'])
    release(); await next; await tick()
    assert.deepEqual(f.state.writeCalls, ['in flight', 'after cancelled native operation'])
    assert.equal(f.state.peakWrites, 1)
  } finally { active.abort(new Error('fixture active cancel')); release(); await firstFailure }
})

test('synchronous image errors, native rejection and oversized path input cannot leak write reservations', async () => {
  const f = await fixture()
  f.state.imageThrow = true
  for (let index = 0; index < 20; index++) await assert.rejects(f.writeClipboardImage('data:image/png;base64,ZmFrZQ=='), /conversion failed/)
  f.state.imageThrow = false
  f.state.writeFail = true
  for (let index = 0; index < 20; index++) await assert.rejects(f.writeClipboardText('native rejection'), /fixture write failed/)
  f.state.writeFail = false
  await assert.rejects(f.writeClipboardFiles(['x'.repeat(8 * 1024 * 1024)]), /paths exceed/)
  await f.writeClipboardText('successful after all rejections')
  await tick()
  assert.equal(f.state.text, 'successful after all rejections')
  assert.equal(f.state.peakWrites, 1)
})
