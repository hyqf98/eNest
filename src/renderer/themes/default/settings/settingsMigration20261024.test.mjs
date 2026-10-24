import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const read = path => readFileSync(join(root, path), 'utf8')
const theme = file => read(`src/renderer/themes/default/settings/${file}`)
const components = ['SettingsTabs', 'ProfileSection', 'AppearanceSettingsSection', 'ThemeSettingsFields',
  'ThemeSettingChoices', 'ThemeSelectionCards', 'QuickSettingsSection', 'PluginShortcutSettings',
  'HotkeyPresetCards', 'ShortcutRecorder', 'ShortcutProbeFeedback', 'DevConsoleSection',
  'PluginMemorySection', 'PerformanceCaptureSection', 'LanguageSelect']

test('settings-only compatibility components contain no duplicate UI or business logic', () => {
  for (const name of components) {
    const facade = read(`src/renderer/components/${name}.tsx`)
    assert.match(facade, new RegExp(`export \\* from '@renderer/themes/default/settings/${name}'`))
    assert.doesNotMatch(facade, /useEffect|useState|shellApi|return\s*\(/)
    assert.ok(theme(`${name}.tsx`).includes(`export function ${name}`), name)
  }
  for (const name of ['shortcutCapture', 'useShortcutProbe']) assert.match(read(`src/renderer/components/${name}.ts`), /export \* from '@renderer\/themes\/default\/settings\//)
})

test('default settings keeps the complete original sections, drafts, failures and lazy adapters', () => {
  const page = theme('DefaultSettingsPage.tsx')
  assert.match(page, /export function DefaultSettingsPage\(\)/)
  for (const section of ['ProfileSection', 'AppearanceSettingsSection', 'DevConsoleSection', 'QuickSettingsSection', 'PluginMemorySection']) {
    assert.match(page, new RegExp(`lazy\\(\\(\\) => import\\('\\./${section}'\\)`))
  }
  for (const behavior of ['setProxy', 'testProxy', 'setSettings', 'updateThemeProfile', 'openUpdateDialog', 'setSettingsTab', 'loadingGeneral', 'saveFailed', 'pluginSections', 'pluginSettings']) assert.ok(page.includes(behavior), behavior)
  assert.match(page, /settingsTab\.startsWith\('p:'\)/)
  assert.match(page, /request === requestVersion\.current/)
  assert.match(theme('SettingsTabs.tsx'), /ResizeObserver/)
  assert.match(theme('SettingsTabs.tsx'), /is-expanded/)
  assert.match(theme('SettingsTabs.tsx'), /collapsedForActive/)
  assert.match(theme('AppearanceSettingsSection.tsx'), /updateThemeProfile/)
  assert.match(theme('QuickSettingsSection.tsx'), /overrideToken/)
  assert.match(theme('ProfileSection.tsx'), /shellApi/)
})

test('all setting surface CSS is theme-owned with compatibility imports', () => {
  const styles = [['styles/settings.css', 'settings.css'], ['styles/settingsBase.css', 'settingsBase.css'],
    ['styles/account.css', 'account.css'], ['styles/appearanceSettings.css', 'appearanceSettings.css'],
    ['styles/pluginMemory.css', 'pluginMemory.css'], ['components/pluginSettings.css', 'pluginSettings.css'],
    ['components/shortcutSettings.css', 'shortcutSettings.css']]
  for (const [source, target] of styles) {
    assert.match(read(`src/renderer/${source}`), new RegExp(`@import '@renderer/themes/default/settings/${target}'`))
    assert.ok(theme(target).length > 500, target)
  }
  const css = theme('settings.css')
  for (const preserved of ['--settings-glass-blur: 20px', '.page-settings', '::before', 'backdrop-filter', 'data-anim', 'prefers-reduced-transparency']) assert.ok(css.includes(preserved), preserved)
})

test('moving keyboard presentation does not bypass suspension restoration or commit late captures', async () => {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(theme('shortcutCapture.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, setTimeout, clearTimeout })
  const { eventToAccelerator, ShortcutCapture } = module.exports
  const event = { code: 'KeyK', key: 'k', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true }
  assert.equal(eventToAccelerator(event, 'darwin'), 'Command+K')
  assert.equal(eventToAccelerator({ ...event, repeat: true }, 'darwin'), null)
  assert.equal(eventToAccelerator({ ...event, metaKey: false }, 'darwin'), null)
  const listeners = new Map(), calls = []
  let ready
  const capture = new ShortcutCapture({ begin: () => new Promise(resolve => { ready = resolve }),
    end: async token => { calls.push(['restore', token]) }, onValue: value => calls.push(['value', value]),
    onPhase: phase => calls.push(['phase', phase]), onError: error => { throw error }, platform: 'darwin',
    target: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) } })
  const starting = capture.start()
  await capture.stop()
  ready({ token: 'fixture-token' })
  await starting
  assert.equal(listeners.size, 0)
  assert.deepEqual(calls.filter(([type]) => type === 'restore'), [['restore', 'fixture-token']])
  assert.deepEqual(calls.filter(([type]) => type === 'value'), [])
  capture.dispose()
})
