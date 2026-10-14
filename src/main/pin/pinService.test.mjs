import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
test('pin close IPC requires the owned WebContents object and its main frame', async () => {
  const ipcMain = new EventEmitter(), windows = []
  class BrowserWindow extends EventEmitter {
    constructor() { super(); this.webContents = { id: 42, mainFrame: {}, executeJavaScript: async () => {} }; this.destroyed = false; windows.push(this) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} async loadURL() {}
  }
  const mocks = {
    electron: { BrowserWindow, ipcMain, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) } },
    '@shared/types/ipc': { IpcChannels: { PluginPinClose: 'pin-close' } },
    '@main/logs/logService': { logWarn() {} },
    '@main/window/createShellWindow': { resolvePreload: path => path }
  }
  const js = ts.transpileModule(readFileSync(new URL('./pinService.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  const api = module.exports
  api.openPin({ pluginId: 'com.test.pin', dataUrl: 'data:image/png;base64,AA==' })
  const win = windows[0]
  ipcMain.emit('pin-close', { sender: win.webContents, senderFrame: {} })
  ipcMain.emit('pin-close', { sender: { id: 42 }, senderFrame: win.webContents.mainFrame })
  assert.equal(win.isDestroyed(), false)
  ipcMain.emit('pin-close', { sender: win.webContents, senderFrame: win.webContents.mainFrame })
  assert.equal(win.isDestroyed(), true)
  assert.deepEqual(api.listPins(), [])
})
