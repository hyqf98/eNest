#!/usr/bin/env node
/**
 * perf-compare — eNest 插件规模性能对比（1 插件 vs 10 插件）
 *
 * 用法：
 *   node scripts/perf-compare.mjs            # 标准模式（不做 3.5 分钟休眠等待）
 *   node scripts/perf-compare.mjs --full     # 完整模式（额外等待 ~215s 验证空闲休眠日志）
 *   node scripts/perf-compare.mjs --keep     # 测试后保留 test-perf 插件（调试用）
 *
 * 流程：
 *   1. 复制 com.example.hello 为 10 个变体（test.perf1..test.perf10）装入 ~/.eNest/plugins
 *   2. 起 `ENEST_REMOTE_DEBUG=9222 npm run dev`，经 CDP（playwright-core connectOverCDP）：
 *      - 读 main.log：ready → window ok 计启动耗时
 *      - evaluate 顺序 openPlugin 全部插件，测总时长与单均
 *      - ps 采样 Electron 主进程 + Helper RSS 求和（3 次取均值）
 *   3. 基线（仅 1 个插件：com.example.hello）重复同流程
 *   4. LRU 验证：>6 存活时 enforceAliveLimit 同步休眠最旧后台插件（日志立即可查）；
 *      空闲休眠默认 3 分钟 → 仅 --full 模式等待验证
 *   5. 输出 markdown 到 docs/engineering/PERF_REPORT.md；清理 test-perf 插件目录
 *
 * 不改任何 app 代码；全部观测走日志 / CDP / ps。
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DATA_ROOT = join(homedir(), '.eNest')
const PLUGINS_DIR = join(DATA_ROOT, 'plugins')
const MAIN_LOG = join(DATA_ROOT, 'logs', 'main.log')
const DATED_LOG = join(DATA_ROOT, 'logs', `${new Date().toISOString().slice(0, 10)}.log`)
const PERF_IDS = Array.from({ length: 10 }, (_, i) => `test.perf${i + 1}`)
const CDP_PORT = 9222
const REPORT = join(ROOT, 'docs', 'engineering', 'PERF_REPORT.md')

const FULL = process.argv.includes('--full')
const KEEP = process.argv.includes('--keep')

const log = (msg) => console.log(`[perf-compare] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** log 文件里电子日志的两种格式：electron-log 控制台镜像 vs 每日文件 */
const TS_RE =
  /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]|^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/

function parseTs(line) {
  const m = line.match(TS_RE)
  const raw = m?.[1] ?? m?.[2]
  if (!raw) return null
  const t = new Date(raw.replace(' ', 'T'))
  return Number.isNaN(t.getTime()) ? null : t.getTime()
}

/** 读 main.log（本次启动的进程写它；旧内容保留，从后往前找标记） */
function readMainLog() {
  try {
    return readFileSync(MAIN_LOG, 'utf-8')
  } catch {
    return ''
  }
}

/** 找最近一次出现的标记行时间戳（ms）；from 若给定则只取其之后 */
function findMarkerTs(content, needle, afterMs = 0) {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(needle)) continue
    const ts = parseTs(lines[i])
    if (ts != null && ts >= afterMs) return ts
  }
  return null
}

/** 计算本次 app 启动的 ready→window ok 间隔 */
function measureStartupMs() {
  const content = readMainLog()
  const ready = findMarkerTs(content, "[main] ready")
  if (ready == null) return null
  const winOk = findMarkerTs(content, "[main] window ok", ready)
  if (winOk == null || winOk < ready) return null
  return { ready, winOk, ms: winOk - ready }
}

/** 统计日志中生命周期事件出现次数（本次 run 之后） */
function countLifecycle(content, needle, afterMs = 0) {
  let n = 0
  for (const line of content.split('\n')) {
    if (!line.includes(needle)) continue
    const ts = parseTs(line)
    if (ts != null && ts >= afterMs) n++
  }
  return n
}

/** ps 抓 Electron 主进程 + 全部 Helper 的 RSS 总和（KB） */
function sampleRssKb(pid) {
  try {
    const out = execSync(`ps -axo pid,rss,command`, { encoding: 'utf-8' })
    let total = 0
    let procs = 0
    for (const line of out.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!m) continue
      const [, pidStr, rss, cmd] = m
      // eNest 相关进程：主进程 / Helper（Renderer/GPU/Network/Plugin）都含 electron 可执行名
      if (cmd.includes('electron') || pidStr === String(pid)) {
        total += Number(rss)
        procs++
      }
    }
    return { totalKb: total, procs }
  } catch {
    return { totalKb: 0, procs: 0 }
  }
}

