import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('./appearanceResources.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const fontHandle = meta => createHash('sha256').update(`enest-font:${meta.id}:${meta.fileName}`).digest('hex')
function loadModule(path, mocks = {}) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const contract = loadModule('../../shared/pluginContract.ts')
const colors = loadModule('../../shared/theme/colors.ts')
const palettes = loadModule('../../shared/theme/defaultTheme/backgroundPalettes.ts', { '@shared/theme/colors': colors })
const pluginPaths = loadModule('../plugin/pluginPaths.ts', { '@shared/pluginContract': contract })

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'enest-appearance-resources-')))
  const dataRoot = join(directory, 'data')
  const state = { fonts: [], plugins: [], legacyMedia: undefined, legacySplash: undefined, legacyBackup: undefined, selection: { canceled: true, filePaths: [] }, dialogs: [], writes: [], dialogWait: null, afterCopy: null, afterPublish: null, beforeFontsRead: null, failWrites: false }
  const mocks = {
    electron: { dialog: { showOpenDialog: async options => { state.dialogs.push(options); if (state.dialogWait) await state.dialogWait; return state.selection } } },
    'node:fs': { ...require('node:fs'), linkSync: (...args) => { require('node:fs').linkSync(...args); state.afterPublish?.() } },
    'node:fs/promises': { ...require('node:fs/promises'), copyFile: async (...args) => { await require('node:fs/promises').copyFile(...args); state.afterCopy?.() } },
    '@shared/constants': { FONTS_DIR: 'fonts' },
    '@shared/pluginContract': contract,
    '@shared/theme/defaultTheme/backgroundPalettes': palettes,
    '@shared/theme/appearance': { themeProfileKey: identity => `v2:${encodeURIComponent(identity.source)}:${encodeURIComponent(identity.id)}` },
    '@shared/theme/builtinThemes': { BUILTIN_THEME_PACKS: [] },
    '@main/theme/themePacks': { themePackRegistry: { list: () => [] } },
    '@main/paths/pathsService': { getAppPathsRoot: () => dataRoot },
    '@main/plugin/PluginRegistry': { pluginRegistry: { getInstalledDescriptors: () => state.plugins, get: id => state.plugins.find(item => item.id === id) } },
    '@main/plugin/pluginPaths': pluginPaths,
    '@main/settings/SettingsStore': { settingsStore: {
      getPluginAppearance: () => { state.beforeFontsRead?.(); return { customFonts: state.fonts } },
      getAppearanceSettings: () => ({ legacy: { theme: { background: state.legacyMedia }, general: { splashBackground: state.legacySplash } }, legacyBackup: state.legacyBackup }),
      commitAppearanceFontRemoval: (id, family) => { if (state.failWrites) throw new Error('fixture persistence failed'); state.writes.push({ removed: id, family }); state.fonts = state.fonts.filter(font => font.id !== id) },
      setAll: async value => { if (state.failWrites) throw new Error('fixture persistence failed'); state.writes.push(value); state.fonts = value.general.customFonts }
    } }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => mocks[name] ?? require(name), module, module.exports)
  return { ...module.exports, state, directory, dataRoot, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('public font handles include only exact selected families without private metadata', async () => {
  const api = await fixture()
  try {
    api.state.fonts = [
      { id: 'selected', family: 'Body Font', name: 'private original', fileName: 'private.woff2' },
      { id: 'substring', family: 'Body', fileName: 'substring.ttf' },
      { id: 'empty', family: '', fileName: 'empty.ttf' },
      { id: 'invalid', family: 'Bad; Font', fileName: 'bad.ttf' },
      { id: 'mono', family: 'Mono_Font', fileName: 'mono.ttf' }
    ]
    const fonts = api.publicAppearanceFonts({ body: '"Body Font", serif', heading: "'Body Font', sans-serif", mono: 'Mono_Font, monospace', scale: 1 })
    assert.deepEqual(fonts, [api.state.fonts[0], api.state.fonts[4]].map(meta => ({ family: meta.family, url: `enest://appearance/font/${fontHandle(meta)}` })))
    assert.equal(JSON.stringify(fonts).includes('private'), false)
    assert.equal(api.publicAppearanceFonts({ body: 'serif', heading: 'serif', mono: 'monospace', cjk: '"Body Font", serif', latin: 'Mono_Font', scale: 1 }).length, 2)
    api.state.fonts = Array.from({ length: 10 }, (_, index) => ({ id: String(index), family: `Font ${index}`, fileName: `${index}.ttf` }))
    assert.equal(api.publicAppearanceFonts({ body: api.state.fonts.map(item => item.family).join(','), heading: '', mono: '', scale: 1 }).length, 8)
  } finally { await api.cleanup() }
})

test('legacy selected files get bounded opaque grants without exposing paths or authorizing sibling files', async () => {
  const api = await fixture()
  try {
    const path = join(api.directory, 'private background.png')
    await writeFile(path, 'selected media')
    const selected = { type: 'image', value: path, fit: 'contain', opacity: 0.65 }
    assert.equal(api.publicAppearanceMedia(selected), null)
    api.state.legacyMedia = selected
    const published = api.publicAppearanceMedia(selected)
    assert.match(published.value, /^enest:\/\/appearance\/media\/[a-f0-9]{64}\.png$/)
    assert.equal(JSON.stringify(published).includes(api.directory), false)
    assert.deepEqual(api.publicAppearanceMedia(selected), published)
    const id = published.value.split('/').at(-1)
    assert.deepEqual(await api.resolveAppearanceResource('media', id), { path, root: api.directory, mime: 'image/png' })
    assert.equal(api.publicAppearanceMedia({ ...selected, value: join(api.directory, 'sibling.png') }), null)
    api.state.legacyMedia = undefined
    assert.equal(await api.resolveAppearanceResource('media', id), null, 'a de-selected file revokes its grant')
    assert.equal(api.publicAppearanceMedia({ type: 'color', value: 'url(file:///secret)', opacity: 1 }), null)
    assert.equal(api.publicAppearanceMedia({ type: 'color', value: '#a85532', opacity: 1 }).value, '#a85532')
  } finally { await api.cleanup() }
})

test('plugin media grants stay within an enabled installed source and cannot follow asset symlinks', async () => {
  const api = await fixture()
  try {
    const rootPath = join(api.directory, 'plugin')
    await mkdir(join(rootPath, 'assets'), { recursive: true })
    await writeFile(join(rootPath, 'assets', 'selected.svg'), '<svg/>')
    const descriptor = { id: 'com.example.theme', rootPath, enabled: true }
    api.state.plugins = [descriptor]
    const selected = { type: 'image', value: 'enest://plugin/com.example.theme/assets/selected.svg', opacity: 0.7 }
    const published = api.publicAppearanceMedia(selected)
    assert.ok(published)
    assert.equal(published.value.includes('com.example'), false)
    const id = published.value.split('/').at(-1)
    assert.equal((await api.resolveAppearanceResource('media', id)).mime, 'image/svg+xml')
    assert.equal(api.publicAppearanceMedia({ ...selected, value: selected.value.replace('/assets/', '/backend/') }), null)
    assert.equal(api.publicAppearanceMedia({ ...selected, value: `${selected.value}?path=private` }), null)
    const outside = join(api.directory, 'outside.png')
    await writeFile(outside, 'private')
    await symlink(outside, join(rootPath, 'assets', 'escape.png'))
    const escape = api.publicAppearanceMedia({ ...selected, value: selected.value.replace('selected.svg', 'escape.png') })
    assert.equal(await api.resolveAppearanceResource('media', escape.value.split('/').at(-1)), null)
    descriptor.enabled = false
    assert.equal(api.publicAppearanceMedia(selected), null)
    assert.equal(await api.resolveAppearanceResource('media', id), null)
  } finally { await api.cleanup() }
})

test('resource resolution requires opaque current handles, canonical containment and per-kind limits', async () => {
  const api = await fixture()
  try {
    const mediaRoot = join(api.dataRoot, 'appearance', 'media')
    const fontsRoot = join(api.dataRoot, 'fonts')
    await mkdir(mediaRoot, { recursive: true })
    await mkdir(fontsRoot, { recursive: true })
    const mediaId = `${'a'.repeat(64)}.png`
    await writeFile(join(mediaRoot, mediaId), 'PNG')
    assert.deepEqual(await api.resolveAppearanceResource('media', mediaId), { path: join(mediaRoot, mediaId), root: mediaRoot, mime: 'image/png' })
    for (const id of ['../private.png', '/private.png', 'a.png', `${'a'.repeat(64)}.svg`, `${mediaId}?path=secret`]) {
      assert.equal(await api.resolveAppearanceResource('media', id), null)
    }
    const meta = { id: 'font', family: 'Font', fileName: 'font.woff2' }
    api.state.fonts = [meta]
    await writeFile(join(fontsRoot, meta.fileName), 'wOF2')
    assert.equal((await api.resolveAppearanceResource('font', fontHandle(meta))).mime, 'font/woff2')
    assert.equal(await api.resolveAppearanceResource('font', meta.fileName), null)
    assert.equal(await api.resolveAppearanceResource('font', 'b'.repeat(64)), null)
    await truncate(join(fontsRoot, meta.fileName), 5 * 1024 * 1024 + 1)
    assert.equal(await api.resolveAppearanceResource('font', fontHandle(meta)), null)
    await truncate(join(mediaRoot, mediaId), 128 * 1024 * 1024 + 1)
    assert.equal(await api.resolveAppearanceResource('media', mediaId), null)
    const outside = join(api.directory, 'outside.ttf')
    await writeFile(outside, 'FONT')
    const escaped = { id: 'escape', family: 'Font', fileName: 'escape.ttf' }
    api.state.fonts.push(escaped, { id: 'traversal', family: 'Font', fileName: '../outside.ttf' })
    await symlink(outside, join(fontsRoot, escaped.fileName))
    assert.equal(await api.resolveAppearanceResource('font', fontHandle(escaped)), null)
    assert.equal(await api.resolveAppearanceResource('font', fontHandle(api.state.fonts.at(-1))), null)
    api.state.fonts = []
    assert.equal(await api.resolveAppearanceResource('font', fontHandle(meta)), null)
  } finally { await api.cleanup() }
})

test('native imports verify content, publish opaque copies and deduplicate font metadata', async () => {
  const api = await fixture()
  try {
    assert.equal(await api.pickAppearanceMedia(), null)
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    const input = join(api.directory, 'private-name.png')
    await writeFile(input, png)
    api.state.selection = { canceled: false, filePaths: [input] }
    const selected = await api.pickAppearanceMedia()
    const mediaName = `${createHash('sha256').update(png).digest('hex')}.png`
    assert.deepEqual(selected, { type: 'image', value: `enest://appearance/media/${mediaName}`, fit: 'cover', opacity: 0.85 })
    assert.deepEqual(await readFile(join(api.dataRoot, 'appearance', 'media', mediaName)), png)
    assert.equal(JSON.stringify(selected).includes('private-name'), false)
    assert.deepEqual(api.state.dialogs.at(-1).properties, ['openFile'])
    const fontInput = join(api.directory, 'My Font.woff2')
    await writeFile(fontInput, 'wOF2verified')
    api.state.selection.filePaths = [fontInput]
    const font = await api.importAppearanceFont()
    assert.equal(font.name, 'My Font')
    assert.match(font.family, /^eNestFont-[a-f0-9]{16}$/)
    assert.match(font.fileName, /^[a-f0-9]{64}\.woff2$/)
    assert.equal(JSON.stringify(font).includes(api.directory), false)
    assert.deepEqual(await api.importAppearanceFont(), font)
    assert.equal(api.state.writes.length, 1)
    assert.equal((await api.resolveAppearanceResource('font', fontHandle(font))).mime, 'font/woff2')
    assert.equal((await readdir(join(api.dataRoot, 'fonts'))).some(name => name.startsWith('.import-')), false)
  } finally { await api.cleanup() }
})

test('imports reject deceptive headers, unsupported extensions, oversized fonts and multi-selection', async () => {
  const api = await fixture()
  try {
    const badPng = join(api.directory, 'bad.png')
    await writeFile(badPng, '<html>not a PNG</html>')
    api.state.selection = { canceled: false, filePaths: [badPng] }
    await assert.rejects(() => api.pickAppearanceMedia(), /文件内容与格式不匹配/)
    assert.deepEqual(await readdir(join(api.dataRoot, 'appearance', 'media')), [])
    const font = join(api.directory, 'large.ttf')
    await writeFile(font, Buffer.from([0, 1, 0, 0]))
    await truncate(font, 5 * 1024 * 1024 + 1)
    api.state.selection.filePaths = [font]
    await assert.rejects(() => api.importAppearanceFont(), /文件格式或大小不受支持/)
    const script = join(api.directory, 'script.js')
    await writeFile(script, 'wOF2not a font')
    api.state.selection.filePaths = [script]
    await assert.rejects(() => api.importAppearanceFont(), /文件格式或大小不受支持/)
    api.state.selection.filePaths = [script, font]
    assert.equal(await api.importAppearanceFont(), null)
    assert.equal(api.state.writes.length, 0)
  } finally { await api.cleanup() }
})

test('retired import owners cannot open a picker or publish a native dialog result', async () => {
  const api = await fixture()
  try {
    for (const pick of [api.pickAppearanceMedia, api.importAppearanceFont]) {
      await assert.rejects(() => pick(() => false), /owner is no longer active/)
    }
    assert.equal(api.state.dialogs.length, 0)
    let release
    api.state.dialogWait = new Promise(resolve => { release = resolve })
    let current = true
    const pending = api.importAppearanceFont(() => current)
    await Promise.resolve()
    assert.equal(api.state.dialogs.length, 1)
    current = false
    release()
    await assert.rejects(() => pending, /owner is no longer active/)
    assert.equal(api.state.writes.length, 0)
    assert.deepEqual(await readdir(api.directory), [], 'no resource directories or copies are created after retirement')
  } finally { await api.cleanup() }
})

test('retirement during copying or publication removes temporary and newly imported resources', async () => {
  for (const phase of ['afterCopy', 'afterPublish', 'beforeFontsRead']) {
    const api = await fixture()
    try {
      const input = join(api.directory, 'Private Font.woff2')
      await writeFile(input, 'wOF2verified')
      api.state.selection = { canceled: false, filePaths: [input] }
      let current = true
      api.state[phase] = () => { current = false }
      await assert.rejects(() => api.importAppearanceFont(() => current), /owner is no longer active/)
      assert.equal(api.state.writes.length, 0)
      assert.deepEqual(await readdir(join(api.dataRoot, 'fonts')), [], phase)
    } finally { await api.cleanup() }
  }
})

test('font persistence failure discards only the new copy and retains pre-existing resources', async () => {
  const api = await fixture()
  try {
    const input = join(api.directory, 'Private Font.woff2')
    await writeFile(input, 'wOF2verified')
    api.state.selection = { canceled: false, filePaths: [input] }
    api.state.failWrites = true
    await assert.rejects(() => api.importAppearanceFont(), /persistence failed/)
    assert.deepEqual(await readdir(join(api.dataRoot, 'fonts')), [])
    assert.equal(api.state.fonts.length, 0)
    api.state.failWrites = false
    const existing = await api.importAppearanceFont()
    const savedBytes = await readFile(join(api.dataRoot, 'fonts', existing.fileName))
    let current = true
    api.state.afterCopy = () => { current = false }
    await assert.rejects(() => api.importAppearanceFont(() => current), /owner is no longer active/)
    assert.deepEqual(await readFile(join(api.dataRoot, 'fonts', existing.fileName)), savedBytes)
    assert.deepEqual(await readdir(join(api.dataRoot, 'fonts')), [existing.fileName])
    assert.equal(api.state.fonts.length, 1)
  } finally { await api.cleanup() }
})

test('only the eight authored atmospheres and controlled legacy slots can cross the public media bridge', async () => {
  const api = await fixture()
  try {
    for (const palette of palettes.DEFAULT_BACKGROUND_PALETTES) {
      assert.equal(api.publicAppearanceMedia({ type: 'color', value: palette.css }).value, palette.css)
      assert.equal(api.publicAppearanceMedia({ type: 'color', value: palette.css + ', url(file:///secret)' }), null)
    }
    assert.equal(api.publicAppearanceMedia({ type: 'color', value: 'linear-gradient(red, blue)' }), null)
    const path = join(api.directory, 'startup.png')
    await writeFile(path, 'PNG selected')
    api.state.legacySplash = { type: 'image', value: path, opacity: 0.55 }
    const marker = { type: 'image', value: 'enest://appearance/legacy/splash', fit: 'cover', opacity: 0.55 }
    const published = api.publicAppearanceMedia(marker)
    assert.match(published.value, /^enest:\/\/appearance\/media\/[a-f0-9]{64}\.png$/)
    assert.equal(JSON.stringify(published).includes(api.directory), false)
    assert.equal((await api.resolveAppearanceResource('media', published.value.split('/').at(-1))).path, path)
    assert.equal(api.publicAppearanceMedia({ ...marker, type: 'video' }), null)
    api.state.legacySplash = undefined
    assert.equal(await api.resolveAppearanceResource('media', published.value.split('/').at(-1)), null)
    api.state.legacyBackup = { theme: {}, general: { splashBackground: { type: 'image', value: path } } }
    api.state.legacySplash = { type: 'brand', opacity: 0.55 }
    assert.ok(api.publicAppearanceMedia(marker), 'the immutable selected migration backup remains recoverable')
    assert.equal(api.publicAppearanceMedia({ ...marker, value: 'enest://appearance/legacy/other' }), null)
  } finally { await api.cleanup() }
})

test('re-projecting legacy compatibility grants is idempotent but revoked or forged handles stay unavailable', async () => {
  const api = await fixture()
  try {
    for (const extension of ['svg', 'ico', 'mov']) {
      const type = extension === 'mov' ? 'video' : 'image'
      const path = join(api.directory, `legacy.${extension}`)
      await writeFile(path, 'legacy selected bytes')
      api.state.legacyMedia = { type, value: path, opacity: 0.7, fit: 'cover' }
      const first = api.publicAppearanceMedia(api.state.legacyMedia)
      assert.ok(first)
      assert.deepEqual(api.publicAppearanceMedia(first), first, `${extension} survives shell -> Home projection`)
      assert.equal(api.publicAppearanceMedia({ ...first, type: type === 'image' ? 'video' : 'image' }), null)
      assert.equal(api.publicAppearanceMedia({ type, value: `enest://appearance/media/${'f'.repeat(64)}.${extension}` }), null)
      api.state.legacyMedia = undefined
      assert.equal(api.publicAppearanceMedia(first), null)
      assert.equal(await api.resolveAppearanceResource('media', first.value.split('/').at(-1)), null)
    }
    const provider = { id: 'com.example.theme', enabled: true, rootPath: join(api.directory, 'plugin') }
    api.state.plugins = [provider]
    const image = api.publicAppearanceMedia({ type: 'image', value: 'enest://plugin/com.example.theme/assets/preview.svg' })
    assert.deepEqual(api.publicAppearanceMedia(image), image)
    provider.enabled = false
    assert.equal(api.publicAppearanceMedia(image), null)
  } finally { await api.cleanup() }
})

test('startup image import rejects video before copying despite a forged picker selection', async () => {
  const api = await fixture()
  try {
    const video = join(api.directory, 'startup.mp4')
    await writeFile(video, Buffer.from([0, 0, 0, 8, 102, 116, 121, 112]))
    api.state.selection = { canceled: false, filePaths: [video] }
    await assert.rejects(() => api.pickAppearanceMedia(() => true, { imageOnly: true }), /文件格式或大小不受支持/)
    assert.ok(api.state.dialogs[0].filters[0].extensions.every(ext => !['mp4', 'webm'].includes(ext)))
    assert.deepEqual(await readdir(api.directory), ['startup.mp4'], 'a rejected resource never creates a library or copy')
  } finally { await api.cleanup() }
})

test('font deletion checks ownership and canonical containment and revokes only after durable success', async () => {
  const api = await fixture()
  try {
    const source = join(api.directory, 'Owned Font.woff2')
    await writeFile(source, 'wOF2verified')
    api.state.selection = { canceled: false, filePaths: [source] }
    const font = await api.importAppearanceFont()
    const path = join(api.dataRoot, 'fonts', font.fileName)
    const before = await readFile(path)
    for (const id of ['../outside.woff2', 'unknown']) await assert.rejects(() => api.removeAppearanceFont(id), /unavailable/)
    await assert.rejects(() => api.removeAppearanceFont(font.id, () => false), /owner is no longer active/)
    api.state.failWrites = true
    await assert.rejects(() => api.removeAppearanceFont(font.id), /persistence failed/)
    assert.deepEqual(api.state.fonts, [font])
    assert.deepEqual(await readFile(path), before)
    api.state.failWrites = false
    let current = true
    api.state.beforeFontsRead = () => { current = false }
    await assert.rejects(() => api.removeAppearanceFont(font.id, () => current), /owner is no longer active/)
    api.state.beforeFontsRead = null
    const outside = join(api.directory, 'outside.woff2')
    await writeFile(outside, 'wOF2outside')
    const link = join(api.dataRoot, 'fonts', 'escape.woff2')
    await symlink(outside, link)
    api.state.fonts.push({ id: 'escape', family: 'Escape', fileName: 'escape.woff2' })
    await assert.rejects(() => api.removeAppearanceFont('escape'), /outside its library/)
    await api.removeAppearanceFont(font.id)
    assert.equal(await api.resolveAppearanceResource('font', fontHandle(font)), null)
    assert.equal(api.state.fonts.some(item => item.id === font.id), false)
    assert.equal((await readdir(join(api.dataRoot, 'fonts'))).includes(font.fileName), false)
    assert.equal((await readFile(outside)).toString(), 'wOF2outside')
  } finally { await api.cleanup() }
})

test('only paints the active theme actually declared may cross the media bridge', async () => {
  const api = await fixture()
  try {
    const declared = 'radial-gradient(ellipse 80% 60% at 10% 0%, #d9b3a0 0%, transparent 62%), linear-gradient(160deg, #f6eee6, #e4cbb9)'
    const selected = { type: 'color', value: declared, opacity: 0.85, fit: 'cover' }
    // 未声明时，第三方渐变仍被拒绝——发布边界没有被整体放宽。
    assert.equal(api.publicAppearanceMedia(selected), null)
    assert.equal(api.publicAppearanceMedia(selected, new Set(['#123456'])), null)
    // 声明后才放行，且不改变其它约束。
    assert.equal(api.publicAppearanceMedia(selected, new Set([declared])).value, declared)
    assert.equal(api.publicAppearanceMedia({ ...selected, value: `${declared}, url(file:///secret)` }, new Set([`${declared}, url(file:///secret)`])), null)
    // 内置 8 套与普通颜色不受影响。
    assert.equal(api.publicAppearanceMedia({ ...selected, value: palettes.DEFAULT_BACKGROUND_PALETTES[1].css }, new Set()).value, palettes.DEFAULT_BACKGROUND_PALETTES[1].css)
    assert.equal(api.publicAppearanceMedia({ ...selected, value: '#a85532' }).value, '#a85532')
  } finally { await api.cleanup() }
})
