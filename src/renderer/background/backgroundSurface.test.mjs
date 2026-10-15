import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {AppBackground} from '@renderer/components/AppBackground';
    import {useThemeStore} from '@renderer/hooks/useTheme';
    import {useAnimationLevelStore} from '@renderer/hooks/useAnimationLevel';
    useThemeStore.setState({mode:'dark',resolved:'dark',hydrated:true,backgroundEffect:'tunnel'});
    useAnimationLevelStore.setState({level:'low',hydrated:true});
    window.themeStore=useThemeStore;
    createRoot(document.getElementById('background')).render(React.createElement(AppBackground));
  ` }, tsconfig: 'tsconfig.web.json', bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
  plugins: [{ name: 'surface-fixture', setup(b) {
    const adapters = {
      '@renderer/hooks/useFpsGuard': 'export const useFpsGuard=()=>{};',
      '@renderer/stores/shellStore': 'export const useShellStore=selector=>selector({view:"home"});',
      '@renderer/services/shellApi': `export const shellApi={onEvent:()=>()=>{}}; export const isMockShell=true;`,
    }
    b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
  } }],
})
const presetSource = readFileSync('src/renderer/components/BackgroundPicker.tsx', 'utf8')
const presets = Object.fromEntries([...presetSource.matchAll(/id: '(\w+)',\s+name: '[^']+',\s+css: '([^']+)'/g)].map(match => [match[1], match[2]]))
const css = ['tokens.css', 'app.css', 'market.css', 'backgroundEffect.css']
  .map(file => readFileSync(`src/renderer/styles/${file}`, 'utf8').replace(/^@import.*$/gm, '')).join('\n')
const luminance = rgb => rgb.reduce((sum, value, index) => {
  const c = value / 255
  return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]
}, 0)
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)

test('atmosphere tints shell surfaces without weakening text, selected states or GPU lifetime', {
  skip: chrome ? false : 'Set ENEST_CHROME_EXECUTABLE for browser composition checks', timeout: 60_000,
}, async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, reducedMotion: 'reduce' })
    await page.setContent(`<style>${css}
      *{box-sizing:border-box}html,body,.app{margin:0;width:100%;height:100%;font:14px system-ui;color:var(--text)}
      .app-chrome{display:block}.titlebar{height:36px;padding:8px 24px}.test-content{display:grid;grid-template-columns:1fr 1fr;height:664px}
      .page-home,.page-settings{padding:30px}.card,.s-card{height:220px!important;padding:24px!important;display:block!important}
      .selected-controls{margin-top:24px}.chip.active{background:var(--accent-soft);color:var(--accent)}
      .segmented button.active{background:var(--surface);color:var(--text)}
    </style><div class="app"><div id="background"></div><div class="app-chrome">
      <header class="titlebar">eNest</header><div class="test-content"><main class="page-home"><article class="card">
      <h2>插件中心</h2><p class="card-description">已安装的插件与常用操作</p></article></main>
      <main class="page-settings"><section class="s-card"><h2>外观设置</h2><p class="hint">氛围颜色保持文字清晰</p>
      <div class="field"><div class="desc">配色立即生效</div><input value="eNest" /></div></section>
      <div class="selected-controls"><button class="chip active">已选择</button><div class="segmented"><button class="active">当前</button></div></div>
      </main></div></div></div>`)
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
      document.documentElement.dataset.anim = 'low'
      window.programs = 0
      const create = WebGLRenderingContext.prototype.createProgram
      WebGLRenderingContext.prototype.createProgram = function () { programs++; return create.call(this) }
      window.classRemovals = 0
      const remove = DOMTokenList.prototype.remove
      DOMTokenList.prototype.remove = function (...tokens) {
        if (tokens.includes('has-bg-media') || tokens.includes('has-bg-effect')) classRemovals++
        return remove.apply(this, tokens)
      }
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.waitForSelector('canvas')
    const beforePrograms = await page.evaluate(() => programs)
    const states = () => page.evaluate(() => ['.chip.active', '.segmented button.active'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector)); return [style.backgroundColor, style.color]
    }))
    const select = async (value, opacity = 1, effect = 'tunnel') => {
      await page.evaluate(({ value, opacity, effect }) => themeStore.setState({ background: { type: 'color', value, opacity, fit: 'cover' }, backgroundEffect: effect }), { value, opacity, effect })
      await page.waitForFunction(strength => document.documentElement.style.getPropertyValue('--atmosphere-strength') === String(strength), opacity)
      await page.waitForTimeout(30)
    }
    const sample = async () => {
      const encoded = (await page.screenshot()).toString('base64')
      return page.evaluate(async encoded => {
        const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        const rgb = color => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) }
        return Object.fromEntries(['.titlebar', '.page-home .card', '.s-card'].map(selector => {
          const el = document.querySelector(selector), box = el.getBoundingClientRect()
          const pixel = [...ctx.getImageData(Math.floor(box.right - 30), Math.floor(box.top + 24), 1, 1).data].slice(0, 3)
          const text = rgb(getComputedStyle(el).color)
          const muted = el.querySelector('.hint,.card-description')
          return [selector, { pixel, text, muted: muted ? rgb(getComputedStyle(muted).color) : null }]
        }))
      }, encoded)
    }
    const output = '/tmp/enest-atmosphere-surface-qa'
    if (process.env.ENEST_BACKGROUND_QA) mkdirSync(output, { recursive: true })
    const noAtmosphere = await sample()
    await select(presets.ocean, 0)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('has-bg-atmosphere')), false)
    assert.deepEqual(await sample(), noAtmosphere, 'zero strength preserves the original effect and surface baseline')
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      const selected = await states()
      await select(presets.dawn)
      const dawn = await sample()
      if (process.env.ENEST_BACKGROUND_QA) await page.screenshot({ path: `${output}/${theme}-dawn.png` })
      await select(presets.ocean)
      const ocean = await sample()
      if (process.env.ENEST_BACKGROUND_QA) await page.screenshot({ path: `${output}/${theme}-ocean.png` })
      for (const selector of Object.keys(dawn)) {
        const delta = dawn[selector].pixel.reduce((sum, value, index) => sum + Math.abs(value - ocean[selector].pixel[index]), 0)
        assert.ok(delta >= 35, `${theme} ${selector}: different atmospheres must visibly change the surface (${delta})`)
      }
      assert.deepEqual(await states(), selected, 'atmosphere never changes active chip/segmented paints')
      for (const color of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff']) {
        await select(color)
        for (const [selector, { pixel, text, muted }] of Object.entries(await sample())) {
          assert.ok(contrast(pixel, text) >= 4.5, `${theme} ${color} ${selector}: primary text contrast`)
          if (muted) assert.ok(contrast(pixel, muted) >= 4.5, `${theme} ${color} ${selector}: secondary text contrast`)
        }
      }
    }
    assert.equal(await page.evaluate(() => programs), beforePrograms, 'color/theme/strength edits keep the GPU program')
    assert.equal(await page.evaluate(() => classRemovals), 0, 'preview changes do not remove and re-add background classes')
    await select(presets.ocean, 0.2)
    const weak = await sample()
    await select(presets.ocean, 1)
    const strong = await sample()
    assert.notDeepEqual(strong['.s-card'].pixel, weak['.s-card'].pixel, 'strength changes surface tint instead of covering it')
    const withEffect = await sample()
    await select(presets.ocean, 1, 'none')
    const withoutEffect = await sample()
    assert.deepEqual(withoutEffect['.s-card'].pixel, withEffect['.s-card'].pixel, 'selecting an effect does not wash out the card tint')
  } finally { await browser.close() }
})
