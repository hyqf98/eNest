/** Build shell + plugin packs first, then ENEST_TOOLS_NATIVE=1 node --test this file. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const ids = [
  'calculator',
  'clipboard',
  'codec',
  'color-picker',
  'json-tools',
  'password-kit',
  'pomodoro',
  'screen-assistant',
  'sticky-notes',
  'timestamp',
  'todos',
  'translate',
].map((name) => `com.github.eNest.${name}`)

async function poll(read, accepts, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let value, error
  while (Date.now() < deadline) {
    try {
      value = await read()
      if (accepts(value)) return value
    } catch (next) {
      error = next
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${label}: ${error?.message || JSON.stringify(value)}`)
}

test(
  '13 real plugin packs retain runtime across Quick and desktop and exercise native bridges',
  { skip: process.env.ENEST_TOOLS_NATIVE !== '1', timeout: 180000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'enest-tools-native-'))
    const dataRoot = join(dir, 'data-root'),
      userData = join(dir, 'electron-user-data')
    const manifests = [],
      modes = [],
      evidence = { modes, screen: 'not attempted' }
    let app,
      stderr = '',
      stdout = ''
    try {
      const packs = await readdir(join(root, 'eNest_plugin/dist'))
      for (const id of ids) {
        const candidates = packs.filter(
          (name) => name.startsWith(`${id}@`) && name.endsWith('.enestplugin'),
        )
        assert.equal(
          candidates.length,
          1,
          `Expected one current packed version for ${id}`,
        )
        const archive = new AdmZip(
          join(root, 'eNest_plugin/dist', candidates[0]),
        )
        const manifest = JSON.parse(archive.readAsText('plugin.json'))
        assert.equal(manifest.id, id)
        manifests.push(manifest)
        const pluginDir = join(dataRoot, 'plugins', id, manifest.version)
        await mkdir(pluginDir, { recursive: true })
        archive.extractAllTo(pluginDir, false)
      }
      await writeFile(
        join(dataRoot, 'settings.json'),
        JSON.stringify({
          theme: { mode: 'light', overrides: {} },
          general: {
            quickLauncher: { enabled: false },
            closeBehavior: 'quit',
            tabStyle: 'classic',
            sessionTabs: [],
          },
          plugins: Object.fromEntries(
            manifests.map((manifest) => [
              manifest.id,
              {
                permissionGrants: Object.fromEntries(
                  manifest.permissions.map((permission) => [
                    permission,
                    'allow',
                  ]),
                ),
              },
            ]),
          ),
        }),
      )
      const env = {
        ...process.env,
        ENEST_TEST_DATA_ROOT: dataRoot,
        ENEST_TEST_USER_DATA: userData,
      }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      delete env.ENEST_REMOTE_DEBUG
      app = await electron.launch({
        executablePath: require('electron'),
        args: [root, '--no-sandbox'],
        env,
        timeout: 25000,
      })
      app.process().stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-64000)
      })
      app.process().stdout.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-64000)
      })
      assert.equal(
        await app.evaluate(({ app }) => app.getPath('userData')),
        userData,
      )
      await app.evaluate(({ app }) => {
        globalThis.__nativePreloadErrors = []
        app.on('web-contents-created', (_event, contents) => {
          contents.on('preload-error', (_event, path, error) => {
            globalThis.__nativePreloadErrors.push({
              path,
              message: error.message,
            })
          })
        })
      })
      const evaluate = (surface, code) =>
        app.evaluate(
          ({ webContents }, { surface, code }) => {
            const wc = webContents.getAllWebContents().find((wc) => {
              const url = wc.getURL()
              if (surface === 'shell')
                return (
                  url.includes('/out/renderer/index.html') &&
                  !url.includes('surface=quick')
                )
              if (surface === 'quick')
                return (
                  url.includes('/out/renderer/index.html') &&
                  url.includes('surface=quick')
                )
              return url.includes(surface)
            })
            if (!wc) throw new Error(`Missing ${surface} web contents`)
            return wc.executeJavaScript(code)
          },
          { surface, code },
        )
      const wcId = (id) =>
        app.evaluate(
          ({ webContents }, id) =>
            webContents
              .getAllWebContents()
              .find((wc) => wc.getURL().includes(id))?.id,
          id,
        )
      const open = async (id, container) => {
        if (container === 'quick') {
          const visible = await app.evaluate(({ BaseWindow }) =>
            BaseWindow.getAllWindows().some(
              (win) =>
                win.webContents?.getURL().includes('surface=quick') &&
                win.isVisible(),
            ),
          )
          if (!visible)
            await evaluate('shell', 'window.enestShell.quickToggle()')
          await poll(
            () => evaluate('quick', 'typeof window.enestShell?.quickInput'),
            (value) => value === 'function',
            'Quick preload',
          )
        }
        const result = await evaluate(
          'shell',
          `window.enestShell.quickOpen(${JSON.stringify({ kind: 'plugin', pluginId: id, container, code: 'main' })})`,
        )
        assert.equal(result.ok, true, `${id}: ${result.error}`)
        await poll(
          () =>
            evaluate(
              id,
              '({ mode: window.enest?.getLaunchMode(), dom: document.documentElement.dataset.mode, kit: typeof window.PluginKit?.create })',
            ),
          (value) =>
            value.mode === container &&
            value.dom === container &&
            value.kit === 'function',
          `${id} ${container} preload and DOM`,
        )
      }
      const inputState = async (id, label) => {
        let focusRecovery = false
        return poll(
          async () => {
            const value = await evaluate('quick', 'window.enestShell.quickInput()')
            if (value?.pluginId === id || focusRecovery) return value
            const visible = await app.evaluate(({ BaseWindow }) =>
              BaseWindow.getAllWindows().some(
                (win) => win.webContents?.getURL().includes('surface=quick') && win.isVisible(),
              ),
            )
            // Outside focus can dismiss Quick during a slow package load.
            // Re-enter once, keeping production blur handling enabled.
            if (!visible) {
              focusRecovery = true
              t.diagnostic(`${id}: Quick was dismissed by native focus; re-entering the same runtime once`)
              await open(id, 'quick')
            }
            return value
          },
          (value) => value?.pluginId === id,
          label,
        )
      }
      const close = async (id) => {
        await evaluate(
          'shell',
          `window.enestShell.closePlugin(${JSON.stringify(id)})`,
        )
        await poll(
          () => wcId(id),
          (value) => !value,
          `${id} native disposal`,
        )
      }
      await poll(
        () =>
          evaluate('shell', 'typeof window.enestShell?.getSettingsSections'),
        (value) => value === 'function',
        'shell preload',
      )
      const installed = await evaluate(
        'shell',
        'window.enestShell.getPlugins()',
      )
      assert.ok(
        ids.every((id) =>
          installed.some((plugin) => plugin.id === id && plugin.installed),
        ),
      )
      const sections = await evaluate(
        'shell',
        'window.enestShell.getSettingsSections()',
      )
      assert.ok(
        ids.every((id) => sections.some((section) => section.pluginId === id)),
        'Manifest settings must be registered before any plugin launch',
      )

      for (const manifest of manifests) {
        const id = manifest.id
        await open(id, 'quick')
        const original = await wcId(id)
        await evaluate(
          id,
          'window.__nativeModes = []; window.__nativeInput = []; window.__nativeActions = []; window.enest.onModeChange(mode => window.__nativeModes.push(mode)); window.enest.quickInput.onChange(value => window.__nativeInput.push(value)); window.enest.quickInput.onAction(action => window.__nativeActions.push(action)); true',
        )
        const initialInput = await inputState(id, `${id} top input configuration`)
        assert.equal(typeof initialInput.generation, 'number')
        const query = id.endsWith('calculator') ? '1+2' : 'native-smoke-query'
        assert.equal(
          await evaluate(
            'quick',
            `window.enestShell.quickInput(${JSON.stringify({ ...initialInput, type: 'change', value: query })})`,
          ),
          true,
        )
        assert.equal(
          await evaluate(
            'quick',
            `window.enestShell.quickInput(${JSON.stringify({ ...initialInput, type: 'action', action: 'next' })})`,
          ),
          true,
        )
        await poll(
          () =>
            evaluate(
              id,
              '({ input: window.__nativeInput, actions: window.__nativeActions })',
            ),
          (value) =>
            value.input.includes(query) && value.actions.includes('next'),
          `${id} top input delivery`,
        )
        await evaluate(
          'quick',
          `window.enestShell.quickInput(${JSON.stringify({ ...initialInput, type: 'change', value: '' })})`,
        )
        const defaults = (manifest.contributes?.settings || [])
          .flatMap((section) => section.items)
          .filter((item) => item.type !== 'page' && item.default !== undefined)
        for (const item of defaults) {
          assert.deepEqual(
            await evaluate(
              id,
              `window.enest.settings.get(${JSON.stringify(item.key)})`,
            ),
            item.default,
            `${id}.${item.key} declarative default`,
          )
        }
        assert.equal(await evaluate(id, 'window.enest.ui.openInShell()'), true)
        await poll(
          () =>
            evaluate(
              id,
              '({ mode: window.enest.getLaunchMode(), dom: document.documentElement.dataset.mode, callbacks: window.__nativeModes })',
            ),
          (value) =>
            value.mode === 'shell' &&
            value.dom === 'shell' &&
            value.callbacks.includes('shell'),
          `${id} promotion callback`,
        )
        assert.equal(
          await wcId(id),
          original,
          `${id} desktop promotion must reuse its web contents`,
        )
        assert.equal(
          await evaluate('quick', 'window.enestShell.quickInput()'),
          null,
          'Desktop promotion releases top input ownership',
        )
        assert.equal(
          await evaluate(
            'quick',
            `window.enestShell.quickInput(${JSON.stringify({ ...initialInput, type: 'change', value: 'stale' })})`,
          ),
          false,
        )
        await open(id, 'quick')
        assert.equal(
          await wcId(id),
          original,
          `${id} Quick return must reuse its web contents`,
        )
        await poll(
          () => evaluate(id, 'window.__nativeModes'),
          (value) => value.includes('quick'),
          `${id} return mode callback`,
        )
        modes.push({
          id,
          version: manifest.version,
          webContentsId: original,
          modes: await evaluate(id, 'window.__nativeModes'),
        })
        await close(id)
      }

      const todo = 'com.github.eNest.todos',
        notes = 'com.github.eNest.sticky-notes'
      await open(todo, 'quick')
      const oldInput = await inputState(todo, 'old input generation')
      await evaluate(
        todo,
        'window.__nativeSettings = []; window.enest.settings.onChange(event => window.__nativeSettings.push(event)); true',
      )
      assert.equal(
        await evaluate(todo, 'window.enest.settings.get("showCompleted")'),
        false,
      )
      await evaluate(
        'shell',
        `window.enestShell.setPluginSetting(${JSON.stringify(todo)}, 'showCompleted', true)`,
      )
      await poll(
        () => evaluate(todo, 'window.__nativeSettings'),
        (values) =>
          values.some(
            (value) => value.key === 'showCompleted' && value.value === true,
          ),
        'settings change event',
      )
      assert.equal(
        await evaluate(todo, 'window.enest.settings.get("showCompleted")'),
        true,
      )
      await close(todo)
      await open(todo, 'quick')
      const newInput = await inputState(todo, 'new input generation')
      assert.notEqual(newInput.generation, oldInput.generation)
      assert.equal(
        await evaluate(
          'quick',
          `window.enestShell.quickInput(${JSON.stringify({ ...oldInput, type: 'change', value: 'retired' })})`,
        ),
        false,
      )
      assert.equal(
        await evaluate(todo, 'window.enest.settings.get("showCompleted")'),
        true,
        'Setting survives real plugin runtime disposal',
      )
      await open(notes, 'shell')
      const payload =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf5sAAAAASUVORK5CYII='
      const blob = await evaluate(
        todo,
        `window.enest.storage.blobs.put(${JSON.stringify({ dataUrl: payload, name: 'fixture.png' })})`,
      )
      assert.ok(blob.id && blob.bytes > 0)
      assert.equal(
        (
          await evaluate(
            todo,
            `window.enest.storage.blobs.get(${JSON.stringify(blob.id)})`,
          )
        ).dataUrl,
        payload,
      )
      assert.equal(
        await evaluate(
          notes,
          `window.enest.storage.blobs.get(${JSON.stringify(blob.id)})`,
        ),
        null,
      )
      await evaluate(
        notes,
        `window.enest.storage.blobs.remove(${JSON.stringify(blob.id)})`,
      )
      assert.equal(
        (
          await evaluate(
            todo,
            `window.enest.storage.blobs.get(${JSON.stringify(blob.id)})`,
          )
        ).dataUrl,
        payload,
        'Another plugin cannot delete the owner attachment',
      )
      assert.equal(
        await evaluate(
          todo,
          `window.enest.storage.blobs.remove(${JSON.stringify(blob.id)})`,
        ),
        true,
      )
      await close(notes)
      await close(todo)

      const timer = 'com.github.eNest.pomodoro'
      await open(timer, 'quick')
      const started = await evaluate(
        timer,
        'window.enest.focusTimer.start({focusMin: 1, breakMin: 1, task: "Native persistence check", notify: false, autoStart: false})',
      )
      assert.equal(started.state.status, 'running')
      const deadline = started.state.deadline
      await close(timer)
      await open(timer, 'shell')
      const reopened = await evaluate(timer, 'window.enest.focusTimer.get()')
      assert.equal(reopened.state.status, 'running')
      assert.equal(reopened.state.deadline, deadline)
      assert.equal(reopened.state.options.task, 'Native persistence check')
      await evaluate(timer, 'window.enest.focusTimer.stop()')
      await close(timer)
      evidence.backgroundTimer =
        'running after view close/reopen; same deadline'

      const screenId = 'com.github.eNest.screen-assistant'
      const screenPermission = await app.evaluate(({ systemPreferences }) =>
        process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus('screen')
          : process.platform === 'win32'
            ? 'granted'
            : 'unknown',
      )
      if (screenPermission === 'granted') {
        await open(screenId, 'shell')
        const bounds = await app.evaluate(({ BaseWindow, screen }) => {
          const win = BaseWindow.getAllWindows().find((win) =>
            win.contentView.children.some(
              (view) =>
                view.webContents
                  ?.getURL()
                  .includes('/out/renderer/index.html') &&
                !view.webContents?.getURL().includes('surface=quick'),
            ),
          )
          if (!win) throw new Error('Shell BaseWindow missing')
          win.show()
          win.focus()
          const position = win.getBounds(),
            display = screen.getDisplayMatching(position),
            scale = display.scaleFactor
          return {
            displayId: display.id,
            bounds: {
              x: Math.max(
                0,
                Math.round((position.x - display.bounds.x + 40) * scale),
              ),
              y: Math.max(
                0,
                Math.round((position.y - display.bounds.y + 100) * scale),
              ),
              width: 160,
              height: 100,
            },
          }
        })
        const shot = await evaluate(
          screenId,
          `window.enest.screen.capture(${JSON.stringify(bounds)})`,
        )
        assert.equal(shot.width, 160)
        assert.equal(shot.height, 100)
        assert.match(shot.dataUrl, /^data:image\/png;base64,/)
        const recording = await evaluate(
          screenId,
          `window.enest.screen.record.start(${JSON.stringify({ ...bounds, withAudio: false })})`,
        )
        assert.ok(recording.sessionId)
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const saved = await evaluate(
          screenId,
          `window.enest.screen.record.stop(${JSON.stringify(recording.sessionId)})`,
        )
        assert.ok(saved.path.startsWith(join(dataRoot, 'recordings')))
        assert.ok(saved.size > 0 && saved.durationMs > 0)
        assert.equal((await stat(saved.path)).size, saved.size)
        assert.equal(
          (await readFile(saved.path)).subarray(0, 4).toString('hex'),
          '1a45dfa3',
          'Native recording contains the WebM/EBML header',
        )
        await evaluate(
          screenId,
          'window.__nativeRegion = "pending"; void window.enest.screen.selectRegion().then(value => { window.__nativeRegion = value; }); true',
        )
        await poll(
          () =>
            app.evaluate(async ({ webContents }) => {
              const region = webContents
                .getAllWebContents()
                .find(
                  (wc) =>
                    wc.getURL().startsWith('data:') &&
                    wc.getURL().includes('regionOverlay'),
                )
              return region?.executeJavaScript(
                'typeof window.regionOverlay?.cancel',
              )
            }),
          (value) => value === 'function',
          'Sandboxed region preload',
        )
        await app.evaluate(({ webContents }) => {
          const region = webContents
            .getAllWebContents()
            .find(
              (wc) =>
                wc.getURL().startsWith('data:') &&
                wc.getURL().includes('regionOverlay'),
            )
          return region.executeJavaScript(
            'setTimeout(() => window.regionOverlay.cancel(), 0); true',
          )
        })
        await poll(
          () => evaluate(screenId, 'window.__nativeRegion'),
          (value) => value === null,
          'Native region cancellation',
        )
        const pin = await evaluate(
          screenId,
          `window.enest.pin.open(${JSON.stringify({ dataUrl: shot.dataUrl, title: 'Native pin smoke', width: 160 })})`,
        )
        assert.ok(pin.pinId)
        await poll(
          () =>
            app.evaluate(async ({ webContents }) => {
              const pinned = webContents
                .getAllWebContents()
                .find((wc) => wc.getTitle() === 'Native pin smoke')
              return pinned?.executeJavaScript('typeof window.pinCtl?.close')
            }),
          (value) => value === 'function',
          'Sandboxed pin preload',
        )
        await app.evaluate(({ webContents }) => {
          const pinned = webContents
            .getAllWebContents()
            .find((wc) => wc.getTitle() === 'Native pin smoke')
          return pinned.executeJavaScript(
            'setTimeout(() => window.pinCtl.close(), 0); true',
          )
        })
        await poll(
          () => evaluate(screenId, 'window.enest.pin.list()'),
          (value) => value.length === 0,
          'Native pin close',
        )
        evidence.screen = {
          permission: screenPermission,
          screenshot: `${shot.width}x${shot.height}`,
          recordingBytes: saved.size,
          durationMs: saved.durationMs,
          regionCancel: true,
          pinClose: true,
        }
        await close(screenId)
      } else {
        evidence.screen = `skipped: existing OS screen access is ${screenPermission}; no permission request was made`
        t.diagnostic(evidence.screen)
      }
      assert.doesNotMatch(
        stderr + stdout,
        /Unable to load preload|uncaughtException|unhandledRejection/,
      )
      assert.deepEqual(
        await app.evaluate(() => globalThis.__nativePreloadErrors),
        [],
      )
      console.log('Native tools evidence:', JSON.stringify(evidence))
    } catch (error) {
      throw new Error(
        `${error.stack || error}\nApplication stdout:\n${stdout}\nApplication stderr:\n${stderr}`,
      )
    } finally {
      if (app) await app.close().catch(() => app.process().kill('SIGKILL'))
      await rm(dir, { recursive: true, force: true })
    }
  },
)
