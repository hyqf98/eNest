import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import yaml from 'js-yaml'
import { assembleRelease, fileSha512, mergeMacMetadata, releaseJobs } from './assemble-release.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { MacUpdater } = require('electron-updater/out/MacUpdater')
const { resolveFiles } = require('electron-updater/out/providers/Provider')
const loadFixture = async arch => yaml.load(await readFile(join(here, 'fixtures/release-metadata', `latest-mac-${arch}.yml`), 'utf8'), { schema: yaml.JSON_SCHEMA })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'enest-release-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'artifacts'), output = join(root, 'release')
  for (const job of releaseJobs) {
    const dir = join(input, job)
    await mkdir(dir, { recursive: true })
    const arch = job.endsWith('arm64') ? 'arm64' : 'x64'
    const info = job.includes('-mac-') ? await loadFixture(arch) : {
      version: '1.2.3', files: [{ url: job.includes('-win-') ? 'eNest-1.2.3-win-x64.exe' : 'eNest-1.2.3-linux-x86_64.AppImage' }], releaseDate: '2026-10-15T06:00:00.000Z'
    }
    for (const entry of info.files) {
      const path = join(dir, entry.url), content = `fixture bytes for ${entry.url}`
      await writeFile(path, content)
      entry.sha512 = await fileSha512(path)
      entry.size = Buffer.byteLength(content)
      if (!job.includes('-linux-')) await writeFile(`${path}.blockmap`, 'fixture blockmap')
    }
    if (job.includes('-linux-')) await writeFile(join(dir, 'eNest-1.2.3-linux-amd64.deb'), 'fixture deb')
    info.path = info.files[0].url
    info.sha512 = info.files[0].sha512
    const name = job.includes('-mac-') ? 'latest-mac.yml' : job.includes('-win-') ? 'latest.yml' : 'latest-linux.yml'
    await writeFile(join(dir, name), yaml.dump(info))
  }
  return { input, output }
}

test('merged fixture metadata selects the correct ZIP through the real electron-updater architecture filter', async () => {
  const sources = await Promise.all(['arm64', 'x64'].map(async arch => ({ arch, info: await loadFixture(arch) })))
  const info = mergeMacMetadata(sources)
  assert.equal(info.files.length, 4)
  assert.equal(info.path, 'eNest-1.2.3-mac-x64.zip')
  assert.equal(info.sha512, 'fixture-x64-zip')
  assert.equal(info.releaseDate, '2026-10-15T06:00:30.000Z')
  const files = resolveFiles(info, new URL('https://example.invalid/releases/'))
  for (const [isArm64, arch] of [[false, 'x64'], [true, 'arm64']]) {
    const selected = MacUpdater.filterFilesForArch(files, isArm64)
    assert.equal(selected.length, 2)
    assert.ok(selected.every(file => file.url.pathname.includes(`-${arch}.`)))
    assert.ok(selected.some(file => file.url.pathname.endsWith(`-${arch}.zip`)))
  }
})

test('assembles all four artifacts without losing blockmaps or platform metadata', async t => {
  const { input, output } = await fixture(t)
  const result = await assembleRelease(input, output)
  assert.equal(result.version, '1.2.3')
  assert.equal(result.macFiles.length, 4)
  assert.equal(result.assets, 12)
  assert.equal((await readdir(output)).length, 15)
  const mac = yaml.load(await readFile(join(output, 'latest-mac.yml'), 'utf8'))
  assert.equal(mac.files.length, 4)
  assert.equal(mac.files.find(file => file.url.endsWith('arm64.zip')).blockMapSize, 110)
})

test('refuses corrupted asset hashes before creating release output', async t => {
  const { input, output } = await fixture(t)
  await writeFile(join(input, 'enest-mac-arm64/eNest-1.2.3-mac-arm64.zip'), 'corrupted')
  await assert.rejects(assembleRelease(input, output), /sha512 mismatch/)
  await assert.rejects(readdir(output), { code: 'ENOENT' })
})

test('refuses mismatched mac versions and missing zip architecture', async () => {
  const x64 = await loadFixture('x64'), arm64 = await loadFixture('arm64')
  await assert.rejects(async () => mergeMacMetadata([{ arch: 'x64', info: x64 }, { arch: 'arm64', info: { ...arm64, version: '1.2.4' } }]), /disagree/)
  await assert.rejects(async () => mergeMacMetadata([{ arch: 'x64', info: x64 }, { arch: 'arm64', info: { ...arm64, files: arm64.files.filter(file => file.url.endsWith('.dmg')) } }]), /missing zip/)
})

test('refuses asset collisions and unexpected channels instead of silently overwriting', async t => {
  const { input, output } = await fixture(t)
  await writeFile(join(input, 'enest-win-x64/eNest-1.2.3-mac-x64.zip'), 'collision')
  await assert.rejects(assembleRelease(input, output), /collision/)
  await rm(join(input, 'enest-win-x64/eNest-1.2.3-mac-x64.zip'))
  await writeFile(join(input, 'enest-win-x64/beta.yml'), 'version: 1.2.3')
  await assert.rejects(assembleRelease(input, output), /Unexpected release artifact/)
})
