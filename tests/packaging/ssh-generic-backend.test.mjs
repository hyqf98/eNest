import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import { createSshHost } from '../../eNest_plugin/packages/ssh-backend/client.js'

const require = createRequire(import.meta.url)
const root = new URL('../../', import.meta.url)
const base = 'eNest_plugin/packages/ssh-backend/'
const read = path => readFileSync(new URL(path, root), 'utf8')
const OWNER = 'com.github.eNest.ssh'
const REMOTE = 'com.github.eNest.remote-desktop'
const compiled = new Map()
function load(path, adapters = {}, globals = {}) {
  if (!compiled.has(path)) compiled.set(path, ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), compiled.get(path))(name => {
    if (Object.hasOwn(adapters, name)) return adapters[name]
    if (name.startsWith('node:')) return require(name)
    throw Error(`Unexpected dependency: ${name}`)
  }, module, module.exports, ...Object.values(globals))
  return module.exports
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function hostFixture(t) {
  const messages = [], timers = new Set()
  const bridge = load(`${base}src/hostBridge.ts`, {}, {
    setTimeout(fn) { const timer = { fn }; timers.add(timer); return timer }, clearTimeout(timer) { timers.delete(timer) }
  })
  bridge.configureHostBridge(OWNER, message => messages.push(message))
  t.after(() => bridge.disposeHostBridge())
  const reply = (message, data, ok = true) => bridge.receiveHostReply({ type: 'host.response', id: message.id, ok, data, error: ok ? undefined : String(data) })
  return { bridge, messages, timers, reply }
}

test('native SSH bridge uses generic capabilities with owner-bound object parameters', async t => {
  const f = hostFixture(t)
  const cases = [
    ['resolveSecret', ['ref'], 'secret.resolve', { ref: 'ref' }, 'secret'],
    ['authorizePluginPermission', ['ssh.agent', 'fixture'], 'permission.authorize', { permission: 'ssh.agent', summary: 'fixture' }, true],
    ['resolveLocalFileHandle', ['handle', 'write'], 'files.resolve', { handleId: 'handle', access: 'write' }, '/fixture'],
    ['resolveLocalDirectoryTarget', ['handle', 'name'], 'files.directoryTarget', { handleId: 'handle', name: 'name' }, '/fixture/name'],
    ['pickLocalFiles', [{ kind: 'file' }], 'files.pick', { options: { kind: 'file' } }, []],
    ['createExportDirectory', [], 'files.exportDirectory', {}, '/fixture/export'],
    ['createLocalExport', [['/fixture/export/file']], 'files.export', { paths: ['/fixture/export/file'] }, { exportId: 'export' }],
    ['getPluginStorageValue', ['key'], 'storage.get', { key: 'key' }, { value: 1 }],
    ['setPluginStorageValue', ['key', { value: 1 }], 'storage.set', { key: 'key', value: { value: 1 } }, true]
  ]
  for (const [name, args, method, params, result] of cases) {
    const request = f.bridge[name](OWNER, ...args), message = f.messages.at(-1)
    assert.equal(message.type, 'host.request'); assert.equal(message.method, method)
    assert.deepEqual(message.params, params); assert.equal('pluginId' in message, false)
    f.reply(message, result); await request
  }
  f.bridge.logInfo('fixture', 'message'); f.reply(f.messages.at(-1), true)
  assert.deepEqual(f.messages.at(-1).params, { level: 'info', source: 'fixture', message: 'message' })
  assert.equal(f.messages.at(-1).method, 'log.write')
  const count = f.messages.length
  await assert.rejects(f.bridge.resolveSecret(REMOTE, 'ref'), /owner/)
  assert.equal(f.messages.length, count)
  const denied = f.bridge.authorizePluginPermission(OWNER, 'ssh.agent', 'fixture')
  f.reply(f.messages.at(-1), 'permission denied', false)
  await assert.rejects(denied, /permission denied/)
  assert.equal(f.timers.size, 0)
})

