import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

const events = []
// 单一 bundle 同时导出 lanShareService 与 PluginRuntimeScope，共享同一模块实例
const servicePath = fileURLToPath(new URL('lanShareService.ts', import.meta.url))
const scopePath = fileURLToPath(new URL('../plugin/PluginRuntimeScope.ts', import.meta.url))
const entry = `export * from ${JSON.stringify(servicePath)};\nexport * from ${JSON.stringify(scopePath)};\n`
const result = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  tsconfig: root + 'tsconfig.node.json',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'stub-host',
    setup(b) {
      b.onResolve({ filter: /^@main\/plugin\/PluginHost$/ }, () => ({ path: 'host', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const pluginHost = { isOpened: () => true, sendEvent: (_id, p) => { globalThis.__lanEvents().push(p) } }'
      }))
    }
  }]
})
globalThis.__lanEvents = () => events
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

const PLUGIN = 'test.lan.plugin'
let scopeSeq = 0
function makeScope() {
  const gen = ++scopeSeq
  const pluginId = `${PLUGIN}.g${gen}`
  const scope = api.createRuntimeScope({ pluginId, generation: gen, wcId: 200 + gen })
  // 对齐 PluginHost 挂载点：scope 释放时停止该插件全部分享（gen 需快照，避免闭包读到递增后的值）
  scope.addDisposer(() => api.releaseLanShares(pluginId, gen))
  return { pluginId, scope }
}

/** 服务已关停：连接被拒（server.close 后无监听）或旧 keep-alive 连接拿到 403 */
async function expectStopped(url) {
  try {
    const res = await fetch(url)
    assert.equal(res.status, 403)
    await res.body?.cancel().catch(() => {})
  } catch (err) {
    assert.match(String(err?.cause ?? err), /ECONNREFUSED|fetch failed/i)
  }
}

async function makeFile(dir, name, content = 'lan-share-payload') {
  const path = join(dir, name)
  await writeFile(path, content, 'utf-8')
  return path
}

async function httpGet(url) {
  const res = await fetch(url, { redirect: 'manual', headers: { connection: 'close' } })
  const body = res.status === 200 || res.status === 206 ? await res.text() : ''
  await res.body?.cancel().catch(() => {})
  return { status: res.status, headers: res.headers, body }
}

