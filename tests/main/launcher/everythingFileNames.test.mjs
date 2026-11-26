import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../../../src/main/launcher/everythingFileNames.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const require = createRequire(import.meta.url)
function fixture(route, status = 200) {
  const requests = [], proxyLookups = [], api = {}
  const payload = { totalResults: 3, results: [{ type: 'file', name: 'report.txt', path: 'C:\\docs' }, { type: 'file', name: 'different.txt', path: 'C:\\report' }, { type: 'file', name: 'report.txt', path: '\\\\other-host\\share' }] }
  Function('exports', 'require', code)(api, id => {
    if (id === 'electron') return { session: { defaultSession: { resolveProxy: async url => { proxyLookups.push(url); return route } } } }
    if (id !== 'node:http') return require(id)
    return { get(options, receive) {
      requests.push(options)
      const body = Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { statusCode: status, headers: { 'content-type': 'application/json', location: 'http://other-host/' } })
      queueMicrotask(() => receive(body)); return new EventEmitter()
    } }
  })
  return { ...api, requests, proxyLookups }
}

test('Everything queries only the chosen loopback port without credentials or path matches', async () => {
  const { everythingFileNames, requests, proxyLookups } = fixture('DIRECT')
  assert.deepEqual(await everythingFileNames('report', 8654, 96, new AbortController().signal), ['C:\\docs\\report.txt'])
  assert.deepEqual(proxyLookups, ['http://127.0.0.1:8654/'])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].hostname, '127.0.0.1'); assert.equal(requests[0].port, 8654)
  assert.ok(requests[0].path.startsWith('/?')); assert.equal(requests[0].headers.Authorization, undefined)
})

test('invalid port, cancellation, proxy routing and redirects never send a lookup to another host', async () => {
  const direct = fixture('DIRECT', 302), controller = new AbortController()
  await assert.rejects(direct.everythingFileNames('report', 65536, 96, controller.signal))
  await assert.rejects(direct.everythingFileNames('report', 80, 96, AbortSignal.abort()))
  assert.equal(direct.requests.length, 0)
  const proxied = fixture('PROXY external:8080')
  await assert.rejects(proxied.everythingFileNames('report', 80, 96, controller.signal)); assert.equal(proxied.requests.length, 0)
  await assert.rejects(direct.everythingFileNames('report', 80, 96, controller.signal)); assert.equal(direct.requests.length, 1)
})
