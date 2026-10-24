import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

// New, fixture-only startup coverage: no Electron, DOM, network, user data or historical tests.
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const nativeRequire = createRequire(import.meta.url)
const controllerFile = join(root, 'src/renderer/themes/default/WorkspaceController.ts')
const policyFile = join(dirname(controllerFile), 'quick/workspaceSearchPolicy.ts')
const matcherFile = join(dirname(controllerFile), 'quick/patternMatching.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const drain = async () => { for (let index = 0; index < 16; index++) await Promise.resolve() }
const entry = (handle, title = handle, extra = {}) => ({ handle, kind: 'plugin', title, aliases: [title], ...extra })
const result = items => ({ revision: 7, items })

function fixture(options = {}) {
  const modules = new Map(), loads = { policy: 0, matcher: 0, dictionary: 0 }
  const attempts = { policy: 0, matcher: 0 }, requests = [], matches = [], publications = [], timers = new Map()
  let nextTimer = 0, appearanceListener, commandListener, remainingFailures = options.policyFailures || 0
  const appearance = generation => ({ generation, appearance: { revision: generation } })
  const bridge = {
    getAppearance: async () => appearance(1),
    getConfig: async () => ({ locale: 'en-US', installedFirst: true, offline: true, warmInstall: false, revision: 1 }),
    getCatalog: async () => ({ items: [], revision: 1 }),
    ready: async () => undefined,
    onAppearance: callback => { appearanceListener = callback; return () => { appearanceListener = undefined } },
    onCommand: callback => { commandListener = callback; return () => { commandListener = undefined } },
    search: request => {
      requests.push(plain(request))
      return options.search ? options.search(request, requests.length) : Promise.resolve(result(options.entries || []))
    },
  }
  const sandbox = vm.createContext({ AbortController, console,
    localStorage: { getItem: () => null, setItem: () => undefined },
    setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id },
    clearTimeout: id => timers.delete(id),
  })
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    if (file === policyFile) loads.policy++
    const module = { exports: {} }
    modules.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false,
    }, fileName: file }).outputText
    const localRequire = specifier => {
      if (specifier === '@renderer/services/workspaceReadme') return { loadWorkspaceReadme: async () => '' }
      if (specifier === 'pinyin-pro') {
        if (!modules.has(specifier)) { loads.dictionary++; modules.set(specifier, { exports: nativeRequire(specifier) }) }
        return modules.get(specifier).exports
      }
      const target = specifier === '@shared/search' ? join(root, 'src/shared/search.ts')
        : specifier.startsWith('.') ? resolve(dirname(file), `${specifier}.ts`) : null
      if (!target) throw new Error(`Unexpected fixture dependency: ${specifier}`)
      if (target === policyFile || target === matcherFile) {
        const key = target === policyFile ? 'policy' : 'matcher'
        attempts[key]++
        const imported = () => {
          if (key === 'policy' && remainingFailures) { remainingFailures--; throw new Error('Fixture transient chunk failure') }
          if (key === 'matcher') {
            if (!modules.has(target)) {
              loads.matcher++
              modules.set(target, { exports: { matchDefaultQuickContent: (catalog, query, signal) => {
                matches.push({ catalog, query, signal })
                return options.match ? options.match(catalog, query, signal) : Promise.resolve(new Set())
              } } })
            }
            return modules.get(target).exports
          }
          return load(target)
        }
        // CommonJS lowering keeps import() asynchronous; the gate models a slow ESM chunk.
        return options.importGate ? options.importGate.promise.then(imported) : imported()
      }
      return load(target)
    }
    try {
      vm.runInContext(`(function(require,module,exports){${source}\n})`, sandbox, { filename: file })(localRequire, module, module.exports)
    } catch (error) { modules.delete(file); throw error }
    return module.exports
  }
  const { createDefaultWorkspaceController } = load(controllerFile)
  const controller = createDefaultWorkspaceController(bridge, { afterPaint: async () => undefined })
  controller.subscribe(() => publications.push(controller.getState()))
  return { controller, loads, attempts, requests, matches, publications, timers,
    appearance: generation => appearanceListener?.(appearance(generation)),
    command: command => commandListener?.(command),
    policy: () => load(policyFile),
  }
}

