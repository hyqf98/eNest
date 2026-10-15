/** Opt-in real OpenSSH test. No system daemon, user SSH config or external host is used.
 * ENEST_LOCAL_SSH_SMOKE=1 node --test src/main/ssh/sshLocalOpenSsh.test.mjs
 * ENEST_LOCAL_SSH_OUTPUT optionally preserves public evidence after temporary keys are removed. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import ts from 'typescript'

const run = promisify(execFile), require = createRequire(import.meta.url)
const pluginRequire = createRequire(new URL('../../../eNest_plugin/packages/ssh-backend/package.json', import.meta.url))
function load(file, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(file.startsWith('./ssh') ? '../../../eNest_plugin/packages/ssh-backend/src/' + file.slice(2) : file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => name === './hostBridge' ? Object.assign({}, ...Object.entries(mocks).filter(([key]) => key.startsWith('@main/') && !key.startsWith('@main/ssh/') && !key.endsWith('PluginRuntimeScope')).map(([,value]) => value)) : name === './runtimeScope' ? mocks['@main/plugin/PluginRuntimeScope'] : mocks[name] ?? mocks[name.replace('./', '@main/ssh/')] ?? (name === 'ssh2' ? pluginRequire(name) : require(name)), module, module.exports)
  return module.exports
}
async function waitFor(read, accepts, label) {
  for (let i = 0; i < 150; i++) { const value = read(); if (accepts(value)) return value; await delay(40) }
  throw new Error(label)
}
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'"

test('temporary loopback OpenSSH authenticates with a file handle and streams SFTP content using real host services', {
  skip: process.env.ENEST_LOCAL_SSH_SMOKE !== '1', timeout: 45000
}, async () => {
  const sshd = process.env.ENEST_TEST_SSHD || '/usr/sbin/sshd'
  const sftpServer = process.platform === 'darwin' ? '/usr/libexec/sftp-server' : '/usr/lib/openssh/sftp-server'
  assert.ok(existsSync(sshd), 'sshd executable required; this test never installs or enables a system service')
  assert.ok(existsSync(sftpServer), 'OpenSSH sftp-server executable required')
  const directory = await mkdtemp(join(tmpdir(), 'enest-local-openssh-'))
  const pluginId = 'com.enest.smoke.localssh', storage = new Map(), events = []
  const scopeApi = load('../plugin/PluginRuntimeScope.ts'), scope = scopeApi.createRuntimeScope({ pluginId, generation: 1, wcId: 9901 })
  const activity = { acquirePluginActivity: () => scope.acquireActivity('local OpenSSH operation') }
  const host = { pluginHost: { sendEvent: (_id, event) => events.push(event) } }
  const localFiles = load('../plugin/localFiles.ts', {
    electron: { app: {}, dialog: {}, nativeImage: {}, shell: {} },
    '@main/plugin/PluginHost': host, '@main/window/createQuickWindow': { acquireQuickInteraction: () => () => {} },
    '@main/plugin/activityRegistry': activity
  })
  const trust = load('./sshTrust.ts', { '@main/db/pluginStorage': {
    getPluginStorageValue: (id, key) => storage.get(id + ':' + key),
    setPluginStorageValue: (id, key, value) => storage.set(id + ':' + key, value)
  } })
  const manager = load('./sshSessionManager.ts', {
    electron: { dialog: {} }, '@main/plugin/PluginRuntimeScope': scopeApi,
    '@main/plugin/PluginPermissions': { authorizePluginPermission: async () => { throw new Error('unexpected optional permission') } },
    '@main/plugin/localFiles': localFiles, '@main/ssh/sshProxy': load('./sshProxy.ts'),
    '@main/vault/secretVault': { resolveSecret: () => '' },
    '@main/ssh/commandDict': { SSH_COMMAND_DICT: [], SSH_SUBCOMMANDS: {}, detectDangerous: () => null, lookupDictCmd: () => [] },
    '@main/window/createShellWindow': { getMainWindow: () => null }, '@main/plugin/PluginHost': host,
    '@main/logs/logService': { logInfo() {}, logWarn() {} }, '@main/ssh/sshTrust': trust,
    '@main/ssh/sshSystem': { releaseSystemState() {} }, '@main/plugin/activityRegistry': activity,
    '@main/window/createQuickWindow': { acquireQuickInteraction: () => () => {} }
  })
  const files = load('./sshFiles.ts', { '@main/ssh/sshSessionManager': manager, '@main/plugin/localFiles': localFiles, '@main/plugin/activityRegistry': activity })
  let daemon, serverLog = '', exitPromise, failure
  const evidence = { platform: process.platform, server: 'OpenSSH', loopbackOnly: true, authentication: 'temporary Ed25519 key through production LocalFileHandle', tests: [], boundary: 'Real SSH/SFTP transport and host services; permission UI, vault and event delivery use isolated fixtures. Not Linux resource/multi-hop/agent validation.' }
  try {
    const version = await run(sshd, ['-V']); evidence.serverVersion = (version.stderr || version.stdout).trim()
    for (const name of ['host-key', 'client-key']) await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)])
    await writeFile(join(directory, 'authorized_keys'), await readFile(join(directory, 'client-key.pub')), { mode: 0o600 })
    const remote = join(directory, 'remote'), downloads = join(directory, 'downloads')
    await mkdir(remote); await mkdir(downloads)
    // Restrict this test identity to a harmless command, an empty shell and SFTP.
    // The wrapper bypasses interactive user shell profiles for the SSH shell channel.
    const wrapper = join(directory, 'session-wrapper')
    await writeFile(wrapper, `#!/bin/sh\nunset ENV BASH_ENV\ncase "$SSH_ORIGINAL_COMMAND" in\n  '') exec /bin/sh ;;\n  'printf enest-local-command-ok') printf enest-local-command-ok ;;\n  'internal-sftp') exec ${quote(sftpServer)} -d ${quote(remote)} ;;\n  *) exit 126 ;;\nesac\n`)
    await chmod(wrapper, 0o700)
    const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
    const config = join(directory, 'sshd_config')
    await writeFile(config, [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${directory}/host-key`,
      `AuthorizedKeysFile ${directory}/authorized_keys`, `PidFile ${directory}/sshd.pid`,
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
      'UsePAM no', 'StrictModes no', 'UseDNS no', 'PermitRootLogin no', `AllowUsers ${userInfo().username}`,
      'PermitUserRC no', 'AllowAgentForwarding no', 'AllowTcpForwarding no', 'X11Forwarding no',
      `ForceCommand ${wrapper}`, 'Subsystem sftp internal-sftp', 'LogLevel VERBOSE', ''
    ].join('\n'))
    await run(sshd, ['-t', '-f', config])
    daemon = spawn(sshd, ['-D', '-e', '-f', config], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    exitPromise = new Promise(resolve => daemon.once('exit', (code, signal) => resolve({ code, signal })))
    daemon.on('error', error => { serverLog += error.message })
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', value => { serverLog = (serverLog + value).slice(-12000) })
    await waitFor(() => serverLog, value => value.includes(`Server listening on 127.0.0.1 port ${port}`), 'isolated sshd did not begin listening')
    const publicKey = (await readFile(join(directory, 'host-key.pub'), 'utf8')).split(' ')[1]
    const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64').replace(/=+$/, '')
    storage.set(pluginId + ':ssh.knownHosts.v1', [{ host: '127.0.0.1', port, fingerprint, firstSeen: Date.now() }])
    const key = await localFiles.grantLocalFile(pluginId, join(directory, 'client-key'))
    const input = { host: '127.0.0.1', port, username: userInfo().username, authType: 'key', privateKeyHandleId: key.id, fingerprintPolicy: 'strict' }
    const connection = await manager.sshConnect(pluginId, input), sessionId = connection.sessionId
    assert.equal(connection.fingerprint, fingerprint)
    assert.equal((await manager.sshExec(pluginId, { sessionId, command: 'printf enest-local-command-ok' })).stdout, 'enest-local-command-ok')
    evidence.tests.push('public-key handle authentication with pre-pinned host fingerprint', 'harmless command through production sshExec')
    const textPath = join(remote, '中文 note.txt')
    const first = await files.writeRemoteFile(pluginId, sessionId, { path: textPath, content: 'first local note\n' })
    assert.equal((await files.readRemoteFile(pluginId, sessionId, textPath)).content, 'first local note\n')
    await files.writeRemoteFile(pluginId, sessionId, { path: textPath, content: 'updated local note ✓\n', expectedHash: first.hash })
    await assert.rejects(files.writeRemoteFile(pluginId, sessionId, { path: textPath, content: 'stale', expectedHash: first.hash }), /已被修改/)
    evidence.tests.push('SFTP read/edit with content-hash conflict rejection')
    const payload = Buffer.alloc(256 * 1024, 79); Buffer.from('eNest local SFTP ✓\n').copy(payload)
    const uploadPath = join(directory, 'upload.bin'), remotePath = join(remote, 'upload.bin')
    await writeFile(uploadPath, payload)
    const upload = await localFiles.grantLocalFile(pluginId, uploadPath), download = await localFiles.grantLocalFile(pluginId, downloads, { writable: true })
    assert.equal((await manager.sshSftpUpload(pluginId, { sessionId, localHandleId: upload.id, remotePath })).ok, true)
    assert.equal((await manager.sshSftpDownload(pluginId, { sessionId, localDirectoryHandleId: download.id, remotePath })).ok, true)
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    assert.equal(digest(await readFile(join(downloads, 'upload.bin'))), digest(payload))
    assert.equal(digest(await readFile(remotePath)), digest(payload))
    await assert.rejects(manager.sshSftpUpload(pluginId, { sessionId, localPath: uploadPath, remotePath }), /raw local paths/)
    await assert.rejects(manager.sshSftpDownload(pluginId, { sessionId, localPath: downloads, remotePath }), /raw local paths/)
    await assert.rejects(localFiles.resolveLocalFileHandle('com.other.plugin', upload.id), /invalid or expired/)
    evidence.bytes = payload.length; evidence.sha256 = digest(payload)
    evidence.tests.push('256 KiB SFTP upload/download with real file capabilities and matching SHA256', 'raw local paths and cross-plugin handle access rejected')
    manager.sshDisconnect(pluginId, sessionId)
    assert.deepEqual(manager.sshListSessions(pluginId), [])
    const reconnected = await manager.sshConnect(pluginId, input)
    assert.equal((await manager.sshExec(pluginId, { sessionId: reconnected.sessionId, command: 'printf enest-local-command-ok' })).stdout, 'enest-local-command-ok')
    manager.sshDisconnect(pluginId, reconnected.sessionId)
    assert.deepEqual(manager.sshListSessions(pluginId), [])
    assert.equal(scope.activityCount, 0)
    localFiles.releaseLocalFiles(pluginId)
    await assert.rejects(localFiles.resolveLocalFileHandle(pluginId, key.id), /invalid or expired/)
    evidence.tests.push('disconnect/reconnect, zero active sessions/leases and released handles invalidated')
  } catch (error) { failure = error }
  finally {
    manager.releaseSshSessions(pluginId); scope.markClosing(); await scope.dispose(); localFiles.releaseLocalFiles(pluginId)
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      try { process.kill(-daemon.pid, 'SIGTERM') } catch {}
      await Promise.race([exitPromise, delay(2000)])
      if (daemon.exitCode === null && daemon.signalCode === null) { try { process.kill(-daemon.pid, 'SIGKILL') } catch {}; await exitPromise }
    }
    evidence.serverStopped = !daemon || daemon.exitCode !== null || daemon.signalCode !== null
    await rm(directory, { recursive: true, force: true })
    evidence.temporaryFilesRemoved = !existsSync(directory)
  }
  if (failure) throw new Error(`${failure.stack || failure}\nIsolated sshd log:\n${serverLog}`)
  assert.equal(evidence.serverStopped, true); assert.equal(evidence.temporaryFilesRemoved, true)
  if (process.env.ENEST_LOCAL_SSH_OUTPUT) {
    await mkdir(dirname(process.env.ENEST_LOCAL_SSH_OUTPUT), { recursive: true })
    await writeFile(process.env.ENEST_LOCAL_SSH_OUTPUT, JSON.stringify(evidence, null, 2))
  }
  console.log('Isolated OpenSSH evidence:', JSON.stringify(evidence))
})
