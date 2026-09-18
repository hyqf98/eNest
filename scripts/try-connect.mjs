#!/usr/bin/env node
/**
 * try-connect — 实机冒烟：启动 eNest + 宿主层连接能力探测
 * 用法：node scripts/try-connect.mjs
 */
import { _electron as electron } from 'playwright-core'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'
import net from 'node:net'

const root = join(import.meta.dirname, '..')
const shots = join(root, 'e2e-artifacts', 'try-connect')
mkdirSync(shots, { recursive: true })

const report = []
const ok = (item, note = '') => {
  report.push({ item, pass: true, note })
  console.log(`PASS  ${item}${note ? ` — ${note}` : ''}`)
}
const fail = (item, note = '') => {
  report.push({ item, pass: false, note })
  console.log(`FAIL  ${item}${note ? ` — ${note}` : ''}`)
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const t = setTimeout(() => {
      sock.destroy()
      resolve({ ok: false, note: `timeout ${host}:${port}` })
    }, timeoutMs)
    sock.on('connect', () => {
      clearTimeout(t)
      sock.end()
      resolve({ ok: true, note: `${host}:${port} open` })
    })
    sock.on('error', (e) => {
      clearTimeout(t)
      resolve({ ok: false, note: e.message })
    })
  })
}

function sshProbe(host, port, username) {
  return new Promise((resolve) => {
    const conn = new Client()
    const t = setTimeout(() => {
      conn.end()
      resolve({ ok: false, note: 'ssh handshake timeout' })
    }, 4000)
    conn
      .on('ready', () => {
        clearTimeout(t)
        conn.exec('echo enest-ssh-ok; uname -s', (_err, stream) => {
          let out = ''
          stream
            .on('data', (d) => {
              out += d.toString()
            })
            .on('close', () => {
              conn.end()
              resolve({ ok: true, note: out.trim().slice(0, 80) })
            })
        })
      })
      .on('error', (e) => {
        clearTimeout(t)
        resolve({ ok: false, note: e.message })
      })
      .connect({ host, port, username, readyTimeout: 3500, tryKeyboard: false })
  })
}

async function testSqlite() {
  const dir = mkdtempSync(join(tmpdir(), 'enest-db-'))
  const file = join(dir, 'smoke.sqlite')
  writeFileSync(file, '')
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  db.prepare('INSERT INTO users (name) VALUES (?)').run('enest')
  const row = db.prepare('SELECT id, name FROM users LIMIT 1').get()
  db.close()
  if (row && row.name === 'enest') ok('sqlite open+write+read', file)
  else fail('sqlite open+write+read', JSON.stringify(row))
  return file
}

async function testMysql() {
  const probe = await tcpProbe('127.0.0.1', 3306)
  if (!probe.ok) {
    fail('mysql tcp 3306', probe.note + '（本机无服务，跳过登录）')
    return
  }
  try {
    const mysql = await import('mysql2/promise')
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      port: 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      connectTimeout: 3000
    })
    const [[v]] = await conn.query('SELECT 1 AS ok')
    await conn.end()
    ok('mysql connect', `SELECT 1 → ${JSON.stringify(v)}`)
  } catch (e) {
    fail('mysql connect', e.message)
  }
}

async function testElectronUi() {
  let app
  try {
    app = await electron.launch({
      args: [root, '--remote-debugging-port=0'],
      cwd: root,
      env: { ...process.env, ENEST_E2E: '1' },
      timeout: 60000
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)
    const title = await page.title()
    ok('electron first window', title || '(no title)')
    await page.screenshot({ path: join(shots, '01-shell-home.png'), fullPage: false })

    // 尝试通过壳子安装并打开 SSH / 数据库插件（若渲染层暴露 shellApi）
    const installResult = await page.evaluate(async () => {
      const api = window.enestShell || window.eNestShell || window.shellApi
      const out = { hasApi: !!api, installed: [], opened: [], plugins: null }
      if (!api) return out
      for (const id of ['com.enest.ssh', 'com.enest.database']) {
        try {
          const r = await api.installMarketPlugin(id)
          out.installed.push({ id, ok: !!(r && (r.ok !== false)), mode: r?.mode, error: r?.error })
        } catch (e) {
          out.installed.push({ id, err: String(e.message || e) })
        }
        try {
          await api.openPlugin(id)
          out.opened.push(id)
        } catch (e) {
          out.opened.push(id + ':err:' + (e.message || e))
        }
      }
      try {
        out.plugins = await api.getPlugins()
      } catch {
        out.plugins = null
      }
      return out
    })
    console.log('[ui] shell api probe', JSON.stringify(installResult, null, 2))
    if (installResult.hasApi && installResult.installed.every((x) => x.ok || x.mode)) {
      ok('install ssh+database via enestShell', JSON.stringify(installResult.installed))
    } else if (installResult.hasApi) {
      fail('install ssh+database', JSON.stringify(installResult.installed))
    } else {
      fail('shellApi on window', '未找到 window.enestShell')
    }
    if (installResult.opened.length === 2) ok('openPlugin ssh+database', installResult.opened.join(','))

    await page.waitForTimeout(2000)
    await page.screenshot({ path: join(shots, '02-after-open-plugins.png') })

    const tabText = await page.locator('body').innerText().catch(() => '')
    console.log('[ui] body snippet:', tabText.slice(0, 400).replace(/\n/g, ' | '))
    if (tabText.includes('SSH') || tabText.includes('终端')) ok('shell shows SSH tab/text')
    else fail('shell shows SSH tab/text', '未在壳子文本中看到 SSH')
    if (tabText.includes('数据库') || tabText.includes('SQL')) ok('shell shows DB tab/text')
    else fail('shell shows DB tab/text', '未在壳子文本中看到数据库')

    // 主进程侧确认插件已安装（evaluate 跑在 Electron main）
    try {
      const mainInfo = await app.evaluate(async () => {
        // 尽力读取 userData 路径下的插件目录
        const { app } = await import('electron')
        const { readdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')
        const root = join(app.getPath('home'), '.eNest', 'plugins')
        const list = existsSync(root) ? readdirSync(root) : []
        return { dataRoot: root, plugins: list }
      })
      console.log('[main] installed plugins dir', mainInfo)
      if (mainInfo.plugins.includes('com.enest.ssh') && mainInfo.plugins.includes('com.enest.database')) {
        ok('plugins on disk ~/.eNest/plugins', mainInfo.plugins.join(','))
      } else {
        fail('plugins on disk ~/.eNest/plugins', JSON.stringify(mainInfo))
      }
    } catch (e) {
      fail('main process evaluate', e.message)
    }
  } catch (e) {
    fail('electron ui smoke', e.message)
  } finally {
    try {
      await app?.close()
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log('=== eNest try-connect ===')
  await testSqlite()
  const sshLocal = await sshProbe(
    process.env.SSH_HOST || '127.0.0.1',
    Number(process.env.SSH_PORT || 22),
    process.env.SSH_USER || process.env.USER || 'haijun'
  )
  if (sshLocal.ok) ok('ssh localhost', sshLocal.note)
  else fail('ssh localhost', sshLocal.note + '（常见：本机未开 Remote Login）')
  await testMysql()
  await testElectronUi()

  const pass = report.filter((r) => r.pass).length
  const total = report.length
  console.log(`\n=== result ${pass}/${total} PASS ===`)
  console.log('screenshots:', shots)
  writeFileSync(join(shots, 'report.json'), JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
