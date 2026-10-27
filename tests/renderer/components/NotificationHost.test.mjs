import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const enabled = process.env.ENEST_NOTIFICATION_UI === '1'
test('notification HTML and Markdown stay inert; pause, keyboard close, bounded queue and reduced motion work in Chromium', { skip: !enabled, timeout: 30000 }, async () => {
  const output = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {NotificationHost} from '@renderer/components/NotificationHost';import {notify,notifyStore} from '@renderer/services/notifyService';import {sanitizeNotificationHtml} from '@renderer/services/notificationContent';window.testNotify=notify;window.testStore=notifyStore;window.testSanitize=sanitizeNotificationHtml;createRoot(document.getElementById('root')).render(React.createElement(NotificationHost));`, resolveDir: process.cwd(), loader: 'tsx' },
    tsconfig: 'tsconfig.web.json', bundle: true, write: false, outfile: 'test.js', platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'shell', setup(b) { b.onResolve({ filter: /^@renderer\/services\/shellApi$/ }, () => ({ path: 'shell', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const shellApi={systemNotify:async()=>{}}' })) } }]
  })
  const browser = await chromium.launch({ executablePath: process.env.ENEST_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, reducedMotion: 'reduce' })
    const requests = []
    page.on('request', request => requests.push(request.url()))
    await page.setContent(`<html data-theme="light"><style>${await readFile('src/renderer/styles/tokens.css', 'utf8')}\n${output.outputFiles.find(file => file.path.endsWith('.css')).text}</style><body><h1 style="font:24px system-ui;padding:30px;color:#666">eNest 通知验收</h1><div id="root"></div></body></html>`)
    await page.addScriptTag({ content: output.outputFiles.find(file => file.path.endsWith('.js')).text })
    const malicious = `<p onclick="window.__xss=1">完成 <strong style="position:fixed" id="host">安全内容</strong></p><script>window.__xss=2</script><img src="https://tracker.invalid/pixel" onerror="window.__xss=3"><iframe srcdoc="<script>parent.__xss=4</script>"></iframe><svg onload="window.__xss=5"><foreignObject><div>unsafe</div></foreignObject></svg><a href="javascript:alert(1)">危险链接</a><a href="https://example.com/help" style="color:red" target="_self">帮助文档</a>`
    await page.evaluate(body => window.testNotify.custom({ title: '安全 HTML', body, format: 'html', position: 'center', duration: 0 }), malicious)
    await page.locator('.notify-card').waitFor()
    const safety = await page.evaluate(() => ({ xss: window.__xss, forbidden: document.querySelectorAll('.notify-card script,.notify-card iframe,.notify-card img,.notify-card svg:not(.notify-symbol svg):not(.notify-close svg),.notify-rich [style],.notify-rich [onclick],.notify-rich [id]').length, links: [...document.querySelectorAll('.notify-rich a')].map(a => a.getAttribute('href')) }))
    assert.equal(safety.xss, undefined); assert.equal(safety.forbidden, 0)
    assert.deepEqual(safety.links, [null, 'https://example.com/help'])
    assert.equal(requests.length, 0)
    await page.evaluate(() => window.testNotify.custom({ title: '导入完成', body: '**成功 24 项**\n\n- 数据已写入本地\n- 可继续编辑\n\n`<img onerror=alert(1)>`', format: 'markdown', position: 'bottom-right', level: 'success', duration: 0 }))
    await page.locator('.notify-success strong').waitFor()
    assert.equal(await page.locator('.notify-success img').count(), 0)
    await page.screenshot({ path: '/tmp/enest-notification-light.png' })
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await page.screenshot({ path: '/tmp/enest-notification-dark.png' })
    await page.locator('.notify-host-center .notify-close').focus()
    await page.keyboard.press('Escape')
    await page.locator('.notify-host-center .notify-card').waitFor({ state: 'detached' })
    await page.locator('.notify-success .notify-close').click()
    await page.locator('.notify-card').waitFor({ state: 'detached' })
    await page.evaluate(() => window.testNotify.info('悬停暂停', { duration: 1500 }))
    const card = page.locator('.notify-card')
    await card.waitFor(); await card.hover(); await page.waitForTimeout(1700)
    assert.equal(await card.count(), 1)
    await page.mouse.move(10, 10); await card.waitFor({ state: 'detached', timeout: 2500 })
    await page.evaluate(() => { for (let i = 0; i < 12; i++) window.testNotify.info(`队列 ${i}`, { duration: 0 }) })
    assert.equal(await page.evaluate(() => window.testStore.getState().items.length), 8)
    assert.equal(await page.locator('.notify-card').count(), 3)
    await page.setViewportSize({ width: 390, height: 650 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  } finally { await browser.close() }
})
