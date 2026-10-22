import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const directory = dirname(fileURLToPath(import.meta.url))

// Execute the actual source without resolving its Electron/native dependency graph.
function loadTypeScript(fileName, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const module = { exports: {} }
  const require = specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `Unexpected dependency: ${specifier}`)
    return imports[specifier]
  }
  new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
  return module.exports
}

const constants = loadTypeScript(join(directory, '..', '..', 'shared', 'constants.ts'))
const unexpectedCall = () => { throw new Error('Bounds tests must not create windows or invoke host services') }

function fixture() {
  return loadTypeScript(join(directory, 'createShellWindow.ts'), {
    'node:url': { pathToFileURL },
    'node:fs': { existsSync },
    'node:path': { join },
    electron: {
      app: { getAppPath: unexpectedCall },
      BaseWindow: unexpectedCall,
      nativeImage: { createFromPath: unexpectedCall },
      WebContentsView: unexpectedCall
    },
    '@shared/constants': constants,
    '@shared/types/ipc': { IpcChannels: {} },
    '@main/ipc/ipcSecurity': { registerTrustedSurface: unexpectedCall },
    '@main/window/mainWindowState': {
      readMainWindowState: unexpectedCall,
      trackMainWindowState: unexpectedCall
    },
    '@main/dev/devShortcuts': { devShortcutAction: unexpectedCall, toggleDevTools: unexpectedCall }
  })
}

test('default inset preserves the full 36px titlebar and adds default chrome', () => {
  const { getPluginTopInset, getPluginContentBounds } = fixture()
  assert.equal(getPluginTopInset(), 0)
  assert.deepEqual(getPluginContentBounds(0), { x: 0, y: 36, width: 1200, height: 764 })
  assert.deepEqual(getPluginContentBounds(), { x: 0, y: 84, width: 1200, height: 716 })
})

test('collapsed inset gives up at most 28px and preserves the 8px shell reveal strip', () => {
  const { setPluginTopInset, getPluginTopInset, getPluginContentBounds } = fixture()
  for (const input of [28, 36, 100, Number.MAX_VALUE]) {
    setPluginTopInset(input)
    assert.equal(getPluginTopInset(), 28, `inset for ${input}`)
    assert.deepEqual(getPluginContentBounds(0), { x: 0, y: 8, width: 1200, height: 792 })
    assert.deepEqual(getPluginContentBounds(), { x: 0, y: 56, width: 1200, height: 744 })
  }
})

test('NaN and infinities reset a previously collapsed inset to zero', () => {
  const { setPluginTopInset, getPluginTopInset, getPluginContentBounds } = fixture()
  for (const input of [NaN, Infinity, -Infinity]) {
    setPluginTopInset(28)
    setPluginTopInset(input)
    assert.equal(getPluginTopInset(), 0, `inset for ${input}`)
    assert.deepEqual(getPluginContentBounds(0), { x: 0, y: 36, width: 1200, height: 764 })
  }
})

test('negative values reset a previously collapsed inset to zero', () => {
  const { setPluginTopInset, getPluginTopInset, getPluginContentBounds } = fixture()
  for (const input of [-1, -28, -Number.MAX_VALUE]) {
    setPluginTopInset(28)
    setPluginTopInset(input)
    assert.equal(getPluginTopInset(), 0, `inset for ${input}`)
    assert.deepEqual(getPluginContentBounds(0), { x: 0, y: 36, width: 1200, height: 764 })
  }
})

test('none and minimal chrome respect both expanded and collapsed titlebar bounds', () => {
  const { setPluginTopInset, getPluginContentBounds } = fixture()
  for (const { inset, chrome, y, height } of [
    { inset: 0, chrome: 0, y: 36, height: 764 },
    { inset: 0, chrome: 28, y: 64, height: 736 },
    { inset: 28, chrome: 0, y: 8, height: 792 },
    { inset: 28, chrome: 28, y: 36, height: 764 }
  ]) {
    setPluginTopInset(inset)
    assert.deepEqual(getPluginContentBounds(chrome), { x: 0, y, width: 1200, height }, `inset=${inset}, chrome=${chrome}`)
  }
})

test('expanding restores the full titlebar after collapse', () => {
  const { setPluginTopInset, getPluginTopInset, getPluginContentBounds } = fixture()
  setPluginTopInset(28)
  assert.equal(getPluginTopInset(), 28)
  assert.equal(getPluginContentBounds(0).y, 8)
  setPluginTopInset(0)
  assert.equal(getPluginTopInset(), 0)
  assert.deepEqual(getPluginContentBounds(0), { x: 0, y: 36, width: 1200, height: 764 })
  assert.deepEqual(getPluginContentBounds(28), { x: 0, y: 64, width: 1200, height: 736 })
})
