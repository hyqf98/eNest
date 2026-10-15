import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = {
  grants: new Map(), manifests: new Map(), prompts: [], writes: [], polling: 0, ignoreAbort: false
}
globalThis.__permissionFixture = fixture

const bundle = await build({
  stdin: {
    contents: `
      export * from '@main/plugin/PermissionService';
      export { createRuntimeScope } from '@main/plugin/PluginRuntimeScope';
      export { BUILTIN_PLUGIN_CAPABILITIES } from '@shared/pluginPermissionPolicy';
      export { permissionLabel } from '@shared/permissionLabels';
    `,
    resolveDir: root
  },
  tsconfig: root + 'tsconfig.node.json',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'permission-fixture',
    setup(builder) {
      builder.onResolve({ filter: /^@main\/plugin\/(PermissionService|PluginRuntimeScope)$/ }, ({ path }) => ({
        path: root + 'src/main/plugin/' + path.split('/').at(-1) + '.ts'
      }))
      builder.onResolve({ filter: /^(electron|@main\/)/ }, ({ path }) => ({ path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        const f = globalThis.__permissionFixture;
        const win = { isDestroyed: () => false, isMinimized: () => false, show: () => {} };
        export const pluginHost = { getContainerWindow: () => win, acquireWindowInteraction: () => { f.dialogLeases = (f.dialogLeases || 0) + 1; let done = false; return () => { if (!done) { done = true; f.dialogLeases--; } } } };
        export const pluginRegistry = { getManifest: id => f.manifests.get(id) };
        export const getMainWindow = () => win;
        export const acquireQuickInteraction = () => () => {};
        export const settingsStore = {
          getPermissionGrant: (id, permission) => f.grants.get(id + ':' + permission) ?? 'ask',
          setPermissionGrant: async (id, permission, value) => {
            f.writes.push({ id, permission, value });
            f.grants.set(id + ':' + permission, value);
          }
        };
        export const logWarn = () => {};
        export const revalidateClipboardPolling = () => f.polling++;
        export const dialog = {
          showMessageBox: (_win, options) => new Promise(resolve => {
            const prompt = { options, resolve };
            f.prompts.push(prompt);
            options.signal.addEventListener('abort', () => {
              if (!f.ignoreAbort) resolve({ response: 0 });
            }, { once: true });
          })
        };
      ` }))
    }
  }]
})

const { PermissionService, createRuntimeScope, BUILTIN_PLUGIN_CAPABILITIES, permissionLabel } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
)
const scopes = []
let generation = 0

function plugin(id, permissions, name = id) {
  fixture.manifests.set(id, { id, name, permissions })
  const scope = createRuntimeScope({ pluginId: id, generation: ++generation, wcId: generation })
  scopes.push(scope)
  return scope
}

function grant(id, permission, value) {
  fixture.grants.set(id + ':' + permission, value)
}

const flush = () => new Promise(resolve => setImmediate(resolve))

async function promptAt(index = 0) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (fixture.prompts[index]) return fixture.prompts[index]
    await flush()
  }
  throw new Error(`Missing native permission prompt ${index + 1}`)
}

function listedPermissions(prompt) {
  return prompt.options.detail.split('\n').filter(line => line.startsWith('• '))
}

afterEach(async () => {
  await Promise.all(scopes.splice(0).map(scope => scope.dispose()))
  for (const prompt of fixture.prompts) prompt.resolve({ response: 0 })
  await flush()
  assert.equal(fixture.dialogLeases || 0, 0, 'native dialog relocation leases are released')
  fixture.grants.clear()
  fixture.manifests.clear()
  fixture.prompts.length = 0
  fixture.writes.length = 0
  fixture.polling = 0
  fixture.ignoreAbort = false
})

test('one native consent includes all declared undecided sensitive capabilities', async () => {
  const service = new PermissionService()
  const scope = plugin('grouped', ['config.agent.read', 'net.fetch', 'config.agent.read', 'storage.local', 'config.agent.write', 'notify', 'future.capability'], '示例插件')
  grant('grouped', 'config.agent.write', 'deny')
  grant('grouped', 'notify', 'allow')

  const read = service.request('grouped', 'config.agent.read', 'read file')
  const prompt = await promptAt()
  assert.equal(scope.activityCount, 1)
  assert.equal(service.resolveRequest('forged', 'always'), false)
  assert.match(prompt.options.message, /示例插件/)
  assert.deepEqual(listedPermissions(prompt), ['config.agent.read', 'net.fetch'].map(permission => `• ${permissionLabel(permission)}`))
  assert.equal(prompt.options.defaultId, 0)
  assert.equal(prompt.options.cancelId, 0)

  prompt.resolve({ response: 1 })
  assert.equal(await read, true)
  assert.equal(await service.request('grouped', 'net.fetch', 'fetch'), true)
  assert.equal(await service.request('grouped', 'config.agent.write', 'write'), false)
  assert.equal(fixture.prompts.length, 1)
  assert.equal(scope.activityCount, 0)
  assert.equal(fixture.writes.length, 0)
  assert.equal(fixture.grants.get('grouped:config.agent.write'), 'deny')
})

test('concurrent requests deduplicate the same permission and share the grouped decision', async () => {
  const service = new PermissionService()
  const scope = plugin('concurrent', ['config.agent.read', 'config.agent.write', 'net.fetch'])
  const read = service.request('concurrent', 'config.agent.read', 'read')
  assert.equal(service.request('concurrent', 'config.agent.read', 'read again'), read)
  const write = service.request('concurrent', 'config.agent.write', 'write')
  const fetch = service.request('concurrent', 'net.fetch', 'fetch')
  const prompt = await promptAt()
  assert.equal(fixture.prompts.length, 1)
  prompt.resolve({ response: 1 })
  assert.deepEqual(await Promise.all([read, write, fetch]), [true, true, true])
  assert.equal(fixture.prompts.length, 1)
  assert.equal(scope.activityCount, 0)
})

test('allow for this run is reused without persistence and expires when close or hibernate recreates the scope', async () => {
  const service = new PermissionService()
  let scope = plugin('temporary', ['config.agent.read'])
  for (const index of [0, 1, 2]) {
    const request = service.request('temporary', 'config.agent.read', 'read')
    ;(await promptAt(index)).resolve({ response: 1 })
    assert.equal(await request, true)
    assert.equal(await service.request('temporary', 'config.agent.read', 'same run'), true)
    assert.equal(fixture.prompts.length, index + 1)
    assert.equal(fixture.grants.size, 0)
    if (index < 2) {
      scope.markClosing()
      assert.equal(await service.request('temporary', 'config.agent.read', 'closing run'), false)
      await scope.dispose()
      scope = plugin('temporary', ['config.agent.read'])
    }
  }
  assert.equal(fixture.writes.length, 0)
})

test('remembered consent persists the group and is reused by a new service and runtime', async () => {
  const service = new PermissionService()
  const scope = plugin('remembered', ['config.agent.read', 'clipboard.history'])
  const request = service.request('remembered', 'config.agent.read', 'read')
  ;(await promptAt()).resolve({ response: 2 })
  assert.equal(await request, true)
  assert.deepEqual(fixture.writes, [
    { id: 'remembered', permission: 'config.agent.read', value: 'allow' },
    { id: 'remembered', permission: 'clipboard.history', value: 'allow' }
  ])
  assert.equal(fixture.polling, 1)

  await scope.dispose()
  plugin('remembered', ['config.agent.read', 'clipboard.history'])
  const reloadedService = new PermissionService()
  assert.equal(await reloadedService.request('remembered', 'config.agent.read', 'read'), true)
  assert.equal(await reloadedService.request('remembered', 'clipboard.history', 'history'), true)
  assert.equal(fixture.prompts.length, 1)
})

test('not now denies the current runtime without persisting or repeating prompts', async () => {
  const service = new PermissionService()
  const scope = plugin('declined', ['config.agent.read', 'config.agent.write'])
  const read = service.request('declined', 'config.agent.read', 'read')
  const write = service.request('declined', 'config.agent.write', 'write')
  ;(await promptAt()).resolve({ response: 0 })
  assert.deepEqual(await Promise.all([read, write]), [false, false])
  assert.equal(await service.request('declined', 'config.agent.read', 'retry'), false)
  assert.equal(fixture.prompts.length, 1)
  assert.equal(fixture.grants.size, 0)
  assert.equal(fixture.writes.length, 0)

  await scope.dispose()
  plugin('declined', ['config.agent.read', 'config.agent.write'])
  const retry = service.request('declined', 'config.agent.write', 'new run')
  ;(await promptAt(1)).resolve({ response: 1 })
  assert.equal(await retry, true)
})

test('built-in private capabilities never prompt, including legacy deny and ask grants', async () => {
  const service = new PermissionService()
  plugin('builtin', [])
  for (const permission of BUILTIN_PLUGIN_CAPABILITIES) {
    for (const previous of [undefined, 'ask', 'deny']) {
      grant('builtin', permission, previous)
      assert.equal(await service.request('builtin', permission, 'own plugin capability'), true, permission)
    }
  }
  assert.equal(fixture.prompts.length, 0)
  assert.equal(fixture.writes.length, 0)
})

test('user-selected file handles and plugin-owned timers stay available without declarations despite legacy denials', async () => {
  const service = new PermissionService()
  plugin('default-available', [])
  for (const permission of ['fs.read', 'fs.write', 'timer.background']) {
    grant('default-available', permission, 'deny')
    assert.equal(await service.request('default-available', permission, 'already scoped capability'), true, permission)
  }
  assert.equal(fixture.prompts.length, 0)
  assert.equal(fixture.writes.length, 0)
})

test('unknown, undeclared and missing-runtime requests are rejected without consent', async () => {
  const service = new PermissionService()
  plugin('restricted', ['config.agent.read', 'future.system.capability'])
  grant('restricted', 'config.agent.read', 'deny')
  grant('restricted', 'future.system.capability', 'allow')
  assert.equal(await service.request('restricted', 'config.agent.read', 'denied'), false)
  assert.equal(await service.request('restricted', 'future.system.capability', 'unknown'), false)
  assert.equal(await service.request('restricted', 'config.agent.write', 'not declared'), false)
  assert.equal(await service.request('missing', 'config.agent.read', 'no runtime'), false)
  assert.equal(fixture.prompts.length, 0)
  assert.equal(fixture.writes.length, 0)
})

test('settings denial while a dialog is open takes precedence over remembered consent', async () => {
  const service = new PermissionService()
  plugin('settings-change', ['config.agent.read', 'config.agent.write', 'net.fetch'])
  grant('settings-change', 'config.agent.write', 'deny')
  const request = service.request('settings-change', 'config.agent.read', 'read')
  const prompt = await promptAt()
  grant('settings-change', 'config.agent.read', 'deny')
  prompt.resolve({ response: 2 })
  assert.equal(await request, false)
  assert.equal(fixture.grants.get('settings-change:config.agent.read'), 'deny')
  assert.equal(fixture.grants.get('settings-change:config.agent.write'), 'deny')
  assert.equal(fixture.grants.get('settings-change:net.fetch'), 'allow')
  assert.deepEqual(fixture.writes, [{ id: 'settings-change', permission: 'net.fetch', value: 'allow' }])
})

test('canceling a plugin aborts its active and queued requests while allowing the global queue to continue', async () => {
  const service = new PermissionService()
  const closingScope = plugin('closing', ['config.agent.read', 'config.agent.write'])
  plugin('next', ['net.fetch'])
  const read = service.request('closing', 'config.agent.read', 'read')
  const write = service.request('closing', 'config.agent.write', 'write')
  const next = service.request('next', 'net.fetch', 'fetch')
  const active = await promptAt()
  assert.equal(fixture.prompts.length, 1)
  service.cancelFor('closing')
  assert.deepEqual(await Promise.all([read, write]), [false, false])
  assert.equal(active.options.signal.aborted, true)
  assert.equal(closingScope.activityCount, 0)
  active.resolve({ response: 2 })
  ;(await promptAt(1)).resolve({ response: 1 })
  assert.equal(await next, true)
  assert.equal(fixture.writes.length, 0)
  assert.equal(fixture.prompts.length, 2)
})

test('a delayed allow after runtime destruction cannot grant access to its replacement', async () => {
  fixture.ignoreAbort = true
  const service = new PermissionService()
  const oldScope = plugin('replaced', ['config.agent.read'])
  const oldRequest = service.request('replaced', 'config.agent.read', 'old run')
  const oldPrompt = await promptAt()
  await oldScope.dispose()
  assert.equal(await oldRequest, false)
  assert.equal(oldPrompt.options.signal.aborted, true)

  const newScope = plugin('replaced', ['config.agent.read'])
  const newRequest = service.request('replaced', 'config.agent.read', 'new run')
  oldPrompt.resolve({ response: 2 })
  const newPrompt = await promptAt(1)
  assert.equal(fixture.grants.size, 0)
  assert.equal(fixture.writes.length, 0)
  assert.equal(newScope.activityCount, 1)
  newPrompt.resolve({ response: 0 })
  assert.equal(await newRequest, false)
  assert.equal(newScope.activityCount, 0)
})

test('newly declared permissions need a new consent and cannot join an already visible dialog', async () => {
  const service = new PermissionService()
  plugin('expanded', ['config.agent.read'])
  const read = service.request('expanded', 'config.agent.read', 'read')
  const initial = await promptAt()
  fixture.manifests.set('expanded', { id: 'expanded', name: 'expanded', permissions: ['config.agent.read', 'config.agent.write'] })
  const write = service.request('expanded', 'config.agent.write', 'new capability')
  initial.resolve({ response: 2 })
  assert.equal(await read, true)

  const additional = await promptAt(1)
  assert.deepEqual(listedPermissions(additional), [`• ${permissionLabel('config.agent.write')}`])
  assert.equal(fixture.grants.has('expanded:config.agent.write'), false)
  additional.resolve({ response: 1 })
  assert.equal(await write, true)
  assert.equal(fixture.grants.has('expanded:config.agent.write'), false)
  assert.equal(fixture.prompts.length, 2)
})

test('timeout cancels queued requests for the same runtime without saving a decision', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const service = new PermissionService()
  const scope = plugin('timed-out', ['config.agent.read', 'config.agent.write'])
  const read = service.request('timed-out', 'config.agent.read', 'read')
  const write = service.request('timed-out', 'config.agent.write', 'write')
  const active = await promptAt()
  t.mock.timers.tick(60_000)
  await flush()
  assert.equal(await read, false)
  assert.equal(fixture.prompts.length, 1)
  assert.equal(await write, false)
  assert.equal(active.options.signal.aborted, true)
  assert.equal(scope.activityCount, 0)
  assert.equal(fixture.writes.length, 0)

  const retry = service.request('timed-out', 'config.agent.read', 'explicit retry')
  ;(await promptAt(1)).resolve({ response: 1 })
  assert.equal(await retry, true)
})

test('backend execution requires explicit consent; once grants are observable only during the live runtime', async () => {
  const service = new PermissionService()
  const old = plugin('backend-once', ['backend.node'])
  assert.equal(service.isGranted('backend-once', 'backend.node'), false)
  const request = service.request('backend-once', 'backend.node', 'execute backend')
  const prompt = await promptAt()
  assert.match(prompt.options.detail, /Node\.js|后端/)
  prompt.resolve({ response: 1 })
  assert.equal(await request, true)
  assert.equal(service.isGranted('backend-once', 'backend.node'), true)
  assert.equal(fixture.writes.length, 0)
  old.markClosing(); assert.equal(service.isGranted('backend-once', 'backend.node'), false)
  await old.dispose(); plugin('backend-once', ['backend.node'])
  assert.equal(service.isGranted('backend-once', 'backend.node'), false)
  grant('backend-once', 'backend.node', 'allow'); assert.equal(service.isGranted('backend-once', 'backend.node'), true)
  grant('backend-once', 'backend.node', 'deny'); assert.equal(service.isGranted('backend-once', 'backend.node'), false)
})
