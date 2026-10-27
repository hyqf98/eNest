import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const enabled = process.env.ENEST_SETTINGS_UI_SMOKE === '1'
const baseline = process.env.ENEST_POPOVER_BASELINE
const root = process.cwd()

test('scrolling portal content does not relayout the anchor; parent scrolling still tracks it', { skip: !enabled, timeout: 60_000 }, async () => {
  const executablePath = process.env.ENEST_CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  assert.ok(executablePath)
  const server = await createServer({ configFile: false, root: join(root, 'src/renderer'), logLevel: 'error',
    plugins: [react(), {
      name: 'popover-scroll-fixture', enforce: 'pre',
      load(id) { if (baseline && id.endsWith('/components/useAnchoredPopover.ts')) return readFileSync(baseline, 'utf8') },
      configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        if (req.url !== '/popover-fixture.html') return next()
        const html = await vite.transformIndexHtml('/popover-fixture.html', `<!doctype html><html><body><div id="root"></div><script type="module">
          import React, { useLayoutEffect, useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client'; import { createPortal } from 'react-dom';
          import { useAnchoredPopover } from '/components/useAnchoredPopover.ts';
          function Fixture() {
            const [open,setOpen]=useState(false), anchor=useRef(null), panel=useRef(null);
            const position=useAnchoredPopover(open,anchor,panel);
            useLayoutEffect(()=>{ window.commits=(window.commits||0)+1 });
            return React.createElement(React.Fragment,null,
              React.createElement('div',{id:'scroll-region',style:{position:'absolute',left:100,top:80,width:400,height:460,overflow:'auto'}},
                React.createElement('div',{style:{height:120}}),
                React.createElement('button',{id:'anchor',ref:anchor,onClick:()=>setOpen(!open),style:{width:220,height:36}},'Open choices'),
                React.createElement('div',{style:{height:1200}})),
              open&&createPortal(React.createElement('div',{id:'panel',ref:panel,style:{...position,overflow:'auto',background:'white',border:'1px solid gray'}},
                Array.from({length:40},(_,i)=>React.createElement('div',{key:i,style:{height:36}},'Option '+i))),document.body));
          }
          createRoot(document.getElementById('root')).render(React.createElement(Fixture));
        </script></body></html>`)
        res.setHeader('Content-Type', 'text/html'); res.end(html)
      }) }
    }], resolve: { alias: Object.fromEntries(['renderer', 'shared', 'main', 'preload'].map(name => [`@${name}`, join(root, 'src', name)])) }, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/popover-fixture.html`)
    await page.locator('#anchor').click()
    await page.locator('#panel').waitFor()
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      const anchor = document.getElementById('anchor'), read = anchor.getBoundingClientRect.bind(anchor)
      anchor.getBoundingClientRect = () => { window.anchorReads++; return read() }
      window.anchorReads = 0; window.commits = 0; window.panelScrolls = 0
      document.getElementById('panel').addEventListener('scroll', () => window.panelScrolls++, { passive: true })
    })
    const box = await page.locator('#panel').boundingBox()
    await page.mouse.move(box.x + 40, box.y + 80)
    for (let index = 0; index < 12; index++) { await page.mouse.wheel(0, 70); await page.waitForTimeout(20) }
    await page.waitForTimeout(100)
    const inner = await page.evaluate(() => ({ anchorReads: window.anchorReads, commits: window.commits, scrollEvents: window.panelScrolls, scrollTop: document.getElementById('panel').scrollTop }))
    assert.ok(inner.scrollTop > 500 && inner.scrollEvents > 5, 'real wheel input scrolls the portal content')
    if (!baseline) { assert.equal(inner.anchorReads, 0); assert.equal(inner.commits, 0) }
    await page.evaluate(() => { window.anchorReads = 0; window.commits = 0; for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('resize')) })
    await page.waitForTimeout(100)
    const burst = await page.evaluate(() => ({ anchorReads: window.anchorReads, commits: window.commits }))
    if (!baseline) { assert.equal(burst.anchorReads, 1); assert.equal(burst.commits, 0) }
    const original = await page.locator('#panel').boundingBox()
    await page.locator('#scroll-region').evaluate(el => { el.scrollTop = 40 })
    await page.waitForTimeout(100)
    const moved = await page.locator('#panel').boundingBox()
    assert.equal(Math.round(original.y - moved.y), 40, 'outer scroll moves the panel with its anchor')
    assert.deepEqual(errors, [])
    const output = join(root, '.cache/verification/anchored-popover')
    mkdirSync(output, { recursive: true })
    const result = { phase: baseline ? 'before' : 'after', inner, burst, parentTrackedPixels: original.y - moved.y, errors }
    writeFileSync(join(output, `popover-${result.phase}.json`), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally { await browser.close(); await server.close() }
})
