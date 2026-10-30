import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.createSourceFile('PluginHost.ts', readFileSync(new URL('../../../src/main/plugin/PluginHost.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const hostClass = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'PluginHost')
assert.ok(hostClass, 'PluginHost class must exist')
const methods = [
  'ensureResourceOwner', 'stopAllPluginResources', 'closePlugin', 'openPlugin', 'capturePanelPluginClose',
  'getPlacement', 'getLayoutMode', 'getPlacementRevision', 'bumpPlacement', 'releaseQuickSession'
].map(name => {
  const method = hostClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)
  assert.ok(method, `PluginHost.${name} must exist`)
  return method.getText(source)
}).join('\n')
const compiled = ts.transpileModule(`class ResourceHostFixture { ${methods} }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const drain = () => new Promise(resolve => setImmediate(resolve))
function settlement(promise) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  return () => settled
}

// Resource coordination executes verbatim; native views, IPC and leaf cleanup are controlled adapters.
function fixture({ withEntry = true, panel = false } = {}) {
  const pluginId = 'resource-plugin', panelId = 'panel-one', generation = 19, wcId = 31
  const calls = { instanceStops: [], fullStops: [], devStops: [], disposals: [], invalidations: [], shell: [], sessionClears: [], snapshots: [], creates: 0 }
  const hooks = { invalidate: undefined }
  const disposing = deferred()
  const gated = (list, fields = {}) => {
    const gate = { ...deferred(), ...fields }
    list.push(gate)
    return gate.promise
  }
  const adapters = {
    toPluginId: id => id.startsWith('t-') ? id.slice(2) : id,
    toTabId: id => `t-${id}`,
    clearQuickInput() {}, forgetQuickEnterInput() {}, destroyDetachedWindow() {}, forgetPanelPlugin() {},
    sendShellEvent: event => calls.shell.push(event),
    BEFORE_CLOSE_ACK_TIMEOUT: 1600,
    permissionService: { cancelFor() {} },
    stopPluginProcesses: (id, version) => gated(version === undefined ? calls.fullStops : calls.instanceStops, { pluginId: id, generation: version }),
    stopDevServerAndWait: id => gated(calls.devStops, { pluginId: id }),
    stopDevWatch() {}, setQuickContentSize() {}, QUICK_HOME_HEIGHT: 400,
    randomUUID: () => 'close-operation',
    invalidatePluginFileCache: root => { calls.invalidations.push(root); hooks.invalidate?.() },
    pluginRegistry: { getRootPath: () => '/fixture/resource-plugin' },
    clearPluginSession: id => calls.sessionClears.push(id),
    deleteSessionSnapshot: id => calls.snapshots.push(id)
  }
  const Host = new Function(...Object.keys(adapters), compiled + '\nreturn ResourceHostFixture')(...Object.values(adapters))
  const host = new Host()
  for (const name of [
    'resourceOwners', 'closing', 'finalClosing', 'entries', 'closingEntries', 'retiringViews', 'opening', 'reloading',
    'placements', 'placementRevisions', 'closeRevisions', 'detachedVisible', 'detachedStateSignatures', 'logicalTabs',
    'layoutModes', 'tabPresentation', 'suspending', 'pendingAcks', 'hibernated', 'byWcId', 'pendingEnter', 'states',
    'restoringDetached', 'barriers'
  ]) host[name] = new Map()
  for (const name of ['mcpBackgroundPlugins', 'restoredSessionIds', 'lazyDetached', 'panelSuppressed', 'enterSent']) host[name] = new Set()
  Object.assign(host, {
    shuttingDown: false, activeTabId: null, quickPluginId: null,
    quickSession: { release: () => false, hide() {} },
    setResidentLease() {}, retireMcpRuntime() {}, cancelDetachedRestore() {}, clearHibernateTimer() {},
    windowSession: { remove() {} }, publishTabs() {}, detachView() {}, sendToPlugin() {},
    applyTransition: id => host.states.set(id, 'closed'),
    waitForBeforeCloseAck: async () => true,
    disposeEntry: entry => {
      const waiting = gated(calls.disposals, { entry })
      disposing.resolve()
      return waiting
    },
    createPlugin() { calls.creates++; throw new Error('Native creation must remain behind the cleanup guard') }
  })
  host.placements.set(pluginId, panel ? { kind: 'panel', panelId } : { kind: 'shell' })
  host.logicalTabs.set(pluginId, { title: 'Resource owner', tabSessionId: 'logical-session' })
  const entry = withEntry ? {
    pluginId, generation, layoutMode: 'shell', rootPath: '/fixture/resource-plugin',
    view: { webContents: { id: wcId } },
    scope: { owner: { pluginId, generation, wcId }, isClosing: false, markClosing() { this.isClosing = true } }
  } : undefined
  if (entry) { host.entries.set(pluginId, entry); host.byWcId.set(wcId, pluginId) }
  const release = list => { for (const gate of list) gate.resolve() }
  return {
    host, pluginId, panelId, entry, calls, hooks, disposing,
    releaseInstance() { release(calls.instanceStops); release(calls.disposals) },
    releaseFull() { release(calls.fullStops); release(calls.devStops) },
    releaseAll() { release(calls.instanceStops); release(calls.disposals); release(calls.fullStops); release(calls.devStops) }
  }
}

function assertFullStopStartedOnce(f) {
  assert.equal(f.calls.fullStops.length, 1, 'all-process cleanup is shared by every full-close joiner')
  assert.equal(f.calls.devStops.length, 1, 'dev-server cleanup starts only once')
  assert.equal(f.calls.fullStops[0].pluginId, f.pluginId)
  assert.equal(f.calls.fullStops[0].generation, undefined)
}

function assertReleased(f) {
  assert.equal(f.host.resourceOwners.has(f.pluginId), false)
  assert.equal(f.host.closing.has(f.pluginId), false)
  assert.equal(f.host.finalClosing.has(f.pluginId), false)
  assert.equal(f.host.closingEntries.has(f.pluginId), false)
  assert.deepEqual(f.calls.sessionClears, [f.pluginId])
  assert.deepEqual(f.calls.snapshots, [f.pluginId])
}

for (const mode of [
  { name: 'preserveSession', preserveSession: true, preserveSharedResources: false },
  { name: 'preserveSharedResources', preserveSession: false, preserveSharedResources: true }
]) {
  test(`${mode.name} close upgrades once to full cleanup and waits before releasing its owner`, { timeout: 5000 }, async t => {
    const f = fixture()
    t.after(() => f.releaseAll())
    const owner = f.host.ensureResourceOwner(f.pluginId)
    const first = f.host.closePlugin(f.pluginId, 'tab-close', mode.preserveSession, mode.preserveSharedResources)
    const settled = settlement(first)
    assert.equal(f.host.ensureResourceOwner(f.pluginId), owner)
    assert.equal(owner.closing, true)
    assert.equal(f.calls.instanceStops.length, 1)
    assert.equal(f.calls.instanceStops[0].generation, f.entry.generation)
    assert.equal(f.calls.fullStops.length, 0)
    await f.disposing.promise

    const joined = f.host.closePlugin(f.pluginId, 'app-quit')
    const fullStop = f.host.finalClosing.get(f.pluginId).fullStop
    const repeated = f.host.closePlugin(f.pluginId, 'uninstall')
    assert.equal(joined, first)
    assert.equal(repeated, first)
    assert.ok(fullStop)
    assert.equal(f.host.finalClosing.get(f.pluginId).fullStop, fullStop)
    assertFullStopStartedOnce(f)

    f.releaseInstance()
    await drain()
    assert.equal(settled(), false, 'finishing the instance is insufficient while shared resources are stopping')
    assert.equal(f.host.resourceOwners.get(f.pluginId), owner)
    f.calls.fullStops[0].resolve()
    await drain()
    assert.equal(settled(), false, 'dev-server cleanup belongs to the same close completion')
    f.calls.devStops[0].resolve()
    await Promise.all([first, joined, repeated])
    assertReleased(f)
  })
}

for (const fail of [false, true]) {
  test(`a full close joining after the body drains is ${fail ? 'rejected for all joiners on cleanup failure' : 'awaited by async finally'}`, { timeout: 5000 }, async t => {
    const f = fixture()
    t.after(() => f.releaseAll())
    const owner = f.host.ensureResourceOwner(f.pluginId)
    const joining = deferred()
    let late, repeated
    f.hooks.invalidate = () => {
      f.hooks.invalidate = undefined
      // The last body adapter queues this after body completion, before its Promise.finally reaction.
      queueMicrotask(() => {
        try {
          late = f.host.closePlugin(f.pluginId, 'app-quit')
          repeated = f.host.closePlugin(f.pluginId, 'uninstall')
          joining.resolve()
        } catch (error) { joining.reject(error) }
      })
    }
    const first = f.host.closePlugin(f.pluginId, 'tab-close', false, true)
    const settled = settlement(first)
    await f.disposing.promise
    f.releaseInstance()
    await joining.promise
    await drain()
    assert.equal(late, first)
    assert.equal(repeated, first)
    assertFullStopStartedOnce(f)
    assert.equal(settled(), false)
    assert.equal(f.host.resourceOwners.get(f.pluginId), owner)
    const outcomes = Promise.allSettled([first, late, repeated])
    const failure = new Error('dev server did not stop')
    f.calls.fullStops[0].resolve()
    if (fail) f.calls.devStops[0].reject(failure)
    else f.calls.devStops[0].resolve()
    const results = await outcomes

    if (fail) {
      for (const result of results) {
        assert.equal(result.status, 'rejected')
        assert.equal(result.reason, failure)
      }
      assert.equal(f.host.resourceOwners.get(f.pluginId), owner, 'a failed full stop must not retire its owner')
      assert.equal(owner.closing, true)
      assert.equal(f.host.closingEntries.get(f.pluginId), f.entry)
      assert.equal(f.host.closing.has(f.pluginId), false)
      assert.equal(f.host.finalClosing.has(f.pluginId), false)
      await assert.rejects(f.host.openPlugin(f.pluginId), /resource cleanup is still pending/)
      assert.equal(f.calls.creates, 0)
    } else {
      for (const result of results) assert.equal(result.status, 'fulfilled')
      assertReleased(f)
    }
  })
}

test('entryless failure keeps the captured owner retryable and prevents a cold open until resources stop', { timeout: 5000 }, async t => {
  const f = fixture({ withEntry: false, panel: true })
  t.after(() => f.releaseAll())
  const capturedClose = f.host.capturePanelPluginClose(f.pluginId, f.panelId)
  const owner = f.host.resourceOwners.get(f.pluginId)
  const first = capturedClose()
  assert.equal(capturedClose(), first, 'the captured closer also joins its in-flight attempt')
  const waitingOpen = f.host.openPlugin(f.pluginId)
  const outcomes = Promise.allSettled([first, waitingOpen])
  const failure = new Error('owned process is still alive')
  assertFullStopStartedOnce(f)
  f.calls.fullStops[0].reject(failure)
  f.calls.devStops[0].resolve()
  for (const result of await outcomes) {
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, failure)
  }
  assert.equal(f.host.resourceOwners.get(f.pluginId), owner)
  assert.equal(f.host.ensureResourceOwner(f.pluginId), owner)
  assert.equal(owner.closing, true)
  assert.equal(f.host.entries.size, 0)
  assert.equal(f.host.closingEntries.size, 0)
  assert.equal(f.host.getPlacement(f.pluginId).kind, 'shell', 'retry cannot rely on the former panel placement')
  await assert.rejects(f.host.openPlugin(f.pluginId), /resource cleanup is still pending/)
  assert.equal(f.calls.creates, 0)

  const retry = capturedClose()
  assert.equal(f.host.resourceOwners.get(f.pluginId), owner, 'retry must keep the failed resource token')
  assert.equal(f.calls.fullStops.length, 2)
  assert.equal(f.calls.devStops.length, 2)
  f.releaseFull()
  await retry
  assert.equal(f.host.resourceOwners.has(f.pluginId), false)
  assert.equal(f.host.closing.has(f.pluginId), false)
  assert.equal(f.host.finalClosing.has(f.pluginId), false)
  await capturedClose()
  assert.equal(f.calls.fullStops.length, 2, 'a completed captured close cannot stop a later incarnation')
  assert.equal(f.calls.creates, 0)
})
