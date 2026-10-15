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

test('shortcut settings browser flow: installed plugin cards, recording, conflicts, persistence and cleanup', { skip: !enabled, timeout: 120_000 }, async () => {
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
    const translate = section.locator('.shortcut-plugin-group[data-plugin-id="com.enest.translate"]')
    const clipboard = section.locator('.shortcut-plugin-group[data-plugin-id="com.enest.clipboard"]')
    await translate.waitFor()
    await clipboard.waitFor()
    assert.equal(await section.locator('.shortcut-plugin-group').count(), 2, 'installed plugins appear before any shortcut exists')
    assert.equal(await section.getByRole('combobox').count(), 0, 'plugin selection does not use a dropdown')
    assert.equal(await clipboard.getByRole('button', { name: '启动', exact: true }).isEnabled(), true)
    const quick = page.getByRole('region', { name: 'Quick 呼出键', exact: true })
    const record = async (input, chord) => {
      await input.click()
      await input.locator('..').locator('..').getByRole('status').filter({ hasText: '正在录制' }).waitFor()
      await page.keyboard.press(chord)
      await input.locator('..').locator('..').getByRole('status').filter({ hasText: '点击重新录制' }).waitFor()
    }
    const snapshot = () => page.evaluate(async () => (await import('/services/shellApi.ts')).shellApi.getPluginShortcuts())
    const checkPresetCards = async () => {
      const cards = await quick.locator('.hotkey-card').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element)
        return { top: box.top, width: box.width, border: parseFloat(style.borderTopWidth), background: style.backgroundImage }
      }))
      assert.equal(cards.length, 3, 'both presets and custom shortcut keep their own card')
      assert.ok(cards.every(card => Math.abs(card.top - cards[0].top) < 2 && card.width > 0 && card.border > 0 && card.background !== 'none'), 'preset and custom cards retain matching surfaces on one row')
    }
    await checkPresetCards()
    await quick.locator('.hotkey-card').last().click()
    await record(quick.getByRole('textbox', { name: 'Quick 自定义快捷键' }), 'Alt+Shift+F8')
    await page.evaluate(async () => {
      const { shellApi } = await import('/services/shellApi.ts')
      const original = shellApi.quickSetHotkeys
      window.restoreQuickSetterFixture = () => { shellApi.quickSetHotkeys = original }
      shellApi.quickSetHotkeys = async patch => ({ ...(await shellApi.quickGetConfig()), ok: false, failed: [],
        error: '磁盘写入失败', probe: { accelerator: patch.activeHotkey, status: 'free' } })
    })
    await quick.getByRole('button', { name: '保存并选择', exact: true }).click()
    await quick.getByRole('alert').filter({ hasText: '磁盘写入失败' }).waitFor()
    await page.evaluate(async () => {
      const { shellApi } = await import('/services/shellApi.ts')
      const { token } = await shellApi.beginShortcutCapture()
      await shellApi.endShortcutCapture(token)
      window.restoreQuickSetterFixture()
      delete window.restoreQuickSetterFixture
    })
    await quick.getByRole('alert').filter({ hasText: '磁盘写入失败' }).waitFor()
    await quick.getByRole('button', { name: '保存并选择', exact: true }).click()
    await quick.locator('.hotkey-card').last().getByText('Alt + ⇧ + F8', { exact: true }).waitFor()
    await quick.getByRole('button', { name: '收起', exact: true }).click()

    await translate.getByRole('button', { name: '添加快捷键', exact: true }).click()
    const editor = page.getByRole('form', { name: '新增插件快捷键' })
    const input = editor.getByRole('textbox', { name: '插件快捷键组合' })
    assert.equal(await input.getAttribute('readonly'), '')
    assert.equal(await editor.getByRole('button', { name: '录制', exact: true }).count(), 0)
    await input.click()
    await editor.getByRole('status').filter({ hasText: '正在录制' }).waitFor()
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.down('K')
    assert.equal(await input.inputValue(), 'Ctrl + ⇧ + K', 'keydown previews the chord before release')
    assert.equal(await editor.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
    assert.equal((await snapshot()).bindings.length, 0, 'preview never commits a shortcut')
    await page.keyboard.up('K')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')
    await editor.locator('.shortcut-probe.is-free').waitFor()
    await page.evaluate(async () => {
      const { shellApi } = await import('/services/shellApi.ts')
      const original = shellApi.savePluginShortcut
      window.restorePluginSetterFixture = () => { shellApi.savePluginShortcut = original }
      shellApi.savePluginShortcut = async patch => ({ ok: false, error: '插件快捷键写入失败',
        probe: { accelerator: patch.accelerator, status: 'free' } })
    })
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.getByRole('alert').filter({ hasText: '插件快捷键写入失败' }).waitFor()
    assert.equal((await snapshot()).bindings.length, 0, 'failed persistence keeps the editor and existing configuration')
    await page.screenshot({ path: '/tmp/enest-shortcuts-save-failure.png', fullPage: true })
    await page.evaluate(() => { window.restorePluginSetterFixture(); delete window.restorePluginSetterFixture })
    await editor.locator('.shortcut-probe.is-free').waitFor()
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await section.locator('.shortcut-binding').first().waitFor()
    assert.equal(await section.locator('.shortcut-binding').count(), 1)
    assert.match(await section.locator('.shortcut-binding').innerText(), /浏览器预览无法注册系统快捷键/)

    await quick.locator('.hotkey-card').last().click()
    await record(quick.getByRole('textbox', { name: 'Quick 自定义快捷键' }), 'Control+Shift+K')
    await quick.getByRole('alert').filter({ hasText: '保存不会覆盖' }).waitFor()
    assert.equal(await quick.getByRole('button', { name: '确认覆盖并保存' }).count(), 0)
    await quick.getByRole('button', { name: '保存并选择', exact: true }).click()
    assert.equal((await snapshot()).bindings[0].enabled, true, 'saving disabled Quick does not take another owner')
    await quick.getByRole('button', { name: '收起', exact: true }).click()

    await translate.getByRole('button', { name: '添加快捷键', exact: true }).click()
    await record(input, 'Control+Shift+K')
    await editor.getByRole('radiogroup', { name: '启动位置' }).getByRole('radio', { name: '主窗口', exact: true }).click()
    await editor.getByRole('alert').filter({ hasText: '「翻译」' }).waitFor()
    assert.equal(await editor.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
    assert.equal(await section.locator('.shortcut-binding').count(), 1)
    assert.equal((await snapshot()).bindings[0].enabled, true, 'a conflict probe leaves its current owner untouched')
    await record(input, 'Alt+Shift+J')
    await editor.locator('.shortcut-probe.is-free').waitFor()
    await record(input, 'Control+Shift+K')
    await editor.getByRole('alert').filter({ hasText: '「翻译」' }).waitFor()
    await editor.getByRole('alert').filter({ hasText: '「翻译」' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/enest-shortcuts-conflict-confirm.png', fullPage: true })
    await editor.getByRole('button', { name: '确认覆盖并保存', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.shortcut-binding').length === 2)
    const replaced = await snapshot()
    assert.equal(replaced.bindings[0].enabled, false, 'confirmation retains and disables the former owner')
    assert.equal(replaced.bindings[1].enabled, true)
    assert.equal(replaced.bindings[0].accelerator, replaced.bindings[1].accelerator)

    await section.locator('.shortcut-binding').last().getByRole('button', { name: '编辑', exact: true }).click()
    const edit = page.getByRole('form', { name: '编辑插件快捷键' })
    await record(edit.getByRole('textbox', { name: '插件快捷键组合' }), 'Alt+Shift+J')
    await edit.getByRole('radiogroup', { name: '启动位置' }).getByRole('radio', { name: '小窗口', exact: true }).click()
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await edit.waitFor({ state: 'detached' })
    await translate.locator('.shortcut-binding').last().getByText('小窗口', { exact: true }).waitFor()
    await section.locator('.shortcut-binding').last().getByRole('button', { name: /^关闭 / }).click()
    await section.locator('.shortcut-binding').last().getByText('已关闭', { exact: true }).waitFor()
    await section.locator('.shortcut-binding').last().getByRole('button', { name: '立即启动' }).click()
    await section.getByRole('alert').filter({ hasText: '浏览器预览不支持原生窗口启动' }).waitFor()

    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '快捷键', exact: true }).click()
    await section.locator('.shortcut-binding').nth(1).waitFor()
    assert.equal(await section.locator('.shortcut-binding').count(), 2)
    await page.evaluate(async () => {
      const { useShellStore } = await import('/stores/shellStore.ts')
      useShellStore.getState().setShortcutPluginFilter('com.enest.clipboard')
    })
    await clipboard.waitFor()
    assert.equal(await section.locator('.shortcut-plugin-group').count(), 2, 'a detail-page target must not hide the other installed plugins')
    await page.screenshot({ path: '/tmp/enest-shortcuts-settings-wide.png', fullPage: true })
    await page.setViewportSize({ width: 800, height: 900 })
    await checkPresetCards()
    await quick.locator('.hotkey-card').last().click()
    await clipboard.getByRole('button', { name: '添加快捷键', exact: true }).click()
    await editor.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/enest-shortcuts-settings-narrow.png', fullPage: true })
    const overflows = await page.evaluate(() => [...document.querySelectorAll('.hotkey-cards, .shortcut-plugin-group, .shortcut-editor, .shortcut-binding-main, .quick-custom-shortcut')].filter(element => element.scrollWidth > element.clientWidth + 2).map(element => element.className))
    assert.deepEqual(overflows, [], 'settings fields must fit compact windows')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await section.locator('.shortcut-binding').last().getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.shortcut-binding').length === 1)
    await translate.locator('.shortcut-binding').getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.shortcut-binding').length === 0)
    assert.equal(await section.locator('.shortcut-plugin-group').count(), 2, 'deleting the last binding keeps the installed plugin card')

    await quick.getByRole('button', { name: '收起', exact: true }).click()
    await quick.getByRole('button', { name: '启用 Quick 呼出键', exact: true }).click()
    await clipboard.getByRole('button', { name: '添加快捷键', exact: true }).click()
    await record(input, 'Control+Shift+K')
    await editor.getByRole('alert').filter({ hasText: 'Quick 呼出键' }).waitFor()
    await editor.getByRole('button', { name: '确认覆盖并保存', exact: true }).click()
    await clipboard.locator('.shortcut-binding').waitFor()
    assert.equal(await quick.getByRole('button', { name: '启用 Quick 呼出键', exact: true }).getAttribute('aria-pressed'), 'false', 'confirmed plugin binding disables the previous Quick owner')
    await clipboard.locator('.shortcut-binding').getByRole('button', { name: '删除', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.shortcut-binding').length === 0)

    // A missing historical plugin is still shown so its stale binding can be removed.
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('enest.settings.v1'))
      settings.pluginShortcuts = [{ id: 'missing-fixture', pluginId: 'com.enest.missing', accelerator: 'Control+Shift+M', mode: 'quick', enabled: true }]
      localStorage.setItem('enest.settings.v1', JSON.stringify(settings))
    })
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('button', { name: '快捷键', exact: true }).click()
    const missing = section.locator('.shortcut-plugin-group[data-plugin-id="com.enest.missing"]')
    await missing.locator('.shortcut-binding').getByText('插件已移除', { exact: true }).waitFor()
    assert.equal(await missing.getByRole('button', { name: '立即启动', exact: true }).isDisabled(), true)
    await missing.getByRole('button', { name: '删除', exact: true }).click()
    await missing.waitFor({ state: 'detached' })
    assert.equal(await section.locator('.shortcut-plugin-group').count(), 2)
    await clipboard.getByRole('button', { name: '启动', exact: true }).click()
    await page.waitForFunction(async () => {
      const { useShellStore } = await import('/stores/shellStore.ts')
      const state = useShellStore.getState()
      return state.tabs.some(tab => tab.pluginId === 'com.enest.clipboard' && tab.id === state.activeTabId)
    })
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log('Browser screenshots: /tmp/enest-shortcuts-settings-wide.png and /tmp/enest-shortcuts-settings-narrow.png')
  } finally {
    await browser.close()
    await server.close()
  }
})
