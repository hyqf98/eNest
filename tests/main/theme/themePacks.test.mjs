import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(file, new URL("../../../src/main/theme/", import.meta.url)), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? (name === '@shared/theme/builtinThemes' ? builtinThemes : name.startsWith('@shared/') ? load(`../../shared/${name.slice('@shared/'.length)}.ts`) : require(name)), module, module.exports)
  return module.exports
}
const builtinThemes = load('../../shared/theme/builtinThemes.ts')
const contract = load('../../shared/pluginContract.ts')
const backgroundEffects = load('../../shared/backgroundEffects.ts', { '@shared/pluginContract': contract })
const appearance = load('../../shared/theme/appearance.ts', {
  '@shared/types/appearance': {},
  '@shared/theme/presets': load('../../shared/theme/presets.ts', { '@shared/theme/colors': load('../../shared/theme/colors.ts') }),
  '@shared/theme/colors': load('../../shared/theme/colors.ts'),
  '@shared/backgroundEffects': backgroundEffects,
  '@shared/pluginContract': contract
})
const validV2 = (id = 'v2-theme') => ({
  schemaVersion: 2,
  version: 1,
  id,
  name: 'V2 Theme',
  mode: 'system',
  tokens: { '--accent': '#bd542b' },
  variants: {
    light: {
      tokens: { '--accent': '#bd542b' },
      fonts: { body: '-apple-system', heading: '-apple-system', mono: 'SF Mono', scale: 1 },
      components: { controlRadius: 6, cardRadius: 10, panelRadius: 8, borderWidth: 1 },
      background: { media: null, effect: 'none', texture: 'none', intensity: 0, speed: 1, direction: 0 },
      layout: { variant: 'comfortable', density: 1, gap: 12, sidebarWidth: 260, contentWidth: 1200, columns: 2 },
      animation: 'medium'
    },
    dark: {
      tokens: { '--accent': '#e98654' },
      fonts: { body: '-apple-system', heading: '-apple-system', mono: 'SF Mono', scale: 1 },
      components: { controlRadius: 6, cardRadius: 10, panelRadius: 8, borderWidth: 1 },
      background: { media: null, effect: 'none', texture: 'none', intensity: 0, speed: 1, direction: 0 },
      layout: { variant: 'comfortable', density: 1, gap: 12, sidebarWidth: 260, contentWidth: 1200, columns: 2 },
      animation: 'medium'
    }
  },
  settings: {
    version: 2,
    groups: [{
      id: 'accent',
      title: 'Accent',
      fields: [{
        key: 'accent',
        label: 'Accent',
        type: 'color',
        default: '#bd542b',
        binding: { target: 'token', key: '--accent' }
      }]
    }]
  },
  home: { source: 'com.test.theme', id: 'home', variant: 'legacy' }
})
test('plugin theme tokens cannot inject selectors or non-token root properties, including persisted packs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-tokens-'))
  const mocks = {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} },
    '@shared/backgroundEffects': backgroundEffects, '@shared/pluginContract': contract, '@shared/theme/appearance': appearance,
    '@shared/theme/builtinThemes': builtinThemes,
  }
  const js = ts.transpileModule(readFileSync(new URL('../../../src/main/theme/themePacks.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  const tokens = {
    '--accent': '#bd542b',
    '--font': 'Arial, sans-serif',
    'display': 'none',
    '--x: red; } body { display': 'none',
    '--x\n} body { color': '#fff',
    '--remote': 'url(https://example.test/exfil)'
  }
  try {
    const registry = new module.exports.ThemePackRegistry()
    const saved = await registry.register({ id: 'test-theme', name: 'Test', source: 'com.test.theme', tokens })
    assert.deepEqual(saved.tokens, { '--accent': '#bd542b', '--font': 'Arial, sans-serif' })
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8'))[0].tokens, saved.tokens)
    await writeFile(join(directory, 'registry.json'), JSON.stringify([{ ...saved, tokens }]))
    const reloaded = new module.exports.ThemePackRegistry()
    await reloaded.load()
    assert.deepEqual(reloaded.get('test-theme').tokens, saved.tokens)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('concurrent theme sources serialize atomic registry writes and leave valid complete JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-persist-'))
  let active = 0, maximum = 0
  const mocks = {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} },
    '@shared/backgroundEffects': backgroundEffects, '@shared/pluginContract': contract, '@shared/theme/appearance': appearance,
    '@shared/theme/builtinThemes': builtinThemes,
    'node:fs/promises': { ...fs, writeFile: async (...args) => {
      active++; maximum = Math.max(maximum, active)
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await writeFile(...args) }
      finally { active-- }
    } }
  }
  const js = ts.transpileModule(readFileSync(new URL('../../../src/main/theme/themePacks.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  try {
    const registry = new module.exports.ThemePackRegistry()
    await Promise.all(Array.from({ length: 6 }, (_, i) => registry.register({
      id: 'theme-' + i, name: 'Theme ' + i, source: 'com.test.source' + i, tokens: { '--accent': '#fff' }
    })))
    assert.equal(maximum, 1)
    const saved = JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8'))
    assert.equal(saved.length, 6)
    assert.deepEqual(await readdir(directory), ['registry.json'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('plugin themes cannot use shell backgrounds for remote, local-file or cross-plugin access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-background-'))
  const { ThemePackRegistry } = load('./themePacks.ts', {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} }, '@shared/backgroundEffects': backgroundEffects, '@shared/pluginContract': contract, '@shared/theme/appearance': appearance
  })
  const source = 'com.test.theme', pack = { id: 'background', name: 'Background', source, tokens: { '--accent': '#fff' } }
  const bad = [
    { type: 'color', value: 'url(https://example.test/track)' },
    { type: 'color', value: 'image-set("https://example.test/track" 1x)' },
    { type: 'image', value: 'https://example.test/track.png' },
    { type: 'image', value: 'data:image/svg+xml,<svg/>' },
    { type: 'video', value: 'blob:enest://plugin/anything' },
    { type: 'image', value: '/Users/someone/private.png' },
    { type: 'image', value: 'enest://media/?path=/Users/someone/private.png' },
    { type: 'image', value: 'enest://plugin/com.other.plugin/assets/private.png' },
    { type: 'image', value: `enest://plugin/${source}/assets/%252e%252e/private.png` },
    { type: 'image', value: `enest://plugin/${source}/assets/../private.png` },
    { type: 'image', value: `enest://plugin/${source}/assets/icon.svg?path=/private` },
    { type: 'image', value: `enest://plugin/${source}/assets/index.html` }
  ]
  try {
    const registry = new ThemePackRegistry()
    for (const background of bad) {
      const saved = await registry.registerPlugin({ ...pack, background }, source)
      assert.equal(saved.background, undefined, JSON.stringify(background))
      assert.equal(registry.get(pack.id).background, undefined)
    }
    for (const background of [
      { type: 'color', value: '#153b4f', opacity: 0.5, fit: 'cover' },
      { type: 'color', value: 'rgba(10, 20, 30, 0.7)', opacity: 0.7, fit: 'contain' },
      { type: 'image', value: `enest://plugin/${source}/assets/wallpaper.webp`, opacity: 0.8, fit: 'cover' },
      { type: 'video', value: `enest://plugin/${source}/assets/wallpaper.webm`, opacity: 0.9, fit: 'contain' }
    ]) assert.deepEqual((await registry.registerPlugin({ ...pack, background }, source)).background, background)
    await writeFile(join(directory, 'registry.json'), JSON.stringify([{ ...pack, background: bad[0] }]))
    const reloaded = new ThemePackRegistry()
    await reloaded.load()
    assert.equal(reloaded.get(pack.id).background, undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('plugin theme sources cannot impersonate built-ins or bypass per-source quotas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-owner-'))
  const { ThemePackRegistry } = load('./themePacks.ts', {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} }, '@shared/backgroundEffects': backgroundEffects, '@shared/pluginContract': contract, '@shared/theme/appearance': appearance
  })
  try {
    const registry = new ThemePackRegistry(), pack = { id: 'default', name: 'Fixture', source: 'enest.builtin', tokens: {} }
    await assert.rejects(registry.registerPlugin(pack, 'enest.builtin'), /reserved theme source/)
    await assert.rejects(registry.register(pack), /reserved theme source/)
    await registry.load()
    await assert.rejects(registry.registerPlugin(pack, 'com.test.theme'), /already registered by enest.builtin/)
    for (let i = 0; i < 8; i++) {
      const saved = await registry.registerPlugin({ ...pack, id: 'plugin-' + i }, 'com.test.theme')
      assert.equal(saved.source, 'com.test.theme')
    }
    await assert.rejects(registry.registerPlugin({ ...pack, id: 'excess' }, 'com.test.theme'), /theme pack limit/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('host startup restores only the single compiled default and keeps retired themes and the reserved source private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-builtin-boot-'))
  const { ThemePackRegistry } = load('./themePacks.ts', {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} }, '@shared/backgroundEffects': backgroundEffects,
    '@shared/pluginContract': contract, '@shared/theme/appearance': appearance,
  })
  try {
    const registry = new ThemePackRegistry()
    await registry.load()
    assert.deepEqual(registry.list(), builtinThemes.BUILTIN_THEME_PACKS, 'compiled package loads without a disk registry')
    await assert.rejects(readFile(join(directory, 'registry.json')), { code: 'ENOENT' })
    assert.deepEqual(builtinThemes.BUILTIN_THEME_PACKS.map(pack => pack.id), ['default'])
    assert.equal(builtinThemes.BUILTIN_THEME_PACKS.length, 1)
    for (const pack of builtinThemes.BUILTIN_THEME_PACKS) {
      assert.deepEqual(registry.get(pack.id), pack)
      await assert.rejects(registry.register(pack), /reserved theme source/)
      await assert.rejects(registry.registerPlugin(pack, 'enest.builtin'), /reserved theme source/)
      await assert.rejects(registry.registerPlugin(pack, 'com.test.theme'), /home/)
    }
    assert.deepEqual(registry.list(), builtinThemes.BUILTIN_THEME_PACKS)
    assert.equal(await registry.remove('default'), false, 'the compiled fallback package cannot be removed')
    assert.deepEqual(await registry.removeBySource('enest.builtin'), [])
    for (const id of ['warm', 'ink', 'sketch', 'painted', 'tech', 'legacy-custom']) {
      assert.equal(registry.get(id), null)
    }
    assert.equal(registry.get('forged'), null)
    const detached = registry.get('default')
    detached.home.variant = 'forged'
    assert.equal(registry.get('default').home.variant, 'default')

    await writeFile(join(directory, 'registry.json'), JSON.stringify([
      ...builtinThemes.BUILTIN_THEME_PACKS.map(pack => ({ ...pack, name: 'Forged from disk' })),
      ...['warm', 'ink', 'sketch', 'painted', 'tech'].map(id => ({ ...builtinThemes.BUILTIN_THEME_PACKS[0], id })),
      { ...builtinThemes.BUILTIN_THEME_PACKS[0], id: 'forged' },
    ]))
    const reloaded = new ThemePackRegistry()
    await reloaded.load()
    assert.deepEqual(reloaded.list(), builtinThemes.BUILTIN_THEME_PACKS, 'disk cannot replace compiled reserved-source definitions')
    const extension = await reloaded.registerPlugin({ id: 'extension', name: 'Extension', tokens: {} }, 'com.test.theme')
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8')), [extension], 'only external registrations are persisted')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('V2 theme packs register without activation and retain strict source and quota ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-v2-'))
  const { ThemePackRegistry } = load('./themePacks.ts', {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} },
    '@shared/backgroundEffects': backgroundEffects,
    '@shared/pluginContract': contract,
    '@shared/theme/appearance': appearance
  })
  try {
    const registry = new ThemePackRegistry()
    const saved = await registry.registerPlugin({ ...validV2(), source: 'forged.source' }, 'com.test.theme')
    assert.equal(saved.source, 'com.test.theme')
    assert.equal(saved.schemaVersion, 2)
    assert.equal(saved.home.source, 'com.test.theme')
    const activeSettings = JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8'))
    assert.equal(activeSettings.length, 1)
    assert.ok(!('active' in activeSettings[0]))

    await assert.rejects(
      registry.registerPlugin({ ...validV2(), home: { source: 'com.other.plugin', id: 'home', variant: 'legacy' } }, 'com.test.theme'),
      /home/
    )
    await assert.rejects(
      registry.registerPlugin({ ...validV2(), schemaVersion: 3 }, 'com.test.theme'),
      /schemaVersion/
    )
    await registry.registerPlugin({ ...validV2(), id: 'second', home: undefined }, 'com.test.theme')
    for (let i = 2; i < 8; i++) await registry.registerPlugin(validV2('theme-' + i), 'com.test.theme')
    await assert.rejects(registry.registerPlugin(validV2('excess'), 'com.test.theme'), /theme pack limit/)

    await writeFile(join(directory, 'registry.json'), JSON.stringify([
      saved,
      { ...validV2('invalid'), variants: { light: saved.variants.light } }
    ]))
    const reloaded = new ThemePackRegistry()
    await reloaded.load()
    assert.equal(reloaded.get(saved.id).schemaVersion, 2)
    assert.equal(reloaded.get('invalid'), null)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('V2 registration and reload preserve official mixed-case source ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-official-source-'))
  const { ThemePackRegistry } = load('./themePacks.ts', {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} }, '@shared/backgroundEffects': backgroundEffects,
    '@shared/pluginContract': contract, '@shared/theme/appearance': appearance
  })
  const source = 'com.github.eNest.theme'
  try {
    const registry = new ThemePackRegistry()
    const input = { ...validV2('official-theme'), source: 'com.forged.source', home: { source, id: 'home', variant: 'legacy' } }
    const saved = await registry.registerPlugin(input, source)
    assert.equal(saved.source, source)
    assert.equal(saved.home.source, source)
    await assert.rejects(registry.registerPlugin({ ...input, home: { ...input.home, source: source.toLowerCase() } }, source), /home/)
    const reloaded = new ThemePackRegistry()
    await reloaded.load()
    assert.equal(reloaded.get(saved.id).source, source)
    assert.equal(reloaded.get(saved.id).home.source, source)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('background effects register with bound ownership, survive reload, and disappear with source GC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-effects-'))
  const { ThemePackRegistry } = load('./themePacks.ts', {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} }, '@shared/pluginContract': contract, '@shared/backgroundEffects': backgroundEffects,
    '@shared/theme/appearance': appearance
  })
  const source = 'com.test.effects'
  const pack = { id: 'effects', name: 'Effects', source: 'enest.builtin', mode: 'dark', tokens: {}, backgroundEffects: [
    { id: 'tunnel', name: 'Custom tunnel', renderer: 'preset', preset: 'tunnel', colors: ['#071B20', '#3AD7AE', '#F5DCA1'], speed: 0.75 },
    { id: 'film', name: 'Film', renderer: 'video', video: `enest://plugin/${source}/assets/film.webm`, poster: `enest://plugin/${source}/assets/film.webp`, logoStyle: 'fold' }
  ] }
  try {
    const registry = new ThemePackRegistry()
    const saved = await registry.registerPlugin(pack, source)
    assert.equal(saved.source, source)
    assert.deepEqual(saved.backgroundEffects, pack.backgroundEffects)
    const id = backgroundEffects.getPluginBackgroundEffectId(source, pack.id, 'tunnel')
    assert.equal(backgroundEffects.resolveBackgroundEffect(id, registry.list()).source, source)
    assert.equal(backgroundEffects.resolveBackgroundEffect('tunnel', registry.list()).source, undefined)
    await assert.rejects(registry.registerPlugin({ ...pack, backgroundEffects: [{ ...pack.backgroundEffects[1], video: 'enest://plugin/com.other.plugin/assets/film.mp4' }] }, source), /belong/)
    await assert.rejects(registry.registerPlugin({ ...pack, backgroundEffects: [{ ...pack.backgroundEffects[0], speed: Infinity }] }, source), /speed/)
    await assert.rejects(registry.registerPlugin({ ...pack, backgroundEffects: [pack.backgroundEffects[0], pack.backgroundEffects[0]] }, source), /duplicate/)
    await assert.rejects(registry.registerPlugin({ ...pack, backgroundEffects: Array.from({ length: 9 }, (_, i) => ({ ...pack.backgroundEffects[0], id: `item${i}` })) }, source), /at most 8/)
    assert.deepEqual(registry.get(pack.id), saved, 'failed updates must leave the previous pack intact')
    const reloaded = new ThemePackRegistry()
    await reloaded.load()
    assert.deepEqual(reloaded.get(pack.id), saved)
    await reloaded.registerPlugin({ id: 'other', name: 'Other', tokens: {}, backgroundEffects: [{ id: 'tunnel', name: 'Other tunnel', renderer: 'preset', preset: 'tunnel' }] }, 'com.other.plugin'),
    await reloaded.load()
    await assert.rejects(reloaded.registerPlugin(pack, 'com.other.plugin'), /already registered by|belong/)
    assert.deepEqual(await reloaded.removeBySource(source), [pack.id])
    assert.equal(backgroundEffects.resolveBackgroundEffect(id, reloaded.list()).id, 'tunnel')
    assert.equal(reloaded.get('other').source, 'com.other.plugin')
    const afterGc = new ThemePackRegistry()
    await afterGc.load()
    assert.equal(afterGc.get(pack.id), null)
    assert.equal(backgroundEffects.listBackgroundEffects(afterGc.list()).length, 6)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('persisted background definitions are revalidated and do not bypass owner or source quotas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-theme-effects-disk-'))
  const { ThemePackRegistry } = load('./themePacks.ts', {
    '@main/paths/pathsService': { getAppPaths: () => ({ themes: directory }) },
    '@main/logs/logService': { logWarn() {} }, '@shared/pluginContract': contract, '@shared/backgroundEffects': backgroundEffects,
    '@shared/theme/appearance': appearance
  })
  const source = 'com.test.effects'
  const base = { id: 'safe', name: 'Safe', source, tokens: { '--accent': '#123456' }, backgroundEffects: [{ id: 'preset', name: 'Preset', renderer: 'preset', preset: 'fold' }] }
  try {
    await writeFile(join(directory, 'registry.json'), JSON.stringify([
      base,
      { ...base, source: 'com.other.plugin', name: 'Spoofed owner' },
      { ...base, id: 'remote', backgroundEffects: [{ id: 'film', name: 'Film', renderer: 'video', video: 'https://example.test/film.mp4' }] },
      { ...base, id: 'shader', backgroundEffects: [{ ...base.backgroundEffects[0], shader: 'void main(){}' }] },
      { ...base, id: 'wrong-owner', backgroundEffects: [{ id: 'film', name: 'Film', renderer: 'video', video: 'enest://plugin/com.other.plugin/assets/film.mp4' }] },
      ...Array.from({ length: 8 }, (_, i) => ({ ...base, id: `extra${i}` }))
    ]))
    const registry = new ThemePackRegistry()
    await registry.load()
    assert.equal(registry.get('safe').source, source)
    assert.equal(registry.get('safe').name, 'Safe')
    for (const id of ['remote', 'shader', 'wrong-owner']) {
      assert.equal(registry.get(id).backgroundEffects, undefined)
      assert.deepEqual(registry.get(id).tokens, base.tokens)
    }
    assert.equal(registry.countBySource(source), 8)
    assert.equal(registry.get('extra7'), null)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
