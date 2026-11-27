import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'

export const PRIVATE_DOCUMENTS_DIR = 'plugin-documents'
export const PRIVATE_EXTENSIONS_DIR = 'extensions'

export function pluginPrivateNamespace(pluginId: string): string {
  return createHash('sha256').update(pluginId).digest('hex')
}

/** This namespace calculation does not grant access or create directories. */
export function pluginDataDir(pluginId: string, dataRoot = getAppPaths().data): string {
  return join(dataRoot, PRIVATE_DOCUMENTS_DIR, pluginPrivateNamespace(pluginId))
}

export function ensurePluginExtensionRoot(pluginId: string): string {
  let directory = realpathSync(getAppPaths().data)
  for (const component of [PRIVATE_DOCUMENTS_DIR, pluginPrivateNamespace(pluginId), PRIVATE_EXTENSIONS_DIR]) {
    directory = join(directory, component)
    try { mkdirSync(directory, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = lstatSync(directory)
    if (!info.isDirectory() || realpathSync(directory) !== directory) throw new Error('Unsafe private extension directory')
  }
  return directory
}
