import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { transform } from 'esbuild'
import ts from 'typescript'

async function importSource(source) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node22' })
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function fixture() {
  const source = await readFile(new URL('../../../src/main/plugin/PluginHost.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('PluginHost.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const hostClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'PluginHost')
  const methods = ['capturePanelPluginClose', 'ensureResourceOwner'].map(name => {
    const method = hostClass?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name)
    assert.ok(method, `exercise the actual ${name}, not a duplicate fixture implementation`)
    return method.getText(ast)
  })
  const { CapturedHost } = await importSource(`export class CapturedHost { ${methods.join('\n')} }`)
  const helpers = await importSource(await readFile(new URL('../../../src/main/panel/panelClose.ts', import.meta.url), 'utf8'))
  const id = 'clock', panelId = 'panel-one', calls = [], attempts = []
  let release = async () => {}
  const host = Object.assign(new CapturedHost(), {
    entries: new Map(), closingEntries: new Map(), retiringViews: new Map(), opening: new Map(),
    placements: new Map([[id, { kind: 'panel', panelId }]]), closeRevisions: new Map(),
    logicalTabs: new Map(), hibernated: new Map(), resourceOwners: new Map(), closing: new Map(),
    getPlacement(pluginId) { return this.placements.get(pluginId) ?? { kind: 'shell' } },
    closePlugin(pluginId) {
      const resourceOwner = this.ensureResourceOwner(pluginId)
      resourceOwner.closing = true
      const entry = this.entries.get(pluginId) ?? this.closingEntries.get(pluginId) ?? this.retiringViews.get(pluginId)
      const pending = this.closing.get(pluginId)
      calls.push({ pluginId, entry, resourceOwner, joined: !!pending })
      this.closeRevisions.set(pluginId, (this.closeRevisions.get(pluginId) ?? 0) + 1)
      if (pending) return pending
      const opening = this.opening.get(pluginId)
      if (opening) opening.cancelled = true
      if (entry) {
        entry.scope.isClosing = true
        this.entries.delete(pluginId)
        this.closingEntries.set(pluginId, entry)
      }
      this.placements.delete(pluginId)
      this.logicalTabs.delete(pluginId)
      this.hibernated.delete(pluginId)
      const attempt = { pluginId, entry, resourceOwner }
      attempts.push(attempt)
      let complete = false
      const operation = Promise.resolve().then(async () => {
        // Native disposal can finish while a scope-less process tree is still stopping.
        if (this.closingEntries.get(pluginId) === entry) this.closingEntries.delete(pluginId)
        if (this.retiringViews.get(pluginId) === entry) this.retiringViews.delete(pluginId)
        await release(attempt)
        complete = true
      }).finally(() => {
        if (this.closing.get(pluginId) === operation) this.closing.delete(pluginId)
        if (complete) {
          if (this.closingEntries.get(pluginId) === entry) this.closingEntries.delete(pluginId)
          if (this.resourceOwners.get(pluginId) === resourceOwner) this.resourceOwners.delete(pluginId)
        } else if (entry) this.closingEntries.set(pluginId, entry)
      })
      this.closing.set(pluginId, operation)
      return operation
    }
  })
  const makeEntry = generation => ({ generation, scope: { isClosing: false } })
  const beginColdOpen = () => {
    assert.notEqual(host.resourceOwners.get(id)?.closing, true, 'failed cleanup must block cold opening')
    const resourceOwner = { closing: false }, opening = { cancelled: false }
    host.resourceOwners.set(id, resourceOwner)
    host.opening.set(id, opening)
    return { resourceOwner, opening }
  }
  const widget = { pluginId: id }
  let captures = 0
  const capture = () => helpers.rememberPanelPluginClose(widget, pluginId => {
    captures++
    return host.capturePanelPluginClose(pluginId, panelId)
  })
  return { ...helpers, host, id, panelId, calls, attempts, widget, makeEntry, beginColdOpen, capture,
    get captures() { return captures }, setRelease(callback) { release = callback } }
}

test('failed widget retries the same entry and concurrent retries join one close', async () => {
  const f = await fixture(), entry = f.makeEntry(1)
  f.host.entries.set(f.id, entry)
  const close = f.capture()
  const resourceOwner = f.host.resourceOwners.get(f.id)
  assert.equal(f.host.ensureResourceOwner(f.id), resourceOwner)
  f.setRelease(async () => { throw new Error('release incomplete') })
  await assert.rejects(close(), /release incomplete/)
  assert.equal(f.host.closingEntries.get(f.id), entry)
  assert.equal(f.host.resourceOwners.get(f.id), resourceOwner)
  assert.equal(resourceOwner.closing, true)
  assert.equal(f.capture(), close)
  const waiting = deferred()
  f.setRelease(() => waiting.promise)
  const first = close(), second = close()
  assert.equal(first, second)
  waiting.resolve()
  await first
  await close()
  assert.equal(f.captures, 1)
  assert.equal(f.calls.length, 2)
  assert.equal(f.attempts.length, 2)
  assert.ok(f.calls.every(call => call.entry === entry))
  assert.equal(f.host.resourceOwners.has(f.id), false)
})

