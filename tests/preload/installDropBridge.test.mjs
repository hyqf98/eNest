import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await build({
  entryPoints: [`${root}/src/preload/installDropBridge.ts`],
  tsconfig: `${root}/tsconfig.node.json`, bundle: true, write: false,
  format: 'iife', globalName: 'installBridge', platform: 'node',
  plugins: [{ name: 'native-drop-fixture', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const ipcRenderer = { send: (...args) => sent.push(args) };
      export const webUtils = { getPathForFile(file) {
        pathReads.push(file);
        if (!nativePaths.has(file)) throw new Error('not a native file');
        return nativePaths.get(file);
      } };
    ` }))
  } }]
})

/** Isolated preload behavior only; native OS drag delivery is covered separately. */
function fixture({ isMainFrame = true } = {}) {
  const handlers = new Map(), sent = [], pathReads = [], nativePaths = new WeakMap()
  const context = vm.createContext({
    handlers, sent, pathReads, nativePaths, process: { isMainFrame },
    addEventListener(name, listener, capture) {
      assert.equal(capture ?? false, name === 'blur' ? false : true)
      handlers.set(name, listener)
    }
  })
  vm.runInContext(bundle.outputFiles[0].text, context)
  context.installBridge.bindNativeInstallDrop(true)
  return {
    sent, pathReads, handlers,
    nativeFile(path, props = {}) {
      const file = { name: path.split('/').pop(), ...props }
      nativePaths.set(file, path)
      return file
    },
    dispatch(name, { isTrusted = true, mime = '', files = [] } = {}, pluginHandler) {
      const event = {
        isTrusted, defaultPrevented: false, propagationStopped: false,
        dataTransfer: { types: ['Files'], items: [{ type: mime }], files, dropEffect: 'none' },
        preventDefault() { this.defaultPrevented = true },
        stopImmediatePropagation() { this.propagationStopped = true }
      }
      handlers.get(name)?.(event)
      if (!event.propagationStopped) pluginHandler?.(event)
      return event
    }
  }
}
const installMessages = f => f.sent.filter(([channel]) => channel === 'install:drop-files')

test('unknown MIME dragover enables a drop without requiring a plugin handler or showing an install target', () => {
  const f = fixture()
  const enter = f.dispatch('dragenter')
  const over = f.dispatch('dragover')
  assert.equal(enter.defaultPrevented, false)
  assert.equal(over.defaultPrevented, true, 'the preload itself must allow the browser to dispatch drop')
  assert.equal(over.propagationStopped, false)
  assert.equal(f.pathReads.length, 0, 'protected-mode drag metadata must not require file paths')
  assert.equal(f.sent.length, 0, 'unknown files must not activate an install overlay before their path is available')
})

test('an unknown MIME package is consumed on drop using its native path', () => {
  const f = fixture()
  const file = f.nativeFile('/tmp/example.enestplugin', { name: 'untrusted-name.txt', path: '/tmp/forged.txt' })
  let pluginDrops = 0
  f.dispatch('dragenter')
  assert.equal(f.dispatch('dragover').defaultPrevented, true)
  const drop = f.dispatch('drop', { files: [file] }, () => pluginDrops++)
  assert.equal(drop.defaultPrevented, true)
  assert.equal(drop.propagationStopped, true)
  assert.equal(pluginDrops, 0)
  assert.deepEqual(f.pathReads, [file])
  assert.equal(installMessages(f).length, 1)
  assert.deepEqual(Array.from(installMessages(f)[0][1]), ['/tmp/example.enestplugin'])
})

test('an ordinary unknown file keeps reaching the plugin drop handler', () => {
  const f = fixture()
  const file = f.nativeFile('/tmp/notes.custom', { name: 'forged.enestplugin', path: '/tmp/forged.enestplugin' })
  let pluginOver = 0, pluginDrop = 0
  f.dispatch('dragenter')
  const over = f.dispatch('dragover', {}, () => pluginOver++)
  const drop = f.dispatch('drop', { files: [file] }, () => pluginDrop++)
  assert.equal(over.defaultPrevented, true)
  assert.equal(pluginOver, 1)
  assert.equal(drop.defaultPrevented, false)
  assert.equal(drop.propagationStopped, false)
  assert.equal(pluginDrop, 1)
  assert.equal(installMessages(f).length, 0, 'a renderer-controlled filename/path must not turn a document into an installation')
  assert.ok(f.sent.every(([channel, active]) => channel !== 'install:drop-state' || !active))
})

test('octet-stream files stay unobscured and use their native path to distinguish documents from packages', () => {
  for (const [path, isPackage] of [['/tmp/document.bin', false], ['/tmp/example.enestplugin', true]]) {
    const f = fixture()
    const mime = 'application/octet-stream'
    let pluginDrops = 0
    const enter = f.dispatch('dragenter', { mime })
    const over = f.dispatch('dragover', { mime })
    assert.equal(enter.defaultPrevented, false)
    assert.equal(over.defaultPrevented, true)
    assert.equal(over.propagationStopped, false)
    assert.equal(f.sent.length, 0, 'generic binary MIME must not show an install overlay')
    const drop = f.dispatch('drop', { mime, files: [f.nativeFile(path)] }, () => pluginDrops++)
    assert.equal(drop.defaultPrevented, isPackage)
    assert.equal(drop.propagationStopped, isPackage)
    assert.equal(pluginDrops, isPackage ? 0 : 1)
    assert.equal(installMessages(f).length, isPackage ? 1 : 0)
    if (isPackage) assert.deepEqual(Array.from(installMessages(f)[0][1]), [path])
  }
})

test('untrusted synthetic drag events cannot resolve native paths or start installation', () => {
  const f = fixture()
  const file = f.nativeFile('/tmp/example.enestplugin')
  for (const name of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    const event = f.dispatch(name, { isTrusted: false, mime: 'application/zip', files: [file] })
    assert.equal(event.defaultPrevented, false)
    assert.equal(event.propagationStopped, false)
  }
  assert.equal(f.pathReads.length, 0)
  assert.equal(f.sent.length, 0)
})

test('subframes cannot register a native installation bridge', () => {
  const f = fixture({ isMainFrame: false })
  assert.equal(f.handlers.size, 0)
  f.dispatch('drop', { mime: 'application/zip', files: [f.nativeFile('/tmp/example.enestplugin')] })
  assert.equal(f.pathReads.length, 0)
  assert.equal(f.sent.length, 0)
})
