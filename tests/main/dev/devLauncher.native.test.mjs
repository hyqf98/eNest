import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const enabled = process.platform === 'darwin' && process.env.ENEST_LAUNCHER_SMOKE === '1'
const processes = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).split('\n')
  .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
  .filter(Boolean).map((m) => ({ pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), command: m[4] }))
const descendants = (pid, all) => {
  const ids = new Set([pid])
  let previous
  do { previous = ids.size; for (const p of all) if (ids.has(p.parent)) ids.add(p.pid) } while (ids.size !== previous)
  return all.filter((p) => ids.has(p.pid))
}
async function waitUntil(probe, deadline = Date.now() + 25_000) {
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(100) }
  throw new Error('Native launcher lifecycle check timed out')
}

for (const signal of ['SIGTERM', 'SIGHUP']) {
  test(`npm dev releases Vite and Electron when only its launcher receives ${signal}`, { skip: !enabled, timeout: 40_000 }, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'enest-launcher-'))
    const reservation = createServer().listen(0, '127.0.0.1')
    await new Promise((resolve) => reservation.once('listening', resolve))
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    const npm = spawn('npm', ['run', 'dev'], {
      detached: true,
      env: { ...process.env, ENEST_TEST_USER_DATA: join(temp, 'profile'), ENEST_TEST_DATA_ROOT: join(temp, 'data'), ENEST_REMOTE_DEBUG: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    npm.stdout.on('data', (chunk) => { output += chunk })
    npm.stderr.on('data', (chunk) => { output += chunk })
    let owned = []
    try {
      owned = await waitUntil(async () => {
        const tree = descendants(npm.pid, processes())
        if (!tree.some((p) => p.command.includes('/eNest.app/Contents/MacOS/Electron'))) return undefined
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return tree } catch { /* still booting */ }
      })
      const launcher = owned.find((p) => /node .*src\/main\/dev\/devLauncher\.mjs dev/.test(p.command))
      const vite = owned.find((p) => p.parent === launcher?.pid && p.command.includes('electron-vite.js'))
      assert.ok(launcher, output)
      assert.ok(vite, output)
      assert.equal(vite.group, vite.pid, 'Vite owns an isolated process group')
      process.kill(launcher.pid, signal)
      await waitUntil(() => {
        const live = new Set(processes().map((p) => p.pid))
        return owned.every((p) => !live.has(p.pid))
      }, Date.now() + 6000)
      assert.equal(processes().filter((p) => p.group === vite.group).length, 0, 'no helper or renderer remains in the development process group')
    } catch (error) {
      throw new Error(`${error.message}\n${output}`, { cause: error })
    } finally {
      // Only this test's recorded processes/groups are eligible for cleanup.
      for (const p of owned) { try { process.kill(p.pid, 'SIGKILL') } catch {} }
      try { process.kill(-npm.pid, 'SIGKILL') } catch {}
      rmSync(temp, { recursive: true, force: true })
    }
  })
}
