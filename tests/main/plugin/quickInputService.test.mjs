import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  'test-state':
    'export const state = {current:null, shell:[], sent:[], dismissed:[]};',
  '@main/window/createShellWindow':
    "import {state} from 'test-state';export const sendShellEvent = event => state.shell.push(event);",
}
const output = await build({
  stdin: {
    resolveDir: root,
    contents:
      "export * from '@main/plugin/quickInputService'; export * from '@main/plugin/PluginRuntimeScope'; export {state} from 'test-state';",
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
const api = await import(
  'data:text/javascript;base64,' +
    Buffer.from(output.outputFiles[0].text).toString('base64')
)
const { state } = api,
  scopes = []
function scope(pluginId, generation = 1) {
  const s = api.createRuntimeScope({
    pluginId,
    generation,
    wcId: generation * 10,
  })
  scopes.push(s)
  return s
}
test.beforeEach(() => {
  api.clearQuickInput()
  Object.assign(state, {
    current: 'plugin',
    shell: [],
    sent: [],
    dismissed: [],
  })
  api.bindQuickInputHost({
    current: () => state.current,
    send: (id, event) => state.sent.push({ id, event }),
    dismiss: (id) => state.dismissed.push(id),
  })
})
test.afterEach(async () => {
  for (const s of scopes.splice(0)) await s.dispose()
  api.clearQuickInput()
})
test('输入仅交给当前容器中的同代插件，旧 generation 消息无效', async () => {
  const first = scope('plugin', 1)
  assert.equal(
    api.configureQuickInput('plugin', { placeholder: '搜索', value: '旧查询' }),
    true,
  )
  assert.equal(
    api.handleQuickInput({
      type: 'change',
      pluginId: 'plugin',
      generation: 9,
      value: '错代',
    }),
    false,
  )
  assert.equal(api.getQuickInputState().value, '旧查询')
  await first.dispose()
  assert.equal(api.getQuickInputState(), null)
  scope('plugin', 2)
  api.configureQuickInput('plugin', { placeholder: '新输入', value: '' })
  assert.equal(
    api.handleQuickInput({
      type: 'action',
      pluginId: 'plugin',
      generation: 1,
      action: 'submit',
    }),
    false,
  )
  assert.equal(
    api.handleQuickInput({
      type: 'change',
      pluginId: 'plugin',
      generation: 2,
      value: '有效查询',
    }),
    true,
  )
  assert.deepEqual(state.sent.at(-1), {
    id: 'plugin',
    event: { type: 'quick-input-change', value: '有效查询' },
  })
})
test('Escape 先清查询再退出插件，清空时不会误退出', () => {
  scope('plugin')
  api.configureQuickInput('plugin', { placeholder: '搜索', value: 'query' })
  assert.equal(api.escapeQuickInput('plugin'), true)
  assert.equal(api.getQuickInputState().value, '')
  assert.equal(state.dismissed.length, 0)
  assert.deepEqual(state.sent.at(-1).event, {
    type: 'quick-input-change',
    value: '',
  })
  assert.equal(api.escapeQuickInput('plugin'), true)
  assert.equal(api.getQuickInputState(), null)
  assert.deepEqual(state.dismissed, ['plugin'])
})
test('迁移容器立即解绑，其他插件无权重配；重复配置不累加释放器', () => {
  const s = scope('plugin')
  scope('other')
  assert.equal(
    api.configureQuickInput('other', { placeholder: '覆盖', value: '' }),
    false,
  )
  api.configureQuickInput('plugin', { placeholder: 'a', value: '1' })
  api.configureQuickInput('plugin', { placeholder: 'b', value: '2' })
  assert.equal(s.diagnostics().resources, 1)
  state.current = 'other'
  assert.equal(api.getQuickInputState(), null)
  assert.equal(
    api.handleQuickInput({
      type: 'action',
      pluginId: 'plugin',
      generation: 1,
      action: 'submit',
    }),
    false,
  )
  assert.equal(api.escapeQuickInput('plugin'), false)
})
test('输入有边界，关闭中的实例拒绝配置，未知动作被拒绝', () => {
  const s = scope('plugin')
  api.configureQuickInput('plugin', {
    placeholder: 'x'.repeat(1000),
    value: 'y'.repeat(110000),
  })
  assert.equal(api.getQuickInputState().placeholder.length, 160)
  assert.equal(api.getQuickInputState().value.length, 100000)
  assert.equal(
    api.handleQuickInput({
      type: 'action',
      pluginId: 'plugin',
      generation: 1,
      action: 'arbitrary',
    }),
    false,
  )
  s.markClosing()
  assert.equal(
    api.configureQuickInput('plugin', { placeholder: 'z', value: '' }),
    false,
  )
})

test('independent compact inputs keep their values and route updates to their own chrome', async () => {
  const a = scope('mini-a'), b = scope('mini-b')
  scope('plugin')
  const detached = new Set(['mini-a', 'mini-b']), published = [], focused = []
  api.bindQuickInputHost({
    current: () => state.current,
    owns: id => id === state.current || detached.has(id),
    detached: id => detached.has(id),
    publish: (id, event) => published.push({ id, event }),
    focus: id => focused.push(id),
    send: (id, event) => state.sent.push({ id, event }),
    dismiss: id => state.dismissed.push(id)
  })
  api.configureQuickInput('mini-a', { value: 'alpha' })
  api.configureQuickInput('mini-b', { value: 'beta' })
  api.configureQuickInput('plugin', { value: 'global' })
  api.clearQuickInput()
  assert.equal(api.getQuickInputState('mini-a').value, 'alpha')
  assert.equal(api.getQuickInputState('mini-b').value, 'beta')
  assert.equal(api.escapeQuickInput('mini-a'), true)
  assert.equal(api.getQuickInputState('mini-a').value, '')
  assert.deepEqual(focused, ['mini-a'])
  api.escapeQuickInput('mini-a')
  assert.deepEqual(focused, ['mini-a', 'mini-a'])
  assert.deepEqual(state.dismissed, [])
  assert.equal(api.getQuickInputState('mini-b').value, 'beta')
  assert.equal(published.at(-1).id, 'mini-a')
  await a.dispose()
  assert.equal(api.getQuickInputState('mini-a'), null)
  assert.equal(api.getQuickInputState('mini-b').generation, b.owner.generation)
})

test('a compact input survives placement migration but is released on changing layout to shell', () => {
  scope('plugin')
  let detached = false, mode = 'quick'
  api.bindQuickInputHost({
    current: () => state.current,
    owns: id => mode === 'quick' && (id === state.current || detached && id === 'plugin'),
    detached: () => detached,
    send: (id, event) => state.sent.push({ id, event }),
    dismiss: id => state.dismissed.push(id)
  })
  api.configureQuickInput('plugin', { value: 'keep me' })
  detached = true; state.current = null
  assert.equal(api.getQuickInputState('plugin').value, 'keep me')
  mode = 'shell'
  assert.equal(api.getQuickInputState('plugin'), null)
})
