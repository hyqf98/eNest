#!/usr/bin/env node
/** 点击插件 Tab 并截图，验证 WebContentsView 是否加载 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const shots = join(root, 'e2e-artifacts', 'try-connect')
mkdirSync(shots, { recursive: true })

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, ENEST_E2E: '1' },
  timeout: 60000
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)

await page.evaluate(async () => {
  const api = window.enestShell
  await api.installMarketPlugin('com.enest.ssh')
  await api.installMarketPlugin('com.enest.database')
  await api.openPlugin('com.enest.ssh')
  await api.openPlugin('com.enest.database')
})
await page.waitForTimeout(1500)

// 点击标题栏 Tab
for (const name of ['SSH管理', '数据库']) {
  const tab = page.locator(`text=${name}`).first()
  try {
    await tab.click({ timeout: 3000 })
    console.log('clicked tab', name)
  } catch (e) {
    console.log('click tab failed', name, e.message)
  }
  await page.waitForTimeout(2000)
  const file = join(shots, `03-tab-${name === 'SSH管理' ? 'ssh' : 'db'}.png`)
  await page.screenshot({ path: file })
  console.log('shot', file)
}

// 读取壳子可见文本
const text = await page.locator('body').innerText()
console.log('body after tab click:\n', text.slice(0, 600))
await app.close()
console.log('done')
