import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileSha256, supportedTargets, verifyPackagedNative } from './native-release.mjs'

const assetExtension = /\.(?:dmg|zip|exe|AppImage|deb)(?:\.blockmap)?$/
const platformLabel = { darwin: 'mac', win32: 'win', linux: 'linux' }
const manifestName = (platform, arch) => `release-manifest-${platform}-${arch}.json`

export async function createReleaseManifest({ directory, platform, arch, version }) {
  if (!supportedTargets.has(`${platform}-${arch}`)) throw new Error(`Unsupported release target: ${platform}-${arch}`)
  const location = join(directory, `.native-payload-${platform}-${arch}.json`), locationInfo = await lstat(location)
  if (!locationInfo.isFile() || locationInfo.isSymbolicLink()) throw new Error('Invalid native payload locator')
  const paths = JSON.parse(await readFile(location, 'utf8'))
  if (paths.schemaVersion !== 1 || paths.platform !== platform || paths.arch !== arch || !Array.isArray(paths.runtimeBinaries)) throw new Error('Native payload locator target mismatch')
  const local = path => {
    if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Native payload locator escapes release directory')
    return join(directory, path)
  }
  const payload = await verifyPackagedNative({ platform, arch, appOutDir: local(paths.appOutDir), resourcesDir: local(paths.resourcesDir),
    executable: local(paths.executable), runtimeBinaries: paths.runtimeBinaries.map(local) })
  const assets = []
  const suffix = `-${platformLabel[platform]}-${arch}.`
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.includes(`-${version}-`) || !entry.name.includes(suffix) || !assetExtension.test(entry.name)) continue
    const path = join(directory, entry.name), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release asset is not a regular file: ${entry.name}`)
    assets.push({ name: entry.name, bytes: info.size, sha256: await fileSha256(path) })
  }
  if (!assets.length) throw new Error(`No ${platform}-${arch} release assets found`)
  const manifest = { schemaVersion: 1, version, platform, arch, generatedAt: new Date().toISOString(),
    builtOn: { platform: process.platform, arch: process.arch, node: process.version },
    runtimeValidated: false, payload, assets: assets.sort((a, b) => a.name.localeCompare(b.name)) }
  await verifyReleaseManifest(manifest, directory, { platform, arch })
  const path = join(directory, manifestName(platform, arch))
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
  return { path, manifest }
}

export async function verifyReleaseManifest(manifest, directory, { platform, arch }) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch || typeof manifest.version !== 'string' || !supportedTargets.has(`${platform}-${arch}`)) throw new Error('Release manifest target/version mismatch')
  const payload = manifest.payload
  if (payload?.schemaVersion !== 1 || payload.platform !== platform || payload.arch !== arch || payload.verification !== 'static-payload-only' || payload.native?.platform !== platform || payload.native?.arch !== arch || !payload.native.files?.length || !payload.binaries?.length) throw new Error('Missing native architecture verification')
  const expected = platform === 'darwin' ? 'macho' : platform === 'win32' ? 'pe' : 'elf'
  for (const binary of payload.binaries) {
    if (binary.format !== expected || !binary.architectures?.includes(arch)) throw new Error('Release binary architecture mismatch')
  }
  for (const file of [...payload.binaries, ...payload.native.files]) {
    if (typeof file.path !== 'string' || isAbsolute(file.path) || /[\\\x00-\x1f]/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid native payload record')
  }
  for (const file of payload.native.files) {
    if (['macho', 'elf', 'pe'].includes(file.format)) {
      if (file.format !== expected || !file.architectures?.includes(arch)) throw new Error('Native manifest architecture mismatch')
    } else if (!(platform === 'win32' && file.format === 'powershell-source' || platform === 'linux' && file.format === 'data')) throw new Error('Invalid native manifest format')
  }
  const recorded = new Set()
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('Empty release asset manifest')
  for (const asset of manifest.assets) {
    if (typeof asset.name !== 'string' || basename(asset.name) !== asset.name || /[\\\x00-\x1f]/.test(asset.name) || !assetExtension.test(asset.name) || recorded.has(asset.name) || !asset.name.includes(`-${manifest.version}-${platformLabel[platform]}-${arch}.`)) throw new Error('Invalid release asset name')
    recorded.add(asset.name)
    const file = join(directory, asset.name), info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.bytes || await fileSha256(file) !== asset.sha256) throw new Error(`Release asset size/sha256 mismatch: ${asset.name}`)
  }
  return recorded
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, platform, arch] = process.argv.slice(2)
  if (!directory || !platform || !arch) throw new Error('Usage: node release-manifest.mjs <release-directory> <darwin|win32|linux> <arch>')
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const result = await createReleaseManifest({ directory: resolve(directory), platform, arch, version: pkg.version })
  console.log(JSON.stringify({ path: result.path, runtimeValidated: false, assets: result.manifest.assets }, null, 2))
}
