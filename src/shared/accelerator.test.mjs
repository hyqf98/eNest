import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const output = await build({ entryPoints: [new URL('./accelerator.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })
const { normalizeAccelerator: normalize, normalizeUserShortcut } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('equivalent native accelerators have one ownership key on each platform', () => {
  assert.equal(normalize(' shift + ctrl + j ', 'win32'), 'Control+Shift+J')
  assert.equal(normalize('CmdOrCtrl+shift+J', 'win32'), 'Control+Shift+J')
  assert.equal(normalize('Super+Shift+j', 'darwin'), 'Shift+Command+J')
  assert.equal(normalize('cmd+shift+j', 'darwin'), 'Shift+Command+J')
  assert.equal(normalize('CommandOrControl+Enter', 'darwin'), 'Command+Return')
  assert.equal(normalize('Ctrl+Control+J', 'linux'), 'Control+J')
  assert.equal(normalize('Ctrl++', 'linux'), 'Control+Plus')
  assert.equal(normalize('Alt+num3', 'linux'), 'Alt+num3')
})

test('malformed accelerators are rejected before touching native registration', () => {
  for (const value of [null, {}, '', 'Control', 'Control+J+K', 'unknown+J', 'Control+++', 'F25', 'Control+']) {
    assert.equal(normalize(value, 'linux'), null, String(value))
  }
})

test('user bindings require a non-Shift modifier while the runtime parser retains Electron key support', () => {
  for (const value of ['A', 'Shift+A', 'F1', 'Shift+F24', 'Return']) {
    assert.equal(normalizeUserShortcut(value), null, value)
    assert.equal(typeof normalize(value), 'string', value)
  }
  for (const value of ['Ctrl+A', 'Alt+F1', 'AltGr+J', 'Super+Space', 'Control+Shift+K']) {
    assert.equal(typeof normalizeUserShortcut(value), 'string', value)
  }
})
