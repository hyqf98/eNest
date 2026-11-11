import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** macOS-only default-handler switcher; other platforms keep their registrar implementations. */
export async function buildOpenWithHelper({ root, outputDir }) {
  if (process.platform !== 'darwin') return
  await mkdir(outputDir, { recursive: true })
  const source = join(root, 'native/open-with/mac.m')
  const output = join(outputDir, 'open-with-helper')
  const [sourceStat, outputStat] = await Promise.all([stat(source), stat(output).catch(() => null)])
  if (!outputStat || sourceStat.mtimeMs > outputStat.mtimeMs) {
    execFileSync('xcrun', [
      'clang', '-arch', 'arm64', '-arch', 'x86_64', '-O2', '-fobjc-arc',
      '-framework', 'AppKit', '-framework', 'UniformTypeIdentifiers', source, '-o', output
    ], { stdio: 'inherit' })
  }
}
