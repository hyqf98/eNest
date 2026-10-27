import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getAppPaths } from '@main/paths/pathsService'

/** This namespace calculation does not grant access or create directories. */
export function pluginDataDir(pluginId: string, dataRoot = getAppPaths().data): string {
  return join(dataRoot, 'plugin-documents', createHash('sha256').update(pluginId).digest('hex'))
}
