import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = await build({
  entryPoints: [root + 'src/main/plugin/PluginRuntimeScope.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm'
})
const { createRuntimeScope, getRuntimeScope } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))

test('failed cleanup retains the incarnation and retries only unresolved resources', async () => {
  const scope = createRuntimeScope({ pluginId: 'retry', generation: 1, wcId: 1 })
  let stable = 0, attempts = 0
  scope.addDisposer(() => { stable++ })
  scope.addDisposer(() => { if (++attempts === 1) throw new Error('not released') })
  await scope.dispose()
  assert.equal(scope.isClosing, true)
  assert.equal(getRuntimeScope('retry'), scope)
  assert.deepEqual(scope.failures, ['Error: not released'])
  assert.throws(() => createRuntimeScope({ pluginId: 'retry', generation: 2, wcId: 2 }), /already exists/)
  await scope.dispose()
  assert.equal(stable, 1)
  assert.equal(attempts, 2)
  assert.deepEqual(scope.failures, [])
  assert.equal(getRuntimeScope('retry'), undefined)
})

test('deadline retries join an in-flight release rather than executing it twice', async () => {
  const scope = createRuntimeScope({ pluginId: 'deadline', generation: 1, wcId: 3 })
  let complete, attempts = 0
  scope.addDisposer(() => { attempts++; return new Promise(resolve => { complete = resolve }) })
  await scope.dispose(Date.now())
  assert.equal(getRuntimeScope('deadline'), scope)
  const retry = scope.dispose()
  complete()
  await retry
  assert.equal(attempts, 1)
  assert.equal(getRuntimeScope('deadline'), undefined)
})
