import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright-core'

const enabled = process.env.ENEST_SHORTCUT_UI_SMOKE === '1'
const root = fileURLToPath(new URL('../../../', import.meta.url))

test('shortcut settings browser flow: recording, conflicts, edits, persistence and cleanup', { skip: !enabled, timeout: 90_000 }, async () => {
  const executablePath = process.env.ENEST_CHROME_PATH || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'
  ].find(existsSync)
  assert.ok(executablePath, 'Set ENEST_CHROME_PATH to a Chromium executable')
  const server = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), plugins: [react()],
    resolve: { alias: Object.fromEntries(['renderer', 'shared', 'preload', 'main'].map(name => [`@${name}`, path.join(root, 'src', name)])) },
    server: { host: '127.0.0.1', port: 5189, strictPort: true }, logLevel: 'warn' })
  await server.listen()
  const browser = await chromium.launch({ executablePath, headless: true })
  const errors = []
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      if (sessionStorage.getItem('shortcut-fixture')) return
      localStorage.setItem('enest.installed.v1', JSON.stringify(['com.enest.translate', 'com.enest.clipboard']))
      localStorage.setItem('enest.settings.v1', JSON.stringify({ general: { locale: 'zh-CN', animationLevel: 'low', tabStyle: 'classic' }, quick: { enabled: false } }))
      sessionStorage.setItem('shortcut-fixture', '1')
    })
    await page.goto('http://127.0.0.1:5189/')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '快捷键', exact: true }).click()
    const blocked = await page.evaluate(async () => {
      const { shellApi } = await import('/services/shellApi.ts')
      const results = []
      for (const patch of [{ pluginShortcuts: [] }, { pluginLaunch: {} }, { quick: { enabled: true } }]) {
        try { await shellApi.setSettings(patch); results.push(false) } catch { results.push(true) }
      }
      return results
    })
    assert.deepEqual(blocked, [true, true, true], 'generic settings cannot bypass shortcut validation')
    const section = page.getByRole('region', { name: '插件快捷键', exact: true })
    await section.getByRole('button', { name: '新增绑定' }).click()
    const editor = page.getByRole('form', { name: '新增插件快捷键' })
    await editor.getByRole('combobox', { name: '绑定插件' }).selectOption('com.enest.translate')
    await editor.getByRole('button', { name: '录制', exact: true }).click()
    await page.getByText('请按组合键 · Esc 取消 · 30 秒内有效', { exact: true }).waitFor()
    await page.keyboard.press('Control+Shift+K')
    await editor.getByRole('textbox', { name: '插件快捷键组合' }).filter({ visible: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-label="插件快捷键组合"]')?.value === 'Control+Shift+K')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await section.locator('.shortcut-binding').first().waitFor()
    assert.equal(await section.locator('.shortcut-binding').count(), 1)
    assert.match(await section.locator('.shortcut-binding').innerText(), /浏览器预览无法注册系统快捷键/)

    await section.getByRole('button', { name: '新增绑定' }).click()
    await editor.getByRole('combobox', { name: '绑定插件' }).selectOption('com.enest.translate')
    await editor.getByRole('textbox', { name: '插件快捷键组合' }).fill('Ctrl+Shift+K')
    await editor.getByRole('combobox', { name: '启动位置' }).selectOption('shell')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.getByRole('alert').filter({ hasText: '请换一个组合键' }).waitFor()
    assert.equal(await section.locator('.shortcut-binding').count(), 1)
    await editor.getByRole('textbox', { name: '插件快捷键组合' }).fill('Alt+Shift+J')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.shortcut-binding').length === 2)

    await section.locator('.shortcut-binding').last().getByRole('button', { name: '编辑', exact: true }).click()
    const edit = page.getByRole('form', { name: '编辑插件快捷键' })
    await edit.getByRole('combobox', { name: '启动位置' }).selectOption('quick')
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await edit.waitFor({ state: 'detached' })
    assert.equal(await section.locator('.shortcut-plugin > span').last().innerText(), '小窗口')
    await section.locator('.shortcut-binding').last().getByRole('button', { name: /^关闭 / }).click()
    await section.locator('.shortcut-binding').last().getByText('已关闭', { exact: true }).waitFor()
    await section.locator('.shortcut-binding').last().getByRole('button', { name: '立即启动' }).click()
    await section.getByRole('alert').filter({ hasText: '浏览器预览不支持原生窗口启动' }).waitFor()

    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '快捷键', exact: true }).click()
    await section.locator('.shortcut-binding').nth(1).waitFor()
    assert.equal(await section.locator('.shortcut-binding').count(), 2)
    await section.getByRole('combobox', { name: '筛选插件' }).selectOption('com.enest.clipboard')
    await section.getByText('此插件还没有快捷键', { exact: true }).waitFor()
    await section.getByRole('button', { name: '显示全部' }).click()
    await page.screenshot({ path: '/tmp/enest-shortcuts-settings-wide.png', fullPage: true })
    await page.setViewportSize({ width: 800, height: 900 })
    await section.getByRole('button', { name: '新增绑定' }).click()
    await editor.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/enest-shortcuts-settings-narrow.png', fullPage: true })
    const overflows = await page.evaluate(() => [...document.querySelectorAll('.shortcut-editor, .shortcut-binding-main, .quick-custom-shortcut')].filter(element => element.scrollWidth > element.clientWidth + 2).map(element => element.className))
    assert.deepEqual(overflows, [], 'settings fields must fit compact windows')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await section.locator('.shortcut-binding').last().getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.shortcut-binding').length === 1)
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log('Browser screenshots: /tmp/enest-shortcuts-settings-wide.png and /tmp/enest-shortcuts-settings-narrow.png')
  } finally {
    await browser.close()
    await server.close()
  }
})
