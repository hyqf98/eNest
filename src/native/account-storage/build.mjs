import { execFileSync } from 'node:child_process'
import { access, cp, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildAccountStorage({ outputDir }) {
  if (!['darwin', 'linux'].includes(process.platform)) return
  const source = dirname(fileURLToPath(import.meta.url)), mac = process.platform === 'darwin'
  const files = [join(source, 'key.c'), join(source, mac ? 'mac.c' : 'linux.c')]
  const output = join(outputDir, 'account-storage.node')
  await cp(join(source, 'account-storage.cjs'), join(outputDir, 'account-storage.cjs'))
  const previous = await stat(output).catch(() => null)
  if (previous && (await Promise.all([...files, fileURLToPath(import.meta.url)].map(file => stat(file)))).every(info => info.mtimeMs <= previous.mtimeMs)) return
  const include = resolve(dirname(process.execPath), '../include/node')
  await access(join(include, 'node_api.h'))
  const flags = mac ? ['-arch', 'arm64', '-arch', 'x86_64', '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'Security', '-framework', 'CoreFoundation', '-Wno-deprecated-declarations']
    : ['-fPIC', '-shared', ...execFileSync('pkg-config', ['--cflags', '--libs', 'libsecret-1'], { encoding: 'utf8' }).trim().split(/\s+/)]
  execFileSync(mac ? 'xcrun' : 'cc', [...(mac ? ['clang'] : []), '-O2', '-DNAPI_VERSION=8', `-I${include}`, ...files, ...flags, '-o', output], { stdio: 'inherit' })
}
