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

test('solid colors and supported gradients retain their image-free rendering without removed preset UI', () => {
  assert.deepEqual(backgroundColorStyle('#abc'), { backgroundColor: '#abc' })
  assert.deepEqual(backgroundColorStyle('rgb(12, 30, 40)'), { backgroundColor: 'rgb(12, 30, 40)' })
  const presets = [
    'linear-gradient(120deg, #264839, #113b55)',
    'radial-gradient(circle at 30% 20%, #e6b785, transparent 70%)',
    'conic-gradient(from 45deg, #f7f3ed, #a85532)',
    'repeating-linear-gradient(45deg, #fff 0 2px, #eee 2px 4px)',
    'linear-gradient(165deg, color-mix(in srgb, var(--accent) 20%, #fff), var(--bg))',
  ]
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
