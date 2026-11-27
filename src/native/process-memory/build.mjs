import { cp, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export async function buildProcessMemoryHelper({ outputDir }) {
  // Copy on every build platform, including Windows packaging from macOS.
  await cp(new URL('./windows.ps1', import.meta.url), join(outputDir, 'process-memory-helper.ps1'))
  if (process.platform !== 'darwin') return
  const source = fileURLToPath(new URL('./mac.c', import.meta.url))
  const output = join(outputDir, 'process-memory-helper')
  const [sourceStat, outputStat] = await Promise.all([stat(source), stat(output).catch(() => null)])
  if (!outputStat || sourceStat.mtimeMs > outputStat.mtimeMs) {
    execFileSync('xcrun', [
      'clang', '-arch', 'arm64', '-arch', 'x86_64', '-O2', source, '-lproc', '-o', output
    ], { stdio: 'inherit' })
  }
}
