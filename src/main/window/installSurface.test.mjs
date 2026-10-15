import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function fixture() {
  const adapters = {
    'test-state': `export const state = { windows: [], views: [], queue: [], sink: null, nextId: 1 };`,
    electron: `
      import { EventEmitter } from 'node:events';
      import { state } from 'test-state';
      export const ipcMain = new EventEmitter();
      export const app = { getAppPath: () => '/app' };
      export class View {
        children = [];
        addChildView(view) { this.children.push(view); }
        removeChildView(view) { this.children = this.children.filter(child => child !== view); }
      }
      export class BaseWindow extends EventEmitter {
        id = state.nextId++; contentView = new View(); destroyed = false;
        constructor() { super(); state.windows.push(this); }
        static getAllWindows() { return state.windows.filter(win => !win.destroyed); }
        getContentBounds() { return { width: 900, height: 700 }; }
        isDestroyed() { return this.destroyed; }
        close() { this.destroyed = true; this.emit('closed'); }
      }
      export class WebContentsView extends View {
        constructor() {
          super();
          const wc = this.webContents = new EventEmitter();
          Object.assign(wc, {
            id: state.nextId++, mainFrame: {}, destroyed: false, sent: [],
            isDestroyed() { return this.destroyed; },
            send(channel, payload) { this.sent.push({ channel, payload }); },
            loadURL() { return new Promise((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject; }); },
            close() { this.destroyed = true; this.emit('destroyed'); this.rejectLoad?.(Error('load cancelled')); }
          });
          state.views.push(this);
        }
        setVisible(value) { this.visible = value; }
        setBackgroundColor() {}
        setBounds(bounds) { this.bounds = bounds; }
      }
    `,
    '@main/ipc/ipcSecurity': 'export const registerTrustedSurface = () => {}; export const assertSurfaceSender = () => {};',
    '@main/plugin/PluginHost': 'export const pluginHost = { getPluginIdByWebContentsId: () => null };',
    '@main/plugin/installQueue': `
      import { state } from 'test-state';
      export function enqueueInstall(path, onEnqueued) {
        const job = { id: 'job-' + state.queue.length, name: path, status: state.queue.length < 3 ? 'active' : 'queued', progress: 10 };
        state.queue.push(job); onEnqueued(job);
        state.sink({ type: 'install-queue', active: state.queue.filter(j => j.status === 'active'), waiting: state.queue.filter(j => j.status === 'queued') });
      }
    `,
    '@main/window/createShellWindow': `
      import { state } from 'test-state';
      export const getMainWindow = () => state.windows[0];
      export const resolvePreload = value => value;
      export const setInstallEventSink = sink => { state.sink = sink; };
    `,
    '@main/theme/resolveThemeCss': `export const resolveThemeTokens = () => ({ mode: 'light', tokens: {} });`,
    '@main/settings/SettingsStore': `export const settingsStore = { getPluginAppearance: () => ({}) };`
  }
  const result = await build({
    stdin: { contents: `export * from '@main/window/installSurface'; export { IpcChannels } from '@shared/types/ipc'; export { BaseWindow, WebContentsView, ipcMain } from 'electron'; export { state } from 'test-state';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'esm', write: false, tsconfig: `${root}/tsconfig.node.json`,
    plugins: [{ name: 'install-surface-fixture', setup(b) {
      b.onResolve({ filter: /.*/ }, ({ path }) => path in adapters ? { path, namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: adapters[path], resolveDir: root }))
    } }]
  })
  const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n// ${Math.random()}`).toString('base64')}`)
  api.registerInstallSurfaceHandlers()
  const win = new api.BaseWindow()
  const shell = new api.WebContentsView()
  win.contentView.addChildView(shell)
  const send = (channel, value, view = shell) => api.ipcMain.emit(channel, { sender: view.webContents, senderFrame: view.webContents.mainFrame }, value)
  return { ...api, win, shell, send }
}

test('a full 16-package batch keeps every job reachable and active work first', async () => {
  const f = await fixture()
  try {
    f.send(f.IpcChannels.InstallDropFiles, Array.from({ length: 16 }, (_, i) => `/tmp/plugin-${i}.enestplugin`))
    const overlay = f.state.views.at(-1)
    f.send(f.IpcChannels.InstallSurfaceReady, undefined, overlay)
    let jobs = overlay.webContents.sent.at(-1).payload.jobs
    assert.equal(jobs.length, 16)
    assert.deepEqual(jobs.slice(0, 3).map(job => job.id), ['job-0', 'job-1', 'job-2'])
    assert.ok(jobs.slice(0, 3).every(job => job.status === 'active'))
    // A later queued job starts after the oldest task finishes.
    f.state.queue[0].status = 'done'
    f.state.queue[3].status = 'active'
    f.state.sink({ type: 'install-result', jobId: 'job-0', name: 'plugin-0', ok: true })
    f.state.sink({ type: 'install-queue', active: f.state.queue.filter(job => job.status === 'active'), waiting: f.state.queue.filter(job => job.status === 'queued') })
    jobs = overlay.webContents.sent.at(-1).payload.jobs
    assert.equal(jobs.length, 16)
    assert.deepEqual(jobs.slice(0, 3).map(job => job.id), ['job-1', 'job-2', 'job-3'])
    assert.equal(jobs.at(-1).status, 'done')
  } finally { f.win.close() }
})

test('a retired view load rejection cannot destroy its replacement surface', async () => {
  const f = await fixture()
  try {
    f.send(f.IpcChannels.InstallDropState, true)
    const retired = f.state.views.at(-1)
    retired.webContents.emit('render-process-gone')
    f.send(f.IpcChannels.InstallDropState, true)
    const replacement = f.state.views.at(-1)
    assert.notEqual(replacement, retired)
    await Promise.resolve()
    f.send(f.IpcChannels.InstallSurfaceReady, undefined, replacement)
    assert.equal(replacement.webContents.sent.at(-1)?.payload.dragging, true)
    f.send(f.IpcChannels.InstallDropState, true)
    assert.equal(f.state.views.length, 3, 'one shell plus exactly two overlay generations')
    assert.deepEqual(f.win.contentView.children, [f.shell, replacement])
    assert.equal(replacement.webContents.isDestroyed(), false)
  } finally { f.win.close() }
})

test('an overlay crash keeps active installs in their live owning window', async () => {
  const f = await fixture()
  const secondary = new f.BaseWindow()
  const secondaryShell = new f.WebContentsView()
  secondary.contentView.addChildView(secondaryShell)
  try {
    f.send(f.IpcChannels.InstallDropFiles, ['/tmp/secondary.enestplugin'], secondaryShell)
    const retired = f.state.views.at(-1)
    assert.ok(secondary.contentView.children.includes(retired))
    retired.webContents.emit('render-process-gone')
    f.state.sink({ type: 'install-progress', jobId: 'job-0', name: 'secondary', progress: 40, step: '解压安装' })
    const replacement = f.state.views.at(-1)
    await Promise.resolve()
    f.send(f.IpcChannels.InstallSurfaceReady, undefined, replacement)
    assert.deepEqual(f.win.contentView.children, [f.shell], 'main window must not acquire another window’s progress')
    assert.deepEqual(secondary.contentView.children, [secondaryShell, replacement])
    assert.equal(replacement.webContents.sent.at(-1)?.payload.jobs[0].progress, 40)
  } finally { secondary.close(); f.win.close() }
})
