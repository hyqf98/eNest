import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'
import { verifyReleaseManifest } from './release-manifest.mjs'

export const releaseJobs = ['enest-mac-x64', 'enest-mac-arm64', 'enest-win-x64', 'enest-linux-x64']
const allowedAsset = /\.(?:dmg|zip|exe|AppImage|deb|blockmap)$|^latest(?:-[a-z0-9-]+)?\.yml$|^release-manifest-(?:darwin|win32|linux)-(?:x64|arm64)\.json$/

export async function fileSha512(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

function validateFileName(name) {
  if (typeof name !== 'string' || basename(name) !== name || /[\\/?#]/.test(name) || name === '.' || name === '..') {
    throw new Error(`Update metadata must reference a release asset basename: ${name}`)
  }
}

export function mergeMacMetadata(sources) {
  if (sources.length !== 2 || !sources.some(s => s.arch === 'x64') || !sources.some(s => s.arch === 'arm64')) {
    throw new Error('Both macOS architectures are required')
  }
  const ordered = [...sources].sort((a, b) => a.arch === 'x64' ? -1 : b.arch === 'x64' ? 1 : 0)
  const common = ({ files, path, sha512, releaseDate, ...rest }) => rest
  const first = ordered[0].info
  const files = []
  for (const { arch, info } of ordered) {
    if (!isDeepStrictEqual(common(first), common(info))) throw new Error('macOS update metadata fields/version disagree')
    if (!Array.isArray(info.files) || info.files.length === 0) throw new Error(`macOS ${arch} has no update files`)
    for (const file of info.files) {
      validateFileName(file.url)
      if (!file.url.endsWith(`-${arch}.zip`) && !file.url.endsWith(`-${arch}.dmg`)) {
        throw new Error(`macOS ${arch} metadata contains an unexpected architecture or format: ${file.url}`)
      }
      if (files.some(existing => existing.url === file.url)) throw new Error(`Duplicate update file: ${file.url}`)
      files.push(file)
    }
    for (const ext of ['zip', 'dmg']) {
      if (!info.files.some(file => file.url.endsWith(`-${arch}.${ext}`))) throw new Error(`macOS ${arch} is missing ${ext}`)
    }
  }
  files.sort((a, b) => Number(!a.url.endsWith('.zip')) - Number(!b.url.endsWith('.zip')))
  const legacy = files.find(file => file.url.endsWith('-x64.zip'))
  const dates = ordered.map(({ info }) => info.releaseDate).filter(Boolean)
  if (dates.some(date => !Number.isFinite(Date.parse(date)))) throw new Error('Invalid release date')
  return {
    ...common(first), files, path: legacy.url, sha512: legacy.sha512,
    ...(dates.length ? { releaseDate: dates.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) } : {})
  }
}

export async function assembleRelease(inputDirectory, outputDirectory, { requireManifests = false } = {}) {
  const input = resolve(inputDirectory), output = resolve(outputDirectory)
  if (input === output || output.startsWith(`${input}/`)) throw new Error('Release output must be outside the artifact input directory')
  const assets = new Map(), metadata = [], manifests = []
  for (const job of releaseJobs) {
    const dir = join(input, job)
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !allowedAsset.test(entry.name)) throw new Error(`Unexpected release artifact: ${job}/${entry.name}`)
      const source = join(dir, entry.name)
      if (entry.name.startsWith('release-manifest-')) {
        const platform = job.includes('-mac-') ? 'darwin' : job.includes('-win-') ? 'win32' : 'linux', arch = job.endsWith('-arm64') ? 'arm64' : 'x64'
        if (entry.name !== `release-manifest-${platform}-${arch}.json`) throw new Error(`Unexpected platform manifest: ${job}/${entry.name}`)
        const manifest = JSON.parse(await readFile(source, 'utf8'))
        const names = await verifyReleaseManifest(manifest, dir, { platform, arch })
        manifests.push({ job, name: entry.name, source, manifest, names })
      } else if (entry.name.endsWith('.yml')) {
        metadata.push({ job, name: entry.name, info: yaml.load(await readFile(source, 'utf8'), { schema: yaml.JSON_SCHEMA }) })
      } else {
        if (assets.has(entry.name)) throw new Error(`Release asset name collision: ${entry.name}`)
        assets.set(entry.name, { source, job })
      }
    }
  }
  if (requireManifests && manifests.length !== releaseJobs.length) throw new Error('Every release job must provide a verified native/asset manifest')
  const expectedMetadata = new Map([
    ['enest-mac-x64', 'latest-mac.yml'], ['enest-mac-arm64', 'latest-mac.yml'],
    ['enest-win-x64', 'latest.yml'], ['enest-linux-x64', 'latest-linux.yml']
  ])
  if (metadata.length !== 4) throw new Error('Expected exactly one update metadata file from each build job')
  let version
  for (const { job, name, info } of metadata) {
    if (expectedMetadata.get(job) !== name) throw new Error(`Unexpected metadata channel: ${job}/${name}`)
    expectedMetadata.delete(job)
    if (!info || typeof info.version !== 'string' || !Array.isArray(info.files) || info.files.length === 0) throw new Error(`Invalid metadata: ${job}/${name}`)
    if (version && version !== info.version) throw new Error('Release versions disagree across platforms')
    version = info.version
    for (const file of info.files) {
      validateFileName(file.url)
      const asset = assets.get(file.url)
      if (!asset || asset.job !== job) throw new Error(`Update file is missing from its build job: ${file.url}`)
      if (!file.sha512 || await fileSha512(asset.source) !== file.sha512) throw new Error(`Update sha512 mismatch: ${file.url}`)
      if (file.size != null && (await stat(asset.source)).size !== file.size) throw new Error(`Update size mismatch: ${file.url}`)
    }
  }
  for (const [job, extensions] of [
    ['enest-mac-x64', ['.zip', '.dmg', '.zip.blockmap', '.dmg.blockmap']],
    ['enest-mac-arm64', ['.zip', '.dmg', '.zip.blockmap', '.dmg.blockmap']],
    ['enest-win-x64', ['.exe', '.exe.blockmap']], ['enest-linux-x64', ['.AppImage', '.deb']]
  ]) {
    for (const ext of extensions) {
      if (![...assets].some(([name, asset]) => asset.job === job && name.endsWith(ext))) throw new Error(`${job} is missing ${ext}`)
    }
  }
  for (const report of manifests) {
    if (report.manifest.version !== version) throw new Error('Manifest and update metadata versions disagree')
    const names = [...assets].filter(([, asset]) => asset.job === report.job).map(([name]) => name)
    if (names.length !== report.names.size || names.some(name => !report.names.has(name))) throw new Error(`Unrecorded release asset: ${report.job}`)
  }
  const mac = mergeMacMetadata(metadata.filter(item => item.name === 'latest-mac.yml').map(item => ({ arch: item.job.endsWith('arm64') ? 'arm64' : 'x64', info: item.info })))
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('Release output directory must be empty')
  for (const [name, { source }] of assets) await copyFile(source, join(output, name))
  for (const report of manifests) await copyFile(report.source, join(output, report.name))
  for (const item of metadata.filter(item => item.name !== 'latest-mac.yml')) {
    await writeFile(join(output, item.name), yaml.dump(item.info, { lineWidth: -1, noRefs: true }))
  }
  await writeFile(join(output, 'latest-mac.yml'), yaml.dump(mac, { lineWidth: -1, noRefs: true }))
  return { version, assets: assets.size, metadata: 3, macFiles: mac.files.map(file => file.url) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: node assemble-release.mjs <downloaded-artifacts> <release-output>')
  console.log(JSON.stringify(await assembleRelease(input, output, { requireManifests: true }), null, 2))
}
