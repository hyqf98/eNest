import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const directory = resolve(root, 'src/renderer/themes/default/quick')
const nativeRequire = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(options = {}) {
  const modules = new Map(), loads = { policy: 0, dictionary: 0 }
  let failures = options.failures ?? 0
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false,
    } }).outputText
    const require = specifier => {
      if (specifier === 'pinyin-pro') { loads.dictionary++; return nativeRequire(specifier) }
      const target = specifier === '@shared/search' ? resolve(root, 'src/shared/search.ts')
        : specifier.startsWith('.') ? resolve(dirname(file), `${specifier}.ts`) : null
      if (!target) throw new Error(`Unexpected fixture import: ${specifier}`)
      if (target === resolve(directory, 'searchPolicy.ts')) {
        loads.policy++
        if (failures > 0) { failures--; throw new Error('Fixture chunk unavailable') }
        return options.gate ? options.gate.promise.then(() => load(target)) : load(target)
      }
      return load(target)
    }
    try { vm.runInNewContext(`(function(require,module,exports){${code}\n})`)(require, module, module.exports) }
    catch (error) { modules.delete(file); throw error }
    return module.exports
  }
  return {
    loads,
    home: load(resolve(directory, 'catalogPolicy.ts')),
    loader: load(resolve(directory, 'searchPolicyLoader.ts')),
  }
}

test('Quick home and pasted media render without importing the pinyin dictionary', () => {
  const f = fixture()
  const catalog = [
    { id: 'notes', kind: 'plugin', title: '笔记' },
    { id: 'recent', kind: 'app', title: 'Editor', lastUsedTs: 1_000, useCount: 2 },
    { id: 'image', kind: 'plugin', title: 'Image', content: { type: 'img' } },
    { id: 'settings', kind: 'action', title: 'open-settings', action: 'open-settings' },
  ]
  const media = f.home.matchDefaultQuickMedia(catalog, [{ id: 'attachment', kind: 'image' }])
  assert.deepEqual(plain(f.home.rankDefaultQuickHome(catalog, undefined, 60, media.matches, 2_000).map(item => item.id)), ['image', 'recent', 'notes'])
  assert.deepEqual(plain(f.home.rankDefaultQuickHome(catalog, 'action').map(item => item.title)), ['打开设置'])
  assert.equal(f.loader.getLoadedDefaultQuickSearchPolicy(), undefined)
  assert.deepEqual(f.loads, { policy: 0, dictionary: 0 })
})

test('first name searches share one pending dictionary load and retain pinyin, aliases and ranking', async () => {
  const gate = deferred(), f = fixture({ gate })
  const first = f.loader.loadDefaultQuickSearchPolicy(), second = f.loader.loadDefaultQuickSearchPolicy()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(f.loads.dictionary, 0)
  assert.equal(f.loader.getLoadedDefaultQuickSearchPolicy(), undefined)
  gate.resolve()
  const policy = await first
  assert.equal(await second, policy)
  assert.equal(await f.loader.loadDefaultQuickSearchPolicy(), policy)
  assert.deepEqual(f.loads, { policy: 1, dictionary: 1 })
  const catalog = [
    { id: 'notes', kind: 'plugin', title: '笔记', aliases: ['笔记'] },
    { id: 'exact', kind: 'plugin', title: 'edit', aliases: ['edit'] },
    { id: 'editor', kind: 'app', title: 'Editor', aliases: ['Editor'], preferred: true },
    { id: 'settings', kind: 'action', title: 'open-settings', action: 'open-settings' },
  ]
  assert.equal(policy.rankDefaultQuickCatalog(catalog, 'bj')[0].id, 'notes')
  assert.equal(policy.rankDefaultQuickCatalog(catalog, 'biji')[0].id, 'notes')
  assert.equal(policy.rankDefaultQuickCatalog(catalog, 'ＥＤＩＴＯＲ')[0].id, 'editor')
  assert.equal(policy.rankDefaultQuickCatalog(catalog, 'edit')[0].id, 'editor')
  assert.deepEqual(plain(policy.rankDefaultQuickCatalog(catalog, '设置').map(item => [item.id, item.title])), [['settings', '打开设置']])
  for (const kind of [undefined, 'app', 'plugin', 'action']) {
    assert.deepEqual(plain(policy.rankDefaultQuickCatalog(catalog, '', kind)), plain(f.home.rankDefaultQuickHome(catalog, kind)))
  }
})

test('failed lazy imports stay unavailable and can be retried without caching partial name indexes', async () => {
  const f = fixture({ failures: 1 })
  await assert.rejects(f.loader.loadDefaultQuickSearchPolicy(), /Fixture chunk unavailable/)
  assert.equal(f.loader.getLoadedDefaultQuickSearchPolicy(), undefined)
  assert.equal(f.loads.dictionary, 0)
  const policy = await f.loader.loadDefaultQuickSearchPolicy()
  assert.equal(policy.rankDefaultQuickCatalog([{ id: 'notes', kind: 'plugin', title: '笔记' }], 'bj')[0].id, 'notes')
  assert.deepEqual(f.loads, { policy: 2, dictionary: 1 })
})

test('the surface fences stale imports and does not publish a final empty projection while loading', () => {
  const surface = readFileSync(resolve(directory, 'DefaultQuickSurface.tsx'), 'utf8')
  assert.doesNotMatch(surface, /from ['"]\.\/searchPolicy['"]|from ['"]\.\/nameMatching['"]/)
  assert.match(surface, /if \(!cancelled\) setSearchPolicy\(policy\)/)
  assert.match(surface, /return \(\) => \{ cancelled = true \}/)
  assert.match(surface, /if \(!searchActive \|\| plugin \|\| hasQuery && !searchPolicy\) return\s+void dispatch\(\{ type: 'results'/)
  assert.match(surface, /const busy = snapshot\.loading \|\| policyPending/)
  assert.match(surface, /searchPolicy\?\.rankDefaultQuickCatalog\(usageCatalog, query, kind/)
  assert.match(surface, /queryRevision: snapshot\.queryRevision/)
  assert.match(surface, /displayError && <div className="quick-error"/)
})
