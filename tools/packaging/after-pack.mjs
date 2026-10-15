import { access, copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { listPackage } from '@electron/asar'

// Plugin protocols and their drivers belong to plugin-owned runtime bundles.
const pluginPackages = new Set([
  '@clickhouse/client', '@duckdb/node-api', '@duckdb/node-bindings', '@tdengine/websocket',
  'amqplib', 'cassandra-driver', 'csv-parse', 'kafkajs', 'lossless-json', 'mongodb',
  'mqtt', 'mssql', 'mysql2', 'neo4j-driver', 'oracledb', 'pg', 'pg-query-stream',
  'redis', 'ssh2', 'undici'
])

export function verifyShellArchiveEntries(entries) {
  const paths = entries.map(path => path.replaceAll('\\', '/').replace(/^\//, ''))
  for (const path of paths) {
    if (path.endsWith('.map')) throw new Error(`Source map leaked into release: ${path}`)
    for (const match of path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g)) {
      if (pluginPackages.has(match[1]) || match[1].startsWith('@duckdb/')) throw new Error(`Plugin driver leaked into shell: ${match[1]}`)
    }
  }
  if (!paths.includes('out/licenses/bundled-ui/manifest.json')) throw new Error('Missing bundled UI license manifest; run npm run build before packaging')
}

async function verifyLocales(directory, extension, expected) {
  const actual = (await readdir(directory)).filter(file => file.endsWith(extension)).map(file => file.slice(0, -extension.length)).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error(`Unexpected Electron locales in ${directory}: ${actual.join(', ')}`)
}

export async function verifyElectronResources({ platform, appOutDir, resourcesDir }) {
  if (platform === 'darwin') {
    const framework = join(dirname(resourcesDir), 'Frameworks/Electron Framework.framework/Versions/A')
    const frameworkResources = join(framework, 'Resources')
    for (const file of ['icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak']) await access(join(frameworkResources, file))
    await access(join(framework, 'Electron Framework'))
    await access(join(framework, 'Libraries/libffmpeg.dylib'))
    if (!(await readdir(frameworkResources)).some(file => /^v8_context_snapshot(?:\.[^.]+)?\.bin$/.test(file))) throw new Error('Missing V8 snapshot')
    for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) await access(join(resourcesDir, 'licenses/Electron', file))
    await verifyLocales(resourcesDir, '.lproj', ['en', 'zh_CN', 'zh_TW'])
    await verifyLocales(frameworkResources, '.lproj', ['en', 'zh_CN', 'zh_TW'])
  } else {
    for (const file of ['icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'v8_context_snapshot.bin', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) await access(join(appOutDir, file))
    await access(join(appOutDir, platform === 'win32' ? 'ffmpeg.dll' : 'libffmpeg.so'))
    await verifyLocales(join(appOutDir, 'locales'), '.pak', ['en-US', 'zh-CN', 'zh-TW'])
  }
  const icons = (await readdir(join(resourcesDir, 'icons'))).sort()
  if (JSON.stringify(icons) !== JSON.stringify(['dock-runtime.png', 'enest-icon-256.png'])) throw new Error(`Unexpected runtime icon resources: ${icons.join(', ')}`)
}

async function preserveMacElectronLicenses(appOutDir, resourcesDir) {
  // Electron's ZIP places these outside Electron.app. Keep them inside the final DMG/ZIP app.
  const require = createRequire(import.meta.url)
  const installedDist = join(dirname(require.resolve('electron/package.json')), 'dist')
  const target = join(resourcesDir, 'licenses/Electron')
  await mkdir(target, { recursive: true })
  for (const [sourceName, targetName] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    let copied = false
    for (const root of [appOutDir, installedDist]) {
      try { await copyFile(join(root, sourceName), join(target, targetName)); copied = true; break }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!copied) throw new Error(`Electron license missing from downloaded distribution: ${sourceName}`)
  }
}

export default async function afterPack(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  verifyShellArchiveEntries(listPackage(join(resourcesDir, 'app.asar')))
  if (context.electronPlatformName === 'darwin') await preserveMacElectronLicenses(context.appOutDir, resourcesDir)
  await verifyElectronResources({ platform: context.electronPlatformName, appOutDir: context.appOutDir, resourcesDir })
  console.log(`Verified ${context.electronPlatformName} shell payload, language packs, native runtime resources, and bundled license notices`)
}
