import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createPackage } from '@electron/asar'
import yaml from 'js-yaml'
import { verifyShellArchive, verifyShellArchiveEntries, verifyShellBundleSource } from '../../tools/packaging/after-pack.mjs'

const require = createRequire(import.meta.url)
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js')
const config = yaml.load(await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8'))
const licenseManifest = 'out/licenses/bundled-ui/manifest.json'
const retiredChannels = [
  'plugin:pin-close', 'plugin:region-confirm', 'plugin:region-cancel',
  'plugin:recorder-started', 'plugin:recorder-failed', 'plugin:recorder-audio-unavailable',
  'plugin:recorder-chunk', 'plugin:recorder-stopped'
]

test('dependency filtering excludes development inputs without dropping Node runtime exports or notices', () => {
  const root = resolve('shell-cleanup-fixture')
  const matcher = getNodeModuleFileMatcher(root, `${root}-out`, value => value, {}, { config, debugLogger: { isEnabled: false } })
  const filter = (path, directory = false) => matcher.createFilter()(join(root, path), { isDirectory: () => directory })
  for (const file of ['.eslintrc.yml', 'fixtures/schema.js', 'index.spec.js']) {
    assert.equal(filter(`node_modules/json-schema-traverse/spec/${file}`), false)
    assert.equal(filter(`node_modules/ajv/node_modules/json-schema-traverse/spec/${file}`), false)
  }
  assert.equal(filter('node_modules/json-schema-traverse/spec', true), false)
  for (const path of ['node_modules/zod/src', 'node_modules/nested/node_modules/zod/src']) {
    assert.equal(filter(path, true), false)
    assert.equal(filter(`${path}/v4/core/index.ts`), false)
  }
  for (const path of ['node_modules/zod/index.d.cts', 'node_modules/nested/node_modules/runtime/types/index.d.mts']) assert.equal(filter(path), false)
  for (const path of [
    'node_modules/zod/index.cjs', 'node_modules/zod/v4/core/index.js', 'node_modules/zod/LICENSE',
    'node_modules/runtime/src/runtime.js', 'node_modules/@modelcontextprotocol/server/dist/index.mjs',
    'node_modules/json-schema-traverse/index.js', 'node_modules/json-schema-traverse/package.json',
    'node_modules/json-schema-traverse/LICENSE', 'node_modules/another-runtime/spec/runtime.json',
    'node_modules/json-schema-traverse/special/runtime.json'
  ]) assert.equal(filter(path), true, path)
})

test('archive entry guard rejects the discarded dependency fixture on every path style', () => {
  for (const path of [
    '/node_modules/json-schema-traverse/spec',
    '/node_modules/json-schema-traverse/spec/fixtures/schema.js',
    '\\node_modules\\ajv\\node_modules\\json-schema-traverse\\spec\\index.spec.js'
  ]) assert.throws(() => verifyShellArchiveEntries([licenseManifest, path]), /Dependency test fixture leaked/)
  for (const path of ['/node_modules/zod/src/index.ts', '\\node_modules\\nested\\node_modules\\zod\\src', '/node_modules/types/index.d.cts', '/node_modules/types/index.d.mts']) {
    assert.throws(() => verifyShellArchiveEntries([licenseManifest, path]), /Development dependency files leaked/)
  }
  assert.doesNotThrow(() => verifyShellArchiveEntries([
    licenseManifest, '/node_modules/json-schema-traverse/index.js', '/node_modules/another-runtime/spec/runtime.json'
  ]))
  for (const name of ['mockShellApi', 'MarketPage']) {
    assert.throws(() => verifyShellArchiveEntries([licenseManifest, `/out/renderer/assets/${name}-fixture.js`]), /Development preview chunk leaked/)
  }
})

test('bundle guard rejects all eight retired plugin IPC names without banning current generic channels', () => {
  for (const channel of retiredChannels) {
    assert.throws(() => verifyShellBundleSource('out/main/index.js', `const channel = ${JSON.stringify(channel)};`), /Retired plugin IPC leaked/)
  }
  assert.doesNotThrow(() => verifyShellBundleSource('out/preload/pluginPreload.cjs', 'const channels = ["plugin:call", "plugin:event"];'))
})

test('archive guard reads actual packed JavaScript and refuses stale preload protocol bytes', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'enest-shell-cleanup-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  for (const [name, source] of [['clean', 'const channel = "plugin:call";'], ['stale', 'const channel = "plugin:recorder-chunk";']]) {
    const root = join(temporary, name), archive = join(temporary, 'app.asar')
    for (const [file, content] of [[licenseManifest, '{}'], ['out/preload/pluginPreload.cjs', source]]) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), content)
    }
    await createPackage(root, archive)
    if (name === 'clean') assert.doesNotThrow(() => verifyShellArchive(archive))
    else assert.throws(() => verifyShellArchive(archive), /Retired plugin IPC leaked into shell bundle out\/preload\/pluginPreload\.cjs/)
  }
})

test('unused direct development dependencies are absent from the project and synchronized lock root', async () => {
  const project = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'))
  assert.deepEqual(lock.packages[''].dependencies, project.dependencies)
  assert.deepEqual(lock.packages[''].devDependencies, project.devDependencies)
  for (const name of ['@radix-ui/react-popover', 'tsx']) {
    assert.equal(Object.hasOwn(project.devDependencies, name), false)
    assert.equal(Object.hasOwn(lock.packages, `node_modules/${name}`), false)
  }
})