test('search policy imports stay out of module evaluation, boot, empty input and composition', async () => {
  const source = ts.createSourceFile(controllerFile, readFileSync(controllerFile, 'utf8'), ts.ScriptTarget.Latest, true)
  const eager = source.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text)
  assert.ok(!eager.includes('./quick/workspaceSearchPolicy'))
  assert.ok(!eager.includes('./quick/patternMatching'))
  const f = fixture()
  try {
    assert.deepEqual(f.loads, { policy: 0, matcher: 0, dictionary: 0 })
    await f.controller.start()
    for (const query of ['', '   ', '\n\t']) {
      f.controller.queueSearch(query)
      await f.controller.runSearch(query)
    }
    f.controller.queueSearch('composing', 'all', true)
    await drain()
    assert.deepEqual(f.loads, { policy: 0, matcher: 0, dictionary: 0 })
    assert.deepEqual(f.attempts, { policy: 0, matcher: 0 })
    assert.deepEqual(f.requests, [])
    assert.ok(![...f.timers.values()].some(timer => timer.ms === 80))
  } finally { f.controller.dispose() }
})

test('first nonempty search loads both modules alongside the bridge; later searches reuse them', async () => {
  const pending = deferred(), entries = [entry('notes', '\u7b14\u8bb0')]
  const f = fixture({ search: (_request, count) => count === 1 ? pending.promise : Promise.resolve(result(entries)) })
  try {
    const first = f.controller.runSearch('  bj  ')
    await drain()
    assert.deepEqual(f.requests, [{ query: 'bj', scope: 'all', limit: 60 }])
    assert.deepEqual(f.loads, { policy: 1, matcher: 1, dictionary: 1 }, 'policy loading does not wait for bridge resolution')
    pending.resolve(result(entries))
    await first
    assert.deepEqual(plain(f.controller.getState().results.items.map(item => item.handle)), ['notes'])
    assert.equal(f.matches[0].query, '  bj  ', 'only the bridge request trims the original ranking/matching input')
    await f.controller.runSearch('biji')
    assert.deepEqual(f.loads, { policy: 1, matcher: 1, dictionary: 1 })
    assert.equal(f.matches.length, 2)
  } finally { f.controller.dispose() }
})

test('late query responses cannot overwrite a newer query while lazy chunks are pending', async () => {
  const gate = deferred(), old = deferred(), fresh = deferred()
  const f = fixture({ importGate: gate, search: request => request.query === 'old' ? old.promise : fresh.promise })
  try {
    const first = f.controller.runSearch('old')
    await drain()
    const second = f.controller.runSearch('fresh')
    fresh.resolve(result([entry('fresh')]))
    gate.resolve()
    await second
    const accepted = f.controller.getState(), count = f.publications.length
    old.resolve(result([entry('old')]))
    await first
    assert.equal(f.controller.getState(), accepted)
    assert.equal(f.publications.length, count)
    assert.deepEqual(plain(accepted.results.items.map(item => item.handle)), ['fresh'])
    assert.deepEqual(f.matches.map(match => match.query), ['fresh'])
  } finally { f.controller.dispose() }
})

test('clearing input aborts in-flight content matching and rejects its late publication', async () => {
  const matching = deferred()
  const f = fixture({ entries: [entry('alpha')], match: () => matching.promise })
  try {
    const search = f.controller.runSearch('alpha')
    await drain()
    assert.equal(f.matches.length, 1)
    assert.equal(f.controller.getState().results.items[0].handle, 'alpha', 'name results still publish before content matching')
    f.controller.queueSearch('')
    assert.equal(f.matches[0].signal.aborted, true)
    const accepted = f.controller.getState(), count = f.publications.length
    matching.resolve(new Set(['alpha']))
    await search
    assert.equal(f.controller.getState(), accepted)
    assert.equal(f.publications.length, count)
    assert.equal(accepted.results, undefined)
    assert.equal(accepted.searching, false)
  } finally { f.controller.dispose() }
})