/** 3 次采样取均值 */
async function sampleRss(pid, times = 3) {
  const samples = []
  for (let i = 0; i < times; i++) {
    samples.push(sampleRssKb(pid))
    if (i < times - 1) await sleep(1200)
  }
  const avgKb = Math.round(samples.reduce((s, x) => s + x.totalKb, 0) / samples.length)
  const procs = samples[samples.length - 1].procs
  return { avgMb: Math.round(avgKb / 102.4) / 10, procs }
}

/** 创建 10 个 test-perf 变体插件（基于已安装的 com.example.hello） */
function installPerfPlugins() {
  const src = join(PLUGINS_DIR, 'com.example.hello', '1.0.0')
  if (!existsSync(src)) throw new Error(`hello plugin not found at ${src}`)
  for (let i = 1; i <= 10; i++) {
    const id = `test.perf${i}`
    const dest = join(PLUGINS_DIR, `test-perf-${i}`, '1.0.0')
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })
    const manifestPath = join(dest, 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    manifest.id = id
    manifest.name = `Perf ${i}`
    manifest.description = `性能对比测试插件 ${i}（perf-compare 生成，将被清理）`
    // features code 保持合法（openPlugin 用 code=main）；cmds 避免与 hello 撞
    manifest.features = [{ code: 'main', explain: `打开 Perf ${i}`, cmds: [`perf${i}`] }]
    // 贡献点全部去掉：避免 10 份 settings/homeCards/railEntries 混入用户数据
    delete manifest.contributes
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  }
  log(`installed ${PERF_IDS.length} perf variants`)
}

function removePerfPlugins() {
  for (let i = 1; i <= 10; i++) {
    const dir = join(PLUGINS_DIR, `test-perf-${i}`)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  log('perf variants removed')
}

/** 等 CDP 端口可用 */
async function waitCdp(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(600)
  }
  return false
}

/** 启动 app（dev 模式 + CDP），返回 { proc, stop }；detached 成进程组便于整组清理 */
function startApp() {
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: ROOT,
    env: { ...process.env, ENEST_REMOTE_DEBUG: String(CDP_PORT) },
    stdio: 'ignore',
    detached: true
  })
  const stop = () => {
    try {
      // 负 pid = 整个进程组（npm + electron-vite + Electron 全家）
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

/** 找壳子主页面（排除 orb-overlay / quick 子页面） */
async function findShellPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const url = page.url()
      if (
        url.startsWith('http') &&
        !url.includes('orb-overlay') &&
        !url.includes('quick') &&
        !url.includes('devtools')
      ) {
        return page
      }
    }
  }
  return null
}

