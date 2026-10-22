/** Actual App + real local catalog. ENEST_DETAIL_MOTION_TEST=1 node --test this-file. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMarketBrowserFixture } from './marketBrowserFixture.test.fixture.mjs'

const enabled = process.env.ENEST_DETAIL_MOTION_TEST === '1'
const output = process.env.ENEST_DETAIL_ARTIFACT_DIR || '/tmp/enest-detail-motion'
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height)

async function installRecorder(page) {
  await page.evaluate(() => {
    window.detailRuns = []
    window.startDetailRecord = (name, origin) => {
      window.detailRecording = { name, origin, samples: [], started: performance.now() }
      const sample = () => {
        const record = window.detailRecording
        if (!record) return
        const modal = document.querySelector('.detail-modal')
        const root = document.querySelector('.detail-overlay')
        const box = modal?.getBoundingClientRect()
        const source = record.origin?.isConnected ? record.origin.getBoundingClientRect() : null
        const style = modal && getComputedStyle(modal)
        record.samples.push({ at: performance.now() - record.started, phase: root?.dataset.detailPhase || (root ? 'unmarked' : 'absent'),
          rect: box?.toJSON(), origin: source?.toJSON(), transform: style?.transform, opacity: style?.opacity,
          scrollTop: document.querySelector('.page-home')?.scrollTop, viewport: { width: innerWidth, height: innerHeight } })
        window.detailFrame = requestAnimationFrame(sample)
      }
      sample()
    }
    window.stopDetailRecord = () => {
      cancelAnimationFrame(window.detailFrame)
      const { origin, ...record } = window.detailRecording
      window.detailRecording = null
      window.detailRuns.push(record)
      return record
    }
  })
}

async function start(page, name, origin) {
  await origin.scrollIntoViewIfNeeded()
  await origin.hover()
  await origin.evaluate((element, name) => window.startDetailRecord(name, element), name)
}
async function openSettled(page) {
  await page.locator('.detail-overlay[data-detail-phase="open"]').waitFor()
  await page.waitForFunction(() => {
    const modal = document.querySelector('.detail-modal')
    if (!modal) return false
    const matrix = new DOMMatrixReadOnly(getComputedStyle(modal).transform)
    return Math.abs(matrix.m41) < .5 && Math.abs(matrix.m42) < .5 && Math.abs(matrix.a - 1) < .003 && Math.abs(matrix.d - 1) < .003
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function close(page) {
  await page.keyboard.press('Escape')
  await page.locator('.detail-overlay').waitFor({ state: 'detached' })
}
async function end(page) { return page.evaluate(() => window.stopDetailRecord()) }
async function capturePhase(page, name) {
  const state = () => page.evaluate(() => ({ phase: document.querySelector('.detail-overlay')?.dataset.detailPhase,
    rect: document.querySelector('.detail-modal')?.getBoundingClientRect().toJSON(), time: performance.now() }))
  const before = await state()
  await page.screenshot({ path: join(output, `${name}.png`) })
  return { file: `${name}.png`, before, after: await state() }
}
function assertOriginJourney(record) {
  const opening = record.samples.filter(sample => sample.phase === 'opening' && sample.rect && sample.origin)
  const open = record.samples.filter(sample => sample.phase === 'open' && sample.rect)
  const closing = record.samples.filter(sample => sample.phase === 'closing' && sample.rect && sample.origin)
  assert.ok(opening.length >= 2, `${record.name}: visible opening frames captured`)
  assert.ok(open.length, `${record.name}: steady dialog captured`)
  assert.ok(closing.length >= 2, `${record.name}: visible closing frames captured`)
  const first = opening[0], final = open.at(-1)
  assert.ok(distance(first.rect, first.origin) < distance(final.rect, first.origin) * .7, `${record.name}: begins near the actual source card`)
  assert.ok(distance(first.rect, final.rect) > 35, `${record.name}: changes geometry while opening`)
  assert.ok(Math.min(...closing.map(sample => distance(sample.rect, sample.origin))) < distance(final.rect, closing[0].origin) * .45, `${record.name}: shrinks back toward source before unmount`)
}

test('plugin detail uses real grid/featured/search origins and survives interrupted motion, resize and accessibility modes', { skip: !enabled, timeout: 180000 }, async () => {
  await mkdir(output, { recursive: true })
  const fixture = await createMarketBrowserFixture()
  const { page, errors, plugins, registry } = fixture
  const report = { generatedAt: registry.generatedAt, catalogCount: plugins.length, fixture: 'Actual App, local real release catalog/media/README; installed flags are isolated. Headless Chromium, no animation freezing.', cases: [], scrollCheckpoints: [] }
  const recordScroll = async label => {
    const checkpoint = await page.locator('.page-home').evaluate((element, label) => ({ label, top: element.scrollTop,
      overflow: element.style.overflow, computedOverflow: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      active: document.activeElement?.outerHTML.slice(0, 250),
      phase: document.querySelector('.detail-overlay')?.dataset.detailPhase,
    }), label)
    report.scrollCheckpoints.push(checkpoint)
    return checkpoint
  }
  try {
    await installRecorder(page)
    const grid = page.locator('.market-category').last().locator('[data-plugin-card]').first()
    await start(page, 'grid-medium', grid)
    const before = await page.locator('.page-home').evaluate(element => element.scrollTop)
    await recordScroll('before-click')
    assert.ok(before > 0, 'grid fixture exercises a scrolled background')
    await grid.locator('.card-detail-trigger').click()
    await recordScroll('after-click')
    await openSettled(page)
    await recordScroll('open-settled')
    assert.equal(await page.locator('[data-detail-close]').evaluate(element => element === document.activeElement), true, 'initial focus enters dialog close button')
    await page.evaluate(() => {
      const elements = [...document.querySelector('.detail-modal').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden],[inert]') && getComputedStyle(element).visibility !== 'hidden')
      window.detailFocusEnds = [elements[0], elements.at(-1)]
      elements.at(-1).focus()
    })
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement === window.detailFocusEnds[0]), true, 'Tab loops to first dialog control')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement === window.detailFocusEnds[1]), true, 'Shift+Tab loops to last dialog control')
    await recordScroll('after-focus-loop')
    await page.locator('.detail-body').evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: join(output, 'grid-open.png') })
    await recordScroll('before-background-wheel')
    await page.mouse.move(12, 500); await page.mouse.wheel(0, 540)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const afterWheel = await recordScroll('after-background-wheel')
    assert.ok(Math.abs(afterWheel.top - before) <= 2, `background scroll is locked while dialog is open: ${JSON.stringify(report.scrollCheckpoints)}`)
    await page.locator('.detail-gallery-open').click()
    await page.locator('dialog[open]').waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog[open]'))
    assert.equal(await page.locator('.detail-overlay[data-detail-phase="open"]').count(), 1, 'gallery Escape only closes the nested preview')
    const body = page.locator('.detail-body')
    await body.hover()
    const bodyBefore = await body.evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, 420)
    await page.waitForFunction(before => document.querySelector('.detail-body').scrollTop > before + 10, bodyBefore)
    assert.ok(Math.abs(await page.locator('.page-home').evaluate(element => element.scrollTop) - before) <= 2, 'README wheel scroll does not move the locked background')
    await close(page)
    const gridRecord = await end(page)
    assertOriginJourney(gridRecord)
    assert.ok(Math.abs(await page.locator('.page-home').evaluate(element => element.scrollTop) - before) <= 2, 'closing restores original background scroll position')
    assert.equal(await grid.locator('.card-detail-trigger').evaluate(element => element === document.activeElement), true, 'focus returns to the actual trigger')
    await page.mouse.move(1250, 750); await page.mouse.wheel(0, -240)
    await page.waitForFunction(before => Math.abs(document.querySelector('.page-home').scrollTop - before) > 10, before)
    report.cases.push({ name: 'grid origin, native wheel background lock, shrink return and scroll restore', passed: true, record: gridRecord })

    const featuredPlugin = plugins.find(plugin => plugin.featured && !plugin.installed)
    assert.ok(featuredPlugin, 'featured detail scenario uses an uninstalled catalog item, not the launch action')
    await page.locator('.product-pagination').getByRole('button', { name: `查看 ${featuredPlugin.name}`, exact: true }).click()
    const featured = page.locator(`.product-slide.is-current:not([data-product-clone])[data-plugin-id="${featuredPlugin.id}"]`)
    await featured.waitFor()
    await start(page, 'featured-medium', featured)
    await featured.locator('.product-title button').click()
    await openSettled(page)
    await close(page)
    const featuredRecord = await end(page)
    assertOriginJourney(featuredRecord)
    report.cases.push({ name: 'featured slide origin and shrink return', passed: true, record: featuredRecord })

    await page.getByRole('combobox').fill('重命名')
    await page.locator('.home-search-scopes').getByRole('button', { name: '插件市场', exact: true }).click()
    const search = page.locator('.home-search-result').filter({ hasText: '查看插件' }).filter({ hasText: '批量重命名' }).first()
    await start(page, 'search-medium', search)
    await search.click()
    await page.locator('.detail-overlay[data-detail-phase="opening"]').waitFor()
    const searchCapture = await capturePhase(page, 'search-opening-mid')
    await openSettled(page)
    await page.screenshot({ path: join(output, 'search-open.png') })
    await close(page)
    const searchRecord = await end(page)
    assertOriginJourney(searchRecord)
    assert.equal(await page.getByRole('combobox').inputValue(), '重命名', 'search state is retained on close')
    report.cases.push({ name: 'search result origin and retained search state', passed: true, captures: [searchCapture], record: searchRecord })
    await page.getByRole('combobox').fill('')

    await start(page, 'rapid-close', grid)
    await grid.locator('.card-detail-trigger').click()
    await page.locator('.detail-overlay').waitFor()
    await close(page)
    report.cases.push({ name: 'Escape interrupts opening without stale overlay', passed: true, record: await end(page) })

    await start(page, 'resize-opening', grid)
    await grid.locator('.card-detail-trigger').click()
    await page.locator('.detail-overlay').waitFor()
    await page.setViewportSize({ width: 900, height: 760 })
    await openSettled(page)
    const bounds = await page.locator('.detail-modal').boundingBox()
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 901 && bounds.y + bounds.height <= 761, 'resized dialog fits viewport')
    await page.screenshot({ path: join(output, 'resized-open.png') })
    await close(page)
    report.cases.push({ name: 'resize during opening converges to current viewport', passed: true, record: await end(page) })
    await page.setViewportSize({ width: 1440, height: 1000 })

    await start(page, 'resize-closing', grid)
    await grid.locator('.card-detail-trigger').click()
    await openSettled(page)
    await page.keyboard.press('Escape')
    await page.locator('.detail-overlay[data-detail-phase="closing"]').waitFor()
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.locator('.detail-overlay').waitFor({ state: 'detached' })
    assert.equal(await page.locator('.page-home').evaluate(element => element.style.overflow), '', 'closing resize does not leak scroll lock')
    report.cases.push({ name: 'resize during closing retires overlay and restores scroll styles', passed: true, record: await end(page) })
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.evaluate(async () => { const { useAppearanceStore } = await import('/hooks/useAppearance.ts'); const state = useAppearanceStore.getState(); await state.updateThemeProfile({ theme: { source: state.appearance.theme.source, id: state.appearance.theme.id }, values: { motion: 'high' } }) })
    await start(page, 'grid-high', grid)
    await grid.locator('.card-detail-trigger').click()
    await page.waitForFunction(() => document.querySelector('.detail-overlay')?.dataset.detailPhase === 'opening' && new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.detail-modal')).transform).a > .5)
    const captures = [await capturePhase(page, 'opening-mid')]
    await openSettled(page)
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('.detail-overlay')?.dataset.detailPhase === 'closing' && new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.detail-modal')).transform).a < .9)
    captures.push(await capturePhase(page, 'closing-mid'))
    await page.locator('.detail-overlay').waitFor({ state: 'detached' })
    const highRecord = await end(page)
    assertOriginJourney(highRecord)
    report.cases.push({ name: 'high setting uses source geometry; mid-transition screenshots without freezing', passed: true, captures, record: highRecord })

    await page.evaluate(async () => { const { useAppearanceStore } = await import('/hooks/useAppearance.ts'); const state = useAppearanceStore.getState(); await state.updateThemeProfile({ theme: { source: state.appearance.theme.source, id: state.appearance.theme.id }, values: { motion: 'low' } }) })
    await start(page, 'low-motion', grid)
    await grid.locator('.card-detail-trigger').click()
    await openSettled(page)
    await close(page)
    const lowRecord = await end(page)
    const lowMatrix = await page.evaluate(record => record.samples.filter(sample => sample.transform).map(sample => { const matrix = new DOMMatrixReadOnly(sample.transform); return { x: matrix.m41, y: matrix.m42, sx: matrix.a, sy: matrix.d } }), lowRecord)
    assert.ok(lowMatrix.every(matrix => Math.abs(matrix.x) <= 7 && Math.abs(matrix.y) <= 7 && matrix.sx >= .97 && matrix.sy >= .97), 'low animation keeps displacement and scale bounded')
    report.cases.push({ name: 'low setting has small DOM-measured motion', passed: true, record: lowRecord })

    await page.evaluate(async () => { const { useAppearanceStore } = await import('/hooks/useAppearance.ts'); const state = useAppearanceStore.getState(); await state.updateThemeProfile({ theme: { source: state.appearance.theme.source, id: state.appearance.theme.id }, values: { motion: 'medium' } }) })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await start(page, 'reduced-motion', grid)
    await grid.locator('.card-detail-trigger').click()
    await openSettled(page)
    await close(page)
    const reducedRecord = await end(page)
    const reducedTransforms = await page.evaluate(record => record.samples.filter(sample => sample.transform).map(sample => new DOMMatrixReadOnly(sample.transform).isIdentity), reducedRecord)
    assert.ok(reducedTransforms.length && reducedTransforms.every(Boolean), 'reduced motion has no displacement or scaling')
    report.cases.push({ name: 'reduced motion keeps identity transform', passed: true, record: reducedRecord })
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    await start(page, 'removed-origin', grid)
    await grid.locator('.card-detail-trigger').click()
    await openSettled(page)
    await page.evaluate(() => {
      const origin = window.detailRecording.origin
      window.removedDetailOrigin = { origin, parent: origin.parentNode, next: origin.nextSibling }
      origin.remove()
    })
    await close(page)
    const missingRecord = await end(page)
    const closingBoxes = missingRecord.samples.filter(sample => sample.phase === 'closing' && sample.rect).map(sample => sample.rect)
    assert.ok(closingBoxes.length >= 2)
    assert.ok(closingBoxes.every(box => distance(box, closingBoxes[0]) < 2), 'removed origin falls back to a stable-position fade')
    await page.evaluate(() => { const { origin, parent, next } = window.removedDetailOrigin; parent.insertBefore(origin, next?.isConnected ? next : null) })
    report.cases.push({ name: 'removed origin uses stable-position fade fallback', passed: true, record: missingRecord })

    await start(page, 'offscreen-origin', grid)
    await grid.locator('.card-detail-trigger').click()
    await openSettled(page)
    await page.locator('.page-home').evaluate(element => { element.scrollTop = 0 })
    assert.ok(await grid.evaluate(element => element.getBoundingClientRect().top >= innerHeight), 'fixture moves the source outside the viewport')
    await close(page)
    const offscreenRecord = await end(page)
    const offscreenBoxes = offscreenRecord.samples.filter(sample => sample.phase === 'closing' && sample.rect).map(sample => sample.rect)
    assert.ok(offscreenBoxes.length >= 2 && offscreenBoxes.every(box => distance(box, offscreenBoxes[0]) < 2), 'offscreen source falls back to stationary fade')
    report.cases.push({ name: 'offscreen origin uses stationary fade fallback', passed: true, record: offscreenRecord })
    assert.deepEqual(errors, [])
    report.status = 'pass'
  } catch (error) {
    report.status = 'failed'; report.error = error.stack
    await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
    throw error
  } finally {
    report.errors = errors
    report.browser = await fixture.browser.version()
    await writeFile(join(output, 'detail-motion-checks.json'), JSON.stringify(report, null, 2))
    await fixture.close()
  }
})
