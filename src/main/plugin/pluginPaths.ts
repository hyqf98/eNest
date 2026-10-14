import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { isPluginAssetPath } from '@shared/pluginContract'

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

/** Source preview exposes a fixed virtual root; secrets, tooling and dependencies are never served. */
export async function resolvePluginFile(root: string, path: string, source = false): Promise<string | null> {
  if (!isPluginAssetPath(path)) return null
  let mapped = path
  if (source) {
    if (path.startsWith('assets/')) mapped = `public/${path}`
    else if (path !== 'index.html' && !path.startsWith('src/')) return null
  } else if (path !== 'index.html' && !path.startsWith('assets/')) return null
  try {
    const canonicalRoot = await realpath(root)
    let partPath = canonicalRoot
    for (const part of mapped.split('/')) {
      partPath = resolve(partPath, part)
      if ((await lstat(partPath)).isSymbolicLink()) return null
    }
    const file = await realpath(resolve(canonicalRoot, mapped))
    if (!within(canonicalRoot, file) || !(await stat(file)).isFile()) return null
    return file
  } catch { return null }
}
