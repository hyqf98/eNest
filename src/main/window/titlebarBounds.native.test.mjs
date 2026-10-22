import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

test('native child views never cover the shell reveal strip and expand below the titlebar', {
  skip: process.env.ENEST_TITLEBAR_NATIVE !== '1', timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'enest-titlebar-native-'))
  let child
  try {
    const source = `
      import { app, WebContentsView } from 'electron';
      import { writeFileSync } from 'node:fs';
      import { createShellWindow, getShellWebContents, setPluginTopInset, getPluginContentBounds } from '@main/window/createShellWindow';
      app.setPath('userData', process.env.ENEST_TITLEBAR_TEST_PROFILE);
      const results = [];
      app.whenReady().then(() => {
        const win = createShellWindow();
        const shell = getShellWebContents();
        const plugin = new WebContentsView({ webPreferences: { sandbox: true } });
        win.contentView.addChildView(plugin);
        for (const release of [0, 28, 36, 0, NaN]) {
          setPluginTopInset(release);
          plugin.setBounds(getPluginContentBounds(0));
          results.push({ release: String(release), nativeBounds: plugin.getBounds() });
        }
        writeFileSync(process.env.ENEST_TITLEBAR_TEST_RESULT, JSON.stringify(results));
        win.contentView.removeChildView(plugin);
        plugin.webContents.close({ waitForBeforeUnload: false });
        win.destroy();
        app.quit();
      }).catch(error => { console.error(error); app.exit(1) });
    `
    const adapters = {
      '@main/ipc/ipcSecurity': 'export const registerTrustedSurface=()=>{}',
      '@main/window/mainWindowState': 'export const readMainWindowState=()=>undefined; export const trackMainWindowState=()=>{}',
      '@main/dev/devShortcuts': 'export const devShortcutAction=()=>null; export const toggleDevTools=()=>{}',
      '@main/plugin/PluginHost': 'export const pluginHost={getActive:()=>null}',
      '@main/plugin/PluginRegistry': 'export const pluginRegistry={get:()=>null}',
    }
    await writeFile(join(directory, 'package.json'), JSON.stringify({ main: 'main.cjs', private: true }))
    await build({
      stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts' },
      tsconfig: 'tsconfig.node.json', platform: 'node', format: 'cjs', bundle: true,
      external: ['electron'], outfile: join(directory, 'main.cjs'),
      plugins: [{ name: 'titlebar-native-fixture', setup(builder) {
        builder.onResolve({ filter: /^@main\// }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: 'fixture' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path] }))
      } }],
    })
    const env = { ...process.env, ENEST_TITLEBAR_TEST_PROFILE: join(directory, 'profile'), ENEST_TITLEBAR_TEST_RESULT: join(directory, 'results.json') }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    let log = ''
    child = spawn(require('electron'), [directory], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-10000) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }).finally(() => clearTimeout(timer))
    assert.equal(code, 0, log)
    const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
    assert.deepEqual(results.map(item => item.nativeBounds.y), [36, 8, 8, 36, 36])
    for (const { nativeBounds } of results) {
      assert.ok(nativeBounds.width > 0 && nativeBounds.height > 0)
      assert.ok(nativeBounds.y >= 8)
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await rm(directory, { recursive: true, force: true })
  }
})
