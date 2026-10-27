import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../', import.meta.url))
const heavyPages = /\/components\/(SettingsSurfaceController|QuickLauncherApp)\.tsx$|\/themes\/default\/(settings\/DefaultSettingsPage|workspace\/preview\/MarketPage)\.tsx$/
const settingsSections = /\/themes\/default\/settings\/(AppearanceSettingsSection|DevConsoleSection|QuickSettingsSection|PluginMemorySection|ProfileSection)\.tsx$|\/components\/ColorPickerField\.tsx$/

test('shell and native overlay cold graphs exclude lazily-loaded routes and settings sections', async t => {
  const result = await build({ absWorkingDir: root,
    entryPoints: ['main.tsx', 'homeClient.ts', 'orb-overlay.ts', 'install-overlay.tsx', 'detached-plugin.ts', 'notification-overlay.tsx', 'modal-overlay.tsx']
      .map(path => `src/renderer/${path}`),
    bundle: true, write: false, splitting: true, minify: true, format: 'esm', platform: 'browser', metafile: true,
    outdir: join(root, '.perf-in-memory-only'), tsconfig: join(root, 'tsconfig.web.json'), loader: { '.css': 'empty', '.png': 'file' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const outputs = result.metafile.outputs
  const graph = entry => {
    const visited = new Set(), inputs = new Set()
    const visit = path => {
      if (visited.has(path)) return
      visited.add(path)
      const output = outputs[path]
      assert.ok(output, `Unknown output ${path}`)
      for (const [input, contribution] of Object.entries(output.inputs)) if (contribution.bytesInOutput > 0) inputs.add(input)
      for (const imported of output.imports) if (!imported.external && imported.kind !== 'dynamic-import') visit(imported.path)
    }
    const entryOutput = Object.keys(outputs).find(path => outputs[path].entryPoint === entry)
    assert.ok(entryOutput, `Missing entry ${entry}`)
    visit(entryOutput)
    return { inputs: [...inputs], bytes: [...visited].reduce((sum, path) => sum + outputs[path].bytes, 0) }
  }
  for (const entry of ['main.tsx', 'homeClient.ts', 'orb-overlay.ts', 'install-overlay.tsx', 'detached-plugin.ts', 'notification-overlay.tsx', 'modal-overlay.tsx']) {
    const cold = graph(`src/renderer/${entry}`)
    assert.deepEqual(cold.inputs.filter(path => heavyPages.test(path) || settingsSections.test(path)), [], entry)
    t.diagnostic(`${entry}: static JS graph ${Math.round(cold.bytes / 1024)} KiB (esbuild fixture, not a runtime memory measurement)`)
  }
  const controller = graph('src/renderer/components/SettingsSurfaceController.tsx')
  assert.deepEqual(controller.inputs.filter(path => path.endsWith('/themes/default/settings/DefaultSettingsPage.tsx')), [], 'the host controller keeps the fallback settings page lazy')
  const settings = graph('src/renderer/themes/default/settings/DefaultSettingsPage.tsx')
  assert.deepEqual(settings.inputs.filter(path => settingsSections.test(path)), [], 'general settings must not eagerly load other sections')
  for (const name of ['AppearanceSettingsSection', 'ColorPickerField', 'DevConsoleSection', 'QuickSettingsSection', 'PluginMemorySection', 'ProfileSection']) {
    const directory = name === 'ColorPickerField' ? 'components' : 'themes/default/settings'
    assert.ok(Object.values(outputs).some(output => output.entryPoint === `src/renderer/${directory}/${name}.tsx`), `${name} stays available as a lazy chunk`)
  }
  const home = graph('src/renderer/homeClient.ts')
  assert.deepEqual(home.inputs.filter(path => /services\/shellApi|fixtures\/browser-preview|stores\/shellStore|hooks\/useAppearance\.ts$/.test(path)), [], 'Home prewarm remains isolated from privileged shell state')
})

test('renderer snapshot adapter forwards the caller force flag to preload', async () => {
  const result = await build({ entryPoints: [join(root, 'src/renderer/services/shellApi.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
    tsconfig: join(root, 'tsconfig.web.json'), loader: { '.css': 'empty' },
  })
  const calls = [], module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require, console, structuredClone,
    localStorage: { getItem: () => null, setItem() {} },
    window: { enestShell: { getPluginMemorySnapshot: async force => { calls.push(force); return { sampledAt: 123 } } } },
  })
  await module.exports.shellApi.getPluginMemorySnapshot(true)
  await module.exports.shellApi.getPluginMemorySnapshot(false)
  await module.exports.shellApi.getPluginMemorySnapshot()
  assert.deepEqual(calls, [true, false, false])
})
