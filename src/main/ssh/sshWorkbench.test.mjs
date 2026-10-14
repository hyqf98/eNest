import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const system = load('./sshSystem.ts', { '@main/ssh/sshSessionManager': {} })
const files = load('./sshFiles.ts', { '@main/ssh/sshSessionManager': {}, '@main/plugin/localFiles': {}, '@main/plugin/activityRegistry': {} })
const config = load('./sshConfig.ts', { '@main/plugin/localFiles': {} })
const workbench = load('./sshWorkbench.ts', { '@main/ssh/sshSessionManager': {}, '@main/ssh/sshSystem': system, '@main/ssh/sshFiles': files, '@main/ssh/sshTrust': {}, '@main/ssh/sshConfig': config })

test('workbench permissions reject unknown, inherited and prefix-shaped actions', () => {
  assert.equal(workbench.sshWorkbenchPermission('files.read'), 'ssh.sftp')
  assert.equal(workbench.sshWorkbenchPermission('transfer.remoteCopy'), 'ssh.sftp')
  assert.equal(workbench.sshWorkbenchPermission('config.import'), 'ssh.session')
  for (const key of ['constructor', '__proto__', 'files.deleteAll', 'system.shell', '', 'transfer']) assert.equal(workbench.sshWorkbenchPermission(key), undefined)
})
test('filename validation rejects traversal and remote shell quoting preserves data', () => {
  for (const name of ['', '.', '..', '../a', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => files.safeFileName(name))
  assert.equal(files.safeFileName('文档 $(touch dangerous).txt'), '文档 $(touch dangerous).txt')
  const raw = "a'\n$PATH; echo $(whoami) 中文"
  const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${system.shellQuote(raw)}`], { encoding: 'utf8' })
  assert.equal(result.stdout, raw)
})
test('Linux CPU and network rates use only supplied per-session previous counters', () => {
  const sample = (cpu, rx, tx) => `---CPU---\ncpu ${cpu}\n---MEM---\nMemTotal: 1000 kB\nMemAvailable: 250 kB\n---LOAD---\n1.5 2 3\n---UPTIME---\n60 1\n---DISK---\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 1000 250 750 25% /\n---NET---\neth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0\n`
  const a = system.parseUnixSnapshot(sample('10 0 10 80 0 0 0 0', 1024, 2048), 'linux', undefined, 1000)
  const b = system.parseUnixSnapshot(sample('20 0 20 160 0 0 0 0', 3072, 6144), 'linux', a.counters, 3000)
  assert.equal(a.snapshot.cpuPercent, undefined)
  assert.ok(Math.abs(b.snapshot.cpuPercent - 20) < 0.001)
  assert.equal(b.snapshot.memPercent, 75)
  assert.deepEqual(b.snapshot.net, [{ iface: 'eth0', rxKbps: 1, txKbps: 2 }])
  const fresh = system.parseUnixSnapshot(sample('20 0 20 160 0 0 0 0', 3072, 6144), 'linux', undefined, 3000)
  assert.deepEqual(fresh.snapshot.net, [])
})
test('OpenSSH parser honors first values, wildcard defaults, aliases and ordered hops', () => {
  const { profiles, warnings } = config.parseOpenSshConfig(`Host prod\n HostName app.internal\n User deploy\n IdentityFile "~/.ssh/prod key"\n ProxyJump public,inner\nHost public\n HostName gateway.net\n Port 2222\nHost inner\n HostName gateway.internal\nHost *\n User root\n ServerAliveInterval 45\n Include conf.d/*\n ProxyCommand never-execute\n`, '/tmp/config', 'local')
  assert.equal(profiles.length, 3)
  assert.equal(profiles[0].username, 'deploy')
  assert.equal(profiles[0].authType, 'key')
  assert.equal(profiles[0].jumps[0].host, 'gateway.net')
  assert.equal(profiles[0].jumps[0].port, 2222)
  assert.equal(profiles[0].jumps[1].host, 'gateway.internal')
  assert.equal(profiles[0].keepAliveSec, 45)
  assert.equal(profiles[1].username, 'root')
  assert.equal(warnings.length, 2)
})
test('OpenSSH Match blocks are not applied and ProxyJump cycles are reported', () => {
  const { profiles, warnings } = config.parseOpenSshConfig('Host a\nHostName real\nProxyJump a\nMatch exec malicious\nUser nobody\nHost b\nUser good\n', '/tmp/config', 'local')
  assert.equal(profiles[0].username, 'local')
  assert.equal(profiles[1].username, 'good')
  assert.ok(warnings.some(w => w.includes('循环')))
})
test('host trust pins per plugin and rejects changed and strict unknown keys', () => {
  const storage = new Map(), trust = load('./sshTrust.ts', { '@main/db/pluginStorage': { getPluginStorageValue: (id, key) => storage.get(id + key), setPluginStorageValue: (id, key, value) => storage.set(id + key, value) } })
  trust.verifySshHost('p1', 'host', 22, 'SHA256:a')
  assert.throws(() => trust.verifySshHost('p1', 'host', 22, 'SHA256:b'), /变化/)
  assert.throws(() => trust.verifySshHost('p2', 'host', 22, 'SHA256:a', 'strict'), /严格/)
  trust.verifySshHost('p2', 'host', 22, 'SHA256:b')
  assert.equal(trust.listTrustedHosts('p1')[0].fingerprint, 'SHA256:a')
})
test('temporary shell integration preserves prompt commands and can be enabled twice', () => {
  for (const shell of ['/bin/bash', '/bin/zsh']) {
    const result = spawnSync(shell, ['-c', `PROMPT_COMMAND='echo before'; PS1='prompt'; PROMPT='prompt'; PS0='old'; ${workbench.INTEGRATION}\n${workbench.INTEGRATION}\nprintf 'CHECK:%s|%s' "$PROMPT_COMMAND" "$PS0"`], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    if (shell.includes('bash')) { assert.match(result.stdout, /__enest_prompt;echo before/); assert.equal((result.stdout.match(/133;C/g) || []).length, 1); assert.match(result.stdout, /old$/) }
  }
})
