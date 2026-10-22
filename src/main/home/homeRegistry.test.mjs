import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function fixture(state) {
  globalThis.homeRegistryFixture = state
  const adapters = {
    fixture: `export const state=globalThis.homeRegistryFixture;`,
    '@main/contrib/ContributionRegistry': `import {state} from 'fixture'; export const contributionRegistry={listSlot:()=>state.rows};`,
    '@main/plugin/PluginRegistry': `import {state} from 'fixture'; export const pluginRegistry={
      getInstalledDescriptors:()=>state.installed,
      getManifest:()=>state.manifest,
      getAssetRootPath:()=>state.root
    };`,
    '@main/logs/logService': `export const logWarn=()=>{};`
  }
  const result = await build({
    stdin: { contents: `export * from '@main/home/homeRegistry'; export const nonce=${Math.random()};`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`,
    define: { __dirname: JSON.stringify('/app/out/main') },
    plugins: [{ name: 'home-registry-fixture', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], loader: 'js' }))
    } }]
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

test('plugin homes require an enabled current manifest declaration and a contained regular entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-home-registry-'))
  try {
    const source = 'com.github.eNest.demo'
    const contribution = { source, id: 'dashboard', version: 1, entry: 'homes/dashboard.html', variants: ['studio-board', 'library'] }
    const pluginRoot = join(directory, 'plugin')
    await mkdir(join(pluginRoot, 'homes'), { recursive: true })
    await writeFile(join(pluginRoot, contribution.entry), '<!doctype html><title>Home</title>')
    const state = {
      root: pluginRoot,
      rows: [{ source, data: contribution }],
      installed: [{ id: source, enabled: true }],
      manifest: { contributes: { homePages: [{ ...contribution, variants: [...contribution.variants] }] } }
    }
    const api = await fixture(state)
    const resolve = () => api.resolveHomePage(source, 'dashboard', 'studio-board')
    assert.equal((await resolve()).contribution.entry, 'homes/dashboard.html', 'equal declarations need not share object identity')
    assert.equal((await api.resolveHomePage(source, 'dashboard', 'library')).contribution.source, source, 'third-party declarations are not limited to host variants')
    assert.equal(await api.resolveHomePage(source, 'dashboard', 'unknown'), null)
    assert.deepEqual(api.builtinHomeReference().variants, ['default'])
    assert.equal((await api.resolveHomePage('enest.builtin', 'home', 'default')).contribution.source, 'enest.builtin')
    for (const variant of ['ink', 'sketch', 'painted', 'tech', 'legacy', 'studio-board']) {
      assert.equal(await api.resolveHomePage('enest.builtin', 'home', variant), null)
    }
    assert.deepEqual(await api.registerDeclaredHomeContribution(source, { ...contribution, source: 'com.other.forged' }), { ok: true, contribution })
    assert.equal((await api.registerDeclaredHomeContribution(source, { ...contribution, version: 2 })).ok, false)
    assert.equal((await api.registerDeclaredHomeContribution(source, { ...contribution, entry: 'other.html' })).ok, false)
    assert.equal((await api.registerDeclaredHomeContribution(source, null)).ok, false)

    state.installed[0].enabled = false
    assert.equal(await resolve(), null)
    assert.deepEqual(api.listHomeContributions(), [])
    assert.equal((await api.registerDeclaredHomeContribution(source, contribution)).ok, false)
    state.installed[0].enabled = true
    state.manifest.contributes.homePages[0].version = 2
    assert.equal(await resolve(), null, 'a cached row cannot override an updated manifest')
    state.manifest.contributes.homePages = []
    assert.equal(await resolve(), null, 'a persisted runtime-only row does not grant loading')

    const outside = join(directory, 'outside.html')
    await writeFile(outside, '<!doctype html>outside')
    await symlink(outside, join(pluginRoot, 'homes/escape.html'))
    contribution.entry = 'homes/escape.html'
    state.manifest.contributes.homePages = [{ ...contribution }]
    assert.equal(await resolve(), null, 'canonical paths reject a symlink outside the plugin root')

    await mkdir(join(pluginRoot, 'homes/directory.html'))
    contribution.entry = 'homes/directory.html'
    state.manifest.contributes.homePages = [{ ...contribution }]
    assert.equal(await resolve(), null, 'an HTML-shaped directory is not an entry file')

    contribution.entry = 'homes/missing.html'
    state.manifest.contributes.homePages = [{ ...contribution }]
    assert.equal(await resolve(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
    delete globalThis.homeRegistryFixture
  }
})
