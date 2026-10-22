import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { chrome, mountAppearanceFixture } from './appearanceBrowserFixture.mjs'

const enabled = process.env.ENEST_BACKGROUND_SETTINGS_SMOKE === '1'
const artifacts = resolve(process.env.ENEST_BACKGROUND_ARTIFACTS ?? '/tmp/enest-background-settings')

test('real appearance schema controls persist and adapt across light, dark and narrow layouts', { skip: !enabled, timeout: 90_000 }, async () => {
  assert.ok(chrome, 'Set ENEST_CHROME_EXECUTABLE to an installed Chromium browser')
  await mkdir(artifacts, { recursive: true })
  const browser = await chromium.launch({ executablePath: chrome, headless: true })
  const evidence = { realComponents: ['AppearanceSettingsSection', 'ThemeSettingsFields', 'AppBackground'], hostBridge: 'isolated appearance authority fixture', errors: [], screenshots: [], matrix: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => evidence.errors.push(error.message))
    await mountAppearanceFixture(page)
    assert.equal(await page.locator('.appearance-theme-card').count(), 1, 'only the default built-in style is shipped')
    assert.equal(await page.getByText('公共资源与启动画面', { exact: true }).count(), 0)
    // 主题 Tab 两张卡：切换主题在前，动态参数在后
    assert.equal(await page.locator('.appearance-card-switch').count(), 1)
    assert.equal(await page.locator('.appearance-card-tuning').count(), 1)
    const segmentedLabelsFit = () => page.locator('.theme-setting-segmented button').evaluateAll(buttons => buttons.every(button => {
      const range = document.createRange(); range.selectNodeContents(button)
      return getComputedStyle(button).whiteSpace === 'nowrap' && range.getBoundingClientRect().height <= button.clientHeight
    }))
    for (const mode of ['light', 'dark']) {
      await page.getByRole('radio', { name: mode === 'light' ? '浅色' : '深色', exact: true }).click()
      await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode)
      assert.equal(await segmentedLabelsFit(), true, 'theme choices do not wrap text inside fixed-height buttons')
      for (const [field, key, expected] of [['gap', 'gap', 'End'], ['radius', 'radius', 'Home']]) {
        const slider = page.locator(`[data-theme-field="${field}"] [role="slider"]`)
        await slider.scrollIntoViewIfNeeded(); await slider.focus(); await slider.press(expected)
        const target = Number(await slider.getAttribute('aria-valuenow'))
        await page.waitForFunction(({ key, target }) => appearanceFixture.snapshot().profile.values[key] === target, { key, target })
        evidence.matrix.push({ mode, field, target })
      }
      await page.locator('.appearance-card-switch').scrollIntoViewIfNeeded()
      const name = `default-${mode}.png`
      await page.screenshot({ path: join(artifacts, name), fullPage: true }); evidence.screenshots.push(name)
    }
    await page.setViewportSize({ width: 480, height: 780 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await segmentedLabelsFit(), true)
    const name = 'default-narrow.png'
    await page.screenshot({ path: join(artifacts, name), fullPage: true }); evidence.screenshots.push(name)
    assert.deepEqual(evidence.errors, [])
    evidence.status = 'pass'
  } catch (error) { evidence.status = 'fail'; evidence.failure = String(error.stack || error); throw error }
  finally { await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); await browser.close() }
})
