/** Launch electron-vite with a branded macOS development bundle, without modifying dependencies. */
import { createHash } from 'node:crypto'
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const projectRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

export function prepareDevElectron(root = projectRoot) {
  if (process.platform !== 'darwin') return undefined
  const electronExecutable = require('electron')
  const sourceBundle = dirname(dirname(dirname(electronExecutable)))
  const sourcePlist = join(sourceBundle, 'Contents', 'Info.plist')
  const sourceIcon = join(root, 'build', 'icon.icns')
  // Keep each runtime immutable: an Electron upgrade or icon edit must not alter a running app.
  const revision = createHash('sha256')
    .update('enest-dev-bundle-v1')
    .update(electronExecutable)
    .update(readFileSync(sourcePlist))
    .update(readFileSync(sourceIcon))
    .digest('hex').slice(0, 16)
  const cacheRoot = join(root, '.cache', 'electron-dev')
  const revisionDir = join(cacheRoot, revision)
  const executable = join(revisionDir, 'eNest.app', 'Contents', 'MacOS', basename(electronExecutable))
  if (existsSync(executable)) return executable

  mkdirSync(cacheRoot, { recursive: true })
  const staging = mkdtempSync(join(cacheRoot, '.prepare-'))
  try {
    const bundle = join(staging, 'eNest.app')
    // APFS clone-on-write where supported; preserve Framework symlinks and executable modes.
    cpSync(sourceBundle, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    const plist = join(bundle, 'Contents', 'Info.plist')
    for (const [key, value] of Object.entries({
      CFBundleName: 'eNest',
      CFBundleDisplayName: 'eNest',
      CFBundleIdentifier: 'com.enest.shell.dev',
      CFBundleIconFile: 'enest.icns'
    })) execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist])
    copyFileSync(sourceIcon, join(bundle, 'Contents', 'Resources', 'enest.icns'))
    // Re-sign only the private copy after changing signed bundle resources.
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', bundle], { stdio: 'pipe' })
    try {
      renameSync(staging, revisionDir)
    } catch (error) {
      // A parallel npm run dev can finish preparing the same revision first.
      if (!existsSync(executable)) throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return executable
}

function launch() {
  const args = process.argv.slice(2)
  const debug = args.indexOf('--debug')
  if (debug !== -1) args.splice(debug, 1)
  const env = { ...process.env }
  if (debug !== -1) env.ENEST_REMOTE_DEBUG ||= '9331'
  env.ELECTRON_EXEC_PATH ||= prepareDevElectron() || ''
  const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
  // Vite spawns Electron itself. A separate POSIX process group lets an IDE stop
  // only this launcher PID while still releasing Electron and its global shortcuts.
  const grouped = process.platform !== 'win32'
  const child = spawn(process.execPath, [cli, ...args], { cwd: projectRoot, env, stdio: 'inherit', detached: grouped })
  let shutdownTimer
  const signalTree = (signal) => {
    if (!child.pid) return
    if (grouped) {
      try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    } else {
      // Node's child.kill on Windows only terminates Vite, leaving Electron alive.
      const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      taskkill.once('error', () => child.kill(signal))
    }
  }
  const ensureStopped = () => {
    if (!grouped || !child.pid || shutdownTimer) return
    const deadline = Date.now() + 2500
    const check = () => {
      try { process.kill(-child.pid, 0) } catch { return }
      if (Date.now() >= deadline) signalTree('SIGKILL')
      else shutdownTimer = setTimeout(check, 100)
    }
    shutdownTimer = setTimeout(check, 100)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { signalTree(signal); ensureStopped() })
  }
  child.once('error', (error) => { console.error(error); process.exitCode = 1 })
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1)
    signalTree('SIGTERM')
    ensureStopped()
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) launch()
