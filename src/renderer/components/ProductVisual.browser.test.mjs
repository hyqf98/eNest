/** ENEST_PRODUCT_VISUAL_TEST=1 node --test src/renderer/components/ProductVisual.browser.test.mjs */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

test('real product screenshots use accessible dots, keep decoded frames during loading, crossfade and isolate gallery input', {
  skip: process.env.ENEST_PRODUCT_VISUAL_TEST !== '1', timeout: 45000,
}, async () => {
  const directory = join(process.cwd(), 'eNest_plugin/plugins/clipboard')
  const manifest = JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8'))
  assert.equal(manifest.market.screenshots.length, 3, 'fixture reads the three repository-declared clipboard screenshots')
  const pictures = await Promise.all(manifest.market.screenshots.map(path => readFile(join(directory, 'public', path))))
  const icon = await readFile(join(directory, 'public', manifest.icon))
  const bundled = await build({ stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {ProductVisual} from '@renderer/components/ProductVisual';
    const root=createRoot(document.getElementById('root'));window.outerEvents={click:0,pointer:0,key:0};window.previewEvents=[];
    window.screenshotEvents=[];
    window.renderVisual=(plugin,active=true,screenshot)=>flushSync(()=>root.render(<div className="fixture" onClick={()=>window.outerEvents.click++} onPointerDown={()=>window.outerEvents.pointer++} onKeyDown={()=>window.outerEvents.key++}><ProductVisual plugin={plugin} active={active} screenshot={screenshot} onScreenshotChange={url=>window.screenshotEvents.push(url)} onPreviewChange={open=>window.previewEvents.push(open)}/></div>));
    window.startFrames=()=>{window.imageFrames=[];window.recordImages=true;const sample=()=>{if(!window.recordImages)return;window.imageFrames.push([...document.querySelectorAll('.product-image-button .product-gallery-image')].map(image=>({src:image.src,opacity:Number(getComputedStyle(image).opacity),decoded:image.naturalWidth>0})));requestAnimationFrame(sample)};sample()};
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, outfile: 'fixture.js', platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: 'tsconfig.web.json', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'isolated-locale', setup(builder) {
      builder.onResolve({ filter: /^@renderer\/hooks\/useI18n$/ }, () => ({ path: 'locale', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "export function useI18n(){return {locale:'zh-CN'}}" }))
    } }],
  })
  let executablePath
  for (const candidate of [process.env.ENEST_CHROME_EXECUTABLE, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)) {
    if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break }
  }
  assert.ok(executablePath, 'Set ENEST_CHROME_EXECUTABLE to installed Chromium')
  const browser = await chromium.launch({ executablePath, headless: true })
  let releaseSlow
  const slow = new Promise(resolve => { releaseSlow = resolve })
  const output = process.env.ENEST_PRODUCT_VISUAL_ARTIFACT_DIR || '/tmp/enest-product-dots'
  await mkdir(output, { recursive: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 620 } })
    page.setDefaultTimeout(7000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('https://product-screenshots.test/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/icon.svg') { await route.fulfill({ body: icon, contentType: 'image/svg+xml' }); return }
      const [, phase, raw] = path.split('/'), index = Number(raw)
      if (phase === 'slow' && index === 1) await slow
      if (phase === 'failed' || phase === 'partial' && index === 1) { await route.fulfill({ status: 404, body: 'unavailable screenshot' }); return }
      await route.fulfill({ body: pictures[index], contentType: manifest.market.screenshots[index].endsWith('.webp') ? 'image/webp' : 'image/png' })
    })
    await page.setContent(`<html data-anim="medium" data-theme="light"><head><style>${await readFile('src/renderer/styles/tokens.css', 'utf8')}\n${bundled.outputFiles.find(file => file.path.endsWith('.css')).text}\nbody{margin:0;background:var(--bg);font-family:system-ui;padding:24px}.fixture{width:900px;height:520px;display:grid}.product-visual{height:480px}</style></head><body><div id="root"></div></body></html>`)
    await page.addScriptTag({ content: bundled.outputFiles.find(file => file.path.endsWith('.js')).text })
    const plugin = phase => ({ ...manifest, glyph: '剪', icon: 'https://product-screenshots.test/icon.svg', screenshots: pictures.map((_, index) => `https://product-screenshots.test/${phase}/${index}`) })
    const render = (phase, active = true, index) => page.evaluate(({ plugin, active, index }) => window.renderVisual(plugin, active, index === undefined ? undefined : plugin.screenshots[index]), { plugin: plugin(phase), active, index })
    const current = page.locator('.product-image-button .product-gallery-image.is-visible')
    const dots = page.locator('.product-gallery-dot')
    const settled = index => page.waitForFunction(index => {
      const image = document.querySelector('.product-image-button .product-gallery-image.is-visible')
      return image?.src.endsWith(`/${index}`) && Number(getComputedStyle(image).opacity) === 1 && image.naturalWidth > 0
    }, index)
    await render('slow')
    await settled(0)
    assert.equal(await dots.count(), 3)
    assert.equal(await page.locator('.product-gallery-controls svg,.product-gallery-count').count(), 0, 'embedded gallery has no arrow/count toolbar')
    const hitBox = await dots.first().boundingBox()
    assert.ok(hitBox.width >= 28 && hitBox.height >= 28, 'small visible markers retain easy hit targets')
    assert.equal(await dots.nth(1).getAttribute('aria-label'), '查看第 2 张截图，共 3 张')
    await page.evaluate(() => window.startFrames())
    await dots.nth(1).click()
    assert.equal(await dots.nth(1).getAttribute('aria-current'), 'true')
    assert.equal(await page.locator('.product-image-button').getAttribute('aria-busy'), 'true')
    assert.ok((await current.getAttribute('src')).endsWith('/0'), 'previous decoded image remains while selected image is pending')
    assert.equal(await current.evaluate(element => Number(getComputedStyle(element).opacity)), 1)
    releaseSlow()
    await settled(1)
    const frames = await page.evaluate(() => { window.recordImages = false; return window.imageFrames })
    assert.ok(frames.some(frame => frame.filter(image => image.opacity > .1 && image.opacity < .95).length >= 2), 'actual images overlap during crossfade')
    assert.ok(frames.every(frame => Math.max(...frame.filter(image => image.decoded).map(image => image.opacity)) >= .4), 'crossfade never exposes a blank stage')
    assert.deepEqual(await page.evaluate(() => window.outerEvents), { click: 0, pointer: 0, key: 0 }, 'dot gestures never reach outer slide drag/open handlers')

    await dots.nth(2).click(); await dots.nth(0).click(); await dots.nth(1).click(); await settled(1)
    await dots.nth(1).focus(); await page.keyboard.press('ArrowRight'); await settled(2)
    assert.equal(await dots.nth(2).evaluate(element => element === document.activeElement), true)
    await page.keyboard.press('Home'); await settled(0)
    await page.keyboard.press('End'); await settled(2)
    assert.equal(await page.locator('.product-gallery-dot[aria-current="true"]').count(), 1)
    assert.equal(await page.locator('.product-gallery-dot[tabindex="0"]').count(), 1)
    assert.equal(await page.evaluate(() => window.outerEvents.key), 0, 'gallery keys do not advance outer carousel')
    await page.screenshot({ path: join(output, 'dots-light.png') })
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.screenshot({ path: join(output, 'dots-dark.png') })

    await page.locator('.product-image-button').click()
    await page.locator('dialog[open]').waitFor()
    await page.locator('dialog[open]').getByRole('button', { name: '下一张截图' }).click()
    await settled(0)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    assert.deepEqual(await page.evaluate(() => window.previewEvents), [true, false])
    assert.equal(await page.locator('.product-image-button').evaluate(element => element === document.activeElement), true)

    await dots.nth(2).click(); await settled(2)
    await render('slow', false)
    assert.equal(await page.locator('.product-gallery-dot:disabled').count(), 3)
    assert.equal(await page.locator('.product-gallery-dot[tabindex="0"]').count(), 0)
    await dots.nth(0).evaluate(element => element.click())
    await settled(2)
    assert.equal(await page.locator('dialog[open]').count(), 0, 'inactive/clone gallery cannot open preview')
    await render('slow', true); await settled(2)
    await render('slow', false, 1); await settled(1)
    assert.equal(await dots.nth(1).getAttribute('aria-current'), 'true', 'inactive loop clone follows the shared screenshot URL')
    await render('slow', true, 2); await settled(2)
    await dots.nth(0).click()
    assert.ok((await page.evaluate(() => window.screenshotEvents.at(-1))).endsWith('/0'), 'dot selection requests a parent update')
    assert.ok((await current.getAttribute('src')).endsWith('/2'), 'controlled gallery waits for shared state before changing its image')
    await render('slow', true, 0); await settled(0)

    await render('partial', true, 1)
    await page.waitForFunction(() => document.querySelectorAll('.product-gallery-dot').length === 2)
    await settled(2)
    assert.ok((await page.evaluate(() => window.screenshotEvents.at(-1))).endsWith('/2'), 'a failed shared screenshot requests the next working image')
    await render('failed')
    await page.locator('.product-identity').waitFor()
    assert.equal(await dots.count(), 0)
    assert.equal(await page.locator('.product-image-button').count(), 0, 'all failed images fall back to real plugin identity')
    await render('stable'); await settled(0)
    const durations = []
    for (const level of ['low', 'medium', 'high']) {
      await page.evaluate(level => document.documentElement.dataset.anim = level, level)
      durations.push(await current.evaluate(element => parseFloat(getComputedStyle(element).transitionDuration)))
    }
    assert.ok(durations[0] > 0 && durations[0] < durations[1] && durations[1] < durations[2])
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await dots.nth(1).click(); await settled(1)
    assert.equal(await current.evaluate(element => getComputedStyle(element).transitionDuration), '0s')
    assert.deepEqual(errors, [])
    await writeFile(join(output, 'checks.json'), JSON.stringify({ status: 'pass', browser: await browser.version(), fixture: manifest.market.screenshots, frames, durations, errors }, null, 2))
  } finally { releaseSlow(); await browser.close() }
})