test('an externally released old widget cannot close new live, hibernated, crashed or opening sessions', async () => {
  for (const state of ['live', 'hibernated', 'crashed', 'opening']) {
    const f = await fixture(), old = f.makeEntry(1)
    f.host.entries.set(f.id, old)
    const close = f.capture()
    f.setRelease(async () => { throw new Error('release incomplete') })
    await assert.rejects(close(), /release incomplete/)
    f.setRelease(async () => {})
    await f.host.closePlugin(f.id)
    const { resourceOwner, opening } = f.beginColdOpen()
    const next = f.makeEntry(2), tab = { session: 'new-session' }, placement = { kind: 'shell' }
    f.host.placements.set(f.id, placement)
    f.host.logicalTabs.set(f.id, tab)
    if (state !== 'opening') f.host.opening.delete(f.id)
    if (state === 'live') f.host.entries.set(f.id, next)
    if (state === 'hibernated') f.host.hibernated.set(f.id, next)
    if (state === 'crashed') { next.scope.isClosing = true; f.host.closingEntries.set(f.id, next) }
    const calls = f.calls.length
    assert.equal(f.capture(), close)
    await f.closePanelPluginRuntimes([f.id], () => close())
    assert.equal(f.captures, 1)
    assert.equal(f.calls.length, calls, state)
    assert.equal(f.host.logicalTabs.get(f.id), tab, state)
    assert.equal(f.host.placements.get(f.id), placement, state)
    assert.equal(f.host.resourceOwners.get(f.id), resourceOwner, state)
    assert.equal(resourceOwner.closing, false, state)
    if (state === 'hibernated') assert.equal(f.host.hibernated.get(f.id), next)
    if (state === 'crashed') assert.equal(f.host.closingEntries.get(f.id), next)
    if (state === 'opening') assert.equal(opening.cancelled, false)
  }
})

test('ownership is checked at close execution, including a move after capture', async () => {
  for (const changed of ['entry', 'placement']) {
    const f = await fixture(), entry = f.makeEntry(1)
    f.host.entries.set(f.id, entry)
    const close = f.capture()
    const operation = f.closePanelPluginRuntimes([f.id], () => close())
    if (changed === 'entry') f.host.entries.set(f.id, f.makeEntry(2))
    else f.host.placements.set(f.id, { kind: 'shell' })
    await operation
    assert.equal(f.calls.length, 0, changed)
  }
})

test('a capture retired by moving away cannot later consume a move back', async () => {
  const f = await fixture(), entry = f.makeEntry(1)
  f.host.entries.set(f.id, entry)
  const close = f.capture()
  f.host.placements.set(f.id, { kind: 'shell' })
  await close()
  f.host.placements.set(f.id, { kind: 'panel', panelId: f.panelId })
  await close()
  assert.equal(f.calls.length, 0)
  assert.equal(f.host.entries.get(f.id), entry)
})

test('an opening capture follows only the entry created by its original operation', async () => {
  const f = await fixture(), opening = { cancelled: false }
  f.host.opening.set(f.id, opening)
  const close = f.capture(), entry = f.makeEntry(1)
  opening.entry = entry
  f.host.entries.set(f.id, entry)
  f.host.opening.delete(f.id)
  await close()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].entry, entry)
})

test('cold opening replaces ownership before an entry exists even with unchanged placement and close revision', async () => {
  for (const original of ['empty', 'opening']) {
    for (const replacement of ['opening', 'crashed']) {
      const f = await fixture()
      if (original === 'opening') f.host.opening.set(f.id, { cancelled: false })
      const close = f.capture(), previousOwner = f.host.resourceOwners.get(f.id)
      const placement = f.host.placements.get(f.id)
      f.host.opening.delete(f.id)
      const { resourceOwner, opening } = f.beginColdOpen()
      if (replacement === 'crashed') {
        opening.entry = f.makeEntry(2)
        opening.entry.scope.isClosing = true
        f.host.opening.delete(f.id)
      }
      await close()
      assert.notEqual(resourceOwner, previousOwner)
      assert.equal(f.calls.length, 0, `${original}: ${replacement}`)
      assert.equal(f.host.placements.get(f.id), placement)
      assert.equal(f.host.closeRevisions.get(f.id) ?? 0, 0)
      assert.equal(f.host.resourceOwners.get(f.id), resourceOwner)
      assert.equal(resourceOwner.closing, false)
      assert.equal(opening.cancelled, false)
    }
  }
})

