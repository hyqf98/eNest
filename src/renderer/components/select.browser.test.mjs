import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const enabled = process.env.ENEST_SETTINGS_UI_SMOKE === '1'
const root = process.cwd()

test('settings controls: keyboard selection, disabled options, focus and viewport-safe color/list popovers', { skip: !enabled, timeout: 60_000 }, async () => {
  const executablePath = process.env.ENEST_CHROME_PATH || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync)
  assert.ok(executablePath)
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), plugins: [react(), {
    name: 'settings-controls-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/controls.html') return next()
        const html = await server.transformIndexHtml('/controls.html', `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="fixture"></div><script type="module">
          import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
          import { Select } from '/components/Select.tsx'; import { ColorPickerField } from '/components/ColorPickerField.tsx';
          import '/styles/tokens.css'; import '/styles/app.css'; import '/styles/settings.css';
          function Fixture() { const [value,setValue]=useState('alpha'); const [color,setColor]=useState('#49a988');
            return React.createElement('div',{className:'page-settings', style:{position:'absolute',left:20,bottom:20,width:320,overflow:'hidden',transform:'translateZ(0)'}},
              React.createElement(Select,{ariaLabel:'Keyboard select', value, onChange:setValue, options:[{value:'alpha',label:'Alpha'},{value:'beta',label:'Beta',disabled:true},{value:'gamma',label:'Gamma'}]}),
              React.createElement(Select,{ariaLabel:'Disabled select', value:'alpha', disabled:true, onChange:setValue, options:[{value:'alpha',label:'Alpha'}]}),
              React.createElement(ColorPickerField,{label:'Fixture',value:color,onChange:setColor}),
              React.createElement('input',{'aria-label':'Next field'}),React.createElement('output',{id:'value'},value),React.createElement('output',{id:'color'},color))
          } createRoot(document.getElementById('fixture')).render(React.createElement(Fixture));
        </script></body></html>`)
        res.setHeader('Content-Type', 'text/html'); res.end(html)
      })
    }
  }], resolve: { alias: Object.fromEntries(['renderer','shared','preload','main'].map(name => ['@'+name,path.join(root,'src',name)])) }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const errors=[]; page.on('pageerror', error=>errors.push(error.message))
  try {
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/controls.html')
    const trigger=page.getByRole('combobox',{name:'Keyboard select'})
    await trigger.focus(); await page.keyboard.press('ArrowDown')
    const list=page.getByRole('listbox',{name:'Keyboard select'});await list.waitFor()
    assert.equal(await list.evaluate(el=>el.parentElement===document.body),true)
    const triggerBox=await trigger.boundingBox(), listBox=await list.boundingBox()
    assert.ok(listBox.y>=12 && listBox.y+listBox.height<=600-12)
    assert.ok(listBox.y+listBox.height<=triggerBox.y, 'list flips above a clipped trigger near viewport bottom')
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter')
    assert.equal(await page.locator('#value').textContent(),'gamma','keyboard skips the disabled option')
    assert.equal(await trigger.evaluate(el=>document.activeElement===el),true)
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('Escape')
    assert.equal(await page.locator('#value').textContent(),'gamma','Escape preserves selection')
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('Enter')
    assert.equal(await page.locator('#value').textContent(),'alpha')
    await page.keyboard.press('g');await page.keyboard.press('Enter')
    assert.equal(await page.locator('#value').textContent(),'gamma','typeahead selects by label')
    assert.equal(await page.getByRole('combobox',{name:'Disabled select'}).isDisabled(),true)
    await trigger.click();await page.getByRole('option',{name:'Alpha',exact:true}).click()
    assert.equal(await page.locator('#value').textContent(),'alpha')
    assert.equal(await trigger.evaluate(el=>document.activeElement===el),true)
    await trigger.click();await page.keyboard.press('Tab');assert.equal(await list.count(),0)
    const color=page.getByRole('button',{name:'选择Fixture颜色'});await color.click()
    const dialog=page.getByRole('dialog',{name:'Fixture'});await dialog.waitFor()
    assert.equal(await dialog.evaluate(el=>el.parentElement===document.body),true)
    await dialog.getByRole('textbox',{name:'Fixture hex'}).fill('2266cc')
    assert.equal(await page.locator('#color').textContent(),'#2266cc')
    await page.keyboard.press('Escape');assert.equal(await dialog.count(),0)
    assert.equal(await color.evaluate(el=>document.activeElement===el),true)
    assert.deepEqual(errors,[])
  } finally { await browser.close();await server.close() }
})
