import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** macOS-only default-handler switcher; other platforms keep their registrar implementations. */
export async function buildOpenWithHelper({ outputDir }) {
  if (process.platform !== 'darwin') return
  await mkdir(outputDir, { recursive: true })
  const source = fileURLToPath(new URL('./mac.m', import.meta.url))
  const output = join(outputDir, 'open-with-helper')
  const [sourceStat, outputStat] = await Promise.all([stat(source), stat(output).catch(() => null)])
  if (!outputStat || sourceStat.mtimeMs > outputStat.mtimeMs) {
    execFileSync('xcrun', [
      'clang', '-arch', 'arm64', '-arch', 'x86_64', '-O2', '-fobjc-arc',
      '-framework', 'AppKit', '-framework', 'UniformTypeIdentifiers', source, '-o', output
    ], { stdio: 'inherit' })
  }
}
