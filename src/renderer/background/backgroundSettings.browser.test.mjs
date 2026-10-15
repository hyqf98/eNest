/** Real settings page acceptance. Baseline snapshots use ENEST_BACKGROUND_SOURCE_ROOT. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const enabled = process.env.ENEST_BACKGROUND_SETTINGS_SMOKE === '1'
const baseline = process.env.ENEST_BACKGROUND_BASELINE === '1'
const sourceRoot = realpathSync(resolve(process.env.ENEST_BACKGROUND_SOURCE_ROOT ?? process.cwd()))
const artifacts = resolve(process.env.ENEST_BACKGROUND_ARTIFACTS ?? '/tmp/enest-background-settings')
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null

test('real settings atmosphere composition, drag persistence and button surfaces', { skip: !enabled, timeout: 150_000 }, async () => {
  const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'
  ].find(existsSync)
  assert.ok(chrome, 'Set ENEST_CHROME_EXECUTABLE to an installed Chromium browser')
  await mkdir(artifacts, { recursive: true })
  const server = await createServer({ configFile: false, root: join(sourceRoot, 'src/renderer'), logLevel: 'warn',
    plugins: [{ name: 'atmosphere-render-counts', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/components/BackgroundPicker.tsx')) return code.replace('export function BackgroundPicker() {', 'export function BackgroundPicker() { globalThis.__atmosphereQA && globalThis.__atmosphereQA.renders.picker++;')
      if (id.endsWith('/components/BackgroundEffect.tsx')) return code.replace('  const containerRef = useRef', '  globalThis.__atmosphereQA && globalThis.__atmosphereQA.renders.effect++; const containerRef = useRef')
      if (id.endsWith('/components/ThemeSettingsSection.tsx')) return code.replace('export function ThemeSettingsSection() {', 'export function ThemeSettingsSection() { globalThis.__atmosphereQA && globalThis.__atmosphereQA.renders.themeSection++;')
      if (id.endsWith('/components/ThemeTokenEditor.tsx')) return code.replace('export function ThemeTokenEditor({ tokens, onSetToken, onReset }: Props) {', 'export function ThemeTokenEditor({ tokens, onSetToken, onReset }: Props) { globalThis.__atmosphereQA && globalThis.__atmosphereQA.renders.tokenEditor++;')
      if (id.endsWith('/components/BackgroundEffectsPicker.tsx')) return code.replace('  const selection =', '  globalThis.__atmosphereQA && globalThis.__atmosphereQA.renders.effectPicker++; const selection =')
      return null
    } }, react()],
    resolve: { alias: Object.fromEntries(['renderer', 'shared', 'main', 'preload'].map(name => [`@${name}`, join(sourceRoot, 'src', name)])) },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [sourceRoot, process.cwd()] } }
  })
  await server.listen()
  const browser = await chromium.launch({ executablePath: chrome, headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const evidence = { sourceRoot, baseline, realPage: true, hostBridge: 'browser mock', renderScope: 'Vite development React StrictMode, includes development double renders', timingScope: 'Headless browser rAF intervals; not Electron key-to-pixel latency', screenshots: [], errors: [], drags: [], matrix: [] }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' })
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => evidence.errors.push(error.message))
    await page.addInitScript(() => {
      localStorage.setItem('enest.theme.v1', JSON.stringify({ mode: 'light', overrides: {}, backgroundEffect: 'tunnel', backgroundSource: 'user',
        background: { type: 'color', value: 'linear-gradient(165deg, #faf4eb 0%, #f2ebe1 55%, #e8ded2 100%)', opacity: .5, fit: 'cover' } }))
      localStorage.setItem('enest.settings.v1', JSON.stringify({ general: { locale: 'zh-CN', animationLevel: 'medium', tabStyle: 'classic' }, quick: { enabled: false } }))
      window.__atmosphereQA = { renders: { picker: 0, effect: 0, themeSection: 0, tokenEditor: 0, effectPicker: 0 }, programs: 0, contextLoss: 0, setTheme: [], setSettings: [], themeEvents: 0, storeUpdates: 0, inputEvents: 0, frames: [], measuring: false }
      for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        const original = Type.prototype.createProgram
        Type.prototype.createProgram = function (...args) { window.__atmosphereQA.programs++; return original.apply(this, args) }
      }
      document.addEventListener('webglcontextlost', () => window.__atmosphereQA.contextLoss++, true)
      document.addEventListener('input', event => { if (event.target.matches('input[type=range]')) window.__atmosphereQA.inputEvents++ }, true)
      let previous
      function frame(now) { if (window.__atmosphereQA.measuring && previous) window.__atmosphereQA.frames.push(now - previous); previous = now; requestAnimationFrame(frame) }
      requestAnimationFrame(frame)
    })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`)
    await page.locator('.app-boot.ready').waitFor()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '主题', exact: true }).click()
    await page.locator('.bg-effects-picker').waitFor()
    console.log('Atmosphere fixture: real theme settings loaded')
    await page.getByRole('radio', { name: '氛围色', exact: true }).click()
    await page.getByRole('option', { name: '晨曦', exact: true }).click()
    await page.evaluate(async () => {
      const { shellApi } = await import('/services/shellApi.ts')
      const { useThemeStore } = await import('/hooks/useTheme.ts')
      window.__themeStore = useThemeStore
      for (const method of ['setTheme', 'setSettings']) {
        const original = shellApi[method]
        shellApi[method] = async (...args) => { window.__atmosphereQA[method].push({ at: performance.now(), args }); return original(...args) }
      }
      shellApi.onEvent(event => { if (event.type === 'theme-changed') window.__atmosphereQA.themeEvents++ })
      useThemeStore.subscribe(() => window.__atmosphereQA.storeUpdates++)
    })
    const slider = page.locator('input[aria-label="氛围强度"], input[aria-label="背景不透明度"]')
    const capture = async name => { await page.mouse.move(2, 38); await page.screenshot({ path: join(artifacts, name), fullPage: true }); evidence.screenshots.push(name) }
    const read = () => page.evaluate(() => ({ ...window.__atmosphereQA, value: window.__themeStore.getState().background?.opacity,
      canvasPresent: !!document.querySelector('.app-bg canvas'), sameCanvas: window.__dragCanvas === document.querySelector('.app-bg canvas') }))
    await slider.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.evaluate(() => { window.__dragCanvas = document.querySelector('.app-bg canvas'); window.__atmosphereQA.frames = []; window.__atmosphereQA.measuring = true })
    const initial = await read()
    evidence.gpu = await page.evaluate(() => { const gl = document.querySelector('.app-bg canvas')?.getContext('webgl'); const info = gl?.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'renderer unavailable' })
    for (const end of [.9, .1, .8]) {
      const beforeDrag = await read()
      const box = await slider.boundingBox()
      const value = Number(await slider.inputValue())
      const x = v => box.x + 8 + (box.width - 16) * v
      await page.mouse.move(x(value), box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(x(end), box.y + box.height / 2, { steps: 24 })
      const held = await read()
      const heldValue = Number(await slider.inputValue())
      if (!baseline) {
        assert.equal(held.setTheme.length, beforeDrag.setTheme.length, 'continuous pointer input remains a preview until released')
        assert.equal(held.renders.themeSection, beforeDrag.renders.themeSection, 'theme mode controls stay out of pointer input rendering')
        assert.equal(held.renders.tokenEditor, beforeDrag.renders.tokenEditor, 'token editor stays out of pointer input rendering')
      }
      await page.mouse.up()
      await page.waitForTimeout(400)
      const released = await read()
      evidence.drags.push({ target: end, heldValue, heldWrites: held.setTheme.length - beforeDrag.setTheme.length,
        heldThemeRenders: held.renders.themeSection - beforeDrag.renders.themeSection, heldTokenRenders: held.renders.tokenEditor - beforeDrag.renders.tokenEditor,
        releasedValue: released.value, releasedWrites: released.setTheme.length - beforeDrag.setTheme.length })
    }
    await page.evaluate(() => { window.__atmosphereQA.measuring = false })
    const after = await read()
    evidence.drag = { inputEvents: after.inputEvents - initial.inputEvents, setThemeCalls: after.setTheme.length - initial.setTheme.length,
      setSettingsCalls: after.setSettings.length - initial.setSettings.length, themeEvents: after.themeEvents - initial.themeEvents,
      storeUpdates: after.storeUpdates - initial.storeUpdates, pickerRenders: after.renders.picker - initial.renders.picker,
      effectRenders: after.renders.effect - initial.renders.effect, programsCreated: after.programs - initial.programs,
      themeSectionRenders: after.renders.themeSection - initial.renders.themeSection, tokenEditorRenders: after.renders.tokenEditor - initial.renders.tokenEditor,
      effectPickerRenders: after.renders.effectPicker - initial.renders.effectPicker,
      contextLoss: after.contextLoss - initial.contextLoss, sameCanvas: after.sameCanvas, frames: after.frames.length,
      frameP50Ms: percentile(after.frames, .5), frameP95Ms: percentile(after.frames, .95), longestFrameMs: Math.max(...after.frames), finalOpacity: after.value }
    console.log('Atmosphere drag measurements: ' + JSON.stringify(evidence.drag))
    if (!baseline) {
      assert.equal(evidence.drag.sameCanvas, true, 'dragging preserves the active canvas')
      assert.equal(evidence.drag.programsCreated, 0, 'dragging must not rebuild WebGL programs')
      assert.equal(evidence.drag.contextLoss, 0)
      assert.ok(evidence.drag.setThemeCalls <= 3, 'three drags persist at most their three final values')
      assert.equal(evidence.drag.setSettingsCalls, 0, 'atmosphere drags do not use generic settings IPC')
    }
    await capture('drag-end.png')

    // Static motion level makes screenshot comparisons deterministic while preserving selected effect composition.
    await page.evaluate(async () => { const { useAnimationLevelStore } = await import('/hooks/useAnimationLevel.ts'); await useAnimationLevelStore.getState().setLevel('low') })
    for (const mode of ['light', 'dark']) {
      await page.getByRole('button', { name: mode === 'light' ? '浅色' : '深色', exact: true }).click()
      for (const effect of ['tunnel', 'none']) {
        if (effect === 'none') await page.locator('.bg-effect-off').click()
        else await page.locator('.bg-effect-card:has(input[value="tunnel"])').click()
        for (const strength of [0, .5, 1]) {
          await slider.focus()
          await slider.press('Home')
          const increment = Number(await slider.getAttribute('step'))
          for (let step = 0; step < Math.round(strength / increment); step++) await slider.press('ArrowRight')
          await slider.press('Tab')
          await page.waitForTimeout(150)
          await page.locator('.bg-effects-picker').scrollIntoViewIfNeeded()
          const composition = await page.evaluate(() => {
            const layer = document.querySelector('.app-bg .background-atmosphere, .app-bg .app-bg-fill')
            const style = layer && getComputedStyle(layer)
            const action = element => { const rect = element.getBoundingClientRect(), css = getComputedStyle(element); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, background: css.backgroundColor, color: css.color, border: css.borderColor } }
            const off = document.querySelector('.bg-effect-off'), replay = [...document.querySelectorAll('.bg-effects-picker button')].find(button => button.textContent.includes('重播'))
            return { opacity: style?.opacity, blend: style?.mixBlendMode, backgroundImage: style?.backgroundImage, pageSurface: getComputedStyle(document.querySelector('.page-settings')).backgroundColor,
              cardSurface: getComputedStyle(document.querySelector('.s-card:has(.bg-effects-picker)')).backgroundColor, off: action(off), replay: action(replay), storeOpacity: window.__themeStore.getState().background?.opacity }
          })
          evidence.matrix.push({ mode, effect, strength, ...composition })
          if (!baseline) {
            assert.equal(composition.storeOpacity, strength)
            assert.ok(Math.abs(composition.off.y - composition.replay.y) < 3, 'off and replay actions share one row')
            for (const control of [composition.off, composition.replay]) assert.notEqual(control.background, 'rgba(0, 0, 0, 0)', 'actions have a visible resting surface')
          }
          await capture(`${mode}-${effect}-${Math.round(strength * 100)}.png`)
        }
      }
    }
    assert.deepEqual(evidence.errors, [])
    evidence.status = 'pass'
    console.log(JSON.stringify({ artifacts, baseline, drag: evidence.drag }))
  } catch (error) { evidence.status = 'fail'; evidence.failure = error.stack; throw error }
  finally { await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(evidence, null, 2)); await browser.close(); await server.close() }
})
