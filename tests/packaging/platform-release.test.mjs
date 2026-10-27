import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { binaryIdentity, fileSha256, verifyNativePayload, verifyPackagedNative } from '../../tools/packaging/native-release.mjs'
import { createReleaseManifest, verifyReleaseManifest } from '../../tools/packaging/release-manifest.mjs'
import { assembleRelease, fileSha512, releaseJobs } from '../../tools/packaging/assemble-release.mjs'

const require = createRequire(import.meta.url)
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher.js')
const { validateConfiguration } = require('app-builder-lib/out/util/config/config')
const config = yaml.load(await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8'))

function binary(format, arch = 'x64') {
  const bytes = Buffer.alloc(512)
  if (format === 'macho') { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4) }
  else if (format === 'fat') {
    bytes.writeUInt32BE(0xcafebabe); bytes.writeUInt32BE(2, 4)
    bytes.writeUInt32BE(0x01000007, 8); bytes.writeUInt32BE(0x0100000c, 28)
  } else if (format === 'elf') {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  } else {
    bytes.write('MZ'); bytes.writeUInt32LE(128, 0x3c); bytes.write('PE\0\0', 128); bytes.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 132)
  }
  return bytes
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'enest-release-20261023-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function nativeFixture(directory, platform, arch = 'x64') {
  await mkdir(directory, { recursive: true })
  if (platform === 'win32') {
    for (const name of ['clipboard-helper.ps1', 'process-memory-helper.ps1']) await writeFile(join(directory, name), 'Write-Output "fixture"\n')
  } else if (platform === 'darwin') {
    for (const name of ['clipboard-helper', 'process-memory-helper']) {
      await writeFile(join(directory, name), binary('fat')); await chmod(join(directory, name), 0o755)
    }
  } else {
    await mkdir(join(directory, 'lib/gio/modules'), { recursive: true }); await mkdir(join(directory, 'licenses'))
    await writeFile(join(directory, 'clipboard-helper'), binary('elf', arch)); await chmod(join(directory, 'clipboard-helper'), 0o755)
    await writeFile(join(directory, 'lib/libfixture.so.1'), binary('elf', arch))
    await writeFile(join(directory, 'lib/gio/modules/README.txt'), 'No extensions')
    await writeFile(join(directory, 'licenses/fixture.copyright'), 'fixture license')
    await writeFile(join(directory, 'THIRD-PARTY-NOTICES.txt'), 'fixture notice')
    await writeFile(join(directory, 'linux-dependencies.json'), JSON.stringify({ format: 1, platform, arch, glibcBuildVersion: '2.35',
      helperSha256: await fileSha256(join(directory, 'clipboard-helper')), dependencies: [{ name: 'libfixture.so.1', sha256: await fileSha256(join(directory, 'lib/libfixture.so.1')) }] }))
  }
}

async function packagedFixture(directory, platform, arch) {
  const appOutDir = join(directory, 'unpacked'), resourcesDir = join(appOutDir, 'resources'), executable = join(appOutDir, platform === 'win32' ? 'eNest.exe' : 'enest')
  await nativeFixture(join(resourcesDir, 'native'), platform, arch)
  await writeFile(executable, binary(platform === 'darwin' ? 'macho' : platform === 'linux' ? 'elf' : 'pe', arch))
  await writeFile(join(directory, `.native-payload-${platform}-${arch}.json`), JSON.stringify({ schemaVersion: 1, platform, arch,
    appOutDir: 'unpacked', resourcesDir: 'unpacked/resources', executable: `unpacked/${platform === 'win32' ? 'eNest.exe' : 'enest'}`, runtimeBinaries: [] }))
  return { appOutDir, resourcesDir, executable }
}

