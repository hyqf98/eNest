import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const absPath = fileURLToPath(new URL('src/main/sys/sysInspectService.ts', 'file://' + root))

const result = await build({
  stdin: { contents: readFileSync(absPath, 'utf8'), resolveDir: root, sourcefile: absPath, loader: 'ts' },
  tsconfig: root + 'tsconfig.node.json',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{ name: 'permission', setup(b) {
    b.onResolve({ filter: /^@main\/plugin\/PluginPermissions$/ }, () => ({ path: 'permission', namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const confirmPluginOperation = async () => { throw new Error("native confirmation denied") }' }))
    b.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'exec', namespace: 'exec' }))
    b.onLoad({ filter: /.*/, namespace: 'exec' }, () => ({ contents: 'export const execFile = (_c,_a,_o,cb) => cb(null,"fixture process identity")' }))
  }}]
})
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
const { parsePsOutput, parseLsofOutput, parseSsOutput } = api

test('parsePsOutput: darwin ps -axo 标准输出', () => {
  const stdout = `  PID  %CPU %MEM   RSS USER      COMM
    1   0.0  0.0 128888 root      launchd
  501  12.5  1.2  83888 haijun    WindowServer
 9999   0.1  0.3  51200 haijun    /Applications/eNest.app/Contents/MacOS/eNest
`
  const rows = parsePsOutput(stdout)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { pid: 1, pcpu: 0, pmem: 0, rss: 128888, user: 'root', command: 'launchd' })
  assert.equal(rows[1].pid, 501)
  assert.equal(rows[1].pcpu, 12.5)
  assert.equal(rows[1].pmem, 1.2)
  assert.equal(rows[1].command, 'WindowServer')
  assert.equal(rows[2].command, '/Applications/eNest.app/Contents/MacOS/eNest')
})

test('parsePsOutput: Linux ps -eo（comm 带参数的 args 形态）', () => {
  const stdout = `  PID %CPU %MEM   RSS USER     COMMAND
    1  0.0  0.1 10240 root     /sbin/init splash
 812  1.1  2.0 40960 user     /usr/lib/code-server --port 8080
`
  const rows = parsePsOutput(stdout)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].command, '/sbin/init splash')
  assert.equal(rows[1].pid, 812)
  assert.equal(rows[1].rss, 40960)
})

test('parsePsOutput: 空行 / 非法行 / 表头跳过', () => {
  const stdout = `  PID %CPU %MEM   RSS USER COMM

 garbage line without columns
   42  0.5  0.1  2048 u   sh
`
  const rows = parsePsOutput(stdout)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 42)
  assert.equal(rows[0].command, 'sh')
})

test('parsePsOutput: 多空格用户名列不塌缩（至少 6 列形态）', () => {
  // pid pcpu pmem rss user comm —— comm 是单列；user 列不允许空格（ps 保证）
  const rows = parsePsOutput('PID %CPU %MEM RSS USER COMM\n7 0 0 100 _windowserver windowserver\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].user, '_windowserver')
})

test('parseLsofOutput: darwin lsof LISTEN 标准输出', () => {
  const stdout = `COMMAND   PID  USER   FD   TYPE   DEVICE SIZE/OFF NODE NAME
rapportd  501 haijun   10u  IPv4  0x1234      0t0  TCP *:54711 (LISTEN)
rapportd  501 haijun   11u  IPv6  0x5678      0t0  TCP [fe80:1]:54712 (LISTEN)
sshd     1234 root    3u  IPv4  0x9abc      0t0  TCP 127.0.0.1:2222 (LISTEN)
`
  const rows = parseLsofOutput(stdout)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { command: 'rapportd', pid: 501, user: 'haijun', protocol: 'TCP', address: '0.0.0.0', port: 54711, name: '*:54711' })
  assert.equal(rows[1].address, 'fe80:1')
  assert.equal(rows[2].address, '127.0.0.1')
  assert.equal(rows[2].port, 2222)
})

test('parseLsofOutput: 同 PID 同端口去重，IPv4/IPv6 双栈保留', () => {
  const stdout = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node    999 u    22u IPv4 0x1 0t0 TCP *:3000 (LISTEN)
node    999 u    23u IPv6 0x2 0t0 TCP *:3000 (LISTEN)
node    999 u    24u IPv4 0x3 0t0 TCP *:3001 (LISTEN)
`
  const rows = parseLsofOutput(stdout)
  // *:3000 IPv4 与 IPv6 同 NAME 形态 → 去重为 1；3001 保留
  const names = rows.map(r => r.name)
  assert.equal(names.filter(n => n === '*:3000').length, 1)
  assert.ok(names.includes('*:3001'))
})

test('parseSsOutput: Linux ss -ltnp 输出', () => {
  const stdout = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128    127.0.0.1:6379       0.0.0.0:*         users:(("redis-server",pid=777,fd=6))
LISTEN 0      511    *:80                 *:*               users:(("nginx",pid=888,fd=6))
`
  const rows = parseSsOutput(stdout)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].address, '127.0.0.1')
  assert.equal(rows[0].port, 6379)
  assert.equal(rows[0].pid, 777)
  assert.equal(rows[0].command, 'redis-server')
  assert.equal(rows[1].port, 80)
})

test('parseSsOutput: 非法行跳过', () => {
  const rows = parseSsOutput('State Recv-Q\njunk\n')
  assert.equal(rows.length, 0)
})

test('sysKill 守卫：未确认 / PID 1 / 自身进程全部拒绝（不真正发信号）', async () => {
  await assert.rejects(() => api.sysKill('p', 123, 'TERM', false), /native confirmation denied/)
  await assert.rejects(() => api.sysKill('p', 123, 'TERM', true), /native confirmation denied/)
  await assert.rejects(() => api.sysKill('p', 1, 'TERM', true), /pid <= 1/)
  await assert.rejects(() => api.sysKill('p', 0, 'TERM', true), /pid <= 1/)
  await assert.rejects(() => api.sysKill('p', -5, 'TERM', true), /pid <= 1/)
})
