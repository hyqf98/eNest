import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)

function browserSource(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '').replace(/^export /gm, '')
}

// Extract the real application SVG so geometry checks cannot drift from Splash.
const splash = readFileSync(new URL('../components/Splash.tsx', import.meta.url), 'utf8')
const mark = splash.match(/<svg className="splash-mark"[\s\S]*?<\/svg>/)[0]
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replaceAll('className=', 'class=')
  .replaceAll('strokeWidth=', 'stroke-width=')
  .replaceAll('strokeLinecap=', 'stroke-linecap=')
  .replaceAll('strokeLinejoin=', 'stroke-linejoin=')
  .replace(/pathLength=\{1\}/g, 'pathLength="1"')
const fixture = `<div class="splash"><div class="splash-stage">${mark}<div class="splash-word">${[...'eNest'].map(c => `<span class="splash-word-char">${c}</span>`).join('')}</div><div class="splash-sub">可组合的桌面工作台</div></div></div>`
const sources = ['./motionTokens.ts', './marketMotion.ts', './logoAssembly.ts', './splashMotion.ts'].map(browserSource).join('\n')

test('five logo assemblies preserve the original mark and cleanly replay in real Chrome', {
  skip: chrome ? false : 'Set ENEST_CHROME_EXECUTABLE for real SVG/GSAP checks', timeout: 60_000,
}, async t => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 540 } })
    const styles = readFileSync(new URL('../styles/splash.css', import.meta.url), 'utf8')
    await page.setContent(`<style>body{margin:0;background:#122420} ${styles}</style>${fixture}`)
    await page.addScriptTag({ path: require.resolve('gsap/dist/gsap.js') })
    await page.addScriptTag({ content: `${sources}\nwindow.createLogoAssembly=createLogoAssembly;window.playSplash=playSplash;window.applyLevelToDefaults=applyLevelToDefaults;` })
    await page.evaluate(() => {
      const nativeTimeline = gsap.timeline
      gsap.timeline = (...args) => { const tl = nativeTimeline(...args); window.lastSplashTimeline = tl; return tl }
      const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document)
      window.visibilityHandlers = new Set()
      document.addEventListener = (type, listener, options) => {
        if (type === 'visibilitychange' && listener.name === 'onVisibility') visibilityHandlers.add(listener)
        return add(type, listener, options)
      }
      document.removeEventListener = (type, listener, options) => {
        visibilityHandlers.delete(listener)
        return remove(type, listener, options)
      }
      window.mark = document.querySelector('.splash-mark')
      window.markMarkup = () => {
        const clone = mark.cloneNode(true)
        // Chromium SVG/CSS serialization may retain style="" after restoring an
        // empty declaration. It is visually and semantically identical to absence.
        for (const element of [clone, ...clone.querySelectorAll('[style]')]) {
          if (!element.getAttribute('style')) element.removeAttribute('style')
        }
        return clone.outerHTML
      }
      window.initialMark = markMarkup()
      window.initialMatrices = [...mark.querySelectorAll('.splash-hex,.splash-tile-l,.splash-tile-r,.splash-node')].map(el => {
        const { a, b, c, d, e, f } = el.getCTM(); return [a, b, c, d, e, f]
      })
      window.handles = () => ({
        root: document.querySelector('.splash'), hex: mark.querySelector('.splash-hex'),
        tileL: mark.querySelector('.splash-tile-l'), tileR: mark.querySelector('.splash-tile-r'), node: mark.querySelector('.splash-node'),
        wordChars: [...document.querySelectorAll('.splash-word-char')], sub: document.querySelector('.splash-sub'),
      })
    })
    const originalPixels = await page.locator('.splash-mark').screenshot()

    await t.test('five different intermediate trajectories all finish at the exact original geometry and pixels', async () => {
      const trajectories = []
      for (const style of ['fold', 'aurora', 'orbit', 'ripple', 'tunnel']) {
        const result = await page.evaluate(style => {
          window.assembly = createLogoAssembly(mark, style)
          assembly.render(0.82)
          const intermediate = [...mark.querySelectorAll('[data-assembly-part],.splash-hex')].map(el => [el.getAttribute('transform'), el.style.opacity, el.style.strokeDashoffset])
          assembly.render(2.3)
          const matrices = [...mark.querySelectorAll('.splash-hex,.splash-tile-l,.splash-tile-r,.splash-node')].map(el => {
            const { a, b, c, d, e, f } = el.getCTM(); return [a, b, c, d, e, f]
          })
          return { intermediate, matrices, expected: initialMatrices,
            hiddenEdges: getComputedStyle(mark.querySelector('[data-assembly-edges]')).opacity,
            visibleHex: getComputedStyle(mark.querySelector('.splash-hex')).opacity }
        }, style)
        trajectories.push(JSON.stringify(result.intermediate))
        assert.deepEqual(result.matrices, result.expected, `${style}: original SVG transform matrices`)
        assert.equal(result.hiddenEdges, '0'); assert.equal(result.visibleHex, '1')
        assert.deepEqual(await page.locator('.splash-mark').screenshot(), originalPixels, `${style}: exact final rendered mark`)
        const restored = await page.evaluate(() => { assembly.dispose(); return { actual: markMarkup(), expected: initialMark } })
        assert.equal(restored.actual, restored.expected, `${style}: restores the original DOM`)
      }
      assert.equal(new Set(trajectories).size, 5, 'each approved background has a different assembly trajectory')
    })

    await t.test('setup-cleanup-setup and backward replay leave no extra groups or stale transforms', async () => {
      const results = await page.evaluate(() => {
        const results = []
        for (const style of ['fold', 'aurora', 'orbit', 'ripple', 'tunnel']) {
          for (let cycle = 0; cycle < 3; cycle++) {
            const animation = createLogoAssembly(mark, style)
            animation.render(0.37)
            const first = mark.outerHTML
            animation.render(1.9)
            animation.render(0.37)
            const replay = first === mark.outerHTML
            animation.dispose(); animation.dispose()
            results.push({ style, cycle, replay, restored: markMarkup() === initialMark, groups: mark.querySelectorAll('[data-assembly-part],[data-assembly-fx],[data-assembly-edges]').length })
          }
        }
        return results
      })
      for (const result of results) {
        assert.equal(result.replay, true, JSON.stringify(result))
        assert.equal(result.restored, true, JSON.stringify(result))
        assert.equal(result.groups, 0)
      }
    })

    await t.test('GSAP cancellation restores the mark, cancels completion and permits a fresh complete replay', async () => {
      const cancelled = await page.evaluate(() => {
        applyLevelToDefaults('high')
        window.completed = 0
        const cleanup = playSplash(handles(), () => completed++, 'high', 'orbit')
        const timeline = lastSplashTimeline
        timeline.pause().totalTime(timeline.duration() * 0.35, false)
        cleanup(); cleanup()
        window.cancelledTimeline = timeline
        return { restored: markMarkup() === initialMark, handlers: visibilityHandlers.size,
          registered: gsap.globalTimeline.getChildren().includes(timeline), completed }
      })
      assert.deepEqual(cancelled, { restored: true, handlers: 0, registered: false, completed: 0 })
      await page.waitForTimeout(80)
      assert.equal(await page.evaluate(() => completed), 0)
      const finished = await page.evaluate(() => {
        const cleanup = playSplash(handles(), () => completed++, 'high', 'tunnel')
        lastSplashTimeline.pause().totalProgress(1, false)
        const visibleBeforeCleanup = [...mark.querySelectorAll('.splash-hex,.splash-tile-l,.splash-tile-r,.splash-node')].every(el => getComputedStyle(el).opacity === '1')
        cleanup()
        return { completed, visibleBeforeCleanup, restored: markMarkup() === initialMark, handlers: visibilityHandlers.size }
      })
      assert.deepEqual(finished, { completed: 1, visibleBeforeCleanup: true, restored: true, handlers: 0 })
    })

    await t.test('hidden documents pause the launch timeline and low animation starts from the complete mark', async () => {
      const result = await page.evaluate(() => {
        const cleanup = playSplash(handles(), () => {}, 'medium', 'fold')
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
        const hiddenPaused = lastSplashTimeline.paused()
        delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
        const visiblePlaying = !lastSplashTimeline.paused()
        cleanup()
        applyLevelToDefaults('low')
        window.disposeLow = playSplash(handles(), () => {}, 'low', 'ripple')
        lastSplashTimeline.pause()
        return { hiddenPaused, visiblePlaying, hexVisible: getComputedStyle(mark.querySelector('.splash-hex')).opacity }
      })
      assert.deepEqual(result, { hiddenPaused: true, visiblePlaying: true, hexVisible: '1' })
      assert.deepEqual(await page.locator('.splash-mark').screenshot(), originalPixels)
      await page.evaluate(() => disposeLow())
      assert.equal(await page.evaluate(() => visibilityHandlers.size), 0)
    })
  } finally { await browser.close() }
})
