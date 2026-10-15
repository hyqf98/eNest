import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const output = await build({ entryPoints: ['src/shared/notification.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { normalizeNotification, safeNotificationLink } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
test('legacy and rich notifications normalize into one bounded contract', () => {
  assert.deepEqual(normalizeNotification({ message: '已保存', type: 'success' }), { title: '', body: '已保存', level: 'success', format: 'text', position: 'bottom-right', duration: 4200 })
  assert.deepEqual(normalizeNotification({ title: '说明', body: '**内容**', format: 'markdown', position: 'center', duration: 0 }), { title: '说明', body: '**内容**', format: 'markdown', position: 'center', level: 'info', duration: 0 })
  assert.equal(normalizeNotification({ body: 'a'.repeat(501) }).duration, 0)
  assert.equal(normalizeNotification({ message: 'old JS call', type: 'unknown' }).level, 'info')
  assert.equal(normalizeNotification({ body: 'new', message: 'old', level: 'warn', type: 'error' }).body, 'new')
  for (const value of [null, [], {}, { body: 4 }, { title: 'a'.repeat(121) }, { body: 'a'.repeat(16001) }, { body: 'ok', duration: 1 }, { body: 'ok', duration: Infinity }, { body: 'ok', position: 'fullscreen' }, { body: 'ok', format: 'svg' }]) assert.throws(() => normalizeNotification(value))
})
test('notification links cannot launch custom protocols, credentials or control-character URLs', () => {
  for (const url of ['https://example.com/docs', 'http://example.com/a#b', 'mailto:help@example.com']) assert.equal(safeNotificationLink(url), url)
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/hosts', 'enest://plugin/test', '//example.com', 'https://user:pass@example.com', 'https://example.com/\nonclick', 'https://exa mple.com']) assert.equal(safeNotificationLink(url), undefined)
})
