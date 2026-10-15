import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyElectronResources, verifyShellArchiveEntries } from './after-pack.mjs'

const notice = '/out/licenses/bundled-ui/manifest.json'
test('shell payload permits generic ws and blocks migrated protocol drivers including nested dependencies', () => {
  assert.doesNotThrow(() => verifyShellArchiveEntries([notice, '/node_modules/ws/index.js']))
  for (const entry of ['/node_modules/pg/lib/index.js', '/node_modules/parent/node_modules/@duckdb/node-bindings-darwin-arm64/duckdb.node', '/node_modules/ssh2/lib/index.js', '/node_modules/undici/index.js']) {
    assert.throws(() => verifyShellArchiveEntries([notice, entry]), /Plugin driver leaked/)
  }
  assert.throws(() => verifyShellArchiveEntries([notice, '/out/renderer/assets/index.js.map']), /Source map leaked/)
  assert.throws(() => verifyShellArchiveEntries(['/out/main/index.js']), /license manifest/)
})

test('macOS verification checks both locale locations and preserves required Chromium/FFmpeg resources', async t => {
  const appOutDir = await mkdtemp(join(tmpdir(), 'enest-after-pack-test-'))
  t.after(() => rm(appOutDir, { recursive: true, force: true }))
  const resourcesDir = join(appOutDir, 'eNest.app/Contents/Resources')
  const framework = join(appOutDir, 'eNest.app/Contents/Frameworks/Electron Framework.framework/Versions/A')
  for (const dir of [resourcesDir, join(framework, 'Resources')]) {
    for (const locale of ['en', 'zh_CN', 'zh_TW']) await mkdir(join(dir, `${locale}.lproj`), { recursive: true })
  }
  await mkdir(join(framework, 'Libraries'))
  await mkdir(join(resourcesDir, 'licenses/Electron'), { recursive: true })
  for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) await writeFile(join(resourcesDir, 'licenses/Electron', file), 'license')
  await mkdir(join(resourcesDir, 'icons'))
  for (const icon of ['dock-runtime.png', 'enest-icon-256.png']) await writeFile(join(resourcesDir, 'icons', icon), 'png')
  for (const file of ['icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'v8_context_snapshot.arm64.bin']) await writeFile(join(framework, 'Resources', file), 'runtime')
  await writeFile(join(framework, 'Libraries/libffmpeg.dylib'), 'ffmpeg')
  await writeFile(join(framework, 'Electron Framework'), 'runtime')
  await verifyElectronResources({ platform: 'darwin', appOutDir, resourcesDir })
  await mkdir(join(framework, 'Resources/fr.lproj'))
  await assert.rejects(verifyElectronResources({ platform: 'darwin', appOutDir, resourcesDir }), /Unexpected Electron locales/)
  await rm(join(framework, 'Resources/fr.lproj'), { recursive: true })
  await rm(join(framework, 'Libraries/libffmpeg.dylib'))
  await assert.rejects(verifyElectronResources({ platform: 'darwin', appOutDir, resourcesDir }), { code: 'ENOENT' })
})
