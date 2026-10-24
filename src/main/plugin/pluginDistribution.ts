import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const targets = new Set(['universal', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])

async function metadata(root: string, path: string): Promise<Record<string, unknown> | undefined> {
  const file = join(root, path)
  try {
    const directory = await lstat(join(root, path.split('/')[0]))
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('Invalid plugin distribution directory')
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Invalid plugin distribution metadata')
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin distribution metadata')
    return value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Legacy packages remain universal; a targeted native artifact can never install on another CPU/OS. */
export async function validatePluginDistribution(root: string, platform: string = process.platform, arch: string = process.arch): Promise<void> {
  const marker = await metadata(root, 'assets/enest-distribution.json')
  const inventory = await metadata(root, 'backend/dependency-inventory.json')
  if (marker && marker.schemaVersion !== 1) throw new Error('Unsupported plugin distribution schema')
  if (marker && typeof marker.target !== 'string') throw new Error('Missing plugin distribution target')
  const target = marker?.target ?? inventory?.target ?? 'universal'
  if (typeof target !== 'string' || !targets.has(target)) throw new Error('Unknown plugin distribution target')
  if (marker && inventory?.target !== undefined && marker.target !== inventory.target) throw new Error('Conflicting plugin distribution targets')
  if (target !== 'universal' && target !== `${platform}-${arch}`) throw new Error(`Plugin package targets ${target}; this host requires ${platform}-${arch}`)
}

export function marketRegistryNames(platform: string = process.platform, arch: string = process.arch): string[] {
  const target = `${platform}-${arch}`
  return targets.has(target) ? [`registry-${target}.json`, 'registry.json'] : ['registry.json']
}
