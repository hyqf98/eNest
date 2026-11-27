import { mkdir, cp, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildLinuxHelper } from '../src/native/clipboard/linux-build.mjs'
import { buildProcessMemoryHelper } from '../src/native/process-memory/build.mjs'
import { buildOpenWithHelper } from '../src/native/open-with/build.mjs'
import { buildAccountStorage } from '../src/native/account-storage/build.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const sourceDir = join(root, 'src/native')
const outputDir = join(root, '.cache/native/bin')
await mkdir(outputDir, { recursive: true })
await buildAccountStorage({ outputDir })
await buildProcessMemoryHelper({ outputDir })
await buildOpenWithHelper({ outputDir })
// The Windows helper is portable source, including when producing Windows packages on macOS.
await cp(join(sourceDir, 'clipboard/windows.ps1'), join(outputDir, 'clipboard-helper.ps1'))
// Force-override hotkey helper (WH_KEYBOARD_LL); only Windows consumes it, but copying is harmless elsewhere.
await cp(join(sourceDir, 'hotkey-hook/hotkey-hook.ps1'), join(outputDir, 'hotkey-hook.ps1'))
// Shell icon extractor (ExtractIconEx by IconLocation index); Windows-only consumer.
await cp(join(sourceDir, 'icon-extract/icon-extract.ps1'), join(outputDir, 'icon-extract.ps1'))
if (process.platform === 'darwin') {
  const source = join(sourceDir, 'clipboard/mac.m'), output = join(outputDir, 'clipboard-helper')
  const fresh = await Promise.all([stat(source), stat(output).catch(() => null)])
  if (!fresh[1] || fresh[0].mtimeMs > fresh[1].mtimeMs) execFileSync('xcrun', ['clang', '-arch', 'arm64', '-arch', 'x86_64', '-O2', '-fobjc-arc', '-framework', 'Cocoa', '-framework', 'ApplicationServices', source, '-o', output], { stdio: 'inherit' })
} else if (process.platform === 'linux') {
  await buildLinuxHelper({ source: join(sourceDir, 'clipboard/linux.c'), outputDir })
}
