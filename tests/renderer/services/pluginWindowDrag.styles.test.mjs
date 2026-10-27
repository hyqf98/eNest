/** Isolated native CSS cascade check; no shell build or user profile is loaded.
 * ENEST_DRAG_STYLE_SMOKE=1 node --test tests/renderer/services/pluginWindowDrag.styles.test.mjs */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)

test('Orb drag transforms have one animation owner in every tier and remain positional under reduced motion', {
  skip: process.env.ENEST_DRAG_STYLE_SMOKE !== '1', timeout: 30000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-drag-css-'))
  let app
  try {
    const script = join(directory, 'main.cjs')
    await writeFile(script, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
app.disableHardwareAcceleration();
app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:160,height:400});win.loadURL('about:blank')});`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ executablePath: require('electron'), args: [script], env, timeout: 15000 })
    const page = await app.firstWindow()
    const styles = (await Promise.all([
      readFile(new URL('../../../src/renderer/themes/default/chrome/orb.css', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/renderer/styles/plugin-window-drag.css', import.meta.url), 'utf8')
    ])).join('\n')
    await page.setContent(`<html data-anim="high"><head><style>${styles}</style></head><body>
      <div class="orb-rail expanded plugin-drag-session"><div class="orb-panel"><div class="orb-item orb-tab" style="transform:translate3d(0px,40px,0px)"><button class="orb-face">A</button></div></div></div>
    </body></html>`)
    const computed = () => page.evaluate(() => {
      const item = getComputedStyle(document.querySelector('.orb-item'))
      const panel = getComputedStyle(document.querySelector('.orb-panel'))
      const transform = new DOMMatrixReadOnly(item.transform)
      return { property: item.transitionProperty, duration: item.transitionDuration, y: transform.m42, panel: panel.transitionProperty }
    })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    for (const tier of ['low', 'medium', 'high']) {
      await page.evaluate(tier => { document.documentElement.dataset.anim = tier }, tier)
      const style = await computed()
      assert.equal(style.property, 'opacity', `${tier}: CSS must never tween GSAP's transform`)
      assert.equal(style.panel, 'none', `${tier}: viewport expansion must not lag reported hit geometry`)
      assert.equal(style.y, 40)
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await computed()
    assert.equal(reduced.property, 'none')
    assert.equal(reduced.duration, '0s')
    assert.equal(reduced.y, 40, 'reduced motion disables interpolation, not the instantaneous drag position')
    await page.evaluate(() => document.querySelector('.orb-rail').classList.remove('plugin-drag-session'))
    assert.equal((await computed()).y, 0, 'normal Orb hover/entrance transforms remain disabled under reduced motion')
  } finally {
    if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
    await rm(directory, { recursive: true, force: true })
  }
})