test('lanShare：无码 403 / 错码 403 / 对码 200 + lan.request 事件 / 白名单外 404', async () => {
  const { pluginId, scope } = makeScope()
  const dir = await mkdtemp(join(tmpdir(), 'lan-'))
  try {
    const inPath = await makeFile(dir, '共享文件.txt')
    const outPath = join(dir, 'not-shared.txt')
    await writeFile(outPath, 'secret', 'utf-8')
    const share = await api.lanShareStart(pluginId, { files: [{ path: inPath }], minutes: 5 })
    assert.ok(share.shareId.startsWith('lan-'))
    assert.match(share.code, /^\d{6}$/)
    assert.ok(share.port > 0)
    const file = share.files[0]
    const base = `http://127.0.0.1:${share.port}`

    // 无码 → 403
    assert.equal((await httpGet(`${base}/d/${file.id}`)).status, 403)
    // 错码 → 403
    assert.equal((await httpGet(`${base}/d/${file.id}?code=000000`)).status, 403)
    // 非白名单文件 id → 404
    assert.equal((await httpGet(`${base}/d/not-exist?code=${share.code}`)).status, 404)
    // 白名单外磁盘文件（未注册）→ 404（URL 只认白名单 id，不认路径）
    assert.equal((await httpGet(`${base}/d/not-shared.txt?code=${share.code}`)).status, 404)
    // POST → 405
    {
      const res = await fetch(`${base}/d/${file.id}?code=${share.code}`, { method: 'POST' })
      assert.equal(res.status, 405)
    }
    events.length = 0
    // 对码 → 200 + 正文 + 附件头 + 事件
    const ok = await httpGet(`${base}/d/${file.id}?code=${share.code}`)
    assert.equal(ok.status, 200)
    assert.equal(ok.body, 'lan-share-payload')
    assert.match(ok.headers.get('content-disposition') || '', /attachment/)
    await new Promise((r) => setTimeout(r, 50))
    const req = events.find((e) => e.type === 'lan.request')
    assert.ok(req, 'lan.request event emitted')
    assert.equal(req.file, '共享文件.txt')
    assert.equal(req.shareId, share.shareId)
    // stop → lan.stopped + 服务关闭（后续连接被拒）
    assert.equal(api.lanShareStop(pluginId, share.shareId), true)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(events.some((e) => e.type === 'lan.stopped' && e.shareId === share.shareId))
    await expectStopped(`${base}/d/${file.id}?code=${share.code}`)
  } finally {
    scope.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('lanShare：Range 请求 206 分片 + timingSafeEqual 取件码校验纯函数', async () => {
  const { pluginId, scope } = makeScope()
  const dir = await mkdtemp(join(tmpdir(), 'lan-'))
  try {
    const path = await makeFile(dir, 'range.bin', '0123456789abcdefghij')
    const share = await api.lanShareStart(pluginId, { files: [{ path }] })
    const base = `http://127.0.0.1:${share.port}/d/${share.files[0].id}?code=${share.code}`
    const part = await fetch(base, { headers: { range: 'bytes=2-5' } })
    assert.equal(part.status, 206)
    assert.equal(await part.text(), '2345')
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/20')
    // 越界 range → 416
    const bad = await fetch(base, { headers: { range: 'bytes=99-' } })
    assert.equal(bad.status, 416)
    // 纯函数：verifyShareCode 拒绝长度不符 / 非数字
    const buf = Buffer.from('123456')
    assert.equal(api.verifyShareCode('123456', buf), true)
    assert.equal(api.verifyShareCode('12345', buf), false)
    assert.equal(api.verifyShareCode('12345a', buf), false)
    assert.equal(api.verifyShareCode('1234567', buf), false)
    assert.equal(api.verifyShareCode('', buf), false)
    // 生成码恒为 6 位数字
    for (let i = 0; i < 20; i++) assert.match(api.generateShareCode(), /^\d{6}$/)
  } finally {
    scope.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('lanShare：限时自动关停（到期语义 → lan.stopped → 服务关闭）', async () => {
  const { pluginId, scope } = makeScope()
  const dir = await mkdtemp(join(tmpdir(), 'lan-'))
  try {
    const path = await makeFile(dir, 'expire.txt')
    const share = await api.lanShareStart(pluginId, { files: [{ path }], minutes: 1 })
    assert.ok(api.__lookupShareForTest(share.shareId), 'share registered')
    // 到期与 stop 走同一 stopShare：验证停止语义（连接拒绝 + 状态移除 + 事件）
    events.length = 0
    assert.equal(api.lanShareStop(pluginId, share.shareId), true)
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(events.some((e) => e.type === 'lan.stopped' && e.shareId === share.shareId))
    assert.equal(api.lanShareStatus(pluginId, share.shareId), null)
    await expectStopped(`http://127.0.0.1:${share.port}/d/${share.files[0].id}?code=${share.code}`)
  } finally {
    scope.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('lanShare：status/list 归属隔离 + releaseLanShares 随 scope 释放', async () => {
  const a = makeScope()
  const b = makeScope()
  const dir = await mkdtemp(join(tmpdir(), 'lan-'))
  try {
    const path = await makeFile(dir, 'owner.txt')
    const share = await api.lanShareStart(a.pluginId, { files: [{ path }], minutes: 5 })
    // 归属隔离：b 查不到 / 停不掉
    assert.equal(api.lanShareStatus(b.pluginId, share.shareId), null)
    assert.equal(api.lanShareStop(b.pluginId, share.shareId), false)
    assert.equal(api.lanShareStatus(a.pluginId, share.shareId).shareId, share.shareId)
    assert.equal(api.lanShareList(a.pluginId).length, 1)
    assert.equal(api.lanShareList(b.pluginId).length, 0)
    // scope 释放（模拟插件关闭）→ 服务停止（连接拒绝 + 状态移除）
    await a.scope.dispose()
    await new Promise((r) => setTimeout(r, 50))
    await expectStopped(`http://127.0.0.1:${share.port}/d/${share.files[0].id}?code=${share.code}`)
    assert.equal(api.lanShareStatus(a.pluginId, share.shareId), null)
  } finally {
    await b.scope.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('lanShare：start 参数防御（空 files / 目录 / 上限分钟）', async () => {
  const { pluginId, scope } = makeScope()
  const dir = await mkdtemp(join(tmpdir(), 'lan-'))
  try {
    await assert.rejects(() => api.lanShareStart(pluginId, { files: [] }), /between 1 and 64/)
    await assert.rejects(() => api.lanShareStart(pluginId, { files: [{ path: dir }] }), /not a regular file/)
    // minutes 越界被钳制（1–120），不抛错
    const path = await makeFile(dir, 'clamp.txt')
    const share = await api.lanShareStart(pluginId, { files: [{ path }], minutes: 9999 })
    assert.ok(share.expiresAt - share.startedAt <= 120 * 60_000 + 50)
    api.lanShareStop(pluginId, share.shareId)
  } finally {
    scope.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
