/** Load all actual official dist packages in a temporary production shell profile. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const execFileAsync = promisify(execFile)
async function poll(read, accepts, label, timeout = 12000) {
  const deadline = Date.now() + timeout
  let result, error
  while (Date.now() < deadline) {
    try { result = await read(); if (accepts(result)) return result } catch (e) { error = e }
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(result)}`)
}

test('every official packaged plugin boots inside a sandbox and releases its native runtime', { skip: process.env.ENEST_OFFICIAL_SMOKE !== '1', timeout: 180000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enest-official-smoke-')), dataRoot = join(dir, 'data')
  const repository = join(root, 'eNest_plugin/plugins'), packages = [], reports = []
  let app, logs = ''
  try {
    for (const id of (await readdir(repository)).sort()) {
      let manifest
      try { manifest = JSON.parse(await readFile(join(repository, id, 'dist/plugin.json'), 'utf8')) } catch { continue }
      await mkdir(join(dataRoot, 'plugins', id), { recursive: true })
      const source = join(repository, id, 'dist'), target = join(dataRoot, 'plugins', id, manifest.version)
      // APFS clone avoids copying large bundled runtimes while keeping fixture metadata private.
      if (process.platform === 'darwin') await execFileAsync('/bin/cp', ['-cR', source, target])
      else await cp(source, target, { recursive: true })
      await writeFile(join(target, '.enest-build.json'), JSON.stringify({ revision: randomBytes(32).toString('hex') }))
      packages.push(manifest)
    }
    assert.ok(packages.length >= 35, `Expected all official builds, found ${packages.length}`)
    const harmless = permission => ['storage.local', 'settings.register', 'vault.write', 'theme'].includes(permission) || permission.startsWith('ui.')
    await writeFile(join(dataRoot, 'settings.json'), JSON.stringify({ theme: { mode: 'light', overrides: {} }, general: { quickLauncher: { enabled: false }, closeBehavior: 'quit', tabStyle: 'classic', sessionTabs: [] }, plugins: Object.fromEntries(packages.map(manifest => [manifest.id, { permissionGrants: Object.fromEntries((manifest.permissions || []).map(permission => [permission, harmless(permission) ? 'allow' : 'deny'])) }])) }))
    const env = { ...process.env, ENEST_TEST_DATA_ROOT: dataRoot, ENEST_TEST_USER_DATA: join(dir, 'user-data') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.ENEST_REMOTE_DEBUG
    app = await electron.launch({ executablePath: require('electron'), args: [root], env, timeout: 25000 })
    app.process().stdout.on('data', chunk => { logs = (logs + chunk).slice(-30000) }); app.process().stderr.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
    const inShell = code => app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find(wc => wc.getURL().includes('/out/renderer/index.html')).executeJavaScript(code), code)
    await poll(() => inShell('typeof window.enestShell?.openPlugin'), value => value === 'function', 'shell ready', 60000)
    await poll(() => inShell('Boolean(document.querySelector(".app-boot.ready .market-grid"))'), Boolean, 'shell initial render')
    await new Promise(resolve => setTimeout(resolve, 250))
    await app.evaluate(({ app, dialog }) => {
      globalThis.__officialMessages = []
      // Any unforeseen permission defaults to denial; no native UI waits or OS grants.
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      app.on('web-contents-created', (_event, wc) => {
        wc.on('console-message', (_event, levelOrDetails, legacyMessage) => {
          const details = typeof levelOrDetails === 'object' ? levelOrDetails : { level: levelOrDetails, message: legacyMessage }
          globalThis.__officialMessages.push({ wcId: wc.id, url: wc.getURL(), level: details.level, message: details.message })
        })
        wc.on('preload-error', (_event, path, error) => globalThis.__officialMessages.push({ wcId: wc.id, url: wc.getURL(), level: 'fatal', message: `preload-error: ${path} ${error.message}` }))
        wc.on('did-fail-load', (_event, code, description, url, mainFrame) => { if (code !== -3) globalThis.__officialMessages.push({ wcId: wc.id, url, level: mainFrame ? 'fatal' : 'resource', message: `${code} ${description}` }) })
      })
    })
    for (const manifest of packages) {
      const id = manifest.id, started = Date.now(), report = { id, version: manifest.version }
      try {
        await inShell(`window.enestShell.openPlugin(${JSON.stringify(id)})`)
        const read = () => app.evaluate(async ({ webContents }, id) => {
          const wc = webContents.getAllWebContents().find(wc => wc.getURL().includes(`/${id}/`))
          if (!wc) return null
          return { wcId: wc.id, sandbox: wc.getLastWebPreferences().sandbox, ...await wc.executeJavaScript(`({ready:document.readyState,bridge:typeof window.enest?.storage?.get,noNode:typeof require==='undefined' && typeof process==='undefined',nodes:document.body?.querySelectorAll('*').length || 0,text:document.body?.innerText.slice(0,260),resources:performance.getEntriesByType('resource').filter(entry=>entry.responseStatus>=400).map(entry=>({url:entry.name,status:entry.responseStatus})),images:[...document.images].filter(image=>image.complete && !image.naturalWidth && image.currentSrc).map(image=>image.currentSrc)})`) }
        }, id)
        await poll(read, state => state?.ready === 'complete' && state.bridge === 'function', id)
        await new Promise(resolve => setTimeout(resolve, 550))
        const state = await read()
        Object.assign(report, state, { startupMs: Date.now() - started })
        report.messages = await app.evaluate((_, wcId) => globalThis.__officialMessages.filter(message => message.wcId === wcId), state.wcId)
        assert.equal(state.sandbox, true); assert.equal(state.noNode, true); assert.ok(state.nodes > 0, `${id} rendered no UI`)
        assert.deepEqual(state.resources, [], `${id} HTTP/resource failures`)
        assert.deepEqual(state.images.filter(url => url.startsWith('enest:')), [], `${id} missing packaged images`)
        const failures = report.messages.filter(item => item.level === 'fatal' || /Refused to (?:load|execute|connect|create)|violat(?:es|ing).*Content Security Policy|Content Security Policy.*invalid source|Uncaught|Unable to load preload|Cannot (?:read|set) properties/i.test(item.message || ''))
        assert.deepEqual(failures, [], `${id} boot/CSP failures`)
        if (id === 'com.enest.theme-demo') {
          const packs = await poll(() => inShell('window.enestShell.getTheme().then(theme=>theme.packs)'), packs => packs.some(pack => pack.id === 'theme-demo.ink-green' && pack.source === id), 'runtime theme registration')
          report.theme = { runtimeRegistered: true, packIds: packs.filter(pack => pack.source === id).map(pack => pack.id) }
          await inShell(`window.enestShell.setPluginEnabled(${JSON.stringify(id)},false)`)
          await poll(() => inShell('window.enestShell.getTheme().then(theme=>theme.packs)'), packs => packs.every(pack => pack.source !== id), 'theme cleanup on disable')
          report.theme.disabledRemovedAllPacks = true
        }
      } catch (error) { report.error = error.message }
      finally {
        await inShell(`window.enestShell.closePlugin(${JSON.stringify(id)})`)
        const cleanup = await poll(() => inShell('window.enestShell.getPluginDiagnostics()'), value => !value.host.closing && !value.host.retiring && value.resources.length === 0, `${id} cleanup`)
        report.cleanup = { instances: cleanup.host.entries.length, activities: cleanup.resources.length, sessionBytes: cleanup.session.residentBytes }
        report.nativeRemaining = await app.evaluate(({ webContents }, id) => webContents.getAllWebContents().filter(wc => wc.getURL().includes(`/${id}/`)).length, id)
        assert.equal(report.cleanup.instances, 0); assert.equal(report.cleanup.sessionBytes, 0); assert.equal(report.nativeRemaining, 0)
      }
      reports.push(report)
      console.log('Official plugin:', id, report.error ? `FAILED ${report.error}` : 'passed')
    }
    const evidence = { platform: process.platform, builtAt: new Date().toISOString(), plugins: packages.length, permissionMode: 'isolated profile; storage/settings/ui/vault/theme allowed, OS/network capabilities denied; no external services started', reports }
    const output = process.env.ENEST_OFFICIAL_SMOKE_OUTPUT || join(root, 'docs/engineering/official-plugin-native-smoke-2026-10-13.json')
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(evidence, null, 2))
    assert.deepEqual(reports.filter(report => report.error).map(report => ({ id: report.id, error: report.error })), [], `See ${output}`)
    console.log('Official native evidence:', output)
  } catch (error) { throw new Error(`${error.stack || error}\n${logs}`) }
  finally { if (app) await app.close().catch(() => app.process().kill('SIGKILL')); await rm(dir, { recursive: true, force: true }) }
})
