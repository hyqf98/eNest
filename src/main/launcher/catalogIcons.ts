import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { resolvePluginFile } from '@main/plugin/pluginPaths'

const MAX_ICON_BYTES = 512 * 1_024
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const cache = new Map<string, string>()

/** Publish only the current enabled package's declared icon, never a caller-selected resource path. */
export async function getCatalogPluginIcon(pluginId: string): Promise<string | undefined> {
  const manifest = pluginRegistry.getManifest(pluginId), root = pluginRegistry.getRootPath(pluginId)
  if (!manifest || !root || !pluginRegistry.isEnabled(pluginId)) return undefined
  const mime = MIME[extname(manifest.icon).toLowerCase()]
  if (!mime) return undefined
  const revision = pluginRegistry.getBuildRevision(pluginId), key = JSON.stringify([pluginId, root, revision, manifest.icon])
  const cached = cache.get(key)
  if (cached) return cached
  try {
    const path = await resolvePluginFile(root, manifest.icon)
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
      const after = await file.stat(), current = await resolvePluginFile(root, manifest.icon)
      if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current !== path) return undefined
      bytes = bytes.subarray(0, bytesRead)
    } finally { await file.close() }
    if (!pluginRegistry.isEnabled(pluginId) || pluginRegistry.getBuildRevision(pluginId) !== revision) return undefined
    const icon = `data:${mime};base64,${bytes.toString('base64')}`
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(key, icon)
    return icon
  } catch { return undefined }
}
