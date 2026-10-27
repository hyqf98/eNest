import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const fixturePlugin = (adapters) => ({ name: 'background-settings-fixture', setup(b) {
  b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
} })

const [storeBuild, preloadBuild, mockBuild] = await Promise.all([
  build({
    stdin: { contents: "export { SettingsStore } from '@main/settings/SettingsStore'", resolveDir: process.cwd() },
    tsconfig: 'tsconfig.node.json', bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [fixturePlugin({
      electron: 'export const nativeTheme={shouldUseDarkColors:false};',
      '@main/paths/pathsService': 'export const getDefaultSettingsPath=()=>"/not-created/enest-background-settings.json";export const setAppPathsRoot=()=>{};',
      '@main/window/createShellWindow': 'export const sendShellEvent=()=>{};',
      '@main/db/sqliteService': "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');export const kvStore={getDatabase:()=>db,initDatabase:async()=>{},getBackend:()=> 'sqlite'};",
    })],
  }),
  build({
    entryPoints: ['src/preload/shellPreload.ts'], tsconfig: 'tsconfig.node.json', bundle: true,
    write: false, platform: 'node', format: 'iife',
    plugins: [fixturePlugin({ electron: `
      export const contextBridge={exposeInMainWorld:(name,api)=>globalThis[name]=api};
      export const ipcRenderer={invoke:(...args)=>globalThis.invoke(...args),on:()=>{},send:()=>{},removeListener:()=>{}};
      export const webUtils={};
    ` })],
  }),
  build({
    entryPoints: ['src/renderer/services/shellApi.ts'], tsconfig: 'tsconfig.web.json', bundle: true,
    write: false, platform: 'browser', format: 'iife', globalName: 'fixtureApi',
  }),
])
const { SettingsStore } = await import('data:text/javascript;base64,' + Buffer.from(storeBuild.outputFiles[0].text).toString('base64'))

async function realBridge() {
  const store = new SettingsStore()
  await store.load()
  const context = vm.createContext({
    process: { isMainFrame: true },
    invoke: async (channel, value) => {
      if (channel === 'shell:get-theme') return { ...store.getTheme(), packs: [] }
      if (channel === 'shell:set-theme') return store.setTheme(value)
      throw new Error(`unexpected IPC: ${channel}`)
    },
  })
  vm.runInContext(preloadBuild.outputFiles[0].text, context)
  return { store, api: context.enestShell }
}

function mockBridge(saved = new Map()) {
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: (key) => saved.delete(key),
    },
    URL, setTimeout, clearTimeout, structuredClone, console,
  })
  vm.runInContext(mockBuild.outputFiles[0].text, context)
  return { api: context.fixtureApi.shellApi, saved }
}

for (const selection of ['none', 'plugin:com.example.uninstalled:future-pack:unknown-effect']) {
  test(`preload and SQLite preserve ${selection} across writes and reload`, async () => {
    const { store, api } = await realBridge()
    await api.setTheme('dark', undefined, { backgroundEffect: selection })
    assert.equal((await api.getTheme()).backgroundEffect, selection)
    await api.setTheme('light', { '--accent': '#00ffaa' })
    assert.equal((await api.getTheme()).backgroundEffect, selection, 'unrelated theme changes preserve selection')
    store.flushNow()
    const restored = new SettingsStore()
    await restored.load()
    assert.equal(restored.getTheme().backgroundEffect, selection)
  })

  test(`browser mock preserves ${selection} across a new shell API instance`, async () => {
    const { api, saved } = mockBridge()
    await api.setTheme('dark', undefined, { backgroundEffect: selection })
    assert.equal((await api.getTheme()).backgroundEffect, selection)
    await api.setTheme('light', {})
    assert.equal((await mockBridge(saved).api.getTheme()).backgroundEffect, selection)
  })
}

test('explicit undefined clears selection through preload and persistence', async () => {
  const { store, api } = await realBridge()
  await api.setTheme('dark', undefined, { backgroundEffect: 'none' })
  await api.setTheme('dark', undefined, { backgroundEffect: undefined })
  store.flushNow()
  const restored = new SettingsStore()
  await restored.load()
  assert.equal(restored.getTheme().backgroundEffect, undefined)
})

test('native theme endpoint rejects malformed background selections atomically', async () => {
  const { store, api } = await realBridge()
  await api.setTheme('dark', undefined, { backgroundEffect: 'orbit' })
  for (const backgroundEffect of [null, false, 1, [], {}, '', '   ', 'bad\nvalue', 'a'.repeat(1025)]) {
    await assert.rejects(api.setTheme('light', undefined, { backgroundEffect }), /invalid background effect/)
    assert.equal(store.getTheme().mode, 'dark')
    assert.equal(store.getTheme().backgroundEffect, 'orbit')
  }
  store.flushNow()
})

test('full settings endpoint also rejects malformed background selections', async () => {
  const { store } = await realBridge()
  await store.setTheme({ backgroundEffect: 'orbit' })
  try {
    for (const backgroundEffect of [null, false, 1, [], {}, '', '   ', 'bad\nvalue', 'a'.repeat(1025)]) {
      await assert.rejects(store.setAll({ theme: { backgroundEffect } }), /invalid background effect/)
      assert.equal(store.getTheme().backgroundEffect, 'orbit')
    }
  } finally { store.flushNow() }
})

test('browser mock rejects malformed background selections before persistence', async () => {
  const { api } = mockBridge()
  await api.setTheme('dark', undefined, { backgroundEffect: 'orbit' })
  for (const backgroundEffect of [null, false, 1, [], {}, '', '   ', 'bad\nvalue', 'a'.repeat(1025)]) {
    await assert.rejects(api.setTheme('light', undefined, { backgroundEffect }), /invalid background effect/)
    assert.equal((await api.getTheme()).backgroundEffect, 'orbit')
  }
})
