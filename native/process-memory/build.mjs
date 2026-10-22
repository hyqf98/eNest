import { cp, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Called by native:build; generated artifacts stay in the already-packaged native/bin. */
export async function buildProcessMemoryHelper({ root, outputDir }) {
  // Copy on every build platform, including Windows packaging from macOS.
  await cp(join(root, 'native/process-memory/windows.ps1'), join(outputDir, 'process-memory-helper.ps1'))
  if (process.platform !== 'darwin') return
  const source = join(root, 'native/process-memory/mac.c')
  const output = join(outputDir, 'process-memory-helper')
  const [sourceStat, outputStat] = await Promise.all([stat(source), stat(output).catch(() => null)])
  if (!outputStat || sourceStat.mtimeMs > outputStat.mtimeMs) {
    execFileSync('xcrun', [
      'clang', '-arch', 'arm64', '-arch', 'x86_64', '-O2', source, '-lproc', '-o', output
    ], { stdio: 'inherit' })
  }
}
