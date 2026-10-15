import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import ts from 'typescript'

const bundle = await build({
  entryPoints: ['src/preload/pluginPreload.ts'], tsconfig: 'tsconfig.node.json', bundle: true,
  write: false, format: 'iife', platform: 'node',
  plugins: [{ name: 'electron-fixture', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const contextBridge={exposeInMainWorld:(name,api)=>globalThis[name]=api};
      export const ipcRenderer={on:(name,cb)=>handlers.set(name,cb),send:(...args)=>sent.push(args),invoke:async(...args)=>{calls.push(args);return {ok:true,data:true}}};
      export const webUtils={};` }))
  } }]
})
function fixture() {
  const ctx = { handlers: new Map(), sent: [], calls: [], URLSearchParams, queueMicrotask, setTimeout, clearTimeout, process: { argv: [] } }
  vm.createContext(ctx)
  vm.runInContext(bundle.outputFiles[0].text, ctx)
  return { ...ctx, dispatch: payload => ctx.handlers.get('plugin:event')(null, payload) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('middleware and WebSocket events reach the public subscribers and unsubscribe cleanly', () => {
  const c = fixture(), seen = []
  for (const type of ['mw.data', 'mw.error', 'ssh.auth']) c.enest.on(type, payload => seen.push(payload))
  const off = c.enest.net.websocket.onMessage(payload => seen.push(payload))
  c.enest.net.websocket.onClose(payload => seen.push(payload))
  c.dispatch({ type: 'mw.data', sessionKey: 'session', tailId: 'tail', message: { payload: 'hello' } })
  c.dispatch({ type: 'mw.error', error: 'fixture' })
  c.dispatch({ type: 'net.websocket.message', socketId: 'socket', data: 'AAE=', binary: true })
  c.dispatch({ type: 'net.websocket.close', socketId: 'socket', code: 1000, reason: 'done' })
  c.dispatch({ type: 'ssh.auth', sessionId: 'ssh', challengeId: 'challenge', host: 'fixture', instructions: '', prompts: [] })
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [
    { type: 'mw.data', sessionKey: 'session', tailId: 'tail', message: { payload: 'hello' } },
    { type: 'mw.error', error: 'fixture' },
    { socketId: 'socket', data: 'AAE=', binary: true },
    { socketId: 'socket', code: 1000, reason: 'done' },
    { type: 'ssh.auth', sessionId: 'ssh', challengeId: 'challenge', host: 'fixture', instructions: '', prompts: [] }
  ])
  off()
  c.dispatch({ type: 'net.websocket.message', socketId: 'socket', data: 'ignored', binary: false })
  assert.equal(seen.length, 5)
})

test('save ACK waits for persistence and reports thrown or rejected listeners as failures', async () => {
  for (const failure of [false, 'throw', 'reject']) {
    const c = fixture()
    let release
    const pending = new Promise(resolve => { release = resolve })
    c.enest.on('save-requested', () => {
      if (failure === 'throw') throw Error('fixture')
      if (failure === 'reject') return Promise.reject(Error('fixture'))
      return pending
    })
    c.dispatch({ type: 'shell-notice', notice: { topic: 'save.requested', data: { reason: 'update', deadlineMs: 5000, operationId: 'save:fixture' } } })
    assert.equal(c.sent.length, 0)
    release()
    await tick()
    assert.equal(c.sent.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(c.sent[0])), ['plugin:lifecycle-ack', { event: 'save-requested', operationId: 'save:fixture', success: !failure }])
  }
})

test('lifecycle ACK IPC accepts save, close and suspend only from the owning main frame', () => {
  const file = 'src/main/ipc/pluginHandlers.ts', source = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  let callback
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'ipcMain.on' && node.arguments[0]?.getText(sf) === 'IpcChannels.PluginLifecycleAck') callback = node.arguments[1].getText(sf)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  assert.ok(callback)
  const received = [], frame = { url: 'enest://plugin/fixture/index.html' }
  const handler = vm.runInNewContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    pluginHost: { getPluginIdByWebContentsId: id => id === 42 ? 'fixture' : undefined, ackBeforeClose: (...args) => received.push(args) },
    pluginRegistry: { get: () => ({}) }, isPluginPageUrl: url => url === frame.url
  })
  const event = { sender: { id: 42, mainFrame: frame }, senderFrame: frame }
  for (const name of ['beforeClose', 'beforeSuspend', 'save-requested']) handler(event, { event: name, operationId: name, success: true })
  handler(event, { event: 'unknown', operationId: 'bad' })
  handler({ ...event, senderFrame: { url: frame.url } }, { event: 'save-requested' })
  handler({ ...event, sender: { id: 43, mainFrame: frame } }, { event: 'save-requested' })
  assert.deepEqual(received.map(args => args[2]), ['beforeClose', 'beforeSuspend', 'save-requested'])
})

test('clipboard privacy and socket encoding survive the public preload API', async () => {
  const c = fixture()
  await c.enest.clipboard.writeText('synthetic-secret', { excludeFromHistory: true })
  await c.enest.net.socket.send('socket', 'PING')
  await c.enest.net.socket.send('socket', 'AAE=', 'base64')
  assert.deepEqual(JSON.parse(JSON.stringify(c.calls.map(([, request]) => request.args))), [
    ['synthetic-secret', { excludeFromHistory: true }], ['socket', 'PING', 'utf8'], ['socket', 'AAE=', 'base64']
  ])
})
