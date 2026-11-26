import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const output = await build({ entryPoints: [fileURLToPath(new URL('../../../src/main/settings/legacyCanvasExport.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
const { legacyCanvasExport } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

const bounds = { x: -1280, y: 24, width: 960, height: 640, displayId: 29 }
const note = { pluginId: 'com.github.eNest.sticky-notes', x: 16, y: 24, width: 360, height: 280, z: 2 }
const clock = { pluginId: 'com.github.eNest.timestamp', x: 300, y: 80, width: 240, height: 160, z: 5 }

test('exports only the old panels section’s geometry, display identity, plugin owners and z-order', () => {
  const source = [{
    id: 'panel-1ac9f730', bounds: { ...bounds, label: 'Private display' }, appearance: { opacity: 0.2 },
    widgets: [{ ...note, data: { text: 'Private note' }, path: '/private/notes' }, { ...clock, status: 'ready', icon: 'private-icon' }],
  }]
  const original = structuredClone(source)
  const result = legacyCanvasExport(source)
  assert.deepEqual(result, { version: 1, panels: [{ id: 'panel-1ac9f730', bounds, widgets: [note, clock] }] })
  result.panels[0].bounds.x = 0
  result.panels[0].widgets[0].z = 99
  result.panels[0].widgets.pop()
  assert.deepEqual(source, original)
})

test('skips malformed records without losing a valid sibling or exporting invalid coordinates', () => {
  const source = [null, [], { bounds: { ...bounds, height: 0 }, widgets: [] }, { bounds, widgets: {} }, {
    id: 'panel-1ac9f730', bounds: { ...bounds, displayId: '29' },
    widgets: [null, { ...note, width: -1 }, { ...note, x: Infinity }, { ...note, y: '24' }, { ...note, pluginId: '/not/an/owner' }, { ...clock, z: 2.5 }],
  }]
  assert.deepEqual(legacyCanvasExport(source), {
    version: 1, panels: [{ id: 'panel-1ac9f730', bounds: { ...bounds, displayId: -1 }, widgets: [{ ...clock, z: 0 }] }],
  })
})

test('caps each export at eight panels and twenty-four widgets without trimming saved settings', () => {
  const source = Array.from({ length: 9 }, (_, panelIndex) => ({
    id: `panel-${panelIndex}`, bounds: { ...bounds },
    widgets: Array.from({ length: 25 }, (_, widgetIndex) => ({ ...clock, pluginId: `example.panel-${panelIndex}.widget-${widgetIndex}`, z: widgetIndex })),
  }))
  const original = structuredClone(source)
  const expected = original.slice(0, 8).map(panel => ({ ...panel, widgets: panel.widgets.slice(0, 24) }))
  assert.deepEqual(legacyCanvasExport(source), { version: 1, panels: expected })
  assert.deepEqual(source, original)
})
