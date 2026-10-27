/** Isolated native registration check; no account, shell data or OS key injection. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))

test('native desktop registers independent keys, preserves ownership and releases them', {
  skip: process.env.ENEST_HOTKEY_PLATFORM_NATIVE !== '1', timeout: 45_000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-hotkey-platform-'))
  let app
  try {
    await build({
      entryPoints: [join(root, 'src/main/hotkey/hotkeyRegistry.ts')], tsconfig: join(root, 'tsconfig.node.json'),
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(directory, 'registry.cjs'),
      plugins: [{ name: 'isolated-log', setup(builder) {
        builder.onResolve({ filter: /^@main\/logs\/logService$/ }, () => ({ path: 'log', namespace: 'test' }))
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const logError=()=>{};export const logWarn=()=>{};' }))
      } }]
    })
    const bootstrap = join(directory, 'main.cjs')
    await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'user-data'))});app.whenReady().then(()=>{global.hotkeyFixture=require('./registry.cjs')});`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // The Linux CI runner provides Xvfb/X11. This deliberately does not claim Wayland portal acceptance.
    if (process.platform === 'linux') { env.XDG_SESSION_TYPE = 'x11'; delete env.WAYLAND_DISPLAY }
    app = await electron.launch({ executablePath: require('electron'), args: [
      ...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=x11'] : []), bootstrap
    ], env, timeout: 25_000 })
    const evidence = await app.evaluate(async ({ app: electronApp, globalShortcut }) => {
      await electronApp.whenReady()
      const registry = global.hotkeyFixture
      if (!registry) throw new Error('native shortcut fixture did not initialize')
      const modifier = process.platform === 'darwin' ? 'Control+Alt+Command' : 'Control+Alt+Shift'
      const firstKey = `${modifier}+F20`, secondKey = `${modifier}+F21`
      const first = { kind: 'shortcut', id: 'first', pluginId: 'fixture' }
      const second = { kind: 'shortcut', id: 'second', pluginId: 'fixture' }
      const replacement = { kind: 'quick', id: 'launcher' }
      const registered = registry.applyHotkeyChanges([
        { owner: first, registration: { owner: first, accelerator: firstKey, onFire() {} } },
        { owner: second, registration: { owner: second, accelerator: secondKey, onFire() {} } }
      ])
      if (!registered.ok) throw new Error(registered.error)
      const bothRegistered = [firstKey, secondKey].every(key => globalShortcut.isRegistered(key))
      const conflicting = registry.applyHotkeyChanges([{ owner: replacement, registration: { owner: replacement, accelerator: firstKey, onFire() {} } }])
      const preservedOwner = registry.getHotkeyOwner(firstKey).id
      const released = registry.applyHotkeyChanges([{ owner: first, registration: null }])
      const independentRelease = released.ok && !globalShortcut.isRegistered(firstKey) && globalShortcut.isRegistered(secondKey)
      registry.disposeHotkeyRegistry()
      return { platform: process.platform, arch: process.arch, session: process.platform === 'linux' ? 'X11' : process.platform,
        bothRegistered, conflictingRejected: !conflicting.ok, preservedOwner, independentRelease,
        allReleased: !globalShortcut.isRegistered(firstKey) && !globalShortcut.isRegistered(secondKey), physicalKeyInput: false }
    })
    assert.equal(evidence.bothRegistered, true)
    assert.equal(evidence.conflictingRejected, true)
    assert.equal(evidence.preservedOwner, 'first')
    assert.equal(evidence.independentRelease, true)
    assert.equal(evidence.allReleased, true)
    console.log(`Native registration evidence: ${JSON.stringify(evidence)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
