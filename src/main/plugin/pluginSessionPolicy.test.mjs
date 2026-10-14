import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const result = await build({ entryPoints: ['src/main/plugin/pluginSessionPolicy.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))

test('plugin browser requests stay within own package or explicitly configured development origin', () => {
  const policy = { pluginId: 'tools.editor' }
  const allowed = (url, type = 'script') => api.pluginRequestAllowed(policy, url, type)
  assert.equal(allowed('enest://plugin/tools.editor/assets/main.js'), true)
  for (const url of ['enest://plugin/other/index.html', 'enest://media/?path=/secret', 'file:///etc/passwd', 'https://example.com/a', 'http://127.0.0.1:3000/admin', 'ws://localhost:1234/socket']) assert.equal(allowed(url), false, url)
  assert.equal(allowed('data:image/png;base64,AA', 'image'), true)
  assert.equal(allowed('data:text/html,hello', 'mainFrame'), false)
  assert.equal(allowed('blob:enest://plugin/abc', 'subFrame'), false)
  const dev = { ...policy, devUrl: 'http://192.168.1.8:5173' }
  assert.equal(api.pluginRequestAllowed(dev, 'http://192.168.1.8:5173/@vite/client', 'script'), true)
  assert.equal(api.pluginRequestAllowed(dev, 'ws://192.168.1.8:5173/?token=hmr', 'webSocket'), true)
  assert.equal(api.pluginRequestAllowed(dev, 'http://192.168.1.8:5174/secret', 'xhr'), false)
  assert.equal(api.pluginRequestAllowed(dev, 'http://192.168.1.8:5173@evil.example/a', 'script'), false)
})

test('dynamic host endpoints are owner scoped, transport scoped and revocable', () => {
  const policy = { pluginId: 'tools.remote' }
  assert.throws(() => api.allowPluginEndpoint(policy.pluginId, 'https://example.com', 'subFrame'), /loopback/)
  assert.throws(() => api.allowPluginEndpoint(policy.pluginId, 'http://[::1]:4000/', 'subFrame'), /loopback/)
  const one = api.allowPluginEndpoint(policy.pluginId, 'ws://127.0.0.1:4000/random-token', 'webSocket')
  const two = api.allowPluginEndpoint(policy.pluginId, 'ws://127.0.0.1:4000/random-token', 'webSocket')
  assert.equal(api.pluginRequestAllowed(policy, 'ws://127.0.0.1:4000/random-token', 'webSocket'), true)
  assert.equal(api.pluginRequestAllowed(policy, 'ws://127.0.0.1:4000/other-token', 'webSocket'), false)
  assert.equal(api.pluginRequestAllowed({pluginId:'other'}, 'ws://127.0.0.1:4000/random-token', 'webSocket'), false)
  one(); assert.equal(api.pluginRequestAllowed(policy, 'ws://127.0.0.1:4000/random-token', 'webSocket'), true)
  two(); assert.equal(api.pluginRequestAllowed(policy, 'ws://127.0.0.1:4000/random-token', 'webSocket'), false)
  api.allowPluginEndpoint(policy.pluginId, 'http://127.0.0.1:4010/?token=host', 'subFrame')
  assert.equal(api.pluginRequestAllowed(policy, 'http://127.0.0.1:4010/assets/main.js', 'script'), true)
  assert.equal(api.pluginRequestAllowed(policy, 'http://127.0.0.1:4010/', 'mainFrame'), false)
  api.releasePluginEndpoints(policy.pluginId)
  assert.equal(api.pluginRequestAllowed(policy, 'http://127.0.0.1:4010/', 'subFrame'), false)
})

test('session denies browser permission prompts, device access, downloads and arbitrary requests', () => {
  const hooks = {}
  const ses = {
    setPermissionRequestHandler: cb => {hooks.request=cb}, setPermissionCheckHandler: cb => {hooks.check=cb},
    setDevicePermissionHandler: cb => {hooks.device=cb}, setDisplayMediaRequestHandler: cb => {hooks.display=cb},
    webRequest: {onBeforeRequest:cb=>{hooks.before=cb},onHeadersReceived:cb=>{hooks.headers=cb}},
    on: (name, cb) => {hooks[name]=cb}
  }
  api.configurePluginSession(ses, {pluginId:'tools.editor', devUrl:'http://127.0.0.1:5173'})
  for (const permission of ['media','geolocation','notifications','clipboard-read','fileSystem']) hooks.request(null, permission, result => assert.equal(result, false))
  assert.equal(hooks.check(), false); assert.equal(hooks.device(), false)
  hooks.display({}, result => assert.deepEqual(result, {}))
  let cancelled = false; hooks['will-download']({preventDefault:()=>{cancelled=true}}); assert.equal(cancelled,true)
  hooks['file-system-access-restricted']({}, {}, decision => assert.equal(decision, 'deny'))
  hooks.before({url:'file:///tmp/test', resourceType:'xhr'}, result => assert.equal(result.cancel,true))
  hooks.headers({url:'http://127.0.0.1:5173/',resourceType:'mainFrame',responseHeaders:{'content-security-policy':['default-src *']}}, result => {
    assert.equal(result.responseHeaders['content-security-policy'],undefined)
    assert.match(result.responseHeaders['Content-Security-Policy'][0], /wasm-unsafe-eval/)
    assert.doesNotMatch(result.responseHeaders['Content-Security-Policy'][0], /'unsafe-eval'/)
    assert.doesNotMatch(result.responseHeaders['Content-Security-Policy'][0], /\[::1\]/)
  })
})
