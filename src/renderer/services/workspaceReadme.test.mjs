import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('./workspaceReadme.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
new Function('module', 'exports', source)(module, module.exports)
const { loadWorkspaceReadme } = module.exports
const pluginId = 'com.github.eNest.todos'
const url = `enest-home://catalog/${pluginId}/readme`

test('README fetch is constrained to the exact public slot and rejects remote or another plugin resources', async () => {
  let calls = 0
  const fetcher = async () => { calls++; return new Response('unused') }
  for (const candidate of ['https://example.com/README.md', 'enest-home://surface/README.md', 'enest-home://catalog/other/readme', `${url}?path=secret`, `${url}#fragment`, `${url}/../icon`]) {
    await assert.rejects(loadWorkspaceReadme(pluginId, candidate, new AbortController().signal, fetcher), /Unsupported/)
  }
  assert.equal(calls, 0)
})

test('README returns plain text without expanding markup or following redirects', async () => {
  const signal = new AbortController().signal
  const text = '<img src="https://example.com/tracker">\n<script>alert(1)</script>'
  const result = await loadWorkspaceReadme(pluginId, url, signal, async (resource, options) => {
    assert.equal(resource, url)
    assert.equal(options.redirect, 'error')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.signal, signal)
    return new Response(`  ${text}  `)
  })
  assert.equal(result, text)
  const redirected = new Response('unsafe')
  Object.defineProperty(redirected, 'url', { value: 'https://example.com/readme' })
  await assert.rejects(loadWorkspaceReadme(pluginId, url, signal, async () => redirected), /unavailable/)
})

test('missing, empty and over-limit README bodies fail safely or remain empty', async () => {
  const signal = new AbortController().signal
  await assert.rejects(loadWorkspaceReadme(pluginId, url, signal, async () => new Response('', { status: 404 })), /unavailable/)
  assert.equal(await loadWorkspaceReadme(pluginId, url, signal, async () => new Response(' \n ')), '')
  await assert.rejects(loadWorkspaceReadme(pluginId, url, signal, async () => new Response('small', { headers: { 'content-length': '1048577' } })), /too large/)
  await assert.rejects(loadWorkspaceReadme(pluginId, url, signal, async () => new Response('x'.repeat(1048577))), /too large/)
})