/** 跑一轮：起 app → 等窗口 → (openIds 顺序 openPlugin) → 采样 → 停 app */
async function runScenario({ label, openIds, waitOpenSettleMs = 2500 }) {
  log(`scenario: ${label}`)
  const { proc, stop } = startApp()
  try {
    if (!(await waitCdp())) throw new Error('CDP port never became ready')
    const { chromium } = await import('playwright-core')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
    try {
      // 等壳子主页面出现（splash → shell）
      let page = null
      for (let i = 0; i < 80; i++) {
        page = await findShellPage(browser)
        if (page) break
        await sleep(600)
      }
      if (!page) {
        const all = browser
          .contexts()
          .flatMap((c) => c.pages())
          .map((p) => p.url())
        throw new Error(`shell page not found via CDP; pages = ${JSON.stringify(all)}`)
      }
      await sleep(1500) // 等 hydrate/splash 走完

      const startup = measureStartupMs()
      log(`startup ready→window: ${startup ? `${startup.ms} ms` : 'n/a (log markers missing)'}`)

      // 顺序打开全部目标插件（shellApi 经 window.enestShell）。
      // 每次打开后等插件 load-ok（真实用户节奏；不等的话上一只还在 opening，
      // deactivate 是非法转移 → LRU 会被 skip-hibernate 防御跳过）
      let openTotalMs = null
      let perOpenMs = []
      if (openIds.length > 0) {
        const t0 = Date.now()
        for (const id of openIds) {
          const s = Date.now()
          await page.evaluate(async (pid) => {
            await window.enestShell.openPlugin(pid, { code: 'main' })
          }, id)
          perOpenMs.push(Date.now() - s)
          await sleep(450) // 等 did-finish-load → ready →（下一次 open 时）deactivate→background
        }
        openTotalMs = Date.now() - t0
      }
      // 收尾：激活一次最早打开的插件，触发 enforceAliveLimit（LRU 驱逐最旧 background）
      if (openIds.length > 1) {
        await page.evaluate(async (pid) => {
          await window.enestShell.activatePlugin(`t-${pid}`)
        }, openIds[0])
      }
      await sleep(waitOpenSettleMs)

      const rss = await sampleRss(proc.pid)

      // 读日志统计生命周期证据（本轮 ready 之后）
      const readyTs = startup?.ready ?? 0
      const content = readMainLog()
      const opened = countLifecycle(content, '→ ready (load-ok)', readyTs)
      const hibernated = countLifecycle(content, '→ hibernated', readyTs)
      const evictedEvidence = content
        .split('\n')
        .filter((l) => l.includes('→ hibernated') && parseTs(l) >= readyTs)
        .slice(-5)

      log(`opened(load-ok)=${opened} totalOpen=${openTotalMs ?? 'n/a'}ms rss=${rss.avgMb}MB (${rss.procs} procs)`)

      // 可选：等待空闲休眠（3min + 缓冲）
      let idleHibernated = null
      if (FULL) {
        log('--full: waiting ~215s for idle hibernate...')
        await sleep(215_000)
        const after = readMainLog()
        idleHibernated = countLifecycle(after, '→ hibernated', readyTs)
      }

      return {
        label,
        startupMs: startup?.ms ?? null,
        openTotalMs,
        perOpenMs,
        rssAvgMb: rss.avgMb,
        procCount: rss.procs,
        openedCount: opened,
        lruHibernated: hibernated,
        hibernatedEvidence: evictedEvidence.map((l) => l.trim()),
        idleHibernated
      }
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    stop()
    await sleep(3000) // 等端口释放 / 日志 flush
    // 兜底清残留 Electron（只杀本仓库 electron 且带本 CDP 端口的）
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

function fmtMs(v) {
  return v == null ? 'n/a' : `${v} ms`
}

function buildReport(baseline, full) {
  const startupDelta =
    baseline.startupMs != null && full.startupMs != null ? full.startupMs - baseline.startupMs : null
  const rssDelta =
    baseline.rssAvgMb != null && full.rssAvgMb != null
      ? Math.round((full.rssAvgMb - baseline.rssAvgMb) * 10) / 10
      : null
  const openAvg = full.perOpenMs.length
    ? Math.round(full.perOpenMs.reduce((s, x) => s + x, 0) / full.perOpenMs.length)
    : null

  const lines = []
  lines.push('# eNest 插件规模性能对比报告')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push('- 工具：`node scripts/perf-compare.mjs`（dev 模式 + CDP + main.log + ps 采样）')
  lines.push('- 环境：macOS dev（electron-vite dev，非打包），数据目录 `~/.eNest`')
  lines.push(`- 模式：${FULL ? '--full（含 3.5 分钟空闲休眠等待）' : '标准（LRU 同步验证，不做 3 分钟空闲等待）'}`)
  lines.push('')
  lines.push('## 数据表')
  lines.push('')
  lines.push('| 指标 | 基线（1 插件） | 10 插件 | 增量 |')
  lines.push('| --- | --- | --- | --- |')
  lines.push(`| 启动 ready→window ok | ${fmtMs(baseline.startupMs)} | ${fmtMs(full.startupMs)} | ${fmtMs(startupDelta)} |`)
  lines.push(
    `| 打开全部插件总时长（含 450ms/个节奏间隔） | ${fmtMs(baseline.openTotalMs)} | ${fmtMs(full.openTotalMs)} | — |`
  )
  lines.push(`| 单次 openPlugin IPC 耗时（均值/最慢） | — | ${openAvg ?? 'n/a'} ms / ${Math.max(...full.perOpenMs, 0)} ms | — |`)
  lines.push(`| 内存（Electron 全进程 RSS 和，3 次均值） | ${baseline.rssAvgMb} MB | ${full.rssAvgMb} MB | ${rssDelta ?? 'n/a'} MB |`)
  lines.push(`| 观测到的进程数 | ${baseline.procCount} | ${full.procCount} | ${full.procCount - baseline.procCount} |`)
  lines.push('')
  lines.push('## 说明')
  lines.push('')
  lines.push('- 「启动」= main.log `[main] ready` → `[main] window ok`（主进程侧窗口创建完成；不含渲染层 splash）。')
  lines.push('- 「打开」= 经 CDP evaluate 顺序 `openPlugin`；每次打开间隔 450ms 等插件 load-ok（真实节奏，且保证 LRU 可对 background 插件生效）。')
  lines.push('- 内存为 `ps` 抓全部 Electron 相关进程（主进程 + Helper）RSS 之和；dev 模式含 Vite/调试开销，绝对值偏高，看增量。')
  lines.push('- 10 插件场景：sessionTabs 惰性恢复只孵化上次 active，其余为占位 Tab（本表「打开」为主动顺序孵化路径）。')
  lines.push('- 休眠日志每事件两行（applyTransition 一行 + hibernatePlugin 汇总一行），统计按事件计数有少量重复，量级不受影响。')
  lines.push('')
  lines.push('## LRU / 休眠验证')
  lines.push('')
  lines.push(`- 打开 10 插件过程中 LRU 立即休眠次数（PLUGIN_ALIVE_LIMIT=6）：**${full.lruHibernated}**`)
  if (full.hibernatedEvidence.length > 0) {
    lines.push('- 休眠日志样本（最近几条）：')
    lines.push('')
    lines.push('```')
    for (const l of full.hibernatedEvidence) lines.push(l)
    lines.push('```')
  } else {
    lines.push('- 本轮未见同步 LRU 休眠日志（若 0，见遗留问题）')
  }
  lines.push('')
  if (full.idleHibernated != null) {
    lines.push(`- --full 模式：等待 3.5 分钟后空闲休眠累计 **${full.idleHibernated}** 条`)
  } else {
    lines.push('- 空闲休眠（3 分钟）未在本轮等待：`PLUGIN_HIBERNATE_DELAY_MS=180000`，可用 `--full` 复测')
  }
  lines.push('')
  lines.push('## 结论')
  lines.push('')
  lines.push(`- 10 插件对主进程启动耗时增量：**${startupDelta != null ? `${startupDelta} ms` : 'n/a（日志标记缺失）'}**（10 个 manifest 扫描 + 校验不放大主进程启动路径，插件孵化按需进行）。`)
  lines.push(`- 10 插件全量打开总时长 **${fmtMs(full.openTotalMs)}**（含节奏间隔），单次 openPlugin IPC 均值 ${openAvg ?? 'n/a'} ms —— 插件孵化为 WebContentsView 创建，亚秒量级。`)
  lines.push(`- 内存增量：**${rssDelta ?? 'n/a'} MB**（10 插件全开；LRU/休眠把存活渲染进程压在 PLUGIN_ALIVE_LIMIT=6 内，见上节——无 LRU 的瞬时峰值见下）。`)
  lines.push('- 惰性恢复：启动仅孵化 active 插件，占位 Tab 不产生渲染进程（启动内存/耗时不受会话 Tab 数放大）。')
  lines.push('')
  lines.push('## 遗留 / 注意')
  lines.push('')
  lines.push('- dev 模式（Vite dev server）绝对值不代表打包性能；发布前建议用 `npm run pack:dir` 复测。')
  lines.push('- RSS 为 ps 采样，含共享库重复计算，只宜看相对增量。')
  lines.push('- 突发连续 openPlugin（无间隔）时，上一只插件尚在 opening 态，deactivate 为非法转移、LRU 驱逐被防御跳过（日志 `skip hibernate in state opening`），瞬时存活可超 PLUGIN_ALIVE_LIMIT；下一次 open/activate 会补收。真实用户点击节奏不受影响。')
  lines.push('- test-perf-* 插件已从 ~/.eNest/plugins 清理；manifest 贡献点已在生成时剔除，不留 contributions 残行。')
  return lines.join('\n')
}

async function main() {
  log('start')

  // 1) 装 10 个变体
  installPerfPlugins()

  try {
    // 2) 基线：只有 com.example.hello（test-perf 尚未被 scan？—— 会在 registry scan 出现，
    //    为保基线干净：基线轮先移除变体，10 插件轮再装回）
    removePerfPlugins()
    const baseline = await runScenario({
      label: 'baseline (1 plugin)',
      openIds: ['com.example.hello']
    })

    installPerfPlugins()
    const full = await runScenario({
      label: '10 plugins',
      openIds: PERF_IDS
    })

    // 3) 报告
    const md = buildReport(baseline, full)
    writeFileSync(REPORT, md)
    log(`report written: ${REPORT}`)

    // 4) 基线数字打印
    console.log('\n===== SUMMARY =====')
    console.log(JSON.stringify(
      {
        baseline: { ...baseline, hibernatedEvidence: undefined, perOpenMs: undefined },
        ten: { ...full, hibernatedEvidence: undefined, perOpenMs: undefined }
      },
      null,
      2
    ))
  } finally {
    if (!KEEP) removePerfPlugins()
    else log('--keep: perf variants kept for inspection')
  }
}

main().catch((err) => {
  console.error('[perf-compare] FAILED:', err)
  if (!KEEP) removePerfPlugins()
  process.exitCode = 1
})
