import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({ entryPoints: ['src/main/dev/devShortcuts.ts'], tsconfig: 'tsconfig.node.json', bundle: true, write: false, format: 'esm', platform: 'node' })
const { devShortcutAction } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

const key = (over = {}) => ({ key: 'a', control: false, meta: false, alt: false, shift: false, isAutoRepeat: false, ...over })

test('browser-style DevTools combos map to the devtools action', () => {
  assert.equal(devShortcutAction(key({ key: 'F12' })), 'devtools')
  assert.equal(devShortcutAction(key({ key: 'i', meta: true, alt: true })), 'devtools', '⌘⌥I')
  assert.equal(devShortcutAction(key({ key: 'I', meta: true, alt: true })), 'devtools')
  assert.equal(devShortcutAction(key({ key: 'i', control: true, shift: true })), 'devtools', 'Ctrl+Shift+I')
})

test('plain modifier combos and bare keys never trigger', () => {
  assert.equal(devShortcutAction(key({ key: 'i' })), null)
  assert.equal(devShortcutAction(key({ key: 'r' })), null)
  assert.equal(devShortcutAction(key({ key: 'i', meta: true })), null, '⌘I alone must stay with the page')
  assert.equal(devShortcutAction(key({ key: 'i', control: true })), null)
  assert.equal(devShortcutAction(key({ key: 'f12' })), 'devtools', 'defensive: lowercase f12 also toggles')
})

test('reload fires once per press and ignores auto-repeat', () => {
  assert.equal(devShortcutAction(key({ key: 'r', meta: true })), 'reload')
  assert.equal(devShortcutAction(key({ key: 'r', control: true })), 'reload')
  assert.equal(devShortcutAction(key({ key: 'r', meta: true, isAutoRepeat: true })), null)
})
