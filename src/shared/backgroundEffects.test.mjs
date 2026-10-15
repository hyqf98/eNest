import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import Ajv2020 from 'ajv/dist/2020.js'

const require = createRequire(import.meta.url)
function load(file, mocks = {}) {
  const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  return module.exports
}
const effects = load('./backgroundEffects.ts', { '@shared/pluginContract': load('./pluginContract.ts') })
const source = 'com.example.backgrounds'
const preset = { id: 'jade', name: 'Jade silk', renderer: 'preset', preset: 'aurora', colors: ['#071B20', '#3AD7AE', '#F5DCA1'], speed: 0.75, logoStyle: 'aurora' }
const video = { id: 'film', name: 'Film', renderer: 'video', video: `enest://plugin/${source}/assets/backgrounds/film.webm`, poster: `enest://plugin/${source}/assets/backgrounds/film.webp`, logoStyle: 'fold' }
const pack = (id = 'night', backgroundEffects = [preset, video]) => ({ id, name: id, source, mode: 'dark', tokens: {}, backgroundEffects })

test('built-ins retain their selected names, default, and explicit off state', () => {
  assert.deepEqual(effects.listBackgroundEffects().map(effect => effect.id), ['fold', 'aurora', 'orbit', 'ripple', 'tunnel'])
  assert.equal(effects.DEFAULT_BACKGROUND_EFFECT, 'tunnel')
  assert.equal(effects.resolveBackgroundEffect('ripple').name, '液态波纹')
  assert.equal(effects.resolveBackgroundEffect('tunnel').name, '光域隧道')
  for (const selection of [undefined, '', 'missing', 'plugin:orphaned']) assert.equal(effects.resolveBackgroundEffect(selection).id, 'tunnel')
  assert.equal(effects.resolveBackgroundEffect('none'), null)
  const listed = effects.listBackgroundEffects()
  listed[0].name = 'mutated'
  assert.equal(effects.resolveBackgroundEffect('fold').name, '空间折叠')
})

test('plugin effect IDs are stable, collision-free and cannot replace a built-in', () => {
  const builtinName = { ...preset, id: 'tunnel' }
  const packs = [pack('a:b', [builtinName]), pack('a%3Ab', [builtinName])]
  const ids = effects.listBackgroundEffects(packs).map(effect => effect.id)
  assert.equal(new Set(ids).size, 7)
  assert.ok(ids.includes(`plugin:${source}:a%3Ab:tunnel`))
  assert.ok(ids.includes(`plugin:${source}:a%253Ab:tunnel`))
  assert.equal(effects.resolveBackgroundEffect('tunnel', packs).source, undefined)
  const selected = effects.resolveBackgroundEffect(effects.getPluginBackgroundEffectId(source, 'a:b', 'tunnel'), packs)
  assert.equal(selected.source, source)
  assert.equal(selected.preset, 'aurora')
  selected.colors[0] = '#000000'
  assert.equal(packs[0].backgroundEffects[0].colors[0], '#071B20')
  assert.equal(effects.listBackgroundEffects([pack(), pack()]).length, 7)
})

test('preset data is bounded, finite, explicit and rejects executable or unknown fields', () => {
  assert.deepEqual(effects.validateBackgroundEffects([preset, video], source), [preset, video])
  for (const speed of [0.25, 2]) assert.equal(effects.validateBackgroundEffects([{ ...preset, speed }], source)[0].speed, speed)
  const invalid = [
    null, [], { ...preset, id: 'plugin:fold' }, { ...preset, id: '../escape' }, { ...preset, id: 'a'.repeat(49) },
    { ...preset, name: '' }, { ...preset, name: ' padded ' }, { ...preset, name: 'a'.repeat(65) },
    { ...preset, description: 'a'.repeat(201) }, { ...preset, description: 'line\nbreak' },
    { ...preset, renderer: 'shader', shader: 'void main(){}' }, { ...preset, script: 'alert(1)' },
    { ...preset, url: 'https://example.test' }, { ...preset, source: 'enest.builtin' },
    { ...preset, preset: 'custom' }, { ...preset, logoStyle: 'javascript:alert(1)' },
    ...[0, 0.249, 2.01, NaN, Infinity, -Infinity, '1'].map(speed => ({ ...preset, speed })),
    ...[[], ['#fff', '#fff', '#fff'], ['red', '#000000', '#FFFFFF'], ['#123456', '#123456'],
      ['#123456', 1, '#123456'], Array(3)].map(colors => ({ ...preset, colors })),
    { ...video, speed: 1 }, { ...preset, video: video.video }
  ]
  for (const item of invalid) assert.throws(() => effects.validateBackgroundEffects([item], source), /background effect/, JSON.stringify(item))
  assert.throws(() => effects.validateBackgroundEffects([preset, preset], source), /duplicate/)
  assert.throws(() => effects.validateBackgroundEffects(Array(1), source), /definition/)
  assert.throws(() => effects.validateBackgroundEffects(Array.from({ length: 9 }, (_, i) => ({ ...preset, id: `effect${i}` })), source), /at most 8/)
  assert.equal(effects.validateBackgroundEffects(Array.from({ length: 8 }, (_, i) => ({ ...preset, id: `effect${i}` })), source).length, 8)
})

