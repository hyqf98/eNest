import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url), module = { exports: {} }
const js = ts.transpileModule(readFileSync(new URL('./httpRequest.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
new Function('require', 'module', 'exports', js)(require, module, module.exports)
const { mwHttp } = module.exports

async function listen(t, server, protocol = 'http') {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return `${protocol}://127.0.0.1:${server.address().port}`
}

test('middleware follows same-origin redirects while preserving configured authentication', async t => {
  let captured
  const url = await listen(t, http.createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/finish' }); res.end(); return }
    captured = req.headers.authorization
    res.end('ok')
  }))
  assert.equal((await mwHttp(`${url}/start`, { basicAuth: { username: 'fixture', password: 'dummy' } })).body, 'ok')
  assert.equal(captured, `Basic ${Buffer.from('fixture:dummy').toString('base64')}`)
})

test('middleware refuses cross-origin redirects before leaking auth, cookies or form bodies', async t => {
  let targetRequests = 0
  const target = await listen(t, http.createServer((_req, res) => { targetRequests++; res.end('unexpected') }))
  const source = await listen(t, http.createServer((_req, res) => { res.writeHead(307, { location: target }); res.end() }))
  for (const auth of [{ basicAuth: { username: 'fixture', password: 'dummy' } }, { bearerToken: 'dummy' }, { headers: { Authorization: 'dummy', Cookie: 'dummy' } }]) {
    await assert.rejects(mwHttp(source, { ...auth, method: 'POST', cookie: 'fixture=dummy', body: 'password=dummy' }), /configured origin/)
  }
  assert.equal(targetRequests, 0)
})

test('middleware validates TLS by default, accepts explicit self-signed opt-in, and rejects downgrade', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'enest-mw-tls-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem')
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('openssl is required to generate a local test certificate'); return }
    throw error
  }
  let targetRequests = 0
  const target = await listen(t, http.createServer((_req, res) => { targetRequests++; res.end('unexpected') }))
  const source = await listen(t, https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.url === '/downgrade') res.writeHead(302, { location: target })
    res.end('ok')
  }), 'https')
  await assert.rejects(mwHttp(source), /self.signed|certificate/i)
  assert.equal((await mwHttp(source, { insecureTls: true })).body, 'ok')
  await assert.rejects(mwHttp(`${source}/downgrade`, { insecureTls: true, bearerToken: 'dummy' }), /downgrade/)
  assert.equal(targetRequests, 0)
})
