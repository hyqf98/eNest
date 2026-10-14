// Run: node --test src/main/screen/screenService.test.mjs
// Exercise the real lifecycle and generated recorder script with deterministic Electron/disk adapters.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test, { beforeEach, afterEach } from 'node:test'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const adapters = {
  electron: `
    import { EventEmitter } from 'node:events';
    import { files } from 'node:fs/promises';
    import { IpcChannels } from '@shared/types/ipc';
    export const ipcMain = new EventEmitter();
    export const windows = [];
    export const controls = { sources: null, loadError: null, autoStart: true };
    let nextId = 1;
    export class BrowserWindow extends EventEmitter {
      constructor(options) {
        super(); this.options = options; this.destroyed = false; this.calls = [];
        this.webContents = new EventEmitter(); this.webContents.id = nextId++; this.webContents.mainFrame = {};
        this.webContents.executeJavaScript = async (script) => { this.calls.push(script) };
        windows.push(this);
      }
      isDestroyed() { return this.destroyed }
      destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed') }
      setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} showInactive() { this.shown = true } focus() {}
      async loadURL(url) {
        this.url = url;
        if (controls.loadError) throw controls.loadError;
        if (controls.autoStart && this.options.webPreferences.preload === 'recorderPreload.js') {
          queueMicrotask(() => ipcMain.emit(IpcChannels.PluginRecorderStarted, { sender: this.webContents, senderFrame: this.webContents.mainFrame }));
        }
      }
      async loadFile(path) {
        this.html = files.get(path)?.toString();
        return this.loadURL('file://' + path);
      }
    }
    const display = { id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    const shot = { getSize: () => display.size, toDataURL: () => 'data:image/png;base64,AA==', crop() { return this } };
    export const screen = { getAllDisplays: () => [display], getPrimaryDisplay: () => display };
    export const desktopCapturer = { getSources: async () => {
      if (controls.sources) await controls.sources();
      return [{ display_id: '1', id: 'screen:1:0', thumbnail: shot }];
    } };
  `,
  'node:fs/promises': `
    export const files = new Map();
    export const disk = { append: null, write: null, mkdir: null, rename: null, stat: null, writes: 0, renames: 0 };
    export const mkdir = async () => { if (disk.mkdir) await disk.mkdir() };
    export const writeFile = async (path, value) => { if (disk.write) await disk.write(); files.set(path, Buffer.from(value)) };
    export const appendFile = async (path, value) => {
      if (disk.append) await disk.append();
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), value])); disk.writes++;
    };
    export const rename = async (from, to) => {
      if (disk.rename) await disk.rename();
      if (!files.has(from)) throw new Error('missing part');
      files.set(to, files.get(from)); files.delete(from); disk.renames++;
    };
    export const stat = async (path) => { if(disk.stat) await disk.stat(); return { size: files.get(path)?.length ?? 0 } };
    export const rm = async (path) => { files.delete(path) };
  `,
  '@main/paths/pathsService': `export const getAppPaths = () => ({ root: '/fixture' });`,
  '@main/window/createShellWindow': `export const resolvePreload = (value) => value;`,
  '@main/logs/logService': `export const logInfo = () => {}; export const logWarn = () => {};`
}
const bundle = await build({
  stdin: {
    contents: `
      export * from '@main/screen/screenService';
      export * from '@main/plugin/PluginRuntimeScope';
      export { windows, controls, ipcMain } from 'electron';
      export { files, disk } from 'node:fs/promises';
      export { IpcChannels } from '@shared/types/ipc';
    `,
    resolveDir: root
  },
  tsconfig: join(root, 'tsconfig.node.json'), bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'adapters', setup(builder) {
    builder.onResolve({ filter: /^(electron|node:fs\/promises|@main\/)/ }, ({ path }) =>
      path in adapters ? { path, namespace: 'adapter' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'adapter' }, ({ path }) => ({ contents: adapters[path], loader: 'js', resolveDir: root }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
const gate = () => {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}
const emit = (window, channel, ...args) => api.ipcMain.emit(api.IpcChannels[channel], { sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args)
const lastWindow = () => api.windows.at(-1)
const chunk = (text) => Uint8Array.from(Buffer.from(text)).buffer
let generation = 0
const owner = (id = 'com.test.screen') => api.createRuntimeScope({ pluginId: id, generation: ++generation, wcId: generation })
beforeEach(() => {
  api.controls.sources = null; api.controls.loadError = null; api.controls.autoStart = true
  for (const key of ['append', 'write', 'mkdir', 'rename', 'stat']) api.disk[key] = null
  api.disk.writes = 0; api.disk.renames = 0; api.files.clear(); api.windows.length = 0
})
afterEach(async () => {
  api.disposeScreenService()
  for (const item of api.getRuntimeDiagnostics()) await api.getRuntimeScope(item.pluginId)?.dispose()
  await flush()
})

test('recorder and region IPC reject subframes and foreign objects with the same WebContents id', async () => {
  const scope = owner()
  const { sessionId } = await api.startRecording(scope.owner.pluginId), recorder = lastWindow()
  for (const event of [
    { sender: recorder.webContents, senderFrame: {} },
    { sender: { id: recorder.webContents.id }, senderFrame: recorder.webContents.mainFrame }
  ]) {
    api.ipcMain.emit(api.IpcChannels.PluginRecorderChunk, event, chunk('forged'))
    api.ipcMain.emit(api.IpcChannels.PluginRecorderStopped, event)
  }
  assert.equal(recorder.isDestroyed(), false)
  emit(recorder, 'PluginRecorderChunk', chunk('real'))
  const stopped = api.stopRecording(scope.owner.pluginId, sessionId)
  emit(recorder, 'PluginRecorderStopped')
  assert.equal(api.files.get((await stopped).path).toString(), 'real')
  const region = api.selectRegion(scope.owner.pluginId)
  await flush()
  const overlay = lastWindow()
  api.ipcMain.emit(api.IpcChannels.PluginRegionCancel, { sender: overlay.webContents, senderFrame: {} })
  api.ipcMain.emit(api.IpcChannels.PluginRegionCancel, { sender: { id: overlay.webContents.id }, senderFrame: overlay.webContents.mainFrame })
  assert.equal(overlay.isDestroyed(), false)
  emit(overlay, 'PluginRegionConfirm', { x: 1, y: 2, width: 3, height: 4 })
  assert.deepEqual(await region, { x: 1, y: 2, width: 3, height: 4 })
})

test('recording reserves its slot before capture and closing in-flight creation prevents a window', async () => {
  const scope = owner(), pendingCapture = gate()
  api.controls.sources = () => pendingCapture.promise
  const first = api.startRecording(scope.owner.pluginId)
  assert.equal(scope.activityCount, 1)
  await assert.rejects(api.startRecording(scope.owner.pluginId), /already in progress/)
  scope.markClosing()
  await assert.rejects(first, /startup/)
  pendingCapture.release(); await flush()
  assert.equal(api.windows.length, 0)
  assert.equal(api.files.size, 0)
  assert.equal(scope.activityCount, 0)
})

test('close stops immediately while a new generation can record during old file finalization', async () => {
  const scope = owner()
  const old = await api.startRecording(scope.owner.pluginId), oldWindow = lastWindow()
  emit(oldWindow, 'PluginRecorderChunk', chunk('old'))
  scope.markClosing()
  assert.match(oldWindow.calls.at(-1), /recorderCtl.stop/)
  await scope.dispose()
  const next = owner()
  const current = await api.startRecording(next.owner.pluginId), newWindow = lastWindow()
  assert.throws(() => api.cancelRecording(next.owner.pluginId, old.sessionId), /another plugin runtime/)
  emit(oldWindow, 'PluginRecorderStopped'); await flush()
  assert.equal(oldWindow.isDestroyed(), true)
  assert.equal(newWindow.isDestroyed(), false)
  assert.equal(next.activityCount, 1)
  assert.equal(api.files.get(`/fixture/recordings/${old.sessionId}.webm`).toString(), 'old')
  assert.equal(api.cancelRecording(next.owner.pluginId, current.sessionId), true)
})

test('stop is idempotent and duplicate stop events finalize once with ordered chunks', async () => {
  const scope = owner()
  const { sessionId } = await api.startRecording(scope.owner.pluginId), window = lastWindow()
  emit(window, 'PluginRecorderChunk', chunk('first'))
  emit(window, 'PluginRecorderChunk', chunk('last'))
  const result = api.stopRecording(scope.owner.pluginId, sessionId)
  assert.equal(api.stopRecording(scope.owner.pluginId, sessionId), result)
  emit(window, 'PluginRecorderStopped'); emit(window, 'PluginRecorderStopped')
  const saved = await result
  assert.equal(api.files.get(saved.path).toString(), 'firstlast')
  assert.equal(api.disk.renames, 1)
  assert.equal(window.isDestroyed(), true)
  assert.equal(scope.activityCount, 0)
})

test('slow disk pauses/resumes the recorder and the hard queue cap destroys it', async () => {
  const scope = owner(), blocked = gate()
  const { sessionId } = await api.startRecording(scope.owner.pluginId), window = lastWindow()
  api.disk.append = () => blocked.promise
  emit(window, 'PluginRecorderChunk', new ArrayBuffer(3 * 1024 * 1024))
  assert.match(window.calls.at(-1), /recorderCtl.pause/)
  blocked.release(); await flush()
  assert.match(window.calls.at(-1), /recorderCtl.resume/)
  const nextBlock = gate()
  api.disk.append = () => nextBlock.promise
  emit(window, 'PluginRecorderChunk', new ArrayBuffer(7 * 1024 * 1024))
  await flush()
  emit(window, 'PluginRecorderChunk', new ArrayBuffer(2 * 1024 * 1024))
  assert.equal(window.isDestroyed(), true)
  assert.equal(scope.activityCount, 0)
  nextBlock.release(); await flush()
  assert.equal(api.files.size, 0)
  assert.equal(api.cancelRecording(scope.owner.pluginId, sessionId), false)
})

test('append errors reject stop and release window, lease and temporary output', async () => {
  const scope = owner()
  const { sessionId } = await api.startRecording(scope.owner.pluginId), window = lastWindow()
  api.disk.append = async () => { throw new Error('disk full') }
  emit(window, 'PluginRecorderChunk', chunk('data'))
  const stopped = api.stopRecording(scope.owner.pluginId, sessionId)
  emit(window, 'PluginRecorderStopped')
  await assert.rejects(stopped, /disk full/)
  await flush()
  assert.equal(api.files.size, 0)
  assert.equal(window.isDestroyed(), true)
  assert.equal(scope.activityCount, 0)
})

test('startup failures and cancellation during initial disk write clean late files', async () => {
  const scope = owner()
  api.controls.loadError = new Error('navigation failed')
  await assert.rejects(api.startRecording(scope.owner.pluginId), /navigation failed/)
  await flush()
  assert.equal(lastWindow().isDestroyed(), true)
  assert.equal(scope.activityCount, 0)
  assert.equal(api.files.size, 0)
  api.controls.loadError = null
  const blocked = gate()
  api.disk.write = () => blocked.promise
  const starting = api.startRecording(scope.owner.pluginId)
  await flush()
  scope.markClosing()
  await assert.rejects(starting, /startup/)
  blocked.release(); await flush()
  assert.equal(api.files.size, 0)
})

test('recorder crash and explicit cancel both destroy capture resources', async () => {
  const scope = owner()
  await api.startRecording(scope.owner.pluginId)
  const crashed = lastWindow()
  crashed.webContents.emit('render-process-gone')
  await flush()
  assert.equal(crashed.isDestroyed(), true)
  assert.equal(api.files.size, 0)
  const { sessionId } = await api.startRecording(scope.owner.pluginId), cancelled = lastWindow()
  assert.equal(api.cancelRecording(scope.owner.pluginId, sessionId), true)
  assert.equal(cancelled.isDestroyed(), true)
  await flush()
  assert.equal(scope.activityCount, 0)
  assert.equal(api.files.size, 0)
})

test('region capture is generation-owned and late capture cannot resurrect a closed overlay', async () => {
  const scope = owner(), blocked = gate()
  api.controls.sources = () => blocked.promise
  const selecting = api.selectRegion(scope.owner.pluginId)
  scope.markClosing()
  assert.equal(await selecting, null)
  blocked.release(); await flush()
  assert.equal(api.windows.length, 0)
  await scope.dispose()
  const next = owner()
  api.controls.sources = null
  const current = api.selectRegion(next.owner.pluginId)
  await flush()
  const window = lastWindow()
  emit(window, 'PluginRegionConfirm', { x: 5, y: 6, width: 70, height: 80 })
  assert.deepEqual(await current, { x: 5, y: 6, width: 70, height: 80 })
  assert.equal(window.isDestroyed(), true)
  assert.equal(next.activityCount, 0)
})

test('closing during region navigation and failure paths resolve once and remove overlays', async () => {
  const scope = owner()
  api.controls.loadError = new Error('overlay navigation failed')
  await assert.rejects(api.selectRegion(scope.owner.pluginId), /navigation failed/)
  assert.equal(lastWindow().isDestroyed(), true)
  assert.equal(scope.activityCount, 0)
  api.controls.loadError = null
  const selecting = api.selectRegion(scope.owner.pluginId)
  await flush()
  scope.markClosing()
  assert.equal(await selecting, null)
  assert.equal(lastWindow().isDestroyed(), true)
})

test('background finalization has a hard 10 second deadline, even during a pending rename', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const scope = owner(), blocked = gate()
  const { sessionId } = await api.startRecording(scope.owner.pluginId), window = lastWindow()
  const result = api.stopRecording(scope.owner.pluginId, sessionId)
  api.disk.rename = () => blocked.promise
  emit(window, 'PluginRecorderStopped'); await flush()
  t.mock.timers.tick(10_000)
  await assert.rejects(result, /stop timeout/)
  assert.equal(window.isDestroyed(), true)
  assert.equal(scope.activityCount, 0)
  blocked.release(); await flush()
  assert.equal(api.files.size, 0)
  t.mock.timers.reset()
})

test('a recorder that never starts releases its slot at the startup deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const scope = owner()
  api.controls.autoStart = false
  const starting = api.startRecording(scope.owner.pluginId)
  await flush()
  t.mock.timers.tick(15_000)
  await assert.rejects(starting, /startup timeout/)
  assert.equal(lastWindow().isDestroyed(), true)
  assert.equal(scope.activityCount, 0)
  await flush()
  assert.equal(api.files.size, 0)
  t.mock.timers.reset()
})

test('generated recorder serializes Blob conversion and sends final data before stopped', async () => {
  const scope = owner()
  await api.startRecording(scope.owner.pluginId)
  const html = lastWindow().html
  assert.match(lastWindow().url, /^file:/)
  assert.equal(lastWindow().options.webPreferences.sandbox, true)
  await flush()
  assert.equal([...api.files.keys()].some(path => path.endsWith('.html')), false)
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1]
  const calls = [], first = gate(), final = gate()
  let recorder
  const rawTrack = { stop() { calls.push('raw.stop') } }, outTrack = { stop() { calls.push('out.stop') } }
  const video = { play: async () => {}, requestVideoFrameCallback: () => 1, cancelVideoFrameCallback() {} }
  const canvas = { getContext: () => ({ drawImage() {} }), captureStream: () => ({
    getTracks: () => [outTrack], addTrack() {}
  }) }
  class MediaRecorder {
    static isTypeSupported() { return true }
    constructor() { recorder = this; this.state = 'inactive' }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive' }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
  }
  const context = {
    window: { recorderBridge: {
      started: () => calls.push('started'), chunk: (value) => calls.push(value),
      stopped: () => calls.push('stopped'), failed: (value) => calls.push(`error:${value}`)
    } },
    document: { getElementById: () => video, createElement: () => canvas },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [rawTrack], getAudioTracks: () => [] }) } },
    MediaRecorder, requestAnimationFrame: () => 1, cancelAnimationFrame() {}
  }
  runInNewContext(script, context)
  await flush()
  recorder.ondataavailable({ data: { size: 1, arrayBuffer: async () => { await first.promise; return 'first' } } })
  recorder.ondataavailable({ data: { size: 1, arrayBuffer: async () => { await final.promise; return 'last' } } })
  context.window.recorderCtl.stop()
  assert.ok(calls.includes('raw.stop'))
  assert.ok(calls.includes('out.stop'))
  recorder.onstop()
  final.release(); await flush()
  assert.equal(calls.includes('last'), false)
  assert.equal(calls.includes('stopped'), false)
  first.release(); await flush()
  assert.deepEqual(calls.filter((value) => ['first', 'last', 'stopped'].includes(value)), ['first', 'last', 'stopped'])
})