test('late activity acquire is followed by exactly one release and disposal blocks future requests', async t => {
  const f = hostFixture(t)
  const release = f.bridge.acquirePluginActivity(OWNER, 'private-key', 'connected')
  const acquire = f.messages.at(-1)
  assert.equal(acquire.method, 'activity.acquire')
  assert.deepEqual(Object.keys(acquire.params).sort(), ['reason', 'token'])
  release(); release()
  assert.equal(f.messages.length, 1)
  f.reply(acquire, undefined); await settle()
  const released = f.messages.at(-1)
  assert.equal(released.method, 'activity.release')
  assert.equal(released.params.token, acquire.params.token)
  f.reply(released, undefined); release(); await settle()
  assert.equal(f.messages.length, 2)
  const pending = f.bridge.resolveSecret(OWNER, 'pending')
  f.bridge.disposeHostBridge()
  await assert.rejects(pending, /closed/)
  await assert.rejects(f.bridge.resolveSecret(OWNER, 'later'), /owner/)
  assert.equal(f.timers.size, 0)
})

test('native bridge has 64 pending quota, 4 MiB request limit and separate event envelopes', async t => {
  const f = hostFixture(t)
  const pending = Array.from({ length: 64 }, () => f.bridge.getPluginStorageValue(OWNER, 'fixture'))
  const all = Promise.allSettled(pending)
  await assert.rejects(f.bridge.getPluginStorageValue(OWNER, 'overflow'), /limit/)
  const first = f.messages[0]
  f.bridge.receiveHostReply({ hostResult: first.id, ok: true, data: 'old protocol' })
  assert.equal(f.timers.size, 64)
  f.reply(first, null)
  await assert.rejects(f.bridge.setPluginStorageValue(OWNER, 'large', 'x'.repeat(4 * 1024 * 1024)), /4 MiB/)
  f.bridge.pluginHost.sendEvent(REMOTE, { type: 'ssh.data', chunk: 'foreign' })
  const count = f.messages.length
  f.bridge.pluginHost.sendEvent(OWNER, { type: 'shell.fake', value: true })
  assert.equal(f.messages.length, count)
  f.bridge.pluginHost.sendEvent(OWNER, { type: 'ssh.data', sessionId: 'one', chunk: 'hello' })
  assert.deepEqual(f.messages.at(-1), { event: 'ssh.data', data: { type: 'ssh.data', sessionId: 'one', chunk: 'hello' } })
  f.bridge.disposeHostBridge()
  assert.equal((await all).filter(result => result.status === 'rejected').length, 63)
  assert.equal(f.timers.size, 0)
})

function workerFixture(methods = {}) {
  const messages = [], calls = [], disposed = [], replies = [], exits = []
  let receive
  const bridge = { configureHostBridge(id) { calls.push(['configure', id]) }, receiveHostReply(reply) { replies.push(reply) }, disposeHostBridge() { disposed.push('bridge') }, acquirePluginActivity() { return () => {} } }
  const runtime = load(`${base}src/runtimeScope.ts`, { './hostBridge': bridge })
  const names = ['sshConnect', 'sshWrite', 'sshResize', 'sshDisconnect', 'sshListSessions', 'sshExec', 'sshMetricsStart', 'sshMetricsStop', 'sshMetricsLatest', 'sshCompletionSuggest', 'sshSftpList', 'sshSftpDownload', 'sshSftpUpload', 'sshSftpMkdir', 'sshSftpRename', 'sshSftpDelete', 'sshSftpChmod']
  const ssh = Object.fromEntries(names.map(name => [name, (...args) => { calls.push([name, ...args]); return true }]))
  Object.assign(ssh, methods, { releaseSshSessions: id => disposed.push(id) })
  const workerRuntime = load(`${base}src/runtime.ts`, { './sshSessionManager': ssh, './hostBridge': bridge, './runtimeScope': runtime, './sshWorkbench': { sshWorkbench: (...args) => calls.push(['workbench', ...args]) } }, {
    process: { parentPort: { postMessage(value) { messages.push(value) }, on(_event, listener) { receive = listener } }, exit(code) { exits.push(code) } }
  })
  load(`${base}src/worker.ts`, { './runtime': workerRuntime })
  const send = value => receive({ data: value })
  return { send, messages, calls, disposed, replies, exits, runtime,
    init(overrides = {}) { send({ type: 'init', pluginId: OWNER, generation: 1, wcId: 12, context: { protocolVersion: 1 }, ...overrides }) },
    request(id, method, args = [], pluginId = OWNER) { send({ id, method, args, pluginId }) }
  }
}