test('an entryless concurrent external close joins one attempt and revision increments cannot retire its retry', async () => {
  const f = await fixture(), close = f.capture()
  const resourceOwner = f.host.resourceOwners.get(f.id), entered = deferred(), waiting = deferred()
  f.setRelease(() => { entered.resolve(); return waiting.promise })
  const firstFailure = assert.rejects(close(), /release incomplete/)
  await entered.promise
  const shared = f.host.closing.get(f.id), external = f.host.closePlugin(f.id)
  const externalFailure = assert.rejects(external, /release incomplete/)
  assert.equal(external, shared)
  waiting.reject(new Error('release incomplete'))
  await Promise.all([firstFailure, externalFailure])
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].joined, true)
  assert.equal(f.attempts.length, 1)
  assert.equal(f.host.closeRevisions.get(f.id), 2)
  assert.equal(f.host.resourceOwners.get(f.id), resourceOwner)
  f.setRelease(async () => {})
  await f.capture()()
  assert.equal(f.captures, 1)
  assert.equal(f.calls.length, 3)
  assert.equal(f.attempts.length, 2)
  assert.equal(f.host.resourceOwners.has(f.id), false)
})

test('entryless external retries retain ownership on failure and retire it only after success', async () => {
  for (const result of ['failed', 'succeeded']) {
    const f = await fixture(), close = f.capture(), resourceOwner = f.host.resourceOwners.get(f.id)
    f.setRelease(async () => { throw new Error('release incomplete') })
    await assert.rejects(close(), /release incomplete/)
    if (result === 'failed') {
      await assert.rejects(f.host.closePlugin(f.id), /release incomplete/)
      assert.equal(f.host.resourceOwners.get(f.id), resourceOwner)
      assert.equal(resourceOwner.closing, true)
    } else {
      f.setRelease(async () => {})
      await f.host.closePlugin(f.id)
      assert.equal(f.host.resourceOwners.has(f.id), false)
    }
    const calls = f.calls.length
    f.setRelease(async () => {})
    await close()
    assert.equal(f.calls.length, calls + (result === 'failed' ? 1 : 0), result)
    assert.equal(f.host.resourceOwners.has(f.id), false)
    assert.equal(f.captures, 1)
  }
})

test('capture before external close joins its stalled process cleanup after the entry has been destroyed', async () => {
  for (const state of ['entryless', 'live']) {
    const f = await fixture()
    if (state === 'live') f.host.entries.set(f.id, f.makeEntry(1))
    const close = f.capture(), resourceOwner = f.host.resourceOwners.get(f.id)
    const disposed = deferred(), waiting = deferred()
    f.setRelease(() => { disposed.resolve(); return waiting.promise })
    const externalFailure = assert.rejects(f.host.closePlugin(f.id), /process tree incomplete/)
    await disposed.promise
    assert.equal(f.host.entries.size + f.host.closingEntries.size + f.host.retiringViews.size, 0)
    assert.equal(f.host.resourceOwners.get(f.id), resourceOwner)
    assert.equal(resourceOwner.closing, true)
    const panelFailure = assert.rejects(close(), /process tree incomplete/)
    waiting.reject(new Error('process tree incomplete'))
    await Promise.all([externalFailure, panelFailure])
    assert.equal(f.calls.length, 2, state)
    assert.equal(f.calls[1].joined, true, state)
    assert.equal(f.attempts.length, 1, state)
    f.setRelease(async () => {})
    await close()
    assert.equal(f.attempts.length, 2, state)
    assert.equal(f.host.resourceOwners.has(f.id), false, state)
  }
})

test('capture before settled external close retries its failure but does not repeat its success', async () => {
  for (const result of ['failed', 'succeeded']) {
    const f = await fixture(), close = f.capture(), resourceOwner = f.host.resourceOwners.get(f.id)
    if (result === 'failed') {
      f.setRelease(async () => { throw new Error('release incomplete') })
      await assert.rejects(f.host.closePlugin(f.id), /release incomplete/)
      assert.equal(f.host.resourceOwners.get(f.id), resourceOwner)
    } else await f.host.closePlugin(f.id)
    f.setRelease(async () => {})
    await close()
    assert.equal(f.attempts.length, result === 'failed' ? 2 : 1, result)
    assert.equal(f.host.resourceOwners.has(f.id), false)
    assert.equal(f.captures, 1)
  }
})

test('a disposed renderer still has the original resource owner until final resource close succeeds', async () => {
  const f = await fixture(), entry = f.makeEntry(1)
  f.host.entries.set(f.id, entry)
  const close = f.capture(), resourceOwner = f.host.resourceOwners.get(f.id)
  entry.scope.isClosing = true
  f.host.entries.delete(f.id)
  await close()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].resourceOwner, resourceOwner)
  assert.equal(f.calls[0].entry, undefined)
  assert.equal(f.host.resourceOwners.has(f.id), false)
})

test('a capture failure cannot bind the same placeholder to a later runtime', async () => {
  const f = await fixture(), failure = new Error('cannot capture owner')
  let captures = 0
  const close = f.rememberPanelPluginClose(f.widget, () => { captures++; throw failure })
  await assert.rejects(close(), error => error === failure)
  const retry = f.rememberPanelPluginClose(f.widget, () => { captures++; return async () => {} })
  assert.equal(retry, close)
  await assert.rejects(retry(), error => error === failure)
  assert.equal(captures, 1)
})
