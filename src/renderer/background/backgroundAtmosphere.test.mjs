import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { chrome, mountAppearanceFixture } from './appearanceBrowserFixture.mjs'

test('the default theme restores all five original shaders and independent atmosphere without canvas churn', {
  skip: chrome ? false : 'Set ENEST_CHROME_EXECUTABLE for the browser check', timeout: 60_000,
}, async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    await mountAppearanceFixture(page)
    await page.waitForSelector('#stage [data-background-effect="tunnel"] canvas')
    assert.equal(await page.locator('[data-theme-field="backgroundEffect"] .bg-effect-card').count(), 6)
    for (const effect of ['fold', 'aurora', 'orbit', 'ripple', 'tunnel']) {
      await page.evaluate(effect => appearanceFixture.publish({ backgroundEffect: effect }), effect)
      await page.waitForSelector(`#stage [data-background-effect="${effect}"] canvas`)
      assert.equal(await page.locator('#stage canvas').count(), 1, 'one renderer owns exactly one shader')
    }
    await page.evaluate(() => {
      window.originalCanvas = document.querySelector('#stage canvas')
      appearanceFixture.publish({ backgroundType: 'gradient', backgroundPalette: 'mint' })
    })
    await page.waitForSelector('#stage .background-atmosphere')
    const before = await page.locator('#stage').screenshot()
    await page.evaluate(() => appearanceFixture.publish({ backgroundPalette: 'ocean', backgroundOpacity: .4 }))
    await page.waitForFunction(() => document.querySelector('#stage .background-atmosphere').style.opacity === '0.4')
    assert.equal(await page.evaluate(() => originalCanvas === document.querySelector('#stage canvas')), true, 'atmosphere edits do not restart the shader')
    assert.notDeepEqual(await page.locator('#stage').screenshot(), before)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('has-bg-atmosphere')), true)
    await page.evaluate(() => appearanceFixture.publish({ backgroundEffect: 'none' }))
    await page.waitForFunction(() => !originalCanvas.isConnected)
    assert.equal(await page.locator('#stage canvas').count(), 0)
    assert.ok(await page.locator('#stage .app-bg-fill').evaluate(node => getComputedStyle(node).backgroundImage !== 'none'))
    await page.evaluate(() => appearanceFixture.unmount())
    assert.equal(await page.locator('#stage canvas').count(), 0)
  } finally { await browser.close() }
})
