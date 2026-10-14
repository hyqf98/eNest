import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, createConnection } from 'node:net'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import ts from 'typescript'
import { startTestProxy } from './sshProxyTestUtils.mjs'
const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const enabled = !!process.env.ENEST_TEST_SSH_PORT

test('real OpenSSH: shell, Linux resources, SFTP editing/transfers, multi-hop, tunnels and cleanup', { skip: !enabled, timeout: 60000 }, async t => {
  const pluginId = 'ssh-integration', events = [], storage = new Map(), handles = new Map(), manager = {}, system = {}
  const scopeApi = load('../plugin/PluginRuntimeScope.ts'), scope = scopeApi.createRuntimeScope({ pluginId, generation: 1, wcId: 999 })
  const activity = { acquirePluginActivity: () => () => {} }
  const localFiles = { resolveLocalFileHandle: async (_id, handle) => { if (!handles.has(handle)) throw Error('unknown local handle'); return handles.get(handle) }, createLocalExport: async () => ({ exportId: 'test' }) }
  const trust = load('./sshTrust.ts', { '@main/db/pluginStorage': { getPluginStorageValue: (id, key) => storage.get(id + key), setPluginStorageValue: (id, key, value) => storage.set(id + key, value) } })
  Object.assign(system, load('./sshSystem.ts', { '@main/ssh/sshSessionManager': manager }))
  Object.assign(manager, load('./sshSessionManager.ts', { electron: { dialog: {} }, '@main/plugin/PluginRuntimeScope': scopeApi, '@main/ssh/sshProxy': load('./sshProxy.ts'), '@main/vault/secretVault': { resolveSecret: (id, ref) => id === pluginId && ref === 'proxy-test-ref' ? 'proxy-secret' : '' }, '@main/ssh/commandDict': { SSH_COMMAND_DICT: [], SSH_SUBCOMMANDS: {}, detectDangerous: () => null, lookupDictCmd: () => [] }, '@main/window/createShellWindow': { getMainWindow: () => null }, '@main/plugin/PluginHost': { pluginHost: { sendEvent: (_id, event) => events.push(event) } }, '@main/logs/logService': { logInfo() {}, logWarn() {} }, '@main/ssh/sshTrust': trust, '@main/ssh/sshSystem': system, '@main/plugin/activityRegistry': activity, '@main/window/createQuickWindow': { acquireQuickInteraction: () => () => {} } }))
  const files = load('./sshFiles.ts', { '@main/ssh/sshSessionManager': manager, '@main/plugin/localFiles': localFiles, '@main/plugin/activityRegistry': activity })
  const config = load('./sshConfig.ts', { '@main/plugin/localFiles': localFiles })
  const workbench = load('./sshWorkbench.ts', { '@main/ssh/sshSessionManager': manager, '@main/ssh/sshSystem': system, '@main/ssh/sshFiles': files, '@main/ssh/sshTrust': trust, '@main/ssh/sshConfig': config })
  const input = { host: process.env.ENEST_TEST_SSH_HOST || '127.0.0.1', port: Number(process.env.ENEST_TEST_SSH_PORT), username: process.env.ENEST_TEST_SSH_USER || 'root', ephemeralSecret: process.env.ENEST_TEST_SSH_PASSWORD, authType: 'password' }
  const local = await mkdtemp(join(tmpdir(), 'enest-ssh-test-')), remote = '/tmp/enest-integration-' + Date.now()
  const keyComment = 'enest-integration-' + Date.now(); let agentPid
  t.after(async () => { const existing = manager.sshListSessions(pluginId)[0]; if (existing) { try { await manager.sshExec(pluginId,{sessionId:existing.sessionId,command:`rm -rf '${remote}'; sed -i '/${keyComment}/d' ~/.ssh/authorized_keys 2>/dev/null || true`}) } catch {} }; for (const session of manager.sshListSessions(pluginId)) manager.sshDisconnect(pluginId, session.sessionId); scope.markClosing(); if(agentPid)try{process.kill(agentPid)}catch{};await rm(local, { recursive: true, force: true }) })
  const first = await manager.sshConnect(pluginId, input), sessionId = first.sessionId
  const exec = command => manager.sshExec(pluginId, { sessionId, command })
  await exec(`mkdir -p '${remote}/source' '${remote}/target'`)
  for (const type of ['http-connect', 'socks5']) {
    const proxy = await startTestProxy(type, { username: 'proxy-user', password: 'proxy-secret', destination: { host: input.host, port: input.port } })
    try {
      const transport = { type, host: '127.0.0.1', port: proxy.port, username: 'proxy-user', secretRef: 'proxy-test-ref' }
      const direct = await manager.sshConnect(pluginId, { ...input, proxy: transport })
      assert.equal((await manager.sshExec(pluginId, { sessionId: direct.sessionId, command: 'printf proxy-ok' })).stdout, 'proxy-ok')
      manager.sshDisconnect(pluginId, direct.sessionId)
      const jumped = await manager.sshConnect(pluginId, { ...input, port: 22, jumps: [input], proxy: transport })
      assert.equal((await manager.sshExec(pluginId, { sessionId: jumped.sessionId, command: 'printf jump-ok' })).stdout, 'jump-ok')
      manager.sshDisconnect(pluginId, jumped.sessionId)
      assert.deepEqual(proxy.targets, [input.host + ':' + input.port, input.host + ':' + input.port])
      assert.deepEqual(proxy.credentials, ['proxy-user:proxy-secret', 'proxy-user:proxy-secret'])
    } finally { await proxy.close() }
  }
  t.diagnostic('HTTP CONNECT and SOCKS5 with vault authentication, direct SSH and first-hop-only proxy routing passed')
  if (process.env.ENEST_TEST_SSH_AGENT === '1') {
    const keyPath = join(local,'identity'),socketPath=join(local,'agent.sock')
    execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',keyPath,'-C',keyComment])
    const publicKey=await readFile(keyPath+'.pub','utf8')
    await exec(`mkdir -p ~/.ssh; chmod 700 ~/.ssh; printf '%s\\n' ${system.shellQuote(publicKey.trim())} >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys`)
    const byKey=await manager.sshConnect(pluginId,{...input,ephemeralSecret:undefined,authType:'key',privateKeyPath:keyPath});manager.sshDisconnect(pluginId,byKey.sessionId)
    const agentOutput=execFileSync('ssh-agent',['-a',socketPath,'-s'],{encoding:'utf8'});agentPid=Number(/SSH_AGENT_PID=(\d+)/.exec(agentOutput)?.[1]);assert.ok(agentPid)
    execFileSync('ssh-add',[keyPath],{env:{...process.env,SSH_AUTH_SOCK:socketPath},stdio:'pipe'})
    const byAgent=await manager.sshConnect(pluginId,{...input,ephemeralSecret:undefined,authType:'agent',agentPath:socketPath});manager.sshDisconnect(pluginId,byAgent.sessionId)
    await exec(`sed -i '/${keyComment}/d' ~/.ssh/authorized_keys`)
    t.diagnostic('real private-key and isolated SSH Agent authentication passed')
  }
  t.diagnostic('shell and exec connected')
  const sample = await system.systemSnapshot(pluginId, sessionId)
  assert.equal(sample.platform, 'linux'); assert.ok(sample.memTotal > 0); assert.ok(sample.disks.length)
  assert.ok((await system.listProcesses(pluginId, sessionId)).some(p => p.name.includes('sshd')))
  assert.ok((await system.listPorts(pluginId, sessionId)).some(p => p.port === 22))
  t.diagnostic('Linux resources and ports read')
  const file = `${remote}/source/中文 ' config.txt`
  const initial = await files.writeRemoteFile(pluginId, sessionId, { path: file, content: 'first\n' })
  const read = await files.readRemoteFile(pluginId, sessionId, file)
  assert.equal(read.content, 'first\n'); assert.equal(read.hash, initial.hash)
  await files.writeRemoteFile(pluginId, sessionId, { path: file, content: 'second\n', expectedHash: initial.hash })
  await assert.rejects(files.writeRemoteFile(pluginId, sessionId, { path: file, content: 'stale', expectedHash: initial.hash }), /已被修改/)
  await assert.rejects(files.renameBatch(pluginId, sessionId, [{ path: file, name: '../escape' }]))
  const copied = await files.copyOrMoveRemote(pluginId, { action: 'files.copy', sessionId, paths: [file], destination: `${remote}/target` }); assert.ok(!copied[0].error)
  await writeFile(join(local, 'upload.txt'), 'upload ✓')
  handles.set('upload', join(local, 'upload.txt')); handles.set('downloads', local)
  async function done(task) { for (let i=0;i<200;i++) { const current=files.listTransfers(pluginId).find(x=>x.id===task.id); if(!['running','queued'].includes(current.status)){ assert.equal(current.status,'completed',current.error); return current } await delay(25) } throw Error('transfer timeout') }
  await done(await files.startTransfer(pluginId, { action:'transfer.upload',sessionId,localHandleId:'upload',destination:`${remote}/source/upload.txt` }))
  await done(await files.startTransfer(pluginId, { action:'transfer.download',sessionId,localHandleId:'downloads',path:file }))
  assert.equal(await readFile(join(local,"中文 ' config.txt"),'utf8'),'second\n')
  const largeData = Buffer.alloc(8 * 1024 * 1024, 79), largePath = join(local, 'large.bin')
  await writeFile(largePath, largeData); handles.set('large', largePath)
  const hash = buffer => createHash('sha256').update(buffer).digest('hex')
  async function interrupt(task, disconnectId) {
    for (let i=0; i<2000; i++) {
      const current = files.listTransfers(pluginId).find(x => x.id === task.id)
      if (current.transferred > 131072 && current.status === 'running') { if(disconnectId) manager.sshDisconnect(pluginId,disconnectId); else files.cancelTransfer(pluginId, task.id); break }
      if (!['running','queued'].includes(current.status)) throw Error('transfer finished before interruption')
      await delay(1)
    }
    for (let i=0;i<1000;i++) { const current=files.listTransfers(pluginId).find(x=>x.id===task.id); if(current.status==='cancelled'){assert.ok(current.resumable);return current} await delay(2) }
    throw Error('cancel did not settle')
  }
  const interruptedUpload = await interrupt(await files.startTransfer(pluginId, {action:'transfer.upload',sessionId,localHandleId:'large',destination:`${remote}/source/large.bin`}))
  await done(await files.retryTransfer(pluginId, interruptedUpload.id))
  assert.equal((await exec(`sha256sum '${remote}/source/large.bin'`)).stdout.split(' ')[0], hash(largeData))
  const downloadDirectory = join(local, 'resume-download'); await (await import('node:fs/promises')).mkdir(downloadDirectory); handles.set('resume-download', downloadDirectory)
  const interruptedDownload = await interrupt(await files.startTransfer(pluginId, {action:'transfer.download',sessionId,localHandleId:'resume-download',path:`${remote}/source/large.bin`}))
  await done(await files.retryTransfer(pluginId, interruptedDownload.id))
  assert.equal(hash(await readFile(join(downloadDirectory,'large.bin'))), hash(largeData))
  const beforeReconnect=await manager.sshConnect(pluginId,input)
  const interruptedConnection=await interrupt(await files.startTransfer(pluginId,{action:'transfer.upload',sessionId:beforeReconnect.sessionId,localHandleId:'large',destination:`${remote}/source/reconnect.bin`}),beforeReconnect.sessionId)
  const afterReconnect=await manager.sshConnect(pluginId,input)
  await done(await files.retryTransfer(pluginId,interruptedConnection.id,false,afterReconnect.sessionId))
  assert.equal((await exec(`sha256sum '${remote}/source/reconnect.bin'`)).stdout.split(' ')[0],hash(largeData));manager.sshDisconnect(pluginId,afterReconnect.sessionId)
  t.diagnostic('8 MB upload/download interrupted and actual disconnect/reconnect resumed with matching SHA256')
  const completions = await manager.sshCompletionSuggest(pluginId, {sessionId,line:'cat 中文',cwd:`${remote}/source`})
  assert.ok(completions.items.some(x=>x.kind==='path' && x.insertText.includes('中文')))
  const pid = Number((await exec('sleep 60 >/dev/null 2>&1 & echo $!')).stdout.trim())
  const processInfo = (await system.listProcesses(pluginId,sessionId)).find(p=>p.pid===pid)
  assert.ok(processInfo?.startTime)
  await assert.rejects(system.signalProcess(pluginId,sessionId,pid,'wrong-identity','TERM'),/变化/)
  await system.signalProcess(pluginId,sessionId,pid,processInfo.startTime,'TERM')
  t.diagnostic('SFTP edit, copy, upload, download passed')
  const second = await manager.sshConnect(pluginId,input)
  await done(await files.startRemoteCopy(pluginId,{action:'transfer.remoteCopy',sessionId:second.sessionId,sourceSessionId:sessionId,path:`${remote}/source`,destination:`${remote}/cross-server`}))
  assert.equal((await files.readRemoteFile(pluginId,second.sessionId,`${remote}/cross-server/upload.txt`)).content,'upload ✓')
  t.diagnostic('cross-server stream copy passed')
  const hop = { ...input, port:22, host:'127.0.0.1' }
  const through = await manager.sshConnect(pluginId,{...hop,jumps:[input,hop]})
  assert.equal((await manager.sshExec(pluginId,{sessionId:through.sessionId,command:'printf through-two-hops'})).stdout,'through-two-hops')
  manager.sshDisconnect(pluginId,through.sessionId)
  t.diagnostic('two-hop connection passed')
  const probe=createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve)); const localPort=probe.address().port; await new Promise(resolve=>probe.close(resolve))
  const tunnel=await workbench.sshWorkbench(pluginId,{action:'tunnel.open',sessionId,localPort,remoteHost:'127.0.0.1',remotePort:22})
  const banner=await new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:localPort});socket.setTimeout(4000);socket.once('data',data=>{resolve(data.toString());socket.destroy()});socket.once('error',reject);socket.once('timeout',()=>{socket.destroy();reject(Error('tunnel timeout'))})})
  assert.match(banner,/SSH-2.0/)
  await workbench.sshWorkbench(pluginId,{action:'tunnel.close',id:tunnel.id})
  manager.sshWrite(pluginId,sessionId,'bash --noprofile --norc\r');await delay(100)
  await workbench.sshWorkbench(pluginId,{action:'shell.integrate',sessionId});await delay(100)
  manager.sshWrite(pluginId,sessionId,'printf integration-ok\r');await delay(150)
  assert.ok(events.some(e=>e.type==='ssh.data' && String(e.data).includes('133;B')),'OSC prompt marker expected')
  await exec(`rm -rf '${remote}'`)
  manager.sshDisconnect(pluginId,sessionId);manager.sshDisconnect(pluginId,second.sessionId)
  assert.deepEqual(manager.sshListSessions(pluginId),[])
})
