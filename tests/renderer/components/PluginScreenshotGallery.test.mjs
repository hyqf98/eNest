/** Opt-in isolated browser regression. Run only where browser automation is authorized.
 * ENEST_GALLERY_BROWSER_TEST=1 node --test tests/renderer/components/PluginScreenshotGallery.test.mjs */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)

const result = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { PluginScreenshotGallery } from '@renderer/themes/default/workspace/PluginScreenshotGallery';
    const root = createRoot(document.getElementById('app'));
    window.renderGallery = (screenshots, name = 'Fixture') => flushSync(() => root.render(<PluginScreenshotGallery name={name} screenshots={screenshots} />));
    window.parentEscapes = 0;
    window.addEventListener('keydown', event => { if (event.key === 'Escape') window.parentEscapes++; });
  `, resolveDir: process.cwd(), loader: 'tsx' },
  tsconfig: 'tsconfig.web.json', bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'isolated-translations', setup(builder) {
    builder.onResolve({ filter: /^@renderer\/hooks\/useI18n$/ }, () => ({ path: 'i18n', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      import zh from '@renderer/i18n/zh-CN';
      import en from '@renderer/i18n/en-US';
      export function useI18n() { return { t(key, values = {}) {
        const template = key.split('.').reduce((value, part) => value?.[part], window.galleryLocale === 'en-US' ? en : zh) || key;
        return template.replace(/\\{(\\w+)\\}/g, (_, name) => String(values[name] ?? name));
      } }; }
    `, resolveDir: process.cwd() }))
  } }],
})

const picture = (color, index) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="${color}"/><text x="50" y="100" font-size="48">${index}</text></svg>`)
const pictures = [picture('#97aa9c', 1), picture('#aab8ca', 2), picture('#d9b594', 3)]
const waitForImage = async page => {
  await page.waitForFunction(() => document.querySelector('.detail-gallery-stage img')?.naturalWidth > 0)
  await page.waitForFunction(() => document.querySelector('.detail-gallery-stage img')?.classList.contains('is-loaded'))
}

test('detail gallery navigates real images and preview, isolates Escape, and handles source changes and failed loads', {
  skip: process.env.ENEST_GALLERY_BROWSER_TEST !== '1' ? 'Opt in with ENEST_GALLERY_BROWSER_TEST=1' : chrome ? false : 'Set ENEST_CHROME_EXECUTABLE for isolated gallery browser checks', timeout: 45_000,
}, async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
    let failure = true, attempts = 0
    await page.route('https://gallery-fixture.test/screenshot.svg', async route => {
      attempts++
      await route.fulfill(failure ? { status: 404, body: 'missing' } : { status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#b0c4b1"/></svg>' })
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<html data-theme="light" data-anim="medium"><head><style>
      :root { --surface: #fff; --surface-2: #f0f0ee; --surface-3: #e4e4e1; --text: #222; --text-2: #555; --text-3: #666; --border: #ddd; --border-strong: #bbb; --link: #2464ba; --bg: #eee; --radius-lg: 12px; }
      * { box-sizing: border-box; } body { margin: 0; padding: 24px; } #app { max-width: 800px; margin: auto; }
      ${readFileSync('src/renderer/themes/default/workspace/detail.css', 'utf8')}
    </style></head><body><div id="app"></div></body></html>`)
    await page.addScriptTag({ content: result.outputFiles[0].text })
    await page.evaluate(pictures => window.renderGallery(pictures), pictures)
    await waitForImage(page)
    const gallery = page.locator('.detail-gallery')
    const pageLabel = gallery.locator(':scope > .detail-gallery-header .detail-gallery-position')
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 1 张，共 3 张')
    assert.equal(await gallery.locator(':scope > .detail-gallery-thumbnails button').count(), 3)
    await gallery.locator(':scope > header').getByRole('button', { name: '下一张截图' }).click()
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 2 张，共 3 张')
    await page.keyboard.press('ArrowRight')
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 3 张，共 3 张')
    await page.keyboard.press('ArrowRight')
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 1 张，共 3 张', 'keyboard wraps around')
    await gallery.locator(':scope > .detail-gallery-thumbnails').getByRole('button', { name: '查看第 2 张截图' }).click()
    await waitForImage(page)
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 2 张，共 3 张')

    await gallery.locator('.detail-gallery-open').click()
    const preview = page.locator('dialog[open]')
    await preview.waitFor()
    await preview.getByRole('button', { name: '下一张截图' }).click()
    await page.keyboard.press('ArrowLeft')
    assert.equal(await preview.locator('.detail-gallery-position').getAttribute('aria-label'), '第 2 张，共 3 张')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog').open)
    assert.equal(await page.evaluate(() => window.parentEscapes), 0, 'Escape never reaches the parent detail listener')
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('detail-gallery-open')), true)

    await page.evaluate(source => window.renderGallery([source], 'Single'), pictures[0])
    await waitForImage(page)
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 1 张，共 1 张')
    assert.equal(await gallery.locator(':scope > .detail-gallery-header button').count(), 0)
    assert.equal(await gallery.locator(':scope > .detail-gallery-thumbnails').count(), 0)
    await page.evaluate(() => window.renderGallery([], 'Empty'))
    await gallery.getByText('此插件暂未提供功能截图').waitFor()
    assert.equal(await gallery.locator('button').count(), 0)

    const broken = 'https://gallery-fixture.test/screenshot.svg'
    await page.evaluate(({ pictures, broken }) => window.renderGallery([broken, ...pictures], 'Failures'), { pictures, broken })
    await gallery.locator('.detail-gallery-stage').getByText('这张截图加载失败').waitFor()
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 1 张，共 4 张', 'errors keep stable page numbering')
    await gallery.locator(':scope > header').getByRole('button', { name: '下一张截图' }).click()
    await waitForImage(page)
    assert.equal(await pageLabel.getAttribute('aria-label'), '第 2 张，共 4 张')
    await gallery.locator(':scope > header').getByRole('button', { name: '上一张截图' }).click()
    failure = false
    const previousAttempts = attempts
    await gallery.locator('.detail-gallery-stage').getByRole('button', { name: '重新加载' }).click()
    await waitForImage(page)
    assert.ok(attempts > previousAttempts, 'retry requests the same resource URL again')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(pictures => { document.documentElement.dataset.theme = 'dark'; window.renderGallery(pictures, 'Compact') }, pictures)
    await waitForImage(page)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await gallery.locator('.detail-gallery-image').evaluate(node => getComputedStyle(node).transitionDuration), '0s')
    await gallery.locator('.detail-gallery-open').click()
    await page.locator('dialog[open]').waitFor()
    assert.equal(await page.locator('dialog[open]').evaluate(node => node.getBoundingClientRect().right <= innerWidth), true)
    await page.locator('dialog[open]').getByRole('button', { name: '关闭大图' }).click()
    await page.evaluate(() => { window.galleryLocale = 'en-US'; window.renderGallery([], 'English') })
    await gallery.getByText('This plugin has no screenshots yet').waitFor()
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
