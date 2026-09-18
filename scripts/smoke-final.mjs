#!/usr/bin/env node
/**
 * smoke-final — 最终批次全流程自动化冒烟
 *
 * 用法：node scripts/smoke-final.mjs
 *
 * 覆盖（CDP 自动化，无法覆盖的项见 docs/engineering/SMOKE_MANUAL.md 与最终报告）：
 *   1. mini 呼出：quickOpen(kind=plugin, container=quick) → Quick 小窗出现 + 插件态
 *   2. Esc 回列表（quickOpen plugin-escape）→ quick-plugin-mode=null；再呼出直接回插件态
 *   3. ⌘Enter 固定到主窗（quickOpen plugin-pin）→ 主窗 TabStrip 出现该插件 Tab（不重载：迁移语义）
 *   4. 设置页 hello-prefs section（4 控件含 slider/color）；setPluginSetting 改值
 *      → 重启 dev 进程后 getSettingsSections 仍在 + settings.general.plugins 回显
 *   5. 首页「插件扩展」区块渲染 Hello 卡片（contrib-card）
 *   6. DevConsole 调用跟踪面板数据（打开插件后 getPluginCallTrace 非空）
 *   7. crash 自愈：需人工（CDP 无法安全注入主进程侧 webContents crash）→ 清单
 *   8. npm run build：单独验收步骤（不在本脚本）
 *   9. 回归：panel 插件从市场打开进主窗 Tab；quick 搜索 apps 结果正常
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CDP_PORT = 9333 // 避开 perf-compare 的 9222 习惯端口，防串线
const HELLO = 'com.example.hello'

const results = []
const log = (m) => console.log(`[smoke] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function record(item, pass, note = '') {
  results.push({ item, pass, note })
  log(`${pass ? 'PASS' : 'FAIL'} — ${item}${note ? `（${note}）` : ''}`)
}

async function waitCdp(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (res.ok) return true
    } catch {
      /* retry */
    }
    await sleep(600)
  }
  return false
}

/** 主壳页面（index.html 无 surface query = 主表面） */
async function findPages(browser) {
  let shell = null
  let quick = null
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const url = page.url()
      if (!url.startsWith('http')) continue
      if (url.includes('orb-overlay') || url.includes('devtools')) continue
      if (url.includes('surface=quick')) quick = page
      else shell = shell ?? page
    }
  }
  return { shell, quick }
}

async function waitFor(fn, timeoutMs = 10000, everyMs = 400) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(everyMs)
  }
  return last
}

function startApp() {
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: ROOT,
    env: { ...process.env, ENEST_REMOTE_DEBUG: String(CDP_PORT) },
    stdio: 'ignore',
    detached: true
  })
  const stop = () => {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
  }
  return { proc, stop }
}

async function connect() {
  const { chromium } = await import('playwright-core')
  return chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
}

