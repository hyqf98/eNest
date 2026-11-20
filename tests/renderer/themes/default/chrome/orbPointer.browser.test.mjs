import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

test('default rail keeps the real close button under a stationary pointer until the user leaves', { skip: process.env.ENEST_ORB_RAIL_UI !== '1' }, async t => {
  const { outputFiles } = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { migrateAppearanceSettings, resolveAppearance } from '@shared/theme/appearance'
      const settings = migrateAppearanceSettings(undefined, { theme: {}, general: { tabStyle: 'orb', animationLevel: 'low' } })
      const appearance = resolveAppearance({ settings, reducedMotion: true })
      appearance.layout.orbDock = window.railDock
      appearance.layout.tabStyle = 'orb'
      window.railState.theme.appearance = appearance
      void import('@renderer/themes/default/chrome/orb')` },
    tsconfig: 'tsconfig.web.json', bundle: true, write: false, outfile: 'orb.js', format: 'iife', platform: 'browser',
    define: { 'import.meta.hot': 'undefined', 'import.meta.env.DEV': 'false' },
  })
  const browser = await chromium.launch(process.env.ENEST_CHROME_PATH ? { executablePath: process.env.ENEST_CHROME_PATH } : { channel: 'chrome' })
  t.after(() => browser.close())
  for (const dock of ['left', 'right']) await t.test(dock, async subtest => {
    const page = await browser.newPage({ viewport: { width: 600, height: 600 }, reducedMotion: 'reduce' })
    subtest.after(() => page.close())
    await page.setContent(`<!doctype html><iframe name="rail" style="position:fixed;${dock}:0;top:0;width:14px;height:100%;border:0" srcdoc='<!doctype html><div id="orb-root"></div>'></iframe>`)
    const frame = page.frame({ name: 'rail' })
    await frame.evaluate(side => {
      window.railDock = side
      window.railState = { view: 'plugin', activeTabId: 'middle', tabStyle: 'orb', animationLevel: 'low', theme: { mode: 'light', tokens: {} },
        tabs: ['first', 'middle', 'last'].map(id => ({ id, pluginId: id, title: id, glyph: id[0] })) }
      window.requests = []
      window.enestBuiltinChrome = {
        getOrbState: async () => window.railState,
        onOrbEvent(listener) { window.publish = () => listener({ type: 'orb-state', state: window.railState }); return () => {} },
        setOrbRailExpanded: async expanded => { window.frameElement.style.width = expanded ? '84px' : '14px' },
        setOrbRailCaption: async open => { window.frameElement.style.width = open ? '320px' : '84px' },
        closePlugin(id) {
          window.requests.push(id)
          return new Promise((resolve, reject) => { window.finishClose = accepted => accepted ? resolve() : reject(Error('refused')) })
        },
      }
      window.removeTab = id => {
        const state = window.railState
        state.tabs = state.tabs.filter(tab => tab.id !== id)
        state.activeTabId = state.tabs.at(-1)?.id ?? null
        window.publish()
      }
    }, dock)
    await frame.addStyleTag({ content: outputFiles.find(file => file.path.endsWith('.css')).text })
    await frame.addScriptTag({ content: outputFiles.find(file => file.path.endsWith('.js')).text })
    await frame.locator('#orb-handle').hover()
    await frame.locator('[data-activate="middle"]').hover()
    await frame.waitForFunction(() => window.innerWidth === 320 && document.querySelector('[data-close="middle"]').closest('.orb-item').classList.contains('is-pointer-over'))
    const rect = await frame.locator('[data-close="middle"]').boundingBox()
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    const hit = id => frame.waitForFunction(({ x, y, tab }) => {
      const origin = window.frameElement.getBoundingClientRect()
      const button = document.elementFromPoint(x - origin.left, y - origin.top)?.closest('[data-close]')
      return button?.dataset.close === tab && button.closest('.orb-item').classList.contains('is-pointer-over')
        && !document.querySelector('#orb-panel').inert
    }, { ...point, tab: id })
    const press = async () => { await page.mouse.down(); await page.mouse.up() }
    await page.mouse.move(point.x, point.y)
    await hit('middle')
    await press(); await press()
    assert.deepEqual(await frame.evaluate(() => window.requests), ['middle'])
    await frame.evaluate(() => window.finishClose(false))
    await hit('middle')
    await press()
    await frame.evaluate(() => window.finishClose(true))
    assert.equal(await frame.locator('[data-close="middle"]').count(), 1, 'a successful IPC alone is not a tab snapshot')
    await press()
    assert.deepEqual(await frame.evaluate(() => window.requests), ['middle', 'middle'])
    await frame.evaluate(() => window.removeTab('middle'))
    await page.waitForTimeout(320)
    await hit('last')
    await press()
    await frame.evaluate(() => { window.finishClose(true); window.removeTab('last') })
    await hit('first')
    assert.deepEqual(await frame.evaluate(() => window.requests), ['middle', 'middle', 'last'])
    await page.mouse.move(dock === 'left' ? 150 : 450, point.y)
    await frame.waitForFunction(() => document.querySelector('#orb-panel').inert)
  })
})
