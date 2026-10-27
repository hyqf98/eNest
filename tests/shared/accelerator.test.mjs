import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const output = await build({ entryPoints: [fileURLToPath(new URL('../../src/shared/accelerator.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { normalizeAccelerator: normalize, normalizeUserShortcut } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('equivalent native accelerators have one ownership key on each platform', () => {
  assert.equal(normalize(' shift + ctrl + j ', 'win32'), 'Control+Shift+J')
  assert.equal(normalize('CmdOrCtrl+shift+J', 'win32'), 'Control+Shift+J')
  assert.equal(normalize('Super+Shift+j', 'darwin'), 'Shift+Command+J')
  assert.equal(normalize('cmd+shift+j', 'darwin'), 'Shift+Command+J')
  assert.equal(normalize('CommandOrControl+Enter', 'darwin'), 'Command+Return')
  assert.equal(normalize('Ctrl+Control+J', 'linux'), 'Control+J')
  assert.equal(normalize('Ctrl++', 'linux'), 'Control+Shift+=')
  assert.equal(normalize('Alt+num3', 'linux'), 'Alt+num3')
})

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: Command and Super aliases share the same native ownership key`, () => {
    const modifier = platform === 'darwin' ? 'Command' : 'Super'
    for (const alias of ['Command', 'Cmd', 'Meta', 'Super', 'Win', 'Windows']) {
      assert.equal(normalize(`${alias}+Shift+K`, platform), `Shift+${modifier}+K`)
      assert.equal(normalizeUserShortcut(`${alias}+Shift+K`, platform), `Shift+${modifier}+K`)
    }
    assert.equal(normalize('Cmd+Super+Meta+K', platform), `${modifier}+K`, 'duplicate aliases do not create a different shortcut')
    assert.equal(normalize('CmdOrCtrl+K', platform), platform === 'darwin' ? 'Command+K' : 'Control+K')
    assert.equal(normalize('Control+Option+Shift+J', platform), 'Control+Alt+Shift+J')
    for (const [symbol, physical] of [['!', '1'], ['Plus', '='], ['_', '-'], ['?', '/'], [':', ';'], ['{', '[']]) {
      assert.equal(normalize(`Ctrl+${symbol}`, platform), normalize(`Control+Shift+${physical}`, platform))
    }
  })
}

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