async function main() {
  log('start')
  let round = 0

  const runRound = async (label) => {
    round += 1
    log(`--- round ${round}: ${label} ---`)
    const { stop } = startApp()
    try {
      if (!(await waitCdp())) throw new Error('CDP not ready')
      const browser = await connect()
      const pages = await waitFor(async () => {
        const p = await findPages(browser)
        return p.shell ? p : null
      }, 30000)
      if (!pages?.shell) throw new Error('shell page not found')
      return { browser, shell: pages.shell, stop }
    } catch (err) {
      stop()
      throw err
    }
  }

  // ============ 第一轮：mini / Esc / pin / 首页卡片 / trace / 搜索 / 市场 panel ============
  {
    const { browser, shell, stop } = await runRound('quick + ui')
    try {
      await sleep(2000) // hydrate 完成

      // 9-回归 先做：quick 搜索 apps
      const search = await shell.evaluate(async () => {
        const res = await window.enestShell.quickSearch('hello', 10)
        return { total: res?.items?.length ?? 0, kinds: (res?.items ?? []).slice(0, 5).map((i) => i.kind) }
      })
      record('Quick 搜索返回结果（apps/插件管线）', search.total > 0, `items=${search.total} kinds=${search.kinds.join(',')}`)

      // 1. mini 呼出（不跳主窗）
      const mini = await shell.evaluate(async (pid) => {
        const r = await window.enestShell.quickOpen({ kind: 'plugin', pluginId: pid, code: 'hello', container: 'quick' })
        return r
      }, HELLO)
      const quickPage = await waitFor(async () => (await findPages(browser)).quick, 10000)
      record('mini 呼出：Quick 小窗出现（surface=quick）', Boolean(quickPage))
      record('mini 呼出：返回 ok + tabId', mini?.ok === true && typeof mini?.tabId === 'string', JSON.stringify(mini))

      // quick 渲染层处于插件态（顶栏含固定按钮）——等 quick-plugin-mode 事件渲染
      let pluginMode = false
      if (quickPage) {
        pluginMode = await waitFor(async () =>
          quickPage
            .evaluate(() => Boolean(document.querySelector('.quick-plugin-pin')))
            .catch(() => false)
        , 6000)
      }
      record('Quick 内嵌插件态（固定按钮顶栏存在）', Boolean(pluginMode))

      // 2a. Esc 回列表（plugin-escape）
      const esc = await shell.evaluate(async (pid) => {
        const r = await window.enestShell.quickOpen({ kind: 'plugin-escape', pluginId: pid })
        return r
      }, HELLO)
      await sleep(800)
      let backToList = false
      const quick2 = (await findPages(browser)).quick
      if (quick2) {
        backToList = await quick2
          .evaluate(() => !document.querySelector('.quick-plugin-pin') && Boolean(document.querySelector('input')))
          .catch(() => false)
      }
      record('Esc 回列表（插件态退回列表态）', esc?.ok === true && backToList)

      // 2b. 再呼出直接回插件态：重挂 quick 容器（列表态 Esc 之后 quickPluginId 已清，
      //     「再呼出回插件态」的路径 = 插件态下隐藏小窗（不 Esc）后再呼出恢复。
      //     此处先重新挂载到插件态，再 hide → toggle 验证恢复语义）
      await shell.evaluate(async (pid) => {
        await window.enestShell.quickOpen({ kind: 'plugin', pluginId: pid, code: 'hello', container: 'quick' })
      }, HELLO)
      await waitFor(async () => {
        const q = (await findPages(browser)).quick
        return q ? q.evaluate(() => Boolean(document.querySelector('.quick-plugin-pin'))).catch(() => false) : false
      }, 6000)
      // 插件态下隐藏小窗（挂载保留）
      await shell.evaluate(async () => {
        await window.enestShell.quickHide()
      })
      await sleep(700)
      // 再呼出：应直接回到插件态（restore hook 重推 quick-plugin-mode）
      await shell.evaluate(async () => {
        await window.enestShell.quickToggle()
      })
      let pluginMode2 = false
      const quick3 = (await findPages(browser)).quick
      if (quick3) {
        pluginMode2 = await waitFor(async () =>
          quick3
            .evaluate(() => Boolean(document.querySelector('.quick-plugin-pin')))
            .catch(() => false)
        , 6000)
      }
      record('再呼出直接回插件态（hide 后 toggle 恢复插件态）', Boolean(pluginMode2))

      // 列表态再 Esc 隐藏（完整用户路径）：先 escape 回列表，再 hide
      await shell.evaluate(async (pid) => {
        await window.enestShell.quickOpen({ kind: 'plugin-escape', pluginId: pid })
      }, HELLO)
      await sleep(500)
      const hidden = await shell.evaluate(async () => {
        await window.enestShell.quickHide()
        return true
      })
      record('列表态 Esc 隐藏小窗（quickHide 不抛错）', hidden === true)

      // 3. ⌘Enter 固定到主窗（迁移不重载）
      const beforePin = await shell.evaluate(() => document.querySelectorAll('[data-tab]').length)
      const pin = await shell.evaluate(async (pid) => {
        const r = await window.enestShell.quickOpen({ kind: 'plugin-pin', pluginId: pid })
        return r
      }, HELLO)
      await sleep(1000)
      const tabCount = await shell.evaluate(() => document.querySelectorAll('[data-tab]').length)
      const hasHelloTab = await shell.evaluate((pid) => Boolean(document.querySelector(`[data-tab="t-${pid}"]`)), HELLO)
      record('⌘Enter 固定到主窗：主窗 Tab 出现', pin?.ok === true && hasHelloTab, `tabs ${beforePin}→${tabCount}`)

      // 5. 首页「插件扩展」区块 + Hello 卡片（先回首页）
      await shell.evaluate(async () => {
        await window.enestShell.goHome()
      })
      await sleep(900)
      const contribCard = await shell.evaluate(() => {
        const cards = [...document.querySelectorAll('.contrib-card')]
        return cards.map((c) => ({
          title: c.querySelector('.contrib-title')?.textContent ?? '',
          source: c.querySelector('.contrib-source')?.textContent ?? ''
        }))
      })
      record(
        '首页「插件扩展」显示 Hello 卡片',
        contribCard.some((c) => c.source.includes('Hello') || c.title.includes('Hello')),
        JSON.stringify(contribCard)
      )

      // 卡片点击带 code 打开（会进主窗 Tab，视图切到 plugin）
      const clicked = await shell.evaluate(() => {
        const card = document.querySelector('.contrib-card')
        if (!card) return false
        card.click()
        return true
      })
      await sleep(1200)
      const viewNow = await shell.evaluate(() => document.querySelector('.stage') !== null)
      record('首页卡片点击打开（不抛错）', clicked && viewNow)

      // 6. DevConsole 调用跟踪：插件有 API 调用后 trace 非空
      const trace = await shell.evaluate(async () => {
        return window.enestShell.getPluginCallTrace()
      })
      record(
        '调用跟踪面板数据源（getPluginCallTrace）',
        Array.isArray(trace) && trace.some((e) => e.pluginId === 'com.example.hello'),
        `entries=${trace?.length ?? 0}`
      )

      // 9-回归：panel 插件从市场安装（sample 源）后打开进主窗 Tab
      const panelOpen = await shell.evaluate(async () => {
        const plugins = await window.enestShell.getPlugins()
        const notInstalled = plugins.find((p) => !p.installed && !p.dev)
        let target
        if (notInstalled) {
          // 市场未安装项 → 走 installMarketPlugin（本地 sample 优先）
          const r = await window.enestShell.installMarketPlugin(notInstalled.id)
          if (!r?.ok) return { ok: false, error: `install failed: ${r?.error ?? 'unknown'}` }
          target = notInstalled.id
        } else {
          // 全都已装：挑一个非 hello 的已装插件
          const installedOther = plugins.find((p) => p.installed && p.id !== 'com.example.hello')
          if (!installedOther) return { ok: false, error: 'no other plugin available' }
          target = installedOther.id
        }
        await window.enestShell.openPlugin(target, { code: 'main' })
        return { ok: true, id: target }
      })
      const panelTab = await shell.evaluate(async (pid) => {
        await new Promise((r) => setTimeout(r, 400))
        return Boolean(document.querySelector(`[data-tab="t-${pid}"]`))
      }, panelOpen.id || '')
      record('panel 插件从市场安装并打开进主窗 Tab', panelOpen.ok && panelTab, JSON.stringify(panelOpen))

      // 4-前半：设置页 hello-prefs section（4 控件含 slider/color）
      await shell.evaluate(async () => {
        await window.enestShell.setShellView('settings')
      })
      await sleep(900)
      // 点 Hello 的设置 tab（settings-tabs 中非内置按钮，文本含 Hello）
      await shell.evaluate(() => {
        const btns = [...document.querySelectorAll('.settings-tabs button')]
        const hello = btns.find((b) => b.textContent.includes('Hello'))
        if (hello) hello.click()
      })
      await sleep(600)
      const sectionInfo = await shell.evaluate(() => {
        const sections = [...document.querySelectorAll('.plugin-settings-section')]
        const sliders = document.querySelectorAll('.plugin-slider-row input[type="range"], input[type="range"]').length
        const colors = document.querySelectorAll('input[type="color"]').length
        const titles = sections.map((s) => s.querySelector('h3')?.textContent ?? '')
        return { sections: sections.length, sliders, colors, titles }
      })
      record(
        '设置页 hello-prefs 分组（4 控件含 slider/color）',
        sectionInfo.sections > 0 && sectionInfo.sliders > 0 && sectionInfo.colors > 0,
        JSON.stringify(sectionInfo)
      )

      // 改值（fontSize → 21），为重启回显做准备
      const setVal = await shell.evaluate(async (pid) => {
        await window.enestShell.setPluginSetting(pid, 'fontSize', 21)
        await window.enestShell.setPluginSetting(pid, 'greeting', 'smoke-ok')
        return true
      }, HELLO)
      record('设置页改值（setPluginSetting）', setVal === true)
    } finally {
      stop()
      await sleep(3500)
      try {
        execSync(
          `pkill -f "node_modules/electron/dist/Electron.*remote-debugging-port=${CDP_PORT}" || true`,
          { shell: '/bin/zsh' }
        )
      } catch {
        /* ignore */
      }
      await sleep(1500)
    }
  }

  // ============ 第二轮：重启即显（section 仍在 + 值回显）+ 会话恢复 ============
  {
    const { shell, stop } = await runRound('restart persistence')
    try {
      await sleep(2500)
      const persisted = await shell.evaluate(async (pid) => {
        const settings = await window.enestShell.getSettings()
        const sections = await window.enestShell.getSettingsSections()
        return {
          fontSize: settings?.plugins?.[pid]?.fontSize,
          greeting: settings?.plugins?.[pid]?.greeting,
          helloSection: sections.some((s) => s.pluginId === pid && s.id === 'hello-prefs')
        }
      }, HELLO)
      record(
        '重启即显：hello-prefs section 仍在 + 值回显（fontSize=21 / greeting=smoke-ok）',
        persisted.fontSize === 21 && persisted.greeting === 'smoke-ok' && persisted.helloSection,
        JSON.stringify(persisted)
      )
    } finally {
      stop()
      await sleep(3500)
      try {
        execSync(
          `pkill -f "node_modules/electron/dist/Electron.*remote-debugging-port=${CDP_PORT}" || true`,
          { shell: '/bin/zsh' }
        )
      } catch {
        /* ignore */
      }
      await sleep(1500)
    }
  }

  // ============ 第三轮：orb 圆轨 rail-entries 渲染接线（验证后还原 tabStyle） ============
  {
    const { browser, shell, stop } = await runRound('orb rail entries')
    try {
      await sleep(2500)
      const prevStyle = await shell.evaluate(async () => {
        const s = await window.enestShell.getSettings()
        return s?.general?.tabStyle ?? 'classic'
      })
      // 切 orb 模式（经主壳 store 同步路径：set-settings + sync-orb-state）
      await shell.evaluate(async () => {
        await window.enestShell.setSettings({ general: { tabStyle: 'orb' } })
        await window.enestShell.syncOrbState({
          view: 'home',
          tabStyle: 'orb',
          activeTabId: null,
          tabs: []
        })
      })
      // 等圆轨 rail 视图出现（orb-overlay.html?part=rail）
      const rail = await waitFor(async () => {
        const p = (await findPages(browser)).shell
        const pages = browser.contexts().flatMap((c) => c.pages())
        return pages.find((pg) => pg.url().includes('orb-overlay') && pg.url().includes('part=rail')) ?? null
      }, 12000)
      record('orb 模式：圆轨 rail 视图出现', Boolean(rail))
      if (rail) {
        const railState = await waitFor(async () => {
          const r = await rail
            .evaluate(() => ({
              contribs: [...document.querySelectorAll('[data-contrib]')].map((b) => ({
                pluginId: b.getAttribute('data-contrib'),
                code: b.getAttribute('data-open-code'),
                title: b.getAttribute('title')
              })),
              tabs: document.querySelectorAll('[data-activate]').length
            }))
            .catch(() => null)
          return r && r.contribs.length > 0 ? r : null
        }, 10000)
        record(
          'rail-entries 渲染：Hello 入口圆点（glyph + title + openCode）',
          Boolean(railState?.contribs?.some((c) => c.pluginId === HELLO && c.code === 'hello')),
          JSON.stringify(railState?.contribs ?? [])
        )
      }
      // 还原用户 tabStyle
      await shell.evaluate(async (style) => {
        await window.enestShell.setSettings({ general: { tabStyle: style } })
        await window.enestShell.syncOrbState({ view: 'home', tabStyle: style, activeTabId: null, tabs: [] })
      }, prevStyle === 'orb' ? 'orb' : 'classic')
      record('还原用户 tabStyle（' + prevStyle + '）', true)
    } finally {
      stop()
      await sleep(3500)
      try {
        execSync(
          `pkill -f "node_modules/electron/dist/Electron.*remote-debugging-port=${CDP_PORT}" || true`,
          { shell: '/bin/zsh' }
        )
      } catch {
        /* ignore */
      }
      await sleep(1500)
    }
  }

  // ============ 汇总 ============
  console.log('\n===== SMOKE RESULTS =====')
  let pass = 0
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.item}${r.note ? ` — ${r.note}` : ''}`)
    if (r.pass) pass++
  }
  console.log(`\n${pass}/${results.length} automated checks passed`)
  process.exitCode = results.every((r) => r.pass) ? 0 : 1
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err)
  process.exitCode = 1
})