test('worker validates protocol and owner, ignores duplicate init and refuses inherited method names', async () => {
  const f = workerFixture()
  for (const overrides of [{ pluginId: '' }, { generation: 0 }, { wcId: -1 }, { context: { protocolVersion: 2 } }]) f.init(overrides)
  assert.equal(f.calls.length, 0)
  f.request(1, 'ssh.listSessions'); await settle()
  assert.match(f.messages.at(-1).error, /owner/)
  f.init(); f.init({ pluginId: REMOTE })
  assert.equal(f.calls.filter(value => value[0] === 'configure').length, 1)
  f.request(2, 'ssh.connect', [{ host: 'fixture', username: 'fixture' }], REMOTE)
  f.request(3, 'constructor'); f.request(4, 'ssh.connect', [{ host: 'fixture', username: 'fixture' }])
  await settle()
  assert.match(f.messages.find(value => value.id === 2).error, /owner/)
  assert.match(f.messages.find(value => value.id === 3).error, /Unsupported/)
  assert.deepEqual(f.calls.at(-1), ['sshConnect', OWNER, { host: 'fixture', username: 'fixture' }])
  f.send({ type: 'host.response', id: 4, ok: true })
  assert.equal(f.replies.length, 1)
})

test('worker enforces 32 pending, duplicate suppression and 4/8 MiB envelope bounds', async () => {
  const resolvers = []
  const f = workerFixture({ sshExec: () => new Promise(resolve => resolvers.push(resolve)), sshListSessions: () => 'x'.repeat(8 * 1024 * 1024) })
  f.init()
  f.request(100, 'ssh.connect', ['x'.repeat(4 * 1024 * 1024)])
  f.request(101, 'ssh.listSessions'); await settle()
  assert.match(f.messages.find(value => value.id === 100).error, /4 MiB/)
  assert.match(f.messages.find(value => value.id === 101).error, /8 MiB/)
  for (let i = 1; i <= 32; i++) f.request(i, 'ssh.exec', [{}])
  f.request(1, 'ssh.exec', [{}]); f.request(33, 'ssh.exec', [{}]); await settle()
  assert.equal(resolvers.length, 32)
  assert.match(f.messages.find(value => value.id === 33).error, /limit/)
  for (const resolve of resolvers) resolve(true)
  await settle()
  assert.equal(f.messages.filter(value => value.ok === true).length, 32)
})

test('shutdown aborts owner, releases sessions and bridge, exits once and suppresses late responses', async () => {
  let finish
  const f = workerFixture({ sshExec: () => new Promise(resolve => { finish = resolve }) })
  f.init(); f.request(1, 'ssh.exec', [{}])
  const scope = f.runtime.getRuntimeScope(OWNER)
  let cleanup = 0
  scope.addDisposer(() => cleanup++)
  f.send({ type: 'shutdown' }); f.send({ type: 'shutdown' }); await settle()
  assert.equal(scope.signal.aborted, true); assert.equal(cleanup, 1)
  assert.deepEqual(f.disposed, [OWNER, 'bridge']); assert.deepEqual(f.exits, [0])
  assert.equal(f.runtime.getRuntimeScope(OWNER), undefined)
  const count = f.messages.length
  finish('late'); f.request(2, 'ssh.connect', [{}]); await settle()
  assert.equal(f.messages.length, count)
  assert.deepEqual(f.messages.at(-1), { type: 'shutdown.complete' })
})

