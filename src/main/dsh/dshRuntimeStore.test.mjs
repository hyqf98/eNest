import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
test('DSH runtime uses only the explicit source/dist or release/runtime layout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'enest-dsh-layout-'))
  let pluginRoot = directory, devSource = true
  const createRuntime = (root, version) => {
    const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version }))
    writeFileSync(join(packageRoot, 'lib', 'bin.js'), '')
  }
  const mocks = {
    '@main/paths/pathsService': { getAppPaths: () => ({ data: join(directory, 'data') }) },
    '@main/plugin/PluginRegistry': { pluginRegistry: {
      getRootPath: () => pluginRoot,
      get: () => ({ devSource })
    } }
  }
  const js = ts.transpileModule(readFileSync(new URL('./dshRuntimeStore.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', js)(name => mocks[name] ?? require(name), module, module.exports)
  const api = module.exports
  try {
    createRuntime(join(directory, 'runtime'), 'legacy-source')
    assert.equal(api.bundledRuntimeRoot(), null, 'source preview must not fall back to legacy runtime')
    createRuntime(join(directory, 'dist', 'runtime'), 'release')
    assert.equal(api.bundledRuntimeRoot(), join(directory, 'dist', 'runtime'))
    devSource = false
    pluginRoot = join(directory, 'dist')
    assert.equal(api.bundledRuntimeRoot(), join(directory, 'dist', 'runtime'), 'dist preview is already a release root')
    pluginRoot = directory
    assert.equal(api.bundledRuntimeRoot(), join(directory, 'runtime'), 'installed release reads root/runtime')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
