import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
class Channel extends EventEmitter {
  stderr = new EventEmitter()
  destroyed = false
  signal() {}
  close() { this.destroyed = true }
  destroy() { this.destroyed = true }
  end() { this.destroyed = true }
}
function fixture({ deferJump = false, deferShell = false, deferExec = false, deferSftp = false } = {}) {
  const clients = [], events = [], transferStreams = []
  let hostActivities = 0
  const scopeApi = load('../plugin/PluginRuntimeScope.ts')
  const scope = scopeApi.createRuntimeScope({ pluginId: 'plugin', generation: 1, wcId: 42 })
  class Client extends EventEmitter {
    destroyed = false
    shellChannel = new Channel()
    execChannel = new Channel()
    sftpChannel = { ended: false, end() { this.ended = true } }
    sftpCalls = 0
    constructor() { super(); clients.push(this) }
    connect(config) { this.config = config; if (!(deferJump && config.host === 'jump')) queueMicrotask(() => this.emit('ready')); return this }
    forwardOut(_src, _port, _host, _targetPort, callback) { callback(null, new Channel()) }
    shell(_options, callback) { this.shellCallback = callback; if (!deferShell) callback(null, this.shellChannel) }
    exec(_command, callback) { this.execCallback = callback; if (!deferExec) callback(null, this.execChannel) }
    sftp(callback) { this.sftpCalls++; this.sftpCallback = callback; if (!deferSftp) callback(null, this.sftpChannel) }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close') } }
    end() { this.destroy() }
  }
  const api = load('./sshSessionManager.ts', {
    ssh2: { Client }, electron: { dialog: {} },
    'node:fs': { ...require('node:fs'), createWriteStream: () => { const stream = new PassThrough(); transferStreams.push(stream); return stream } },
    '@main/plugin/PluginPermissions':{authorizePluginPermission:async()=>{throw new Error('permission denied')}},'@main/plugin/localFiles':{resolveLocalFileHandle:async()=>'/tmp/selected-file',resolveLocalDirectoryTarget:async()=>'/tmp/selected-file'},'@main/plugin/PluginRuntimeScope': scopeApi,
    '@main/ssh/sshProxy': load('./sshProxy.ts'), '@main/vault/secretVault': { resolveSecret: () => 'secret' },
    '@main/ssh/commandDict': { SSH_COMMAND_DICT: [], SSH_SUBCOMMANDS: {}, detectDangerous: () => null, lookupDictCmd: () => [] },
    '@main/window/createShellWindow': { getMainWindow: () => null },
    '@main/plugin/PluginHost': { pluginHost: { sendEvent: (...args) => events.push(args) } },
    '@main/logs/logService': { logInfo() {}, logWarn() {} },
    '@main/ssh/sshTrust': { verifySshHost() {} },
    '@main/ssh/sshSystem': { systemSnapshot: async () => ({}), releaseSystemState() {} },
    '@main/plugin/activityRegistry': { acquirePluginActivity: () => { hostActivities++; let done = false; return () => { if (!done) { done = true; hostActivities-- } } } },
    '@main/window/createQuickWindow': { acquireQuickInteraction: () => () => {} }
  })
  const connect = input => api.sshConnect('plugin', { host: 'target', username: 'user', ephemeralSecret: 'secret', ...input })
  return { api, scope, scopeApi, clients, events, connect, transferStreams, hostActivities: () => hostActivities }
}

