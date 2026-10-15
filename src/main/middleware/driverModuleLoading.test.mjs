import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

test('Kafka driver loads with the real external CommonJS package in an ESM utility', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./drivers/kafka.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', tsconfig: 'tsconfig.node.json',
    plugins: [{ name: 'real-kafkajs-external', setup(builder) {
      builder.onResolve({ filter: /^kafkajs$/ }, () => ({ path: import.meta.resolve('kafkajs'), external: true }))
    } }]
  })
  const module = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
  assert.equal(module.kafkaDriver.kind, 'kafka')
  assert.equal(typeof module.kafkaDriver.configsDescribe, 'function')
})
