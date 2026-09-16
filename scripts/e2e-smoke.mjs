/**
 * eNest 冒烟自动化：用 Playwright 驱动 Electron。
 * 用法：npm run build && npm run e2e:smoke
 */
import { _electron as electron } from 'playwright-core'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'e2e-artifacts')

async function main() {
  await mkdir(shots, { recursive: true })

  const app = await electron.launch({
    args: [root, '--remote-debugging-port=0'],
    cwd: root,
    env: {
      ...process.env,
      ENEST_E2E: '1'
    }
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)

  const title = await page.title()
  console.log('[e2e] title:', title)

  // 市场首页关键节点
  const hasHero = await page.locator('text=发现最佳').count()
  console.log('[e2e] hero found:', hasHero > 0)

  await page.screenshot({ path: join(shots, '01-home.png') })

  // 点击第一张卡片或精选打开插件
  const openBtn = page.locator('button', { hasText: /^打开$|^安装$/ }).first()
  if (await openBtn.count()) {
    await openBtn.click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(shots, '02-plugin.png') })
    console.log('[e2e] opened plugin via first action button')
  }

  // 设置页
  const settings = page.locator('#btn-settings, [title="设置"]').first()
  if (await settings.count()) {
    await settings.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(shots, '03-settings.png') })
    console.log('[e2e] settings page ok')
  }

  await app.close()
  console.log('[e2e] smoke passed')
}

main().catch((err) => {
  console.error('[e2e] failed:', err)
  process.exit(1)
})
