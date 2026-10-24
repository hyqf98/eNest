import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

const machines = { macho: { 0x01000007: 'x64', 0x0100000c: 'arm64' }, elf: { 62: 'x64', 183: 'arm64' }, pe: { 0x8664: 'x64', 0xaa64: 'arm64' } }
export const supportedTargets = new Set(['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64'])

/** Inspect headers, never execute a foreign binary or rely on the build machine's `file` utility. */
export function binaryIdentity(bytes) {
  const arch = (format, machine) => {
    const value = machines[format][machine]
    if (!value) throw new Error(`Unsupported ${format} machine: ${machine}`)
    return value
  }
  if (bytes.length < 20) throw new Error('Truncated native binary')
  const magic = bytes.subarray(0, 4).toString('hex')
  if (magic === 'cffaedfe') return { format: 'macho', architectures: [arch('macho', bytes.readUInt32LE(4))] }
  if (magic === 'cafebabe' || magic === 'cafebabf') {
    const count = bytes.readUInt32BE(4), stride = magic === 'cafebabe' ? 20 : 32
    if (count < 1 || count > 8 || bytes.length < 8 + count * stride) throw new Error('Invalid universal Mach-O header')
    return { format: 'macho', architectures: [...new Set(Array.from({ length: count }, (_, i) => arch('macho', bytes.readUInt32BE(8 + i * stride))))].sort() }
  }
  if (magic === '7f454c46') {
    if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Release ELF must be 64-bit little-endian')
    return { format: 'elf', architectures: [arch('elf', bytes.readUInt16LE(18))] }
  }
  if (bytes.subarray(0, 2).toString() === 'MZ' && bytes.length >= 64) {
    const offset = bytes.readUInt32LE(0x3c)
    if (offset < 64 || offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString('hex') !== '50450000') throw new Error('Invalid PE header')
    return { format: 'pe', architectures: [arch('pe', bytes.readUInt16LE(offset + 4))] }
  }
  throw new Error('Unrecognized native binary format')
}

export async function fileSha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function regularFile(file) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Native payload must be a regular file: ${file}`)
  return info
}

export async function inspectBinary(file) {
  await regularFile(file)
  const handle = await open(file, 'r')
  try {
    const bytes = Buffer.alloc(65536), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return binaryIdentity(bytes.subarray(0, bytesRead))
  } finally { await handle.close() }
}

async function tree(directory, prefix = '') {
  const files = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name), info = await lstat(path), entry = prefix + name
    if (info.isSymbolicLink()) throw new Error(`Native payload symlink forbidden: ${entry}`)
    if (info.isDirectory()) files.push(...await tree(path, `${entry}/`))
    else if (info.isFile()) files.push(entry)
    else throw new Error(`Non-regular native payload: ${entry}`)
  }
  return files.sort()
}

export async function verifyNativePayload({ platform, arch, directory }) {
  if (!supportedTargets.has(`${platform}-${arch}`)) throw new Error(`Unsupported release target: ${platform}-${arch}`)
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Invalid native payload directory')
  const top = (await readdir(directory)).sort(), files = await tree(directory)
  const expected = platform === 'darwin' ? ['clipboard-helper', 'process-memory-helper'] : platform === 'win32'
    ? ['clipboard-helper.ps1', 'process-memory-helper.ps1']
    : ['THIRD-PARTY-NOTICES.txt', 'clipboard-helper', 'lib', 'licenses', 'linux-dependencies.json']
  if (JSON.stringify(top) !== JSON.stringify(expected.sort())) throw new Error(`Unexpected ${platform} native payload: ${top.join(', ')}`)
  let inventory
  if (platform === 'linux') {
    inventory = JSON.parse(await readFile(join(directory, 'linux-dependencies.json'), 'utf8'))
    if (inventory.format !== 1 || inventory.platform !== 'linux' || inventory.arch !== arch || !Array.isArray(inventory.dependencies) || !inventory.dependencies.length) throw new Error('Invalid Linux native dependency inventory')
    const version = /^(\d+)\.(\d+)$/.exec(inventory.glibcBuildVersion || '')
    if (!version || Number(version[1]) !== 2 || Number(version[2]) > 35) throw new Error('Linux release requires the glibc 2.35-or-older build baseline')
    const names = new Set()
    for (const dependency of inventory.dependencies) {
      if (typeof dependency.name !== 'string' || basename(dependency.name) !== dependency.name || /[\\\x00-\x1f]/.test(dependency.name) || !/^lib.+\.so(?:\.[\w.-]+)*$/.test(dependency.name) || names.has(dependency.name)) throw new Error('Invalid Linux dependency name')
      names.add(dependency.name)
      if (await fileSha256(join(directory, 'lib', dependency.name)) !== dependency.sha256) throw new Error(`Linux dependency sha256 mismatch: ${dependency.name}`)
    }
    if (await fileSha256(join(directory, 'clipboard-helper')) !== inventory.helperSha256) throw new Error('Linux helper sha256 mismatch')
    for (const file of files.filter(file => file.startsWith('lib/'))) {
      if (file !== 'lib/gio/modules/README.txt' && !names.has(file.slice(4))) throw new Error(`Unrecorded Linux native dependency: ${file}`)
    }
  }
  const records = []
  for (const path of files) {
    const file = join(directory, path), info = await regularFile(file)
    const binary = platform === 'darwin' || platform === 'linux' && (path === 'clipboard-helper' || inventory.dependencies.some(dep => path === `lib/${dep.name}`))
    let identity = { format: 'data', architectures: [] }
    if (binary) {
      identity = await inspectBinary(file)
      if (identity.format !== (platform === 'darwin' ? 'macho' : 'elf') || !identity.architectures.includes(arch)) throw new Error(`Native architecture mismatch: ${path} is ${identity.format}/${identity.architectures}, expected ${platform}/${arch}`)
      if (!path.startsWith('lib/') && !(info.mode & 0o111)) throw new Error(`Native helper is not executable: ${path}`)
    } else if (platform === 'win32') {
      const text = await readFile(file, 'utf8')
      if (!text.trim() || text.includes('\0') || text.includes('\ufffd')) throw new Error(`Invalid PowerShell source: ${path}`)
      identity = { format: 'powershell-source', architectures: ['portable'] }
    }
    records.push({ path, bytes: info.size, sha256: await fileSha256(file), ...identity })
  }
  return { platform, arch, ...(inventory ? { glibcBuildVersion: inventory.glibcBuildVersion } : {}), files: records }
}

export async function verifyPackagedNative({ platform, arch, appOutDir, resourcesDir, executable, runtimeBinaries = [] }) {
  const native = await verifyNativePayload({ platform, arch, directory: join(resourcesDir, 'native') })
  const binaries = []
  for (const file of [executable, ...runtimeBinaries]) {
    const info = await regularFile(file), identity = await inspectBinary(file)
    const format = platform === 'darwin' ? 'macho' : platform === 'win32' ? 'pe' : 'elf'
    if (identity.format !== format || !identity.architectures.includes(arch)) throw new Error(`Electron architecture mismatch: ${file}`)
    binaries.push({ path: relative(appOutDir, file).replaceAll('\\', '/'), bytes: info.size, sha256: await fileSha256(file), ...identity })
  }
  return { schemaVersion: 1, platform, arch, verification: 'static-payload-only', binaries, native }
}
