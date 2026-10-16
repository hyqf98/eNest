import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { prepareDevElectron } from './devLauncher.mjs'

const enabled = process.platform === 'darwin' && process.env.ENEST_IDENTITY_SMOKE === '1'

test('macOS development bundle exposes eNest to the OS and preserves the Electron dependency', { skip: !enabled, timeout: 30_000 }, async (t) => {
  const require = createRequire(import.meta.url)
  const originalExecutable = require('electron')
  const originalBundle = dirname(dirname(dirname(originalExecutable)))
  const sourceFiles = ['Info.plist', 'Resources/electron.icns'].map((file) => join(originalBundle, 'Contents', file))
  const fingerprint = () => sourceFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'))
  const before = fingerprint()
  const executable = prepareDevElectron()
  assert.notEqual(executable, originalExecutable)
  assert.equal(prepareDevElectron(), executable, 'unchanged inputs reuse the prepared runtime')
  assert.deepEqual(fingerprint(), before, 'preparation must not patch node_modules')
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dirname(dirname(dirname(executable)))])

  const fixture = mkdtempSync(join(tmpdir(), 'enest-identity-'))
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'enest', main: 'main.cjs' }))
  writeFileSync(join(fixture, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    app.setName('eNest')
    app.setPath('userData', ${JSON.stringify(join(fixture, 'profile'))})
    app.whenReady().then(() => {
      const win = new BrowserWindow({ show: false, width: 240, height: 120 })
      console.log('IDENTITY:' + JSON.stringify({ name: app.getName(), isPackaged: app.isPackaged, defaultApp: process.defaultApp }))
    })
    process.on('SIGTERM', () => app.exit(0))
  `)
  const child = spawn(executable, [fixture], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    const identity = await new Promise((resolve, reject) => {
      let output = ''
      let errors = ''
      child.stderr.on('data', (chunk) => { errors += chunk })
      child.on('error', reject)
      child.on('exit', () => reject(new Error(`Fixture exited before identity was ready: ${errors}`)))
      child.stdout.on('data', (chunk) => {
        output += chunk
        const match = output.match(/IDENTITY:(.+)\n/)
        if (match) resolve(JSON.parse(match[1]))
      })
    })
    assert.deepEqual(identity, { name: 'eNest', isPackaged: false, defaultApp: true })
    // Query AppKit's process metadata: app.getName alone does not establish the Dock label.
    const native = JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
      ObjC.import('AppKit');
      var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid});
      JSON.stringify({ name: app.localizedName.js, bundleId: app.bundleIdentifier.js });
    `], { encoding: 'utf8' }))
    assert.deepEqual(native, { name: 'eNest', bundleId: 'com.github.eNest.shell.dev' })
    t.diagnostic(JSON.stringify({ electron: identity, native, executable, sourceDependencyUnchanged: true, signatureVerified: true, cacheReused: true }))
  } finally {
    child.kill('SIGTERM')
    await exited
    clearTimeout(killTimer)
    rmSync(fixture, { recursive: true, force: true })
  }
})
