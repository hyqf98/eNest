import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { net } from 'electron'
import { installFromDirectory } from '@main/plugin/PluginInstaller'
import { normalizePluginDevUrl } from '@shared/pluginContract'
import type { DevPluginLoadOptions, PluginManifest } from '@shared/types/plugin'

/** A listening port alone does not identify a plugin development server. */
export async function matchesDevelopmentServer(url: string, pluginId: string): Promise<boolean> {
  try {
    const response = await net.fetch(new URL('plugin.json', url).href, { signal: AbortSignal.timeout(1200), redirect: 'error', credentials: 'omit' })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 65536) return false
    const reader = response.body?.getReader()
    if (!reader) return false
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > 65536) return false
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<PluginManifest>
    return manifest.id === pluginId && manifest.main === 'index.html'
  } catch { return false }
}

/** Explicit API overrides remain available; the developer UI uses automatic selection. */
export async function resolveDevPluginEntry(sourcePath: string, options: DevPluginLoadOptions = {}) {
  if (options.preview === 'dist') {
    const rootPath = join(sourcePath, 'dist')
    return { rootPath, manifest: await installFromDirectory(rootPath), devSource: false, devUrl: undefined }
  }
  const manifest = await installFromDirectory(sourcePath, { source: true })
  const declaredUrl = normalizePluginDevUrl(options.url ?? manifest.development?.main)
  if (options.url !== undefined) return { rootPath: sourcePath, manifest, devSource: true, devUrl: declaredUrl }
  if (declaredUrl && await matchesDevelopmentServer(declaredUrl, manifest.id)) {
    return { rootPath: sourcePath, manifest, devSource: true, devUrl: declaredUrl }
  }
  const distPath = join(sourcePath, 'dist')
  if (declaredUrl && existsSync(join(distPath, 'plugin.json'))) {
    const built = await installFromDirectory(distPath)
    if (built.id !== manifest.id || built.version !== manifest.version) {
      throw new Error(`${manifest.name} 的构建产物与源码版本不一致，请在插件目录运行 npm run build`)
    }
    return { rootPath: distPath, manifest: built, devSource: false, devUrl: undefined }
  }
  if (declaredUrl) throw new Error(`${manifest.name} 的开发服务未启动或端口属于其它项目；请启动该插件的开发服务，或在插件目录运行 npm run build`)
  return { rootPath: sourcePath, manifest, devSource: true, devUrl: undefined }
}
