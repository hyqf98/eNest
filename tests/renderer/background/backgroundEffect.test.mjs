import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { chromium } from 'playwright-core'

const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync)

function browserSource(relativePath) {
  const source = readFileSync(fileURLToPath(new URL(relativePath, new URL("../../../src/renderer/background/", import.meta.url))), 'utf8')
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')
}

const engine = [
  browserSource('../../shared/theme/colors.ts'),
  browserSource('./shaders.ts'),
  browserSource('./backgroundEffect.ts'),
  'window.startBackgroundEffect = startBackgroundEffect;',
].join('\n')

test('background materials render in WebGL and release their lifecycle resources', {
  skip: chrome ? false : 'Set ENEST_CHROME_EXECUTABLE to run the real WebGL browser checks',
  timeout: 60_000,
}, async (t) => {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.setContent('<style>:root{--bg:#17191b}body{margin:0}canvas{width:960px;height:540px;display:block}</style>')
    await page.evaluate(() => {
      const nativeRaf = window.requestAnimationFrame.bind(window)
      const nativeCancel = window.cancelAnimationFrame.bind(window)
      const nativeStyle = window.getComputedStyle.bind(window)
      const counters = window.qa = {
        pending: new Set(), draws: 0, styleReads: 0, capture: false, samples: [],
        buffers: new Set(), programs: new Set(), shaders: new Set(),
        resizeObservers: new Set(), mutationObservers: new Set(), listeners: new Set(),
      }
      window.requestAnimationFrame = (callback) => {
        const id = nativeRaf((time) => { counters.pending.delete(id); callback(time) })
        counters.pending.add(id)
        return id
      }
      window.cancelAnimationFrame = (id) => { counters.pending.delete(id); nativeCancel(id) }
      window.getComputedStyle = (...args) => { counters.styleReads++; return nativeStyle(...args) }
      const listenerNames = new Set(['syncActivity', 'onFocus', 'onBlur', 'onPointerMove', 'onPointerOut', 'onContextLost'])
      const addListener = EventTarget.prototype.addEventListener
      const removeListener = EventTarget.prototype.removeEventListener
      EventTarget.prototype.addEventListener = function (event, listener, options) {
        if (listenerNames.has(listener?.name)) counters.listeners.add(listener)
        return addListener.call(this, event, listener, options)
      }
      EventTarget.prototype.removeEventListener = function (event, listener, options) {
        counters.listeners.delete(listener)
        return removeListener.call(this, event, listener, options)
      }
      for (const [name, key] of [['ResizeObserver', 'resizeObservers'], ['MutationObserver', 'mutationObservers']]) {
        const Native = window[name]
        window[name] = class extends Native {
          constructor(callback) {
            super(callback)
            // Playwright also creates observers for its own script injection.
            if (callback.name === 'resize' || callback.name === 'refreshTheme') counters[key].add(this)
          }
          disconnect() { counters[key].delete(this); super.disconnect() }
        }
      }
      for (const [kind, key] of [['Buffer', 'buffers'], ['Program', 'programs'], ['Shader', 'shaders']]) {
        const create = WebGLRenderingContext.prototype[`create${kind}`]
        const remove = WebGLRenderingContext.prototype[`delete${kind}`]
        WebGLRenderingContext.prototype[`create${kind}`] = function (...args) {
          const resource = create.apply(this, args)
          if (resource) counters[key].add(resource)
          return resource
        }
        WebGLRenderingContext.prototype[`delete${kind}`] = function (resource) {
          counters[key].delete(resource)
          return remove.call(this, resource)
        }
      }
      const draw = WebGLRenderingContext.prototype.drawArrays
      WebGLRenderingContext.prototype.drawArrays = function (...args) {
        const result = draw.apply(this, args)
        counters.draws++
        if (counters.capture) {
          counters.capture = false
          const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4)
          this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight, this.RGBA, this.UNSIGNED_BYTE, pixels)
          let min = 255
          let max = 0
          let sum = 0
          let hash = 2166136261
          for (let i = 0; i < pixels.length; i += 4) {
            const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
            min = Math.min(min, value)
            max = Math.max(max, value)
            sum += value
            hash = Math.imul(hash ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 2] << 16), 16777619)
          }
          counters.samples.push({ min, max, mean: sum / (pixels.length / 4), hash: hash >>> 0, error: this.getError() })
        }
        return result
      }
      window.mountEffect = (options = {}) => {
        window.disposeEffect?.()
        document.querySelector('canvas')?.remove()
        const canvas = document.createElement('canvas')
        document.body.append(canvas)
        window.failures = 0
        window.disposeEffect = window.startBackgroundEffect(canvas, {
          preset: 'fold', level: 'low', reducedMotion: true, ...options, onError: () => window.failures++,
        })
        window.dispatchEvent(new Event('focus'))
      }
      window.resourceCounts = () => Object.fromEntries([
        'pending', 'buffers', 'programs', 'shaders', 'resizeObservers', 'mutationObservers', 'listeners',
      ].map((key) => [key, counters[key].size]))
    })
    await page.addScriptTag({ content: engine })

    await t.test('all five presets compile and draw distinct nonempty images', async () => {
      const hashes = []
      for (const preset of ['fold', 'aurora', 'orbit', 'ripple', 'tunnel']) {
        const result = await page.evaluate((preset) => {
          qa.capture = true
          mountEffect({ preset })
          return { failures, sample: qa.samples.at(-1), raf: qa.pending.size }
        }, preset)
        assert.equal(result.failures, 0, `${preset}: WebGL shader setup`)
        assert.equal(result.sample.error, 0, `${preset}: WebGL error`)
        assert.ok(result.sample.max - result.sample.min > 30, `${preset}: material contrast`)
        assert.ok(result.sample.mean > 10, `${preset}: nonempty image`)
        assert.equal(result.raf, 0, `${preset}: reduced motion has no RAF`)
        hashes.push(result.sample.hash)
      }
      assert.equal(new Set(hashes).size, 5)
    })

    await t.test('theme and plugin palette updates change rendered colors', async () => {
      await page.evaluate(() => {
        qa.capture = true
        mountEffect({ preset: 'aurora', colors: ['#243863', '#6655cc', '#eface0'] })
      })
      const dark = await page.evaluate(() => qa.samples.at(-1))
      await page.evaluate(() => {
        qa.capture = true
        document.documentElement.style.setProperty('--bg', '#f6f6f4')
      })
      await page.waitForTimeout(50)
      const light = await page.evaluate(() => qa.samples.at(-1))
      assert.ok(light.mean > dark.mean + 100, 'light theme follows the application base color')
      assert.notEqual(light.hash, dark.hash)
      const custom = await page.evaluate(() => {
        document.documentElement.style.setProperty('--bg', '#17191b')
        qa.capture = true
        mountEffect({ preset: 'aurora', colors: ['#ff4000', '#ff9000', '#ffeedd'] })
        return qa.samples.at(-1)
      })
      assert.notEqual(custom.hash, dark.hash, 'declarative palettes alter the material')
    })

    await t.test('animation suspends on blur and hidden document, then resumes', async () => {
      await page.evaluate(() => mountEffect({ level: 'medium', reducedMotion: false }))
      await page.waitForTimeout(100)
      const active = await page.evaluate(() => ({ draws: qa.draws, reads: qa.styleReads }))
      await page.waitForFunction((count) => qa.draws > count, active.draws, { timeout: 5000 })
      const playing = await page.evaluate(() => ({ draws: qa.draws, reads: qa.styleReads }))
      assert.ok(playing.draws > active.draws)
      assert.equal(playing.reads, active.reads, 'no computed style reads during animation frames')
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      const paused = await page.evaluate(() => ({ draws: qa.draws, pending: qa.pending.size }))
      await page.waitForTimeout(120)
      assert.equal(await page.evaluate(() => qa.draws), paused.draws)
      assert.equal(paused.pending, 0)
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForFunction((count) => qa.draws > count, paused.draws, { timeout: 5000 })
      assert.ok(await page.evaluate(() => qa.draws) > paused.draws)
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      assert.equal(await page.evaluate(() => qa.pending.size), 0)
      await page.evaluate(() => {
        delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.waitForTimeout(60)
      assert.equal(await page.evaluate(() => qa.pending.size), 1)
    })

    await t.test('reduced motion, resize budgets, context loss and disposal are bounded', async () => {
      await page.evaluate(() => mountEffect({ level: 'high', reducedMotion: true, launch: true }))
      assert.equal(await page.evaluate(() => qa.pending.size), 0)
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        canvas.style.width = '6000px'
        canvas.style.height = '4000px'
      })
      await page.waitForTimeout(80)
      assert.ok(await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        return canvas.width * canvas.height <= 2_100_000
      }))
      await page.evaluate(() => document.querySelector('canvas').getContext('webgl').getExtension('WEBGL_lose_context').loseContext())
      await page.waitForTimeout(50)
      assert.equal(await page.evaluate(() => failures), 1, 'context loss invokes fallback exactly once')
      assert.deepEqual(await page.evaluate(() => resourceCounts()), {
        pending: 0, buffers: 0, programs: 0, shaders: 0, resizeObservers: 0, mutationObservers: 0, listeners: 0,
      })
      await page.evaluate(() => { mountEffect({ level: 'high', reducedMotion: false }); disposeEffect(); disposeEffect() })
      assert.deepEqual(await page.evaluate(() => resourceCounts()), {
        pending: 0, buffers: 0, programs: 0, shaders: 0, resizeObservers: 0, mutationObservers: 0, listeners: 0,
      })
      const unavailable = await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.getContext = () => null
        let failures = 0
        const dispose = startBackgroundEffect(canvas, { preset: 'fold', level: 'high', onError: () => failures++ })
        dispose()
        return failures
      })
      assert.equal(unavailable, 1)
    })

    await t.test('low keeps slow animation within a smaller pixel budget; reduced motion remains static', async () => {
      const first = await page.evaluate(() => {
        qa.capture = true
        mountEffect({ preset: 'ripple', level: 'low', reducedMotion: false })
        return { sample: qa.samples.at(-1), draws: qa.draws }
      })
      assert.ok(await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        return canvas.width * canvas.height <= 360_000
      }))
      await page.waitForTimeout(450)
      await page.evaluate(() => { qa.capture = true })
      await page.waitForFunction((count) => qa.draws > count && !qa.capture, first.draws, { timeout: 5000 })
      const after = await page.evaluate(() => qa.samples.at(-1))
      assert.notEqual(after.hash, first.sample.hash, 'low must visibly evolve instead of freezing')
      await page.evaluate(() => mountEffect({ level: 'low', reducedMotion: true }))
      assert.equal(await page.evaluate(() => qa.pending.size), 0)
      await page.evaluate(() => disposeEffect())
    })
  } finally {
    await browser.close()
  }
})
