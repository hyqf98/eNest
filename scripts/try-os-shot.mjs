#!/usr/bin/env node
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const shots = join(root, 'e2e-artifacts', 'try-connect')
const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, ENEST_E2E: '1' },
  timeout: 60000
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2000)
await page.evaluate(async () => {
  const api = window.enestShell
  await api.installMarketPlugin('com.enest.ssh')
  await api.installMarketPlugin('com.enest.database')
  await api.openPlugin('com.enest.ssh')
})
await page.waitForTimeout(2500)
try {
  await page.locator('text=SSH管理').first().click({ timeout: 3000 })
} catch {}
await page.waitForTimeout(3000)
const out = join(shots, '04-os-screen-ssh.png')
try {
  // macOS 全屏截当前聚焦窗口区域不够准；用系统截整个屏幕
  execFileSync('screencapture', ['-x', out])
  console.log('os screenshot', out)
} catch (e) {
  console.log('screencapture failed', e.message)
}
// 插件页 CDP：Electron 可能暴露多个 target
try {
  const port = app.process && process.env.E2E_CDP
} catch {}
await app.close()
console.log('done')