test('binary identity reads Mach-O, universal Mach-O, PE and ELF without executing binaries', () => {
  assert.deepEqual(binaryIdentity(binary('fat')), { format: 'macho', architectures: ['arm64', 'x64'] })
  for (const format of ['macho', 'elf', 'pe']) for (const arch of ['x64', 'arm64']) assert.deepEqual(binaryIdentity(binary(format, arch)), { format, architectures: [arch] })
  assert.throws(() => binaryIdentity(Buffer.alloc(8)), /Truncated/)
  assert.throws(() => binaryIdentity(Buffer.alloc(512)), /Unrecognized/)
  const invalid = binary('pe'); invalid.writeUInt32LE(0xffff, 0x3c)
  assert.throws(() => binaryIdentity(invalid), /Invalid PE/)
})

test('per-platform electron-builder resources exclude foreign helpers from a mixed local native bin', async t => {
  await validateConfiguration(config, { isEnabled: false })
  const root = await workspace(t), source = join(root, 'native/bin')
  await nativeFixture(source, 'darwin'); await nativeFixture(source, 'win32')
  await mkdir(join(root, 'assets/icons'), { recursive: true })
  for (const name of ['dock-runtime.png', 'enest-icon-256.png']) await writeFile(join(root, 'assets/icons', name), 'png')
  for (const [platform, key] of [['darwin', 'mac'], ['win32', 'win']]) {
    const destination = join(root, key)
    const matchers = getFileMatchers(config, 'extraResources', destination, { macroExpander: value => value,
      customBuildOptions: config[key], defaultSrc: root, globalOutDir: destination })
    await copyFiles(matchers)
    assert.equal((await verifyNativePayload({ platform, arch: 'x64', directory: join(destination, 'native') })).files.length, 2)
    assert.equal((await readdir(join(destination, 'icons'))).length, 2)
  }
  assert.ok(config.win.target.some(target => target.target === 'zip'))
})

test('Linux native payload requires genuine matching ELF, dependency digests and glibc baseline', async t => {
  const root = await workspace(t), directory = join(root, 'native')
  await nativeFixture(directory, 'linux')
  const options = { platform: 'linux', arch: 'x64', directory }
  assert.equal((await verifyNativePayload(options)).glibcBuildVersion, '2.35')
  const helper = join(directory, 'clipboard-helper'), metadataFile = join(directory, 'linux-dependencies.json')
  const original = JSON.parse(await readFile(metadataFile, 'utf8'))
  await writeFile(helper, binary('macho'))
  await writeFile(metadataFile, JSON.stringify({ ...original, helperSha256: await fileSha256(helper) }))
  await assert.rejects(verifyNativePayload(options), /Native architecture mismatch/)
  await writeFile(helper, binary('elf')); await writeFile(metadataFile, JSON.stringify(original))
  await writeFile(join(directory, 'lib/libfixture.so.1'), binary('elf', 'arm64'))
  await assert.rejects(verifyNativePayload(options), /sha256 mismatch/)
  await writeFile(join(directory, 'lib/libfixture.so.1'), binary('elf'))
  await writeFile(metadataFile, JSON.stringify({ ...original, glibcBuildVersion: '2.36' }))
  await assert.rejects(verifyNativePayload(options), /glibc 2.35/)
})

test('native payload rejects mixed-platform additions, symbolic links and wrong Electron architecture', async t => {
  const root = await workspace(t), fixture = await packagedFixture(root, 'win32', 'x64'), directory = join(fixture.resourcesDir, 'native')
  await writeFile(join(directory, 'clipboard-helper'), binary('macho'))
  await assert.rejects(verifyNativePayload({ directory, platform: 'win32', arch: 'x64' }), /Unexpected win32/)
  await rm(join(directory, 'clipboard-helper'))
  await symlink(join(directory, 'clipboard-helper.ps1'), join(directory, 'linked.ps1'))
  await assert.rejects(verifyNativePayload({ directory, platform: 'win32', arch: 'x64' }), /symlink forbidden/)
  await rm(join(directory, 'linked.ps1'))
  await writeFile(fixture.executable, binary('pe', 'arm64'))
  await assert.rejects(verifyPackagedNative({ ...fixture, platform: 'win32', arch: 'x64' }), /Electron architecture mismatch/)
})

