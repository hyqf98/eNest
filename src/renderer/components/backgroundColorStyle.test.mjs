import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const module = { exports: {} }
const javascript = ts.transpileModule(readFileSync(new URL('./backgroundColorStyle.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
new Function('module', 'exports', javascript)(module, module.exports)
const { backgroundColorStyle } = module.exports

test('solid colors use backgroundColor and all existing gradient presets retain their image-free rendering', () => {
  assert.deepEqual(backgroundColorStyle('#abc'), { backgroundColor: '#abc' })
  assert.deepEqual(backgroundColorStyle('rgb(12, 30, 40)'), { backgroundColor: 'rgb(12, 30, 40)' })
  const picker = readFileSync(new URL('./BackgroundPicker.tsx', import.meta.url), 'utf8')
  const presets = [...picker.matchAll(/css: '([^']+)'/g)].map(match => match[1])
  assert.ok(presets.length >= 8)
  assert.ok(presets.some(value => value.includes('color-mix(') && value.includes('var(')))
  for (const value of presets) assert.deepEqual(backgroundColorStyle(value), { backgroundImage: value })
})

test('legacy color values cannot become CSS resource fetches through functions, escapes or comments', () => {
  for (const value of [
    'url(https://example.invalid/track)',
    'linear-gradient(red,blue),url(https://example.invalid/track)',
    'image-set(url(x) 1x)', 'image(x)', 'cross-fade(red,blue)', 'paint(tracker)',
    'linear-gradient(red,blue),image-set("https://example.invalid/track" 1x)',
    String.raw`linear-gradient(red,blue),u\72l(x)`,
    'linear-gradient(red,blue),u/**/rl(x)',
    'linear-gradient(red,blue);background:url(x)',
    'linear-gradient(red,blue),URL(x)', 'linear-gradient(red,blue),attr(data-url url)'
  ]) assert.deepEqual(backgroundColorStyle(value), {}, value)
})
