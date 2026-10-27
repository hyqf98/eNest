import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../../src/main/plugin/pluginBackendControl.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function fixture() {
  let current = true, pid = 100, rows = [{ pid: 100, parentPid: 1, startedAt: 1000123, metric: 'footprint' }], sample
  const grants = new Set(), registrations = new Set()
  const scope = { owner: { pluginId: 'fixture.plugin', generation: 1 }, signal: new AbortController().signal,
    isClosing: false, isCurrent: () => current, acquireActivity: () => () => {} }
  const imports = {
    electron: { session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } },
    './pluginSessionPolicy': { allowPluginEndpoint(...args) { const grant = { args }; grants.add(grant); return () => grants.delete(grant) } },
    './pluginProcessMemory': { sampleProcessMemory: () => sample ? sample() : Promise.resolve(rows) },
    './pluginOwnedProcesses': { registerPluginProcess(value) { registrations.add(value); return () => registrations.delete(value) } },
    './pluginBackendCapabilities': { PluginBackendCapabilities: class { supports() { return false } beginClose() {} async dispose() {} } }
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, URL, process: { platform: 'darwin' },
    require(name) { assert.ok(name in imports, name); return imports[name] } })
  const control = new module.exports.PluginBackendControl(scope, () => pid)
  return { control, grants, registrations, expire() { current = false }, setRows(value) { rows = value },
    setPid(value) { pid = value }, setSample(value) { sample = value } }
}
const endpoint = { token: 'fixture-endpoint', pid: 100, url: 'ws://127.0.0.1:34567/transport', kind: 'webSocket' }

test('a precise live backend can expose its own WebSocket without a redundant child process', async () => {
  const f = fixture()
  await f.control.request('endpoint.allow', endpoint)
  assert.equal(f.grants.size, 1)
  assert.equal(f.registrations.size, 0)
  assert.deepEqual([...f.grants][0].args, ['fixture.plugin', endpoint.url, 'webSocket'])
  await f.control.beginClose()
  assert.equal(f.grants.size, 0)
  await f.control.request('endpoint.revoke', { token: endpoint.token })
})

test('endpoint kind/protocol/authority and uncertain or unrelated PID are rejected', async () => {
  for (const patch of [
    { kind: 'script' }, { url: 'https://127.0.0.1:34567/transport' }, { url: 'ws://example.com:34567/transport' },
    { url: 'ws://127.0.0.1/transport' }, { url: 'ws://user@127.0.0.1:34567/transport' },
    { url: 'ws://127.0.0.1:34567/transport#fragment' }, { pid: 999 }
  ]) {
    const f = fixture()
    await assert.rejects(f.control.request('endpoint.allow', { ...endpoint, ...patch }))
    assert.equal(f.grants.size, 0)
  }
  const coarse = fixture()
  coarse.setRows([{ pid: 100, parentPid: 1, startedAt: 1000000, metric: 'resident' }])
  await assert.rejects(coarse.control.request('endpoint.allow', endpoint), /owner not confirmed/)
})

test('late endpoint registration cannot survive backend closing or PID replacement', async () => {
  for (const replace of [false, true]) {
    const f = fixture(); let done
    f.setSample(() => new Promise(resolve => { done = resolve }))
    const pending = f.control.request('endpoint.allow', endpoint)
    if (replace) f.setPid(101); else f.expire()
    done([{ pid: 100, parentPid: 1, startedAt: 1000123, metric: 'footprint' }])
    await assert.rejects(pending)
    assert.equal(f.grants.size, 0)
  }
})

test('a confirmed descendant still supports existing subFrame endpoints and revocation', async () => {
  const f = fixture()
  f.setRows([{ pid: 100, parentPid: 1, startedAt: 1000123, metric: 'footprint' }, { pid: 101, parentPid: 100, startedAt: 1000222, metric: 'footprint' }])
  await f.control.request('endpoint.allow', { ...endpoint, pid: 101, kind: 'subFrame', url: 'http://127.0.0.1:34568/' })
  assert.equal(f.registrations.size, 1)
  await f.control.request('endpoint.revoke', { token: endpoint.token })
  assert.equal(f.grants.size, 0)
})