test('release manifest records final bytes and rejects corrupted assets or changed native payload', async t => {
  const root = await workspace(t), fixture = await packagedFixture(root, 'win32', 'x64'), name = 'eNest-0.2.1-win-x64.zip'
  await writeFile(join(root, name), 'fixture archive bytes')
  const { manifest } = await createReleaseManifest({ directory: root, platform: 'win32', arch: 'x64', version: '0.2.1' })
  assert.equal(manifest.runtimeValidated, false)
  assert.equal(manifest.assets[0].bytes, 21)
  assert.equal(manifest.payload.binaries[0].format, 'pe')
  await verifyReleaseManifest(manifest, root, { platform: 'win32', arch: 'x64' })
  await writeFile(join(root, name), 'corrupt')
  await assert.rejects(verifyReleaseManifest(manifest, root, { platform: 'win32', arch: 'x64' }), /size\/sha256 mismatch/)
  await writeFile(fixture.executable, binary('macho'))
  await assert.rejects(createReleaseManifest({ directory: root, platform: 'win32', arch: 'x64', version: '0.2.1' }), /Electron architecture mismatch/)
})

test('release manifest refuses a locator outside its output directory', async t => {
  const root = await workspace(t)
  await packagedFixture(root, 'win32', 'x64')
  await writeFile(join(root, '.native-payload-win32-x64.json'), JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: 'x64', appOutDir: '../outside', runtimeBinaries: [] }))
  await assert.rejects(createReleaseManifest({ directory: root, platform: 'win32', arch: 'x64', version: '0.2.1' }), /escapes release directory/)
})

test('release assembly requires all target manifests and verifies every final asset before merging', async t => {
  const root = await workspace(t), input = join(root, 'artifacts'), output = join(root, 'release')
  for (const job of releaseJobs) await mkdir(join(input, job), { recursive: true })
  await assert.rejects(assembleRelease(input, output, { requireManifests: true }), /Every release job/)
  for (const job of releaseJobs) {
    const directory = join(root, 'build', job), platform = job.includes('-mac-') ? 'darwin' : job.includes('-win-') ? 'win32' : 'linux', arch = job.endsWith('arm64') ? 'arm64' : 'x64'
    await mkdir(directory, { recursive: true }); await packagedFixture(directory, platform, arch)
    const label = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
    const extensions = platform === 'darwin' ? ['zip', 'dmg', 'zip.blockmap', 'dmg.blockmap'] : platform === 'win32' ? ['exe', 'exe.blockmap', 'zip'] : ['AppImage', 'deb']
    const files = []
    for (const extension of extensions) {
      const name = `eNest-0.2.1-${label}-${arch}.${extension}`, path = join(directory, name)
      await writeFile(path, `${job} ${extension}`)
      await cp(path, join(input, job, name))
      if (!extension.endsWith('blockmap')) files.push({ url: name, sha512: await fileSha512(path), size: (await readFile(path)).length })
    }
    const { path } = await createReleaseManifest({ directory, platform, arch, version: '0.2.1' })
    await cp(path, join(input, job, `release-manifest-${platform}-${arch}.json`))
    const channel = platform === 'darwin' ? 'latest-mac.yml' : platform === 'win32' ? 'latest.yml' : 'latest-linux.yml'
    await writeFile(join(input, job, channel), yaml.dump({ version: '0.2.1', files, path: files[0].url, sha512: files[0].sha512 }))
  }
  const result = await assembleRelease(input, output, { requireManifests: true })
  assert.equal(result.version, '0.2.1')
  assert.equal((await readdir(output)).filter(name => name.startsWith('release-manifest')).length, 4)
  const file = join(input, 'enest-win-x64', 'eNest-0.2.1-win-x64.zip')
  await writeFile(file, 'tampered')
  await assert.rejects(assembleRelease(input, join(root, 'rejected'), { requireManifests: true }), /size\/sha256 mismatch/)
})
