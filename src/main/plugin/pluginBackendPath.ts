import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPluginAssetPath } from '@shared/pluginContract'

export function isPluginBackendEntry(value: unknown): value is string {
  return isPluginAssetPath(value) && value.startsWith('backend/') && /\.(?:cjs|mjs|js)$/.test(value)
}

/** Backend files are private to the process launcher; never expose them via enest://. */
export function resolveBackendFile(root: string, entry: string): string {
  if (!isPluginBackendEntry(entry)) throw new Error('invalid plugin backend entry')
  const base = realpathSync(root)
  let current = base
  for (const part of entry.split('/')) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('plugin backend cannot use symbolic links')
  }
  const canonical = realpathSync(resolve(base, entry)), delta = relative(base, canonical)
  if (delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta) || !lstatSync(canonical).isFile()) throw new Error('plugin backend is outside its package')
  return canonical
}
