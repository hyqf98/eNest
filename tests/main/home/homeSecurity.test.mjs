import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))

test('home contribution validation binds source, entry shape, variants, and version', async () => {
  const result = await build({
    stdin: { contents: `export { validateHomeContribution } from '@main/home/homeContract'; export const nonce=${Math.random()};`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`
  })
  const { validateHomeContribution } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const valid = {
    source: 'com.test.plugin',
    id: 'dashboard',
    version: 2,
    entry: 'homes/dashboard.html',
    variants: ['ink', 'tech']
  }
  assert.deepEqual(validateHomeContribution(valid, 'com.test.plugin'), valid)
  assert.equal(validateHomeContribution({ ...valid, source: 'com.other.plugin' }, 'com.test.plugin'), null)
  assert.equal(validateHomeContribution({ ...valid, entry: '../shell.html' }, 'com.test.plugin'), null)
  assert.equal(validateHomeContribution({ ...valid, entry: 'https://evil.example/home.html' }, 'com.test.plugin'), null)
  assert.equal(validateHomeContribution({ ...valid, variants: ['ink', 'ink'] }, 'com.test.plugin'), null)
  assert.equal(validateHomeContribution({ ...valid, version: 0 }, 'com.test.plugin'), null)
})

test('home references follow existing plugin ID casing and reject malformed references', async () => {
  const result = await build({
    stdin: { contents: `export * from '@main/home/homeSecurity';`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node', tsconfig: `${root}/tsconfig.node.json`
  })
  const { parseHomeReference, isInsideDirectory } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
  const reference = { source: 'com.github.eNest.demo', id: 'dashboard', variant: 'ink' }
  assert.deepEqual(parseHomeReference(reference), reference)
  assert.equal(parseHomeReference({ ...reference, source: 'com/github/eNest/demo' }), null)
  assert.equal(parseHomeReference({ ...reference, source: 'enest.builtin' }), null)
  assert.equal(parseHomeReference({ ...reference, variant: '../shell' }), null)
  assert.equal(isInsideDirectory('/plugins/demo', '/plugins/demo/home.html'), true)
  assert.equal(isInsideDirectory('/plugins/demo', '/plugins/demo-other/home.html'), false)
  assert.equal(isInsideDirectory('/plugins/demo', '/plugins/demo/../private.html'), false)
})
