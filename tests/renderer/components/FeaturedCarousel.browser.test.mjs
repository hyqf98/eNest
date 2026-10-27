/** Opt-in real catalog interaction and native Electron blur regression. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { createMarketBrowserFixture, prepareMarketBrowserPage } from './marketBrowserFixture.test.fixture.mjs'

const require = createRequire(import.meta.url)
const artifacts = process.env.ENEST_FEATURED_ARTIFACTS || '/tmp/enest-featured-validation'

async function settled(page, index) {
  await page.waitForFunction(index => {
    const viewport = document.querySelector('.product-viewport')
    const slide = document.querySelector(`[data-product-index="${index}"].is-current`)
    return viewport && slide && Math.abs(viewport.scrollLeft - (slide.offsetLeft - 4)) < 2 && !viewport.style.scrollSnapType
  }, index)
}

test('featured copy launches installed plugins, opens details otherwise, and preserves gesture/navigation behavior', {
  skip: process.env.ENEST_FEATURED_UI !== '1', timeout: 60000,
}, async () => {
  const fixture = await createMarketBrowserFixture()
  const { page, errors } = fixture
  await mkdir(artifacts, { recursive: true })
  const checks = []
  try {
    await page.evaluate(async () => {
      const { useShellStore } = await import('/stores/shellStore.ts')
      window.featuredLaunches = []
      useShellStore.setState({ openPlugin: async id => { window.featuredLaunches.push(id) } })
    })
    const pages = page.locator('.product-page')
    const first = page.locator('[data-product-index="0"]')
    const second = page.locator('[data-product-index="1"]')
    await settled(page, 0)
    for (const target of ['.product-heading .product-icon', '.product-description', '.product-title button']) {
      await first.locator(target).click()
      await page.locator('.detail-overlay[data-detail-phase="open"]').waitFor()
      assert.equal(await page.locator('#plugin-detail-title').textContent(), '剪贴板')
      await page.keyboard.press('Escape')
      await page.locator('.detail-overlay').waitFor({ state: 'detached' })
    }
    checks.push('Uninstalled icon, title and description open anchored details')
    await pages.nth(1).click(); await settled(page, 1)
    for (const target of ['.product-heading .product-icon', '.product-description', '.product-title button', '.product-cta']) {
      await second.locator(target).click()
    }
    assert.deepEqual(await page.evaluate(() => window.featuredLaunches), Array(4).fill('com.github.eNest.database'))
    assert.equal(await page.locator('.detail-overlay').count(), 0)
    await second.locator('.product-title button').focus(); await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.featuredLaunches.length), 5, 'keyboard title access launches exactly once')
    checks.push('Installed left region and CTA launch exactly once; keyboard title works')
    await page.evaluate(async () => {
      const { useShellStore } = await import('/stores/shellStore.ts')
      useShellStore.setState({ plugins: useShellStore.getState().plugins.map(plugin => plugin.id === 'com.github.eNest.database' ? { ...plugin, enabled: false } : plugin) })
    })
    await second.locator('.product-title button').click()
    await page.locator('.detail-overlay[data-detail-phase="open"]').waitFor()
    assert.equal(await page.locator('#plugin-detail-title').textContent(), '数据库')
    assert.equal(await page.evaluate(() => window.featuredLaunches.length), 5)
    await page.keyboard.press('Escape'); await page.locator('.detail-overlay').waitFor({ state: 'detached' })
    checks.push('Disabled installed plugins retain details/recovery behavior')

    await pages.first().click(); await settled(page, 0)
    const description = await first.locator('.product-description').boundingBox()
    await page.mouse.move(description.x + description.width * .8, description.y + 10)
    await page.mouse.down(); await page.mouse.move(description.x - 200, description.y + 10, { steps: 15 }); await page.mouse.up()
    await settled(page, 1)
    assert.equal(await page.locator('.detail-overlay').count(), 0)
    assert.equal(await page.evaluate(() => window.featuredLaunches.length), 5, 'drag must not launch or open details')
    checks.push('Dragging the enlarged click region does not activate it')

    const last = await pages.count() - 1
    await pages.nth(last).click(); await settled(page, last)
    await page.locator('.product-nav-next').click(); await settled(page, 0)
    await page.locator('.product-nav-prev').click(); await settled(page, last)
    await page.locator('.product-viewport').focus(); await page.keyboard.press('Home'); await settled(page, 0)
    checks.push('Forward/backward clone seam and Home navigation settle correctly')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await pages.nth(1).click(); await settled(page, 1)
    assert.equal(await page.locator('.product-carousel').getAttribute('data-autoplay'), null)
    checks.push('Reduced motion disables autoplay and preserves navigation')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await pages.first().click(); await settled(page, 0)
    // The published snapshot has one screenshot; the current repository manifest has three.
    const pluginRoot = join(process.cwd(), 'eNest_plugin/plugins/clipboard')
    const manifest = JSON.parse(await readFile(join(pluginRoot, 'plugin.json'), 'utf8'))
    const images = manifest.market.screenshots.slice(0, 3)
    const urls = images.map((_, index) => `${fixture.url}/__current_clipboard/${index}`)
    for (const [index, file] of images.entries()) {
      const body = await readFile(join(pluginRoot, 'public', file))
      await page.route(urls[index], route => route.fulfill({ body, contentType: file.endsWith('.webp') ? 'image/webp' : 'image/png' }))
    }
    await page.evaluate(async screenshots => {
      const { useShellStore } = await import('/stores/shellStore.ts')
      useShellStore.setState({ plugins: useShellStore.getState().plugins.map(plugin => plugin.id === 'com.github.eNest.clipboard' ? { ...plugin, screenshots } : plugin) })
    }, urls)
    await first.locator('.product-gallery-dot').nth(1).click()
    await page.waitForFunction(url => document.querySelector('[data-product-index="0"] .product-gallery-image.is-visible')?.getAttribute('src') === url, urls[1])
    assert.equal(await page.locator('.detail-overlay').count(), 0)
    await pages.nth(last).click(); await settled(page, last)
    await page.locator('.product-nav-next').click(); await settled(page, 0)
    assert.equal(await first.locator('.product-gallery-image.is-visible').getAttribute('src'), urls[1])
    const replicas = await page.locator('[data-plugin-id="com.github.eNest.clipboard"] .product-gallery-dot[aria-current="true"]').allTextContents()
    assert.equal(replicas.length, 2, 'real slide and loop clone share the selected screenshot')
    await first.locator('.product-image-button').click()
    await first.locator('dialog[open]').waitFor()
    await page.keyboard.press('Escape'); await first.locator('dialog[open]').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.featuredLaunches.length), 5)
    checks.push('Real three-image repository gallery uses dots; selection survives clone wrap and preview does not launch')
    await page.mouse.move(10, 20)
    await page.screenshot({ path: join(artifacts, 'featured-home.png') })
    assert.deepEqual(errors, [])
    await writeFile(join(artifacts, 'featured-ui.json'), JSON.stringify({ status: 'pass', catalogCount: fixture.plugins.length, checks, errors }, null, 2))
  } finally { await fixture.close() }
})

test('a visible Electron window continues its real autoplay interval after native focus moves away', {
  skip: process.env.ENEST_FEATURED_NATIVE !== '1', timeout: 60000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-carousel-focus-'))
  const fixture = await createMarketBrowserFixture({ viewport: { width: 1000, height: 800 } })
  let app
  const errors = []
  try {
    await fixture.browser.close()
    const entry = join(directory, 'main.cjs')
    await writeFile(entry, `const {app,BrowserWindow,screen}=require('electron');
      app.setPath('userData',process.env.ENEST_CAROUSEL_TEST_PROFILE);
      app.whenReady().then(()=>{const a=screen.getPrimaryDisplay().workArea;
        const win=new BrowserWindow({title:'eNest 精选轮播验证',width:1000,height:800,x:a.x,y:a.y,webPreferences:{contextIsolation:true}});
        win.loadURL('about:blank');win.focus();});
      app.on('window-all-closed',()=>app.quit());`)
    const env = { ...process.env, ENEST_CAROUSEL_TEST_PROFILE: join(directory, 'profile') }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ executablePath: require('electron'), args: [entry], env })
    const page = await app.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await prepareMarketBrowserPage(page, { url: fixture.url })
    // Playwright emulates an always-focused document; this case needs native focus state.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus() })
    await page.waitForFunction(() => document.hasFocus() && !document.hidden)
    await page.locator('.product-carousel').hover()
    assert.equal(await page.locator('.product-carousel').getAttribute('data-autoplay'), null, 'hover pauses while focused')
    const count = await page.locator('.product-page').count()
    const before = await page.locator('[data-product-index].is-current').getAttribute('data-product-index')
    await app.evaluate(async ({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea
      const helper = new BrowserWindow({ title: '轮播失焦验证', width: 240, height: 140, x: area.x + area.width - 250, y: area.y + area.height - 150 })
      await helper.loadURL('data:text/html,<meta charset="utf-8"><body>验证主窗口失焦后继续轮播</body>')
      helper.show(); helper.focus()
    })
    await page.waitForFunction(() => !document.hasFocus() && !document.hidden, null, { timeout: 5000 })
    await page.locator('.product-carousel[data-autoplay]').waitFor()
    const started = Date.now()
    await page.waitForFunction(before => document.querySelector('[data-product-index].is-current')?.dataset.productIndex !== before, before, { timeout: 11000 })
    const after = await page.locator('[data-product-index].is-current').getAttribute('data-product-index')
    await settled(page, Number(after))
    const state = await page.evaluate(() => ({ hasFocus: document.hasFocus(), hidden: document.hidden, running: document.querySelector('.product-carousel').hasAttribute('data-autoplay') }))
    assert.equal(state.hasFocus, false); assert.equal(state.hidden, false)
    assert.equal(Number(after), (Number(before) + 1) % count)
    assert.deepEqual(errors, [])
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'native-blurred-autoplay.png') })
    await writeFile(join(artifacts, 'native-focus.json'), JSON.stringify({ status: 'pass', platform: process.platform, electron: await app.evaluate(() => process.versions.electron), before, after, elapsedMs: Date.now() - started, state, errors, boundary: 'Isolated Electron BrowserWindow with actual App and real local market; native focus transferred to a second window without hiding the first. No real user profile.' }, null, 2))
  } finally {
    await app?.close()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})
