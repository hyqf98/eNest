import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const chrome = process.env.ENEST_CHROME_EXECUTABLE ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync)
const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import React, { act, StrictMode } from 'react';
    import { createRoot } from 'react-dom/client';
    import { BackgroundEffect } from '@renderer/components/BackgroundEffect';
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.getElementById('root'));
    window.renderEffect = async props => { await act(async () => root.render(
      React.createElement(StrictMode, null, props ? React.createElement(BackgroundEffect, props) : null)
    )); };
  ` },
  tsconfig: 'tsconfig.web.json', bundle: true, write: false, platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' },
  plugins: [{ name: 'background-component-fixture', setup(b) {
    const adapters = {
      '@renderer/background/backgroundEffect': `export function startBackgroundEffect(canvas, options) {
        const entry={canvas, options, stopped:false}; window.engineEntries.push(entry);
        return () => { entry.stopped=true; };
      }`,
      '@renderer/hooks/useAnimationLevel': `
        export const useAnimationLevel=()=>({level:window.componentLevel});
        export const useReducedMotion=()=>window.componentReduced;
      `,
      '@renderer/hooks/useReducedMotion': 'export const useReducedMotion=()=>window.componentReduced;',
      '@renderer/hooks/useAppearance': 'export const useAppearanceStore=selector=>selector({appearance:{animation:{effective:window.componentLevel},background:{media:window.componentBackground}}});',
    }
    b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
  } }],
})

test('background component owns StrictMode canvases and video resources', {
  skip: chrome ? false : 'Set ENEST_CHROME_EXECUTABLE to run the React browser checks', timeout: 60_000,
}, async (t) => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.evaluate(() => {
      window.componentLevel = 'medium'
      window.componentReduced = false
      window.engineEntries = []
      window.preset = { id: 'fold', renderer: 'preset', preset: 'fold', name: 'Fold' }
      window.mediaCalls = { play: 0, pause: 0, release: 0 }
      for (const method of ['play', 'pause', 'load']) {
        const native = HTMLMediaElement.prototype[method]
        HTMLMediaElement.prototype[method] = function (...args) {
          if (method === 'load' && !this.hasAttribute('src')) mediaCalls.release++
          else if (method !== 'load') mediaCalls[method]++
          return native.apply(this, args)
        }
      }
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })

    await t.test('StrictMode replaces the canvas and stops every retired owner', async () => {
      await page.evaluate(() => renderEffect({ effect: preset }))
      const initial = await page.evaluate(() => ({
        count: engineEntries.length, active: engineEntries.filter((entry) => !entry.stopped).length,
        fresh: engineEntries[0].canvas !== engineEntries[1].canvas,
        retiredRemoved: !engineEntries[0].canvas.isConnected,
        canvases: document.querySelectorAll('canvas').length,
      }))
      assert.deepEqual(initial, { count: 2, active: 1, fresh: true, retiredRemoved: true, canvases: 1 })
      await page.evaluate(() => renderEffect({ effect: preset, paused: true }))
      assert.equal(await page.evaluate(() => engineEntries.filter((entry) => !entry.stopped).length), 0)
      assert.equal(await page.locator('canvas').count(), 0)
      await page.evaluate(() => renderEffect({ effect: preset, paused: false }))
      assert.equal(await page.evaluate(() => engineEntries.filter((entry) => !entry.stopped).length), 1)
      await page.evaluate(() => renderEffect(null))
      assert.equal(await page.evaluate(() => engineEntries.filter((entry) => !entry.stopped).length), 0)
    })

    await t.test('changing the color atmosphere updates its layer without recreating the effect', async () => {
      await page.evaluate(() => renderEffect({ effect: preset }))
      const started = await page.evaluate(() => engineEntries.length)
      await page.evaluate(async () => {
        componentBackground = { type: 'color', value: 'linear-gradient(120deg, #264839, #113b55)', opacity: 0.4, fit: 'cover' }
        await renderEffect({ effect: preset })
      })
      const layer = page.locator('.background-atmosphere')
      assert.equal(await layer.count(), 1)
      assert.equal(await layer.evaluate(element => element.style.opacity), '0.4')
      assert.match(await layer.evaluate(element => element.style.backgroundImage), /linear-gradient/)
      await page.evaluate(async () => {
        componentBackground = { ...componentBackground, value: '#dd7722', opacity: 0.9 }
        await renderEffect({ effect: preset })
      })
      assert.equal(await layer.evaluate(element => element.style.backgroundImage), '')
      assert.equal(await layer.evaluate(element => element.style.backgroundColor), 'rgb(221, 119, 34)')
      assert.equal(await page.evaluate(() => engineEntries.length), started)
      const canvas = await page.evaluate(() => { window.retainedCanvas = document.querySelector('canvas'); return engineEntries.length })
      await page.evaluate(() => renderEffect({ effect: { ...preset, name: 'Refreshed pack label' } }))
      assert.equal(await page.evaluate(() => engineEntries.length), canvas, 'fresh descriptor objects from appearance broadcasts retain their GPU owner')
      assert.equal(await page.evaluate(() => document.querySelector('canvas') === retainedCanvas), true)
      await page.evaluate(async () => {
        componentBackground = { type: 'image', value: 'example.png', opacity: 1, fit: 'cover' }
        await renderEffect({ effect: preset })
      })
      assert.equal(await layer.count(), 0, 'legacy media is not silently overlaid on selected effects')
      await page.evaluate(() => renderEffect(null))
    })

    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 32
      const context = canvas.getContext('2d')
      const stream = canvas.captureStream(0)
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
      const chunks = []
      recorder.ondataavailable = (event) => chunks.push(event.data)
      const stopped = new Promise((resolve) => { recorder.onstop = resolve })
      recorder.start()
      // A pre-painted static canvas can produce an empty recording in headless Chromium.
      for (let frame = 0; frame < 6; frame++) {
        context.fillStyle = frame % 2 ? 'teal' : 'navy'
        context.fillRect(0, 0, 32, 32)
        stream.getVideoTracks()[0].requestFrame()
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      recorder.stop()
      await stopped
      stream.getTracks().forEach((track) => track.stop())
      const video = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }))
      window.videoEffect = { id: 'video', name: 'Video', renderer: 'video', video,
        poster: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="teal"/></svg>' }
    })

    await t.test('low and reduced motion never allocate a video decoder', async () => {
      for (const [level, reduced] of [['low', false], ['high', true]]) {
        const calls = await page.evaluate(async ({ level, reduced }) => {
          componentLevel = level
          componentReduced = reduced
          const before = mediaCalls.play
          await renderEffect({ effect: videoEffect })
          return { plays: mediaCalls.play - before, videos: document.querySelectorAll('video').length,
            posters: document.querySelectorAll('img').length }
        }, { level, reduced })
        assert.deepEqual(calls, { plays: 0, videos: 0, posters: 1 })
      }
    })

    await t.test('video failure releases the source; changing effects and unmount stop playback', async () => {
      await page.evaluate(async () => {
        componentLevel = 'medium'
        componentReduced = false
        await renderEffect({ effect: videoEffect })
        window.dispatchEvent(new Event('focus'))
      })
      assert.equal(await page.locator('video').count(), 1)
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
      assert.ok(await page.evaluate(() => mediaCalls.play) > 0)
      const activeCalls = await page.evaluate(() => {
        window.activeDecoder = document.querySelector('video')
        return { pause: mediaCalls.pause, release: mediaCalls.release, source: activeDecoder.src }
      })
      await page.evaluate(() => renderEffect({ effect: { ...videoEffect, name: 'Refreshed video label' } }))
      // loadeddata can independently call play(); decoder ownership must remain unchanged.
      assert.equal(await page.evaluate(() => activeDecoder === document.querySelector('video')), true)
      assert.deepEqual(await page.evaluate(() => ({ pause: mediaCalls.pause, release: mediaCalls.release, source: activeDecoder.src })), activeCalls, 'metadata refresh does not reload the active decoder')
      const before = await page.evaluate(() => mediaCalls.release)
      await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('error')))
      await page.waitForTimeout(30)
      assert.ok(await page.evaluate(() => mediaCalls.release) > before)
      assert.equal(await page.locator('video').getAttribute('src'), null)
      assert.equal(await page.locator('.background-effect--fallback').count(), 1)
      await page.evaluate(async () => {
        window.oldVideo = document.querySelector('video')
        await renderEffect({ effect: preset })
      })
      assert.ok(await page.evaluate(() => oldVideo.paused && !oldVideo.hasAttribute('src')))
      await page.evaluate(() => renderEffect({ effect: videoEffect }))
      await page.evaluate(async () => {
        window.oldVideo = document.querySelector('video')
        await renderEffect(null)
      })
      assert.ok(await page.evaluate(() => oldVideo.paused && !oldVideo.hasAttribute('src')))
      await page.evaluate(() => URL.revokeObjectURL(videoEffect.video))
    })
  } finally { await browser.close() }
})
