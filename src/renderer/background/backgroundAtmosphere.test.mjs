import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
const built = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {BackgroundEffect} from '@renderer/components/BackgroundEffect';
    import {BackgroundPicker} from '@renderer/components/BackgroundPicker';
    import {useBackgroundEffect} from '@renderer/hooks/useBackgroundEffect';
    import {useThemeStore} from '@renderer/hooks/useTheme';
    import {useAnimationLevelStore} from '@renderer/hooks/useAnimationLevel';
    useThemeStore.setState({mode:'dark',resolved:'dark',hydrated:true,backgroundEffect:'tunnel'});
    useAnimationLevelStore.setState({level:'low',hydrated:true});
    function Fixture(){const effect=useBackgroundEffect();return React.createElement(React.Fragment,null,
      React.createElement('section',{id:'stage'},effect&&React.createElement(BackgroundEffect,{effect})),
      React.createElement('aside',null,React.createElement(BackgroundPicker)))}
    window.themeStore=useThemeStore;
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  ` },
  tsconfig: 'tsconfig.web.json', bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
  plugins: [{ name: 'delayed-appearance-persistence', setup(b) {
    b.onResolve({ filter: /^@renderer\/services\/shellApi$/ }, () => ({ path: 'api', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const shellApi={getSettings:async()=>({general:{splashBackground:{type:'brand'}}}),
        getTheme:async()=>({mode:'dark',overrides:{},packs:[]}),
        setTheme:(...args)=>{window.appearanceWrites.push(args);return new Promise(resolve=>window.releaseAppearanceWrite=resolve)},
        setSettings:async()=>{},pickFile:async()=>null,onEvent:()=>()=>{}};
      export const isMockShell=true;
    ` }))
  } }],
})

test('settings atmosphere controls repaint the active WebGL background before persistence completes', {
  skip: chrome ? false : 'Set ENEST_CHROME_EXECUTABLE to run background composition checks', timeout: 45_000,
}, async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1350, height: 900 }, reducedMotion: 'reduce' })
    const css = readFileSync('src/renderer/styles/backgroundEffect.css', 'utf8')
      + readFileSync('src/renderer/components/backgroundEffectsPicker.css', 'utf8')
    await page.setContent(`<style>${css}
      :root{--bg:#17191b;--surface:#24292c;--surface-2:#30373b;--text:#e1ebe9;--text-2:#a4b7b1;--text-3:#82928e;--accent:#7fbdac;--accent-soft:#29473e;--border:#44514a}
      *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px system-ui}
      #root{display:grid;grid-template-columns:760px 1fr;gap:18px;padding:20px}#stage{position:relative;width:760px;height:600px}aside{height:860px;overflow:auto}
      button,input{font:inherit}button{cursor:pointer}.bg-grad-grid,.bg-type-row{display:flex;flex-wrap:wrap;gap:7px}.bg-grad-card{width:90px}.bg-grad-face{display:block;height:28px;width:100%}.field{margin:14px 0}.hint,.desc{color:var(--text-2)}.bg-merge-divider{margin:20px 0;border-top:1px solid var(--border)}
    </style><div id="root"></div>`)
    await page.evaluate(() => {
      window.appearanceWrites = []
      window.programsCreated = 0
      const create = WebGLRenderingContext.prototype.createProgram
      WebGLRenderingContext.prototype.createProgram = function () { programsCreated++; return create.call(this) }
    })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.waitForSelector('#stage canvas')
    const stage = page.locator('#stage')
    const before = await stage.screenshot(process.env.ENEST_BACKGROUND_QA ? { path: '/tmp/enest-atmosphere-before.png' } : {})
    const programs = await page.evaluate(() => programsCreated)
    await page.getByRole('radio', { name: '氛围色', exact: true }).click()
    await page.getByRole('option', { name: '晨曦', exact: true }).click()
    const dawn = await stage.screenshot(process.env.ENEST_BACKGROUND_QA ? { path: '/tmp/enest-atmosphere-dawn.png' } : {})
    assert.notDeepEqual(dawn, before, 'the atmosphere must change visible pixels on the current page')
    assert.equal(await page.evaluate(() => appearanceWrites.length), 1, 'first persistence is deliberately still pending')
    assert.equal(await page.evaluate(() => themeStore.getState().backgroundEffect), 'tunnel')
    await page.getByRole('option', { name: '深海', exact: true }).click()
    const ocean = await stage.screenshot(process.env.ENEST_BACKGROUND_QA ? { path: '/tmp/enest-atmosphere-ocean.png' } : {})
    assert.notDeepEqual(ocean, dawn)
    assert.equal(await page.evaluate(() => programsCreated), programs, 'color edits must preserve the running GPU context')
    await page.getByLabel('氛围强度', { exact: true }).evaluate(input => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(await page.locator('#stage .background-atmosphere').evaluate(layer => layer.style.opacity), '0')
    const transparent = await stage.screenshot()
    assert.deepEqual(transparent, before, 'zero atmosphere strength restores the unmodified effect')
    assert.equal(await page.evaluate(() => programsCreated), programs)
  } finally { await browser.close() }
})
