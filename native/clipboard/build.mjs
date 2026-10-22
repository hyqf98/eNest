import { mkdir, cp, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildLinuxHelper } from './linux-build.mjs'
import { buildProcessMemoryHelper } from '../process-memory/build.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dir = join(root, 'native/bin')
await mkdir(dir, { recursive: true })
await buildProcessMemoryHelper({ root, outputDir: dir })
// The Windows helper is portable source, including when producing Windows packages on macOS.
await cp(join(root, 'native/clipboard/windows.ps1'), join(dir, 'clipboard-helper.ps1'))
if (process.platform === 'darwin') {
  const source = join(root, 'native/clipboard/mac.m'), output = join(dir, 'clipboard-helper')
  const fresh = await Promise.all([stat(source), stat(output).catch(() => null)])
  if (!fresh[1] || fresh[0].mtimeMs > fresh[1].mtimeMs) execFileSync('xcrun', ['clang', '-arch', 'arm64', '-arch', 'x86_64', '-O2', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'ApplicationServices', source, '-o', output], { stdio: 'inherit' })
} else if (process.platform === 'win32') {
  await cp(join(root, 'native/clipboard/windows.ps1'), join(dir, 'clipboard-helper.ps1'))
} else if (process.platform === 'linux') {
  await buildLinuxHelper({ source: join(root, 'native/clipboard/linux.c'), outputDir: dir })
}
