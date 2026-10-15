import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// Keep the target distro's loader and glibc together. Everything else is shipped.
const systemRuntime = /^(?:linux-vdso\.so\.\d+|ld-linux[^/]*\.so(?:\.\d+)*|ld64\.so(?:\.\d+)*|lib(?:c|m|mvec|pthread|dl|rt|resolv|util|anl|BrokenLocale|thread_db|c_malloc_debug|nss_[A-Za-z0-9_]+)\.so(?:\.\d+)*)$/
const cleanEnvironment = { ...process.env, LC_ALL: 'C', LD_LIBRARY_PATH: '', LD_PRELOAD: '', LD_AUDIT: '' }
const run = (file, args) => execFileSync(file, args, { env: cleanEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sha256 = data => createHash('sha256').update(data).digest('hex')

export function parseDependencies(output) {
  const libraries = new Map()
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.includes('=> not found')) throw new Error(`Unresolved native dependency: ${line}`)
    const mapped = line.match(/^(\S+)\s+=>\s+(.+)\s+\(0x[0-9a-f]+\)$/i)
    if (mapped) {
      const [, name] = mapped, file = mapped[2].trim()
      if (!isAbsolute(file) || basename(name) !== name || name === '.' || name === '..') throw new Error(`Invalid native dependency: ${line}`)
      if (!systemRuntime.test(name)) libraries.set(name, file)
      continue
    }
    const direct = line.match(/^(\S+)\s+\(0x[0-9a-f]+\)$/i)
    if (direct && systemRuntime.test(basename(direct[1]))) continue
    throw new Error(`Unrecognized loader dependency: ${line}`)
  }
  if (!libraries.size) throw new Error('No Linux shared libraries were found; use a glibc Linux builder')
  return libraries
}

async function packageNotice(file, licenseDir) {
  // Debian/Ubuntu builders can retain the exact upstream notices of each DSO.
  // Other Linux builders still get hashes and source paths in the manifest.
  const alternatives = [file, file.startsWith('/usr/') ? file.slice(4) : `/usr${file}`]
  for (const candidate of alternatives) {
    try {
      const owner = run('dpkg-query', ['--search', candidate]).split('\n')[0].split(': /')[0]
      const packageName = owner.split(':')[0]
      if (!/^[a-z0-9][a-z0-9+.-]*$/.test(packageName)) continue
      const version = run('dpkg-query', ['--show', '--showformat=${source:Package}\t${source:Version}', owner]).split('\t')
      const destination = `${packageName}.copyright`
      await cp(`/usr/share/doc/${packageName}/copyright`, join(licenseDir, destination))
      return { package: owner, sourcePackage: version[0], sourceVersion: version[1], notice: `licenses/${destination}` }
    } catch { /* Package ownership tools are only a build-time enhancement. */ }
  }
  return { notice: null }
}

export async function buildLinuxHelper({ source, outputDir }) {
  if (process.platform !== 'linux') throw new Error('The Linux helper must be built on Linux for the release architecture')
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error(`Unsupported Linux release architecture: ${process.arch}`)
  const requestedArch = process.env.ENEST_NATIVE_ARCH || process.env.npm_config_arch
  if (requestedArch && requestedArch !== process.arch) throw new Error(`Build Linux ${requestedArch} in a matching Linux builder; current Node architecture is ${process.arch}`)
  source = resolve(source)
  outputDir = resolve(outputDir)
  await mkdir(dirname(outputDir), { recursive: true })
  const staging = await mkdtemp(join(dirname(outputDir), '.clipboard-linux-build-'))
  try {
    const helper = join(staging, 'clipboard-helper'), libraryDir = join(staging, 'lib'), licenseDir = join(staging, 'licenses')
    await mkdir(libraryDir)
    await mkdir(join(libraryDir, 'gio', 'modules'), { recursive: true })
    await writeFile(join(libraryDir, 'gio', 'modules', 'README.txt'), 'Intentionally no GIO extension modules. Keep this directory in packaged builds to isolate the bundled GIO from system modules.\n')
    await mkdir(licenseDir)
    run('patchelf', ['--version'])
    // gio-unix-2.0 提供 gio/gunixfdlist.h 等平台头文件，gio-2.0 不含
    const flags = run('pkg-config', ['--cflags', '--libs', 'gio-2.0', 'gio-unix-2.0', 'json-glib-1.0', 'x11', 'xtst']).split(/\s+/)
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', helper, '-Wl,-rpath,$ORIGIN/lib', ...flags], { env: cleanEnvironment, stdio: 'inherit' })
    run('patchelf', ['--set-rpath', '$ORIGIN/lib', helper])
    const libraries = parseDependencies(run('ldd', [helper]))
    const dependencies = []
    for (const [name, locatedFile] of libraries) {
      const origin = await realpath(locatedFile), target = join(libraryDir, name)
      if (!(await stat(origin)).isFile()) throw new Error(`Dependency is not a regular file: ${origin}`)
      const bytes = await readFile(origin)
      if (bytes.subarray(0, 4).toString('hex') !== '7f454c46') throw new Error(`Dependency is not ELF: ${origin}`)
      await cp(origin, target)
      // Each DSO needs its own path: executable RUNPATH does not cover grandchildren.
      run('patchelf', ['--set-rpath', '$ORIGIN', target])
      dependencies.push({ name, originalPath: origin, originalSha256: sha256(bytes), sha256: sha256(await readFile(target)), ...await packageNotice(origin, licenseDir) })
    }
    const linked = parseDependencies(run('ldd', [helper]))
    for (const [name, file] of linked) {
      if (!(await realpath(file)).startsWith(`${libraryDir}${sep}`)) throw new Error(`Bundle still depends on a system library: ${name} -> ${file}`)
    }
    if (linked.size !== libraries.size) throw new Error('Shared-library dependency set changed while bundling')
    const report = process.report.getReport().header
    if (!report.glibcVersionRuntime) throw new Error('Release helpers require a glibc builder, not musl')
    await writeFile(join(staging, 'linux-dependencies.json'), JSON.stringify({
      format: 1, platform: 'linux', arch: process.arch, glibcBuildVersion: report.glibcVersionRuntime,
      sourceSha256: sha256(await readFile(source)), helperSha256: sha256(await readFile(helper)),
      runtimeRequirement: 'Matching architecture and a glibc release at least as new as the oldest supported build image; no helper CLI or non-glibc library installation is required.',
      dependencies
    }, null, 2) + '\n')
    await writeFile(join(staging, 'THIRD-PARTY-NOTICES.txt'), [
      'eNest Linux clipboard helper shared libraries',
      'The lib directory contains dynamically linked dependencies. Their available upstream copyright and license notices are in licenses/.',
      'linux-dependencies.json records exact source packages, versions, hashes and original locations for release reproducibility.',
      'The operating system supplies its own glibc and ELF loader; these are deliberately not redistributed here.',
      '', ...dependencies.map(item => `${item.name}: ${item.package || item.originalPath}; ${item.notice || 'notice must be supplied by the release builder'}`), ''
    ].join('\n'))
    // Publish only after every dependency resolves from the completed bundle.
    await mkdir(outputDir, { recursive: true })
    for (const entry of ['clipboard-helper', 'lib', 'licenses', 'linux-dependencies.json', 'THIRD-PARTY-NOTICES.txt']) {
      await rm(join(outputDir, entry), { recursive: true, force: true })
      await rename(join(staging, entry), join(outputDir, entry))
    }
    console.log(`Linux ${process.arch}: bundled clipboard helper and ${dependencies.length} shared libraries (${report.glibcVersionRuntime} glibc builder)`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