test('video and poster assets cannot escape their owning plugin or load active content', () => {
  const invalidUrls = [
    'https://example.test/film.mp4', 'file:///private/film.mp4', '/private/film.mp4', 'C:\\private\\film.mp4',
    'data:video/mp4;base64,AAAA', 'blob:enest://plugin/film', 'javascript:alert(1)',
    'enest://plugin/com.other.plugin/assets/film.mp4', `enest://plugin/${source}/index.mp4`,
    `enest://plugin/${source}/assets/../film.mp4`, `enest://plugin/${source}/assets/sub/../film.mp4`,
    `enest://plugin/${source}/assets/%2e%2e/film.mp4`, `enest://plugin/${source}/assets/%252e%252e/film.mp4`,
    `enest://plugin/${source}/assets/%2f../film.mp4`, `enest://plugin/${source}/assets/.secret/film.mp4`,
    `enest://plugin/${source}/assets/a%5cb.mp4`, `enest://plugin/${source}/assets/%00film.mp4`,
    `enest://plugin/${source}/assets/film.mp4?track=1`, `enest://plugin/${source}/assets/film.mp4#fragment`,
    `enest://plugin/${source}/assets/film.mov`, `enest://plugin/${source}/assets/script.js`,
    `enest://plugin/${source}/assets/film%ZZ.mp4`, `enest://plugin/${source}/assets/film.mp4\n`
  ]
  for (const url of invalidUrls) assert.throws(() => effects.validateBackgroundEffects([{ ...video, video: url }], source), /background effect/, url)
  for (const poster of ['https://example.test/p.png', 'enest://plugin/com.other.plugin/assets/p.png', `enest://plugin/${source}/assets/p.svg`]) {
    assert.throws(() => effects.validateBackgroundEffects([{ ...video, poster }], source), /background effect/)
  }
  assert.equal(effects.validateBackgroundEffects([{ ...video, video: `enest://plugin/${source}/assets/space%20film.MP4` }], source)[0].video, `enest://plugin/${source}/assets/space%20film.MP4`)
  assert.equal(effects.listBackgroundEffects([pack('bad', [{ ...video, video: invalidUrls[0] }])]).length, 5)
})

test('manifest schema accepts preset/video examples and rejects unknown executable fields and unbounded parameters', () => {
  const schema = JSON.parse(readFileSync(new URL('./pluginManifest.schema.json', import.meta.url), 'utf8'))
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile({
    ...schema.properties.contributes.properties.themePacks, $defs: schema.$defs
  })
  assert.equal(validate([pack()]), true, JSON.stringify(validate.errors))
  for (const effect of [{ ...preset, shader: 'x' }, { ...preset, speed: 3 }, { ...preset, colors: ['#fff'] },
    { ...video, video: 'https://example.test/film.mp4' }, { ...video, poster: 'file:///private/p.png' },
    { ...video, video: `enest://plugin/${source}/assets/../film.mp4` }]) {
    assert.equal(validate([pack('invalid', [effect])]), false, JSON.stringify(effect))
  }
  assert.equal(validate([pack('too-many', Array.from({ length: 9 }, (_, i) => ({ ...preset, id: `effect${i}` })))]), false)
})

test('published manifest and runnable HTML examples register valid background definitions', async () => {
  const documentation = readFileSync(new URL('../../docs/site/plugin/themes.md', import.meta.url), 'utf8')
  const manifestExamples = [...documentation.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]))
  const example = manifestExamples.find(item => item.id === source)
  assert.ok(example, 'the complete background manifest example must exist')
  for (const item of example.contributes.themePacks) assert.equal(effects.validateBackgroundEffects(item.backgroundEffects, example.id).length, 2)

  const html = documentation.match(/```html\n([\s\S]*?)\n```/)[1]
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  let click, registered
  const button = { disabled: false, addEventListener: (name, callback) => { assert.equal(name, 'click'); click = callback } }
  const status = { textContent: '' }
  runInNewContext(script, {
    document: { querySelector: selector => selector === '#register-backgrounds' ? button : status },
    enest: { getPluginId: () => source, theme: { register: async item => { registered = structuredClone(item) } } }
  })
  await click()
  assert.equal(registered.source, source)
  assert.equal(effects.validateBackgroundEffects(registered.backgroundEffects, source)[0].preset, 'aurora')
  assert.match(status.textContent, /已注册/)
  assert.equal(button.disabled, false)
})
