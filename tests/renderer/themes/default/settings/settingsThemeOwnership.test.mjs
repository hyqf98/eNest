import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
  'PluginMemorySection', 'PerformanceCaptureSection', 'LanguageSelect', 'TopTabBarSection',
  'GeneralSettingsSection', 'PluginSettingsSection']

test('settings components have one physical owner and no retired compatibility entries', () => {
  for (const name of components) {
    assert.equal(existsSync(join(root, `src/renderer/components/${name}.tsx`)), false, name)
    assert.ok(theme(`${name}.tsx`).includes(`export function ${name}`), name)
  }
  for (const name of ['shortcutCapture', 'useShortcutProbe']) {
    assert.equal(existsSync(join(root, `src/renderer/components/${name}.ts`)), false, name)
    assert.ok(theme(`${name}.ts`).includes(`export ${name === 'shortcutCapture' ? 'class ShortcutCapture' : 'function useShortcutProbe'}`), name)
  }
  for (const name of ['useGeneralSettings', 'useSettingsUpdates', 'usePluginSettings']) {
    assert.equal(existsSync(join(root, `src/renderer/hooks/${name}.ts`)), false, name)
    assert.ok(theme(`${name}.ts`).includes(`export function ${name}`), name)
  }
  for (const name of ['Field', 'Card']) assert.ok(theme('SettingsFields.tsx').includes(`export function ${name}`), name)
  assert.equal(existsSync(join(root, 'src/renderer/pages/SettingsPage.tsx')), false)
  assert.equal(existsSync(join(root, 'src/renderer/pages/DevConsolePage.tsx')), false)
  const layout = read('src/renderer/layout/ShellLayout.tsx')
  assert.match(layout, /import\('@renderer\/components\/SettingsSurfaceController'\)/)
  assert.match(layout, /default: module\.SettingsSurfaceController/)
  assert.match(read('src/renderer/components/SettingsSurfaceController.tsx'), /import\('@renderer\/themes\/default\/settings\/DefaultSettingsPage'\)/)
})

test('default settings keeps the complete original sections, drafts, failures and lazy adapters', () => {
  const page = theme('DefaultSettingsPage.tsx')
  assert.match(page, /export function DefaultSettingsPage\(\)/)
  for (const section of ['ProfileSection', 'AppearanceSettingsSection', 'DevConsoleSection', 'QuickSettingsSection', 'PluginMemorySection']) {
    assert.match(page, new RegExp(`lazy\\(\\(\\) => import\\('\\./${section}'\\)`))
  }
  for (const [module, behaviors] of [
    ['DefaultSettingsPage.tsx', ['setSettingsTab', 'useGeneralSettings()', 'useSettingsUpdates()', 'usePluginSettings()']],
    ['useGeneralSettings.ts', ['setProxy', 'testProxy', 'setSettings', 'loadingGeneral']],
    ['TopTabBarSection.tsx', ['updateThemeProfile', 'saveFailed']],
    ['useSettingsUpdates.ts', ['openUpdateDialog']],
    ['usePluginSettings.ts', ['pluginSections', 'pluginSettings']],
  ]) for (const behavior of behaviors) assert.ok(theme(module).includes(behavior), `${module}: ${behavior}`)
  assert.match(page, /settingsTab\.startsWith\('p:'\)/)
  assert.match(theme('TopTabBarSection.tsx'), /request === requestVersion\.current/)
  assert.match(theme('SettingsTabs.tsx'), /ResizeObserver/)
  assert.match(theme('SettingsTabs.tsx'), /is-expanded/)
  assert.match(theme('SettingsTabs.tsx'), /collapsedForActive/)
  assert.match(theme('AppearanceSettingsSection.tsx'), /updateThemeProfile/)
  assert.match(theme('QuickSettingsSection.tsx'), /overrideToken/)
  assert.match(theme('ProfileSection.tsx'), /shellApi/)
})

test('all setting surface CSS is theme-owned without retired compatibility imports', () => {
  const styles = [['styles/settings.css', 'settings.css'], ['styles/settingsBase.css', 'settingsBase.css'],
    ['styles/account.css', 'account.css'], ['styles/appearanceSettings.css', 'appearanceSettings.css'],
    ['styles/pluginMemory.css', 'pluginMemory.css'], ['components/pluginSettings.css', 'pluginSettings.css'],
    ['components/shortcutSettings.css', 'shortcutSettings.css']]
  for (const [source, target] of styles) {
    assert.equal(existsSync(join(root, `src/renderer/${source}`)), false, source)
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
