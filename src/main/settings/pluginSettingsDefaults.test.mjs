import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state': 'export const state={persisted:{},events:[]};',
  '@main/db/sqliteService':
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');export const kvStore={getDatabase:()=>db};export const runInTransaction=(_db,fn)=>{db.exec('BEGIN');try{fn();db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}};",
  '@main/logs/logService':
    'export const logInfo=()=>{};export const logWarn=()=>{};',
  '@main/window/createShellWindow':
    "import {state} from 'test-state';export const sendShellEvent=e=>state.events.push(e);",
  '@main/window/orbRailViews':
    'export const refreshOrbRailContribEntries=()=>{};',
  '@main/settings/SettingsStore':
    "import {state} from 'test-state';export const settingsStore={getPluginSettings:id=>state.persisted[id]||{}};",
}
const output = await build({
  stdin: {
    resolveDir: root,
    contents:
      "export {contributionRegistry as registry} from '@main/contrib/ContributionRegistry';export {PluginSettingsBridge} from '@main/settings/PluginSettingsBridge';export {state} from 'test-state';",
  },
  tsconfig: join(root, 'tsconfig.node.json'),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'mocks',
      setup(b) {
        b.onResolve({ filter: /.*/ }, ({ path }) =>
          path in adapters ? { path, namespace: 'test' } : undefined,
        )
        b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
          contents: adapters[path],
        }))
      },
    },
  ],
})
const { registry, PluginSettingsBridge, state } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(output.outputFiles[0].text).toString('base64')
)
test('未启动插件可读取声明式 defaults，false 与 zero 不能回退为默认值', () => {
  registry.registerManifestContributes('defaults', {
    settings: [
      {
        id: 'prefs',
        title: '偏好',
        items: [
          { key: 'auto', type: 'switch', label: '自动', default: true },
          { key: 'count', type: 'number', label: '数量', default: 10 },
        ],
      },
    ],
  })
  const bridge = new PluginSettingsBridge()
  assert.equal(bridge.get('defaults', 'auto'), true)
  assert.equal(bridge.get('defaults', 'count'), 10)
  bridge.set('defaults', 'auto', false)
  bridge.set('defaults', 'count', 0)
  assert.equal(bridge.get('defaults', 'auto'), false)
  assert.equal(bridge.get('defaults', 'count'), 0)
  assert.equal(bridge.get('other', 'auto'), undefined)
  registry.unregisterBySource('defaults')
})
test('注册偏好保留已保存值，页入口不成为可读默认值，变更通知含声明', () => {
  state.persisted.saved = { auto: false, count: 0 }
  state.events = []
  const bridge = new PluginSettingsBridge()
  bridge.register('saved', {
    id: 'preferences',
    title: '偏好',
    items: [
      { key: 'auto', type: 'switch', label: '自动', default: true },
      { key: 'count', type: 'number', label: '数量', default: 10 },
      {
        key: 'advanced',
        type: 'page',
        label: '高级',
        default: 'not-a-value',
        entry: { code: 'settings' },
      },
    ],
  })
  assert.equal(bridge.get('saved', 'auto'), false)
  assert.equal(bridge.get('saved', 'count'), 0)
  assert.equal(bridge.get('saved', 'advanced'), undefined)
  const event = state.events.findLast((e) => e.type === 'settings-sections')
  assert.equal(
    event.sections.find((s) => s.pluginId === 'saved').items.length,
    3,
  )
  bridge.unregister('saved')
  assert.equal(bridge.get('saved', 'auto'), undefined)
  assert.equal(state.events.at(-1).type, 'contributions-changed')
})
