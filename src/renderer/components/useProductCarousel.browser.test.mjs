/** Opt-in frame-level motion regression; real catalog and actual browser input. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMarketBrowserFixture } from './marketBrowserFixture.test.fixture.mjs'

const artifacts = process.env.ENEST_CAROUSEL_MOTION_ARTIFACTS || join(process.cwd(), 'docs/engineering/featured-motion-2026-10-15')

async function settled(page, index) {
  await page.waitForFunction(index => {
    const viewport = document.querySelector('.product-viewport')
    const slide = document.querySelector(`[data-product-index="${index}"].is-current`)
    return viewport && slide && Math.abs(viewport.scrollLeft - slide.offsetLeft + 4) < 2 && !viewport.style.scrollSnapType
  }, index)
}

async function startFrames(page) {
  await page.evaluate(() => {
    const viewport = document.querySelector('.product-viewport')
    const slides = [...viewport.querySelectorAll('[data-product-position]')]
    const stride = slides[1].offsetLeft - slides[0].offsetLeft
    window.carouselFrames = []
    const sample = now => {
      window.carouselFrames.push({ time: now, left: viewport.scrollLeft, stride,
        viewportOpacity: Number(getComputedStyle(viewport).opacity),
        index: Number(viewport.querySelector('[data-product-index].is-current').dataset.productIndex),
        slides: slides.map(slide => ({ physical: Number(slide.dataset.productPosition), plugin: slide.dataset.pluginId,
          reveal: Number(getComputedStyle(slide).getPropertyValue('--product-reveal')),
          left: slide.offsetLeft - 4, copy: Number(getComputedStyle(slide.querySelector('.product-copy')).opacity),
          peek: Number(getComputedStyle(slide.querySelector('.product-peek')).opacity) })) })
      window.carouselFrameId = requestAnimationFrame(sample)
    }
    window.carouselFrameId = requestAnimationFrame(sample)
  })
}

async function endFrames(page) {
  return page.evaluate(() => { cancelAnimationFrame(window.carouselFrameId); return window.carouselFrames })
}

function checkReveal(frames, { drag = false } = {}) {
  assert.ok(frames.length >= 5, 'capture real requestAnimationFrame samples')
  let maxError = 0, maxOpacityError = 0, partial = 0
  for (const frame of frames) {
    assert.ok(frame.viewportOpacity > .98, 'adjacent motion must not flash the whole viewport')
    for (const slide of frame.slides) {
      const expected = Math.max(0, 1 - Math.abs(slide.left - frame.left) / frame.stride)
      maxError = Math.max(maxError, Math.abs(slide.reveal - expected))
      const expectedCopy = Math.min(1, Math.max(0, (slide.reveal - .2) * 2))
      const expectedPeek = Math.min(1, Math.max(0, 1 - slide.reveal * 5))
      maxOpacityError = Math.max(maxOpacityError, Math.abs(slide.copy - expectedCopy), Math.abs(slide.peek - expectedPeek))
      assert.ok(!(slide.copy > .1 && slide.peek > .1), 'one slide must not show two readable title/icon layouts together')
      if (slide.copy > .1 && slide.copy < .9) partial++
    }
    assert.ok(Math.max(...frame.slides.map(slide => slide.copy)) >= .44, 'a seam must not produce an empty copy frame')
  }
  // Native scroll events can arrive after this test's rAF callback, giving one-frame latency.
  assert.ok(maxError < (drag ? .14 : .025), `presentation follows physical scroll; max error ${maxError}`)
  assert.ok(maxOpacityError < .005, `copy and peek follow separate reveal windows; max error ${maxOpacityError}`)
  assert.ok(partial >= 4, 'full copy must fade across multiple rendered frames')
  return { frames: frames.length, partialSamples: partial, maxRevealError: maxError, maxOpacityError }
}

test('carousel frame continuity, gesture seams and offscreen suspension', {
  skip: process.env.ENEST_CAROUSEL_MOTION !== '1', timeout: 60000,
}, async t => {
  const fixture = await createMarketBrowserFixture({ level: 'medium', viewport: { width: 1440, height: 1000 } })
  const { page, errors } = fixture
  const report = { status: 'running', catalogCount: fixture.plugins.length, browser: await fixture.browser.version(),
    boundary: 'Headless Chromium frame samples verify continuity and state, not desktop frame rate; actual mouse input with real published catalog.', checks: [], frames: {} }
  await mkdir(artifacts, { recursive: true })
  const dots = page.locator('.product-page')
  try {
    await settled(page, 0)
    await page.waitForTimeout(500)

    await t.test('copy and peek track physical motion; a second click reverses from the live position', async () => {
      await startFrames(page)
      await dots.nth(1).click()
      await page.waitForFunction(() => {
        const v = document.querySelector('.product-viewport'), a = v.querySelector('[data-product-index="0"]'), b = v.querySelector('[data-product-index="1"]')
        const progress = (v.scrollLeft - a.offsetLeft + 4) / (b.offsetLeft - a.offsetLeft)
        return progress > .32 && progress < .65
      })
      report.midCapture = await page.evaluate(() => ({ time: performance.now(), left: document.querySelector('.product-viewport').scrollLeft }))
      await page.screenshot({ path: join(artifacts, 'mid-transition.png'), animations: 'allow' })
      await settled(page, 1)
      report.frames.forward = await endFrames(page)
      const forward = checkReveal(report.frames.forward)

      await startFrames(page)
      await dots.first().click()
      await page.waitForFunction(() => {
        const v = document.querySelector('.product-viewport'), a = v.querySelector('[data-product-index="0"]'), b = v.querySelector('[data-product-index="1"]')
        const progress = (b.offsetLeft - 4 - v.scrollLeft) / (b.offsetLeft - a.offsetLeft)
        return progress > .35 && progress < .65
      })
      await dots.nth(1).evaluate(button => {
        button.addEventListener('click', () => {
          const viewport = document.querySelector('.product-viewport')
          window.carouselRetarget = { before: viewport.scrollLeft }
          queueMicrotask(() => { window.carouselRetarget.after = viewport.scrollLeft })
        }, { once: true, capture: true })
      })
      await dots.nth(1).click()
      const retarget = await page.evaluate(() => window.carouselRetarget)
      assert.ok(Math.abs(retarget.after - retarget.before) < 1, 'the actual click must retarget from the current position without an endpoint jump')
      await settled(page, 1)
      report.frames.reversal = await endFrames(page)
      const reverse = checkReveal(report.frames.reversal)
      report.checks.push({ name: 'continuous copy/peek and interruptible reversal', forward, reverse, reverseDelta: retarget.after - retarget.before })
    })

    await t.test('native mouse dragging and both clone seams retain a visible matching copy', async () => {
      const last = await dots.count() - 1
      await dots.nth(last).click(); await settled(page, last)
      for (const [name, button, index] of [['forwardSeam', '.product-nav-next', 0], ['backwardSeam', '.product-nav-prev', last]]) {
        await startFrames(page)
        await page.locator(button).click(); await settled(page, index)
        report.frames[name] = await endFrames(page)
        const summary = checkReveal(report.frames[name])
        const jumps = report.frames[name].slice(1).map((frame, i) => frame.left - report.frames[name][i].left)
          .filter(delta => Math.abs(delta) > report.frames[name][0].stride * .5)
        assert.ok(jumps.length <= 1, 'only the seamless clone-to-real normalization may jump')
        const final = report.frames[name].at(-1)
        const target = final.slides.find(slide => slide.physical === index)
        assert.ok(target.copy > .98 && target.peek < .02)
        report.checks.push({ name, ...summary, normalizationJumps: jumps })
      }
      await dots.first().click(); await settled(page, 0)
      const description = await page.locator('[data-product-index="0"] .product-description').boundingBox()
      await startFrames(page)
      await page.mouse.move(description.x + description.width * .8, description.y + 12)
      await page.mouse.down()
      await page.mouse.move(description.x - 160, description.y + 12, { steps: 20 })
      await page.mouse.up(); await settled(page, 1)
      report.frames.drag = await endFrames(page)
      report.checks.push({ name: 'native mouse drag', ...checkReveal(report.frames.drag, { drag: true }) })
      assert.equal(await page.locator('.detail-overlay').count(), 0, 'drag cannot accidentally open the enlarged click target')
    })

    await t.test('offscreen freezes the current tween and returning resumes motion and autoplay', async () => {
      await startFrames(page)
      await dots.nth(2).click()
      await page.waitForFunction(() => {
        const v = document.querySelector('.product-viewport'), a = v.querySelector('[data-product-index="1"]'), b = v.querySelector('[data-product-index="2"]')
        const progress = (v.scrollLeft - a.offsetLeft + 4) / (b.offsetLeft - a.offsetLeft)
        return progress > .1 && progress < .65
      })
      await page.locator('.page-home').evaluate(el => { el.scrollTop = el.scrollHeight })
      await page.waitForTimeout(100)
      const paused = await page.locator('.product-viewport').evaluate(el => el.scrollLeft)
      await page.waitForTimeout(400)
      const held = await page.locator('.product-viewport').evaluate(el => el.scrollLeft)
      assert.ok(Math.abs(held - paused) < 1, 'an offscreen tween must remain at its actual presentation position')
      assert.equal(await page.locator('.product-carousel').getAttribute('data-autoplay'), null)
      await page.mouse.move(10, 20)
      await page.locator('.page-home').evaluate(el => { el.scrollTop = 0 })
      await settled(page, 2)
      report.frames.suspension = await endFrames(page)
      await page.locator('.product-carousel[data-autoplay]').waitFor()
      await page.waitForFunction(() => document.querySelector('[data-product-index].is-current')?.dataset.productIndex === '3', null, { timeout: 10000 })
      await settled(page, 3)
      report.checks.push({ name: 'offscreen pause/resume and subsequent real autoplay', paused, held, resumedIndex: 2, nextAutoplayIndex: 3 })
    })

    assert.deepEqual(errors, [])
    report.status = report.checks.length === 5 ? 'pass' : 'failed'
  } finally {
    report.errors = errors
    await writeFile(join(artifacts, 'frame-checks.json'), JSON.stringify(report, null, 2))
    await fixture.close()
  }
})
