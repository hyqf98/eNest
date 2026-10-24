import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import Ajv from 'ajv'

const require = createRequire(import.meta.url)
function load(entry) {
  const output = buildSync({ entryPoints: [resolve(entry)], platform: 'node', format: 'cjs', bundle: true, write: false,
    alias: { '@shared': resolve('src/shared') } }).outputFiles[0].text
  const module = { exports: {} }
  new Function('module', 'exports', 'require', output)(module, module.exports, require)
  return module.exports
}
const assets = load('src/main/theme/themeChromeAssets.ts')
const { validateThemePackV2 } = load('src/shared/theme/appearance.ts')
const { DEFAULT_THEME_PACKAGE } = load('src/shared/theme/defaultTheme/package.ts')

test('theme chrome schema and runtime agree; executable entries stay package-relative', () => {
  const source = 'com.github.eNest.chrome-fixture'
  const pack = structuredClone(DEFAULT_THEME_PACKAGE.contributes.themePacks[0])
  pack.source = source; pack.id = 'chrome-fixture'; delete pack.home
  pack.chrome = { version: 1, classic: { entry: 'chrome/tabs.html' }, rail: { entry: 'chrome/rail.html' } }
  const schema = JSON.parse(readFileSync('src/shared/pluginManifest.schema.json', 'utf8'))
  const validate = new Ajv({ strict: false }).compile({ $ref: '#/$defs/themePackV2', $defs: schema.$defs })
  assert.equal(validate(pack), true, JSON.stringify(validate.errors))
  assert.deepEqual(validateThemePackV2(pack, source).chrome, pack.chrome)
  for (const entry of ['../secret.html', 'https://example.com/a.html', '/a.html', 'backend/index.html', 'node_modules/app.html', 'runtime/a.html']) {
    const bad = { ...pack, chrome: { version: 1, classic: { entry } } }
    assert.equal(validate(bad), false, entry)
    assert.throws(() => validateThemePackV2(bad, source), /chrome/)
  }
  assert.throws(() => validateThemePackV2({ ...pack, chrome: { version: 1 } }, source), /renderer/)
})

test('resource URLs are canonical, scoped and exclude private trees', () => {
  const key = 'abcdef123456'
  const url = assets.chromeAssetUrl(key, 'chrome/tabs.html')
  assert.equal(assets.parseChromeAssetUrl(url, key), 'chrome/tabs.html')
  for (const bad of [url + '?x', url + '#x', url.replace('abcdef', 'fedcba'), url.replace('tabs', '%74abs'), url.replace('/chrome/', '/chrome%2f'), 'file:///etc/passwd']) {
    assert.equal(assets.parseChromeAssetUrl(bad, key), null, bad)
  }
  for (const path of ['backend/index.js', 'runtime/private.json', 'node_modules/a.js', 'src/a.js', 'plugin.json', '../a.js']) assert.equal(assets.chromeAssetPath(path), false)
})

test('asset reads reject symlinks and oversized files; CSP denies remote execution, frames and workers', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'enest-chrome-assets-')))
  try {
    await mkdir(join(root, 'chrome'))
    await writeFile(join(root, 'chrome/tabs.html'), '<!doctype html><button>Tabs</button>')
    const bytes = await assets.readChromeAsset(root, root, 'chrome/tabs.html')
    assert.match(new TextDecoder().decode(bytes), /Tabs/)
    await symlink(join(root, 'chrome/tabs.html'), join(root, 'chrome/link.html'))
    assert.equal(await assets.readChromeAsset(root, root, 'chrome/link.html'), null)
    await writeFile(join(root, 'chrome/huge.js'), Buffer.alloc(8 * 1024 * 1024 + 1))
    assert.equal(await assets.readChromeAsset(root, root, 'chrome/huge.js'), null)
    const response = assets.chromeAssetResponse(new Request('https://example.invalid'), 200, bytes, 'tabs.html')
    const policy = response.headers.get('Content-Security-Policy')
    assert.match(policy, /default-src 'none'/); assert.match(policy, /worker-src 'none'/); assert.match(policy, /frame-src 'none'/)
    assert.doesNotMatch(policy, /unsafe-eval|https:/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
