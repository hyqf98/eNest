import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { existingOwnedDirectory } from '@main/paths/ownedDirectory'
import { isPackageId, isPackageVersion } from './packageIdentity'

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function matchesPackage(directory: string, id: string, version: string): Promise<boolean> {
  const file = join(directory, 'plugin.json')
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > 256 * 1024) return false
    const manifest: unknown = JSON.parse(await readFile(file, 'utf8'))
    return !!manifest && typeof manifest === 'object' && Reflect.get(manifest, 'id') === id && Reflect.get(manifest, 'version') === version
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function ownedPackageVersion(plugins: string, id: string, version: string, sources: string[], skipUnrelated = false): Promise<string | null> {
  if (!isPackageId(id) || !isPackageVersion(version)) throw new Error('Invalid package identity')
  const directory = await existingOwnedDirectory(dirname(plugins), basename(plugins), id, version)
  if (directory && !await matchesPackage(directory, id, version)) {
    if (skipUnrelated) return null
    throw new Error('Installed package identity changed')
  }
  const candidate = directory ?? join(await realpath(plugins), id, version)
  for (const path of sources) {
    const source = await realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return path; throw error })
    if (inside(candidate, source) || inside(source, candidate)) throw new Error('Package overlaps a development source directory')
  }
  return directory
}
