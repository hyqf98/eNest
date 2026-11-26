import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { resolvePluginFile } from '@main/plugin/pluginPaths'
import { catalogResourceKey, catalogResourceMime, validCatalogImage } from '@main/plugin/catalogResources'

const MAX_ICON_BYTES = 512 * 1_024
const cache = new Map<string, string>()

/** Publish only the current enabled package's declared icon, never a caller-selected resource path. */
export async function getCatalogPluginIcon(pluginId: string): Promise<string | undefined> {
  if (!pluginRegistry.isEnabled(pluginId)) return undefined
  const resource = pluginRegistry.getCatalogResources(pluginId).icon
  if (!resource || resource.source === 'remote') return undefined
  const mime = catalogResourceMime(resource.path, 'image')
  if (!mime) return undefined
  const identity = catalogResourceKey(resource), revision = pluginRegistry.getBuildRevision(pluginId)
  const key = JSON.stringify([identity, revision])
  const cached = cache.get(key)
  if (cached) return cached
  try {
    const resolveIcon = () => resolvePluginFile(resource.rootPath, resource.path, resource.devSource)
    const path = await resolveIcon()
    if (!path) return undefined
    const expected = await stat(path)
    if (!expected.isFile() || expected.size > MAX_ICON_BYTES) return undefined
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let bytes: Buffer
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size !== expected.size || before.dev !== expected.dev || before.ino !== expected.ino) return undefined
      bytes = Buffer.alloc(before.size + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const after = await file.stat(), current = await resolveIcon()
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current !== path) return undefined
      bytes = bytes.subarray(0, bytesRead)
    } finally { await file.close() }
    const current = pluginRegistry.getCatalogResources(pluginId).icon
    if (!current || catalogResourceKey(current) !== identity || !pluginRegistry.isEnabled(pluginId) || pluginRegistry.getBuildRevision(pluginId) !== revision || !validCatalogImage(bytes, mime)) return undefined
    const icon = `data:${mime};base64,${bytes.toString('base64')}`
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(key, icon)
    return icon
  } catch { return undefined }
}
