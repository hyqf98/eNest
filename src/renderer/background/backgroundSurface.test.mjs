import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright-core'
import { chrome, mountAppearanceFixture } from './appearanceBrowserFixture.mjs'

const luminance = rgb => rgb.reduce((sum, value, index) => {
  const channel = value / 255
  return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]
}, 0)
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)

test('the default appearance keeps readable controls in both modes and releases mounted media', {
  skip: chrome ? false : 'Set ENEST_CHROME_EXECUTABLE for the browser check', timeout: 45_000,
}, async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 850 }, reducedMotion: 'reduce' })
    await mountAppearanceFixture(page)
    const selectedPaint = () => page.locator('.appearance-card-head .segmented .active').evaluate(node => {
      const css = getComputedStyle(node); return [css.backgroundColor, css.color]
    })
    for (const mode of ['light', 'dark']) {
      await page.evaluate(mode => appearanceFixture.setMode(mode), mode)
      await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode)
      // 模式切换后卡片仍有一帧颜色过渡，等过渡落定再取对比度
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const before = await selectedPaint()
      const colors = await page.locator('.appearance-settings-stack > .s-card').first().evaluate(node => {
        const css = getComputedStyle(node)
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        const rgb = value => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg')
          context.fillRect(0, 0, 1, 1)
          context.fillStyle = value; context.fillRect(0, 0, 1, 1)
          return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
        }
        return { foreground: rgb(css.color), background: rgb(css.backgroundColor) }
      })
      assert.ok(contrast(colors.foreground, colors.background) >= 4.5, `${mode}: theme surface keeps primary text contrast`)
      await page.evaluate(() => appearanceFixture.publish({ backgroundType: 'gradient', backgroundPalette: 'mint', backgroundOpacity: .8 }))
      assert.deepEqual(await selectedPaint(), before, 'material controls never override the selected mode paint')
      assert.equal(await page.locator('#stage [data-background-effect="tunnel"] canvas').count(), 1)
    }
    await page.evaluate(() => {
      appearanceFixture.publish({ backgroundEffect: 'none' }); window.mediaCalls = { pause: 0, play: 0 }
      HTMLMediaElement.prototype.pause = function () { mediaCalls.pause++ }
      HTMLMediaElement.prototype.play = function () { mediaCalls.play++; return Promise.resolve() }
      appearanceFixture.media({ type: 'video', value: 'data:video/mp4;base64,', opacity: .5, fit: 'cover' })
    })
    await page.waitForSelector('#stage video')
    await page.evaluate(() => { window.ownedVideo = document.querySelector('#stage video') })
    assert.equal(await page.evaluate(() => mediaCalls.play), 0, 'reduced motion never starts video playback')
    await page.evaluate(() => appearanceFixture.media(null))
    await page.waitForFunction(() => !ownedVideo.isConnected)
    assert.ok(await page.evaluate(() => mediaCalls.pause) > 0)
    await page.evaluate(() => appearanceFixture.unmount())
    assert.equal(await page.locator('.background-effect, video, canvas').count(), 0)
  } finally { await browser.close() }
})