test('dispose during lazy loading cannot publish results or invoke content matching', async () => {
  const gate = deferred()
  const f = fixture({ importGate: gate, entries: [entry('alpha')] })
  const search = f.controller.runSearch('alpha')
  await drain()
  f.controller.dispose()
  const accepted = f.controller.getState(), count = f.publications.length
  gate.resolve()
  await search
  assert.equal(f.controller.getState(), accepted)
  assert.equal(f.publications.length, count)
  assert.equal(f.matches.length, 0)
})

test('runtime generation changes retire both successful and failed pending searches', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), f = fixture({ search: () => pending.promise })
    try {
      await f.controller.start()
      const search = f.controller.runSearch('alpha')
      await drain()
      f.appearance(2)
      const accepted = f.controller.getState(), count = f.publications.length
      if (fail) pending.reject(new Error('Fixture retired bridge request'))
      else pending.resolve(result([entry('alpha')]))
      await search
      assert.equal(f.controller.getState(), accepted)
      assert.equal(f.publications.length, count)
      assert.equal(f.matches.length, 0)
      assert.equal(accepted.searchError, undefined)
    } finally { f.controller.dispose() }
  }
})

test('a transient chunk failure reports the current error and permits a later retry', async () => {
  const f = fixture({ policyFailures: 1, entries: [entry('alpha')] })
  try {
    await f.controller.start()
    await f.controller.runSearch('alpha')
    assert.equal(f.controller.getState().searching, false)
    assert.match(f.controller.getState().searchError, /retry/i)
    assert.equal(f.loads.policy, 0)
    await f.controller.runSearch('alpha')
    assert.equal(f.controller.getState().searchError, undefined)
    assert.equal(f.controller.getState().results.items[0].handle, 'alpha')
    assert.deepEqual(f.loads, { policy: 1, matcher: 1, dictionary: 1 })
  } finally { f.controller.dispose() }
})

test('lazy controller retains actual pinyin, fullwidth, action, market and content ranking', async () => {
  const entries = [entry('notes', '\u7b14\u8bb0', { pluginId: 'fixture.notes' }),
    entry('editor', 'Editor', { kind: 'app', preferred: true }),
    entry('market-notes', 'bj market', { kind: 'market', pluginId: 'fixture.notes' }),
    entry('settings', 'open-settings', { kind: 'action', action: 'open-settings' }),
    entry('regex', 'Email', { content: { type: 'regex', source: '@', minLength: 1 } }),
    entry('over', 'Send text', { content: { type: 'over', minLength: 1 } })]
  const matched = new Set(['regex', 'over'])
  const f = fixture({ entries, match: () => Promise.resolve(matched) })
  try {
    for (const [query, scope, handles] of [['bj', 'all', ['notes']], ['\uff25\uff24\uff29\uff34\uff2f\uff32', 'app', ['editor']],
      ['settings', 'action', ['settings']], ['bj', 'market', ['market-notes']], ['a@example.com', 'all', ['regex', 'over']]]) {
      f.controller.queueSearch(query, scope, true)
      const begin = f.publications.length
      await f.controller.runSearch(query)
      const { rankDefaultWorkspaceSearch: rank } = f.policy()
      const publications = f.publications.slice(begin).filter(state => state.results)
      assert.equal(publications.length, 2, 'name pass and content pass remain distinct')
      assert.deepEqual(plain(publications[0].results.items), plain(rank(entries, query, scope)))
      assert.deepEqual(plain(publications[1].results.items), plain(rank(entries, query, scope, matched)))
      const expectedNamed = handles.filter(handle => !['regex', 'over'].includes(handle))
      const named = publications[0].results.items.map(item => item.handle)
      for (const handle of expectedNamed) assert.ok(named.includes(handle), `${query}: ${handle}`)
      if (query === 'a@example.com') assert.deepEqual(plain(publications[1].results.items.map(item => item.handle)), handles)
    }
    assert.deepEqual(f.loads, { policy: 1, matcher: 1, dictionary: 1 })
  } finally { f.controller.dispose() }
})
