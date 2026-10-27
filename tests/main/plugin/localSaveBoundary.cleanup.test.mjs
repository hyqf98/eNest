import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const owner = 'fixture.generic-file-picker'
const selected = join(tmpdir(), 'enest-virtual-save-fixture', 'selected.csv')

function compile(url, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const module = { exports: {} }
  vm.runInNewContext(outputText, {
    module, exports: module.exports, Buffer,
    require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (name.startsWith('node:')) return require(name)
      throw new Error(`Unexpected fixture import: ${name}`)
    }
  })
  return module.exports
}

function fixture() {
  const calls = [], leases = new Set(), inspected = []
  const acquire = () => {
    const lease = Symbol()
    leases.add(lease)
    return () => leases.delete(lease)
  }
  const info = { isSymbolicLink: () => false, isFile: () => true, size: 7 }
  const api = compile(new URL('../../../src/main/plugin/localFiles.ts', import.meta.url), {
    electron: { dialog: { showSaveDialog(...args) {
      return new Promise(resolve => calls.push({ options: args.at(-1), resolve }))
    } } },
    'node:fs/promises': {
      realpath: async path => { inspected.push(path); return path },
      lstat: async () => info
    },
    '@main/plugin/PluginHost': { pluginHost: { getContainerWindow: () => ({}), acquireWindowInteraction: acquire } },
    '@main/window/createQuickWindow': { acquireQuickInteraction: acquire },
    '@main/plugin/activityRegistry': { acquirePluginActivity: acquire }
  })
  return { api, calls, leases, inspected }
}

test('an omitted or empty filename leaves the native save dialog extension-neutral', async () => {
  for (const options of [undefined, {}, { defaultName: '' }]) {
    const f = fixture()
    const pending = f.api.pickLocalSaveFile(owner, options)
    assert.equal(f.calls.length, 1)
    assert.equal(Object.hasOwn(f.calls[0].options, 'defaultPath'), false)
    f.calls[0].resolve({ canceled: true })
    assert.equal(await pending, null)
    assert.equal(f.leases.size, 0)
    assert.equal(f.inspected.length, 0)
  }
})

test('only the calling plugin supplies a suggested basename, not an initial directory', async () => {
  const f = fixture()
  const pending = f.api.pickLocalSaveFile(owner, { defaultName: '../private/report.csv' })
  assert.equal(f.calls[0].options.defaultPath, 'report.csv')
  f.calls[0].resolve({ canceled: true })
  assert.equal(await pending, null)
  assert.equal(f.leases.size, 0)
})

test('native selection still grants one writable file only to the current owner', async () => {
  const f = fixture()
  const pending = f.api.pickLocalSaveFile(owner, { defaultName: 'report.csv' })
  f.calls[0].resolve({ canceled: false, filePath: selected })
  const handle = await pending
  assert.equal(handle.name, 'selected.csv')
  assert.equal(await f.api.resolveLocalFileHandle(owner, handle.id, 'write'), selected)
  await assert.rejects(f.api.resolveLocalFileHandle('fixture.other-plugin', handle.id, 'write'), /invalid or expired/)
  assert.equal(f.leases.size, 0)
})

test('invalid filename hints are rejected before acquiring UI leases or opening dialogs', async () => {
  const f = fixture()
  for (const defaultName of [null, 1, {}, [], 'x'.repeat(256), 'report\0.csv', '.', '..', '../..', '/']) {
    await assert.rejects(f.api.pickLocalSaveFile(owner, { defaultName }), /invalid default file name/)
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.leases.size, 0)
})

test('cancelling a picker releases leases and does not accept a late native selection', async () => {
  const f = fixture(), controller = new AbortController()
  const pending = f.api.pickLocalSaveFile(owner, {}, { signal: controller.signal })
  const rejected = assert.rejects(pending, /cancelled/)
  assert.equal(f.leases.size, 3)
  controller.abort()
  await rejected
  f.calls[0].resolve({ canceled: false, filePath: selected })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.leases.size, 0)
  assert.equal(f.inspected.length, 0)
})

test('the live shared IPC contract contains no retired pin, region or recorder channels', () => {
  const { IpcChannels } = compile(new URL('../../../src/shared/types/ipc.ts', import.meta.url))
  const retired = [
    'plugin:pin-close', 'plugin:region-confirm', 'plugin:region-cancel',
    'plugin:recorder-started', 'plugin:recorder-failed', 'plugin:recorder-audio-unavailable',
    'plugin:recorder-chunk', 'plugin:recorder-stopped'
  ]
  const values = Object.values(IpcChannels)
  for (const channel of retired) assert.equal(values.includes(channel), false, channel)
  assert.ok(values.includes('plugin:call'), 'the generic plugin capability transport remains')
  assert.ok(values.includes('plugin:event'), 'the generic plugin lifecycle transport remains')
})