test('browser adapter preserves argument shapes and per-operation timeouts without mutating preload', async () => {
  const calls = [], host = Object.freeze({ backend: Object.freeze({ call: async (...args) => { calls.push(args); return true } }), localFiles: { pick: async () => [{ id: 'picked' }] } })
  const client = createSshHost(host)
  assert.equal(createSshHost(host), client); assert.equal(host.ssh, undefined)
  await client.ssh.connect({ host: 'fixture' }); await client.ssh.sftp.download({ sessionId: 'one' })
  await client.ssh.metrics.start({ sessionId: 'one', intervalMs: 5000 }); await client.ssh.metrics.stop({ sessionId: 'one' })
  await client.ssh.metrics.latest('one'); await client.ssh.sftp.rename('one', 'a', 'b')
  assert.deepEqual(calls, [
    ['ssh.connect', [{ host: 'fixture' }], { timeoutMs: 1_200_000 }],
    ['ssh.sftp.download', [{ sessionId: 'one' }], { timeoutMs: 86_400_000 }],
    ['ssh.metrics.start', ['one', 5000], { timeoutMs: 180_000 }],
    ['ssh.metrics.stop', ['one'], { timeoutMs: 180_000 }],
    ['ssh.metrics.latest', ['one'], { timeoutMs: 180_000 }],
    ['ssh.sftp.rename', ['one', 'a', 'b'], { timeoutMs: 180_000 }]
  ])
  assert.deepEqual(await client.ssh.pickLocalFile(), { id: 'picked' })
  await assert.rejects(createSshHost({}).ssh.listSessions(), /eNest/)
  assert.doesNotMatch(read(`${base}client.js`), /from ['"](?:node:|ssh2|\.\/src\/worker)/)
})

test('browser adapter filters backend event envelopes and unsubscribes by old off or new disposer', () => {
  for (const returnsDisposer of [true, false]) {
    const events = new Map(), offCalls = []
    const host = { on(event, callback) { events.set(callback, event); return returnsDisposer ? () => events.delete(callback) : undefined }, off(event, callback) { offCalls.push(event); events.delete(callback) } }
    const client = createSshHost(host), received = [], listener = value => received.push(value)
    const off = client.on('ssh.data', listener)
    client.on('ssh.data', listener)
    assert.equal(events.size, 1)
    const relay = [...events.keys()][0]
    relay({ event: 'ssh.exit', data: { value: 1 } }); relay({ event: 'ssh.data', data: { chunk: 'two' } })
    assert.deepEqual(received, [{ chunk: 'two' }])
    client.off('ssh.data', listener); off(); assert.equal(events.size, 0)
    assert.equal(offCalls.length, returnsDisposer ? 0 : 1)
    client.on('mode', listener); client.off('mode', listener)
    assert.equal(events.size, 0)
  }
})

test('unexpected generic backend exit maps to SSH error only and preserves unsubscribe semantics', () => {
  for (const returnsDisposer of [true, false]) {
    const relays = new Set(), errors = [], data = []
    const host = { on(event, callback) { assert.equal(event, 'backend.event'); relays.add(callback); return returnsDisposer ? () => relays.delete(callback) : undefined }, off(event, callback) { assert.equal(event, 'backend.event'); relays.delete(callback) } }
    const client = createSshHost(host), listener = value => errors.push(value)
    const off = client.on('ssh.error', listener), offData = client.on('ssh.data', value => data.push(value))
    const emit = envelope => { for (const relay of relays) relay(envelope) }
    emit({ event: 'backend.exit', data: { code: 0, unexpected: false } })
    emit({ event: 'backend.exit', data: { code: 1 } })
    assert.equal(errors.length, 0)
    emit({ event: 'backend.exit', data: { code: 9, unexpected: true } })
    emit({ event: 'backend.exit', data: { code: null, unexpected: true } })
    emit({ event: 'ssh.error', data: { type: 'ssh.error', sessionId: 'one', message: 'session error' } })
    assert.deepEqual(errors, [
      { type: 'ssh.error', message: 'SSH 后端已退出（9），请重新连接' },
      { type: 'ssh.error', message: 'SSH 后端已退出，请重新连接' },
      { type: 'ssh.error', sessionId: 'one', message: 'session error' }
    ])
    assert.deepEqual(data, [])
    client.off('ssh.error', listener); off(); offData()
    assert.equal(relays.size, 0)
    emit({ event: 'backend.exit', data: { code: 2, unexpected: true } })
    assert.equal(errors.length, 3)
  }
})

function tunnelFixture({ delayListen = false } = {}) {
  let allowed = true, listening
  const servers = [], session = { status: 'connected', cleanup: new Set(), client: new EventEmitter() }
  const ssh = { requireOwnedSshSession(id, sessionId) { if (!allowed || id !== OWNER || sessionId !== 'own-session') throw Error('foreign or closed session'); return session } }
  const workbench = load(`${base}src/sshWorkbench.ts`, { './sshSessionManager': ssh, './sshSystem': {}, './sshFiles': {}, './sshTrust': {}, './sshConfig': {},
    'node:net': { createServer() { const server = new EventEmitter(); server.listen = (port, host, callback) => { server.request = { port, host }; listening = callback; if (!delayListen) callback() }; server.address = () => ({ port: 32109 }); server.close = () => { server.closed = true }; servers.push(server); return server }, createConnection() { throw Error('unexpected external connection') } }
  })
  const open = (input = {}, owner = OWNER) => workbench.sshWorkbench(owner, { action: 'tunnel.open', sessionId: 'own-session', localPort: 0, remoteHost: 'fixture.invalid', remotePort: 5900, ...input })
  return { open, servers, session, workbench, expire() { allowed = false }, finishListen() { listening() } }
}

test('local tunnel port zero binds loopback and returns actual port; reverse zero and foreign owners are rejected', async () => {
  const f = tunnelFixture()
  const result = await f.open()
  assert.equal(result.localPort, 32109)
  assert.deepEqual(f.servers[0].request, { port: 0, host: '127.0.0.1' })
  assert.equal(f.session.cleanup.size, 1)
  await assert.rejects(f.open({}, REMOTE), /foreign/)
  for (const values of [{ direction: 'remote', localPort: 0 }, { localPort: -1 }, { localPort: 65536 }, { remotePort: 0 }]) await assert.rejects(f.open(values), /端口/)
  await f.workbench.sshWorkbench(OWNER, { action: 'tunnel.close', id: result.id })
  assert.equal(f.servers[0].closed, true); assert.equal(f.session.cleanup.size, 0)
})

test('tunnel listening after owner disposal closes immediately and never enters the tunnel registry', async () => {
  const f = tunnelFixture({ delayListen: true }), opening = f.open()
  f.expire(); f.finishListen()
  await assert.rejects(opening, /closed/)
  assert.equal(f.servers[0].closed, true); assert.equal(f.session.cleanup.size, 0)
  assert.deepEqual(await f.workbench.sshWorkbench(OWNER, { action: 'tunnel.list' }), [])
})

function remoteFixture({ socketFailure = false, wsFailure = false, ownSessions = [] } = {}) {
  const calls = [], global = { RdpStore: {}, enest: {
    backend: { async call(method, args) { calls.push([method, args]); if (method === 'ssh.connect') return { sessionId: 'dedicated' }; if (method === 'ssh.listSessions') return ownSessions; if (args[0]?.action === 'tunnel.open') return { id: 'tunnel', localPort: 32109 }; return true } },
    net: { socket: {
      async connect(input) { calls.push(['socket.connect', input]); if (socketFailure) throw Error('socket failure'); return { socketId: 'socket' } },
      async serveWs() { if (wsFailure) throw Error('ws failure'); return { url: 'ws://127.0.0.1:32110' } },
      async close(id) { calls.push(['socket.close', id]) }
    } }
  } }
  load('eNest_plugin/plugins/remote-desktop/src/js/connection.js', { '@enest/ssh-backend/client': { createSshHost } }, { window: global })
  return { api: global.RdpConnection, calls }
}

test('Remote Desktop uses its own backend connection and closes tunnel plus session on downstream setup failures', async () => {
  const profile = { host: 'desktop.invalid', port: 5900, tunnel: { enabled: true, connection: { host: 'ssh.invalid', username: 'fixture', secretRef: 'private-ref' } } }
  for (const config of [{ socketFailure: true }, { wsFailure: true }, {}]) {
    const f = remoteFixture(config)
    if (config.socketFailure || config.wsFailure) await assert.rejects(f.api.openTransport(profile), /failure/)
    else { const transport = await f.api.openTransport(profile); assert.equal(transport.viaTunnel, true); await transport.close(); await transport.close() }
    assert.deepEqual(f.calls[0], ['ssh.connect', [profile.tunnel.connection]])
    assert.equal(f.calls.filter(([method, args]) => method === 'ssh.workbench' && args[0].action === 'tunnel.close').length, 1)
    assert.equal(f.calls.filter(([method]) => method === 'ssh.disconnect').length, 1)
    assert.deepEqual(f.calls.find(([method]) => method === 'socket.connect')[1], { host: '127.0.0.1', port: 32109, sessionId: 'dedicated', timeoutMs: 10000 })
  }
})

test('legacy Remote Desktop SSH references fail clearly; foreign sessions are not borrowed', async () => {
  const f = remoteFixture(), profile = { host: 'desktop.invalid', port: 5900, tunnel: { enabled: true, sshProfileId: 'foreign-profile' } }
  await assert.rejects(f.api.openTransport(profile), /不能跨插件/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.api.openTransport(profile, { sshSessionId: 'foreign-session' }), /不属于远程桌面/)
  assert.deepEqual(f.calls.map(([method]) => method), ['ssh.listSessions'])
})

test('production SSH transport, policies and DTOs are plugin-owned and both frontends use the pure adapter', () => {
  for (const file of ['sshBackendClient.ts', 'sshSessionManager.ts', 'sshWorkbench.ts']) assert.equal(existsSync(new URL(`src/main/ssh/${file}`, root)), false)
  for (const file of ['src/main/ipc/pluginHandlers.ts', 'src/main/ipc/pluginToolsHandlers.ts', 'src/preload/pluginPreload.ts']) assert.doesNotMatch(read(file), /@main\/ssh\/|case ['"]ssh\.|sshWorkbenchPermission/)
  for (const file of ['api.js', 'files.js', 'workbench.js']) assert.match(read(`eNest_plugin/plugins/ssh/src/js/${file}`), /@enest\/ssh-backend\/client/)
  for (const name of ['ssh', 'remote-desktop']) {
    const manifest = JSON.parse(read(`eNest_plugin/plugins/${name}/plugin.json`))
    assert.ok(manifest.permissions.includes('backend.node'))
    assert.equal(manifest.permissions.some(permission => ['ssh.session', 'ssh.exec', 'ssh.sftp'].includes(permission)), false)
  }
  for (const file of ['worker.ts', 'hostBridge.ts', 'contracts.ts', 'sshWorkbench.ts']) assert.doesNotMatch(read(`${base}src/${file}`), /@main\/|@shared\/|hostResult|hostEvent|hostCall:/)
})