test('closing during jump connection destroys both clients and releases the opening lease', async () => {
  const f = fixture({ deferJump: true })
  const pending = f.connect({ jump: { host: 'jump', username: 'jump-user', ephemeralSecret: 'secret' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.scope.activityCount, 1)
  f.scope.markClosing()
  await assert.rejects(pending, /closing/)
  assert.equal(f.clients.length, 2)
  assert.ok(f.clients.every(client => client.destroyed))
  assert.equal(f.scope.activityCount, 0)
  assert.deepEqual(f.api.sshListSessions('plugin'), [])
})

test('a shell callback arriving after close cannot create an activity or emit into the replacement', async () => {
  const f = fixture({ deferShell: true })
  const pending = f.connect()
  await new Promise(resolve => setImmediate(resolve))
  f.scope.markClosing()
  await assert.rejects(pending, /closing/)
  f.clients[0].shellCallback(null, f.clients[0].shellChannel)
  f.clients[0].shellChannel.emit('data', Buffer.from('late data'))
  assert.equal(f.clients[0].shellChannel.destroyed, true)
  assert.equal(f.hostActivities(), 0)
  assert.equal(f.events.length, 0)
})

test('disconnect cleans every independent resource when one cleanup throws', async () => {
  const f = fixture()
  const info = await f.connect()
  const session = f.api.requireOwnedSshSession('plugin', info.sessionId)
  let cleaned = 0
  session.cleanup.add(() => { throw new Error('first cleanup failed') })
  session.cleanup.add(() => cleaned++)
  f.api.sshDisconnect('plugin', info.sessionId)
  assert.equal(cleaned, 1)
  assert.equal(f.clients[0].destroyed, true)
  assert.equal(f.scope.activityCount, 0)
  assert.equal(f.hostActivities(), 0)
})

test('exec timeout closes the underlying channel and output memory is bounded', async () => {
  const f = fixture()
  const info = await f.connect()
  await assert.rejects(f.api.sshExec('plugin', { sessionId: info.sessionId, command: 'long task', timeoutMs: 100 }), /timeout/)
  assert.equal(f.clients[0].execChannel.destroyed, true)
  f.clients[0].execChannel = new Channel()
  const pending = f.api.sshExec('plugin', { sessionId: info.sessionId, command: 'large output' })
  f.clients[0].execChannel.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1))
  await assert.rejects(pending, /8 MiB/)
  assert.equal(f.clients[0].execChannel.destroyed, true)
  f.api.sshDisconnect('plugin', info.sessionId)
})

test('pending exec is rejected on close and its late channel is destroyed', async () => {
  const f = fixture({ deferExec: true })
  const info = await f.connect()
  const pending = f.api.sshExec('plugin', { sessionId: info.sessionId, command: 'pending channel' })
  f.scope.markClosing()
  await assert.rejects(pending, /closing/)
  f.clients[0].execCallback(null, f.clients[0].execChannel)
  assert.equal(f.clients[0].execChannel.destroyed, true)
})

test('concurrent SFTP creation is coalesced and a late handle is closed', async () => {
  const f = fixture({ deferSftp: true })
  const info = await f.connect()
  const session = f.api.requireOwnedSshSession('plugin', info.sessionId)
  const first = f.api.getSftp(session), second = f.api.getSftp(session)
  assert.equal(f.clients[0].sftpCalls, 1)
  f.scope.markClosing()
  await Promise.all([assert.rejects(first, /closing/), assert.rejects(second, /closing/)])
  f.clients[0].sftpCallback(null, f.clients[0].sftpChannel)
  assert.equal(f.clients[0].sftpChannel.ended, true)
})

test('late generation-specific release cannot disconnect a newly opened runtime', async () => {
  const f = fixture()
  await f.connect()
  await f.scope.dispose()
  const successor = f.scopeApi.createRuntimeScope({ pluginId: 'plugin', generation: 2, wcId: 43 })
  const info = await f.connect()
  f.api.releaseSshSessions('plugin', 1)
  assert.equal(f.api.sshListSessions('plugin')[0].sessionId, info.sessionId)
  assert.equal(f.clients[1].destroyed, false)
  await successor.dispose()
})

test('closing a download destroys both the remote stream and the local destination', async () => {
  const f = fixture()
  const info = await f.connect()
  const source = new PassThrough()
  Object.assign(f.clients[0].sftpChannel, { stat: (_path, callback) => callback(null, { size: 1024 }), createReadStream: () => source })
  const transfer = f.api.sshSftpDownload('plugin', { sessionId: info.sessionId, remotePath: '/sample', localDirectoryHandleId: 'selected-directory' })
  await new Promise(resolve => setImmediate(resolve))
  f.scope.markClosing()
  const result = await transfer
  assert.equal(result.ok, false)
  assert.equal(source.destroyed, true)
  assert.equal(f.transferStreams[0].destroyed, true)
})

test('SSH rejects arbitrary key/agent paths and requires a separate host-agent grant',async()=>{
  const f=fixture()
  for(const input of [{privateKeyPath:'/etc/passwd'},{agentPath:'/tmp/agent'},{authType:'agent'}]) {
    await assert.rejects(f.connect(input),/raw credential paths|permission denied/)
  }
  assert.equal(f.clients.length,0)
  assert.equal(f.scope.activityCount,0)
  await f.scope.dispose()
})
