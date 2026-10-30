import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = await build({
  entryPoints: [root + 'src/main/plugin/pluginQuickSession.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm'
})
const { PluginQuickSession } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))

test('auto-hide retains one logical session while removing visible ownership', () => {
  const session = new PluginQuickSession()
  session.show('one')
  const token = session.capture()
  assert.equal(session.hide(), 'one')
  assert.equal(session.visiblePluginId, null)
  assert.equal(session.retains('one'), true)
  assert.equal(session.matches(token), true)
  session.show('one')
  assert.equal(session.visiblePluginId, 'one')
  assert.equal(session.matches(token), true)
})

test('explicit release and replacement invalidate pending resume tokens, including ABA', () => {
  const session = new PluginQuickSession()
  session.show('one')
  const token = session.capture()
  session.hide()
  assert.equal(session.release('other'), false)
  assert.equal(session.release('one'), true)
  assert.equal(session.pluginId, null)
  session.show('one')
  assert.equal(session.matches(token), false)
  session.show('two')
  assert.equal(session.retains('one'), false)
  assert.equal(session.retains('two'), true)
})

// Exercise the production orchestration without importing Electron or creating native windows.
const hostSource = ts.createSourceFile('PluginHost.ts', readFileSync(root + 'src/main/plugin/PluginHost.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const hostClass = hostSource.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'PluginHost')
assert.ok(hostClass, 'PluginHost class must exist')
const hostMethods = ['isQuickInputOwner', 'releaseQuickSession', 'resetQuickSession', 'prepareQuickSummon', 'onQuickHidden', 'sendEnter'].map(name => {
  const method = hostClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(hostSource) === name)
  assert.ok(method, `PluginHost.${name} must exist`)
  return method.getText(hostSource)
}).join('\n')
const hostCode = ts.transpileModule(`class QuickHostFixture { ${hostMethods} }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function hostFixture({ summary = { installed: true, enabled: true }, state = 'background', pending, launchError } = {}) {
  const pluginId = 'one', generation = 7
  const context = { text: 'retained input', query: { raw: 'fy retained input', trigger: 'fy' } }
  const issued = new Map([[pluginId, { generation, input: context }]])
  const calls = { launches: 0, cleared: [], hidden: [], hibernated: [], shell: [], plugin: [], writes: [], warnings: [] }
  const HostFixture = new Function(
    'pluginRegistry', 'forgetQuickEnterInput', 'clearQuickInput', 'sendShellEvent', 'finishQuickPluginReveal', 'logWarn', 'rememberQuickEnterInput', 'toTabId',
    hostCode + '\nreturn QuickHostFixture'
  )(
    { get: id => id === pluginId ? summary : undefined },
    id => issued.delete(id),
    id => calls.cleared.push(id),
    event => calls.shell.push(event),
    () => {},
    (area, message) => calls.warnings.push({ area, message }),
    (id, version, input) => {
      calls.writes.push({ id, generation: version, input })
      if (input) issued.set(id, { generation: version, input })
      else issued.delete(id)
    },
    id => `t-${id}`
  )
  const host = new HostFixture()
  const view = { setVisible: visible => calls.hidden.push(visible), webContents: {} }
  Object.assign(host, {
    quickSession: new PluginQuickSession(), shuttingDown: false, barriers: new Set(),
    pendingEnter: new Map(pending ? [[pluginId, pending]] : []), enterSent: new Set([pluginId]),
    entries: new Map([[pluginId, { pluginId, generation, layoutMode: 'quick', view }]]),
    getPlacement: () => ({ kind: 'quick' }), getLayoutMode: () => 'quick', getState: () => state,
    clearHibernateTimer() {}, scheduleHibernate: id => calls.hibernated.push(id), windowSession: { focus() {} },
    applyTransition(_id, action) { state = action === 'activate' ? 'active' : 'background' },
    sendToPlugin(_contents, message) { calls.plugin.push({ message, context: issued.get(pluginId)?.input }) },
    async launchPluginIn(id, target, enter, guard) {
      calls.launches++
      assert.equal(id, pluginId)
      assert.equal(target, 'quick')
      assert.equal(enter, undefined, 'resume must not fabricate a new input payload')
      assert.equal(guard(), true)
      if (launchError) throw new Error(launchError)
      this.quickSession.show(id)
      this.sendEnter(id)
    }
  })
  host.quickSession.show(pluginId)
  host.quickSession.hide()
  return { host, pluginId, context, issued, calls }
}

function assertReset(f) {
  assert.equal(f.host.quickSession.pluginId, null)
  assert.equal(f.host.pendingEnter.has(f.pluginId), false, 'reset must discard an undelivered enter before a later launch')
  assert.equal(f.issued.has(f.pluginId), false, 'reset must retire the issued input context')
  assert.ok(f.calls.cleared.includes(f.pluginId))
  assert.deepEqual(f.calls.hibernated, [f.pluginId])
  assert.deepEqual(f.calls.shell.at(-1), { type: 'quick-plugin-mode', mode: null })
  assert.deepEqual(f.calls.plugin, [])
}

test('a failed restore lets reset release the owner and discard its undelivered enter', async () => {
  const pending = { code: 'translate', payload: 'not delivered', input: { text: 'not delivered' } }
  const f = hostFixture({ pending, launchError: 'native attachment failed' })
  assert.equal(await f.host.prepareQuickSummon(), false)
  assert.equal(f.calls.launches, 1)
  assert.equal(f.calls.warnings.length, 1)
  assertReset(f)
})

for (const unavailable of [
  { name: 'disabled', summary: { installed: true, enabled: false } },
  { name: 'crashed', state: 'crash' }
]) {
  test(`a ${unavailable.name} plugin resets without leaving an undelivered enter`, async () => {
    const f = hostFixture({ ...unavailable, pending: { code: 'translate', input: { text: 'retired draft' } } })
    assert.equal(await f.host.prepareQuickSummon(), false)
    assert.equal(f.calls.launches, 0)
    assertReset(f)
  })
}

test('a successful restore retains the logical session and context without replaying its input', async () => {
  const f = hostFixture()
  const token = f.host.quickSession.capture()
  assert.equal(await f.host.prepareQuickSummon(), true)
  assert.equal(f.host.quickSession.matches(token), true)
  assert.equal(f.host.quickSession.visiblePluginId, f.pluginId)
  assert.equal(f.issued.get(f.pluginId).input, f.context)
  assert.deepEqual(f.calls.cleared, [])
  assert.deepEqual(f.calls.hibernated, [])
  assert.deepEqual(f.calls.shell, [])
  assert.deepEqual(f.calls.writes, [])
  assert.equal(f.calls.plugin.length, 1)
  assert.equal(f.calls.plugin[0].context, f.context, 'onEnter can still read the current session context')
  assert.equal(f.calls.plugin[0].message.event, 'enter')
  assert.equal(Object.hasOwn(f.calls.plugin[0].message, 'input'), false, 'resume must not replay the original input')
})
