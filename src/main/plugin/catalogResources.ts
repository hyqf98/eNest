import { extname, posix } from 'node:path'
import { isPluginAssetPath } from '@shared/pluginContract'
import type { PluginManifest } from '@shared/types/plugin'
import type { MarketPluginSummary } from './marketMetadata'

export const MARKET_REPO_OWNER = 'hyqf98'
export const MARKET_REPO_NAME = 'eNest_plugin'
export const CATALOG_IMAGE_LIMIT = 16 * 1024 * 1024
export const CATALOG_README_LIMIT = 512 * 1024

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon'
}
const RELEASE_CDNS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
const IMAGE_CDNS = new Set(['user-images.githubusercontent.com', 'camo.githubusercontent.com'])

type ResourceIdentity = { pluginId: string; version: string; kind: 'image' | 'readme' }
export type CatalogResource = ResourceIdentity & (
  | { source: 'dev' | 'installed'; rootPath: string; path: string; devSource: boolean }
  | { source: 'remote'; url: string }
)
export interface CatalogResources {
  icon?: CatalogResource
  screenshots: CatalogResource[]
  readme?: CatalogResource
  /** Only aliases of existing screenshots, not additional fetchable resources. */
  readmeImages?: Record<string, number>
}

function withReadmeImages(resources: CatalogResources, declared?: Record<string, string>): CatalogResources {
  const readme = resources.readme
  if (!readme) return resources
  const images: Record<string, number> = Object.create(null)
  resources.screenshots.forEach((screenshot, index) => {
    let path: string | undefined
    if (readme.source !== 'remote' && screenshot.source !== 'remote') path = posix.relative(posix.dirname(readme.path), screenshot.path)
    else if (readme.source === 'remote' && screenshot.source === 'remote') {
      const base = new URL(readme.url), image = new URL(screenshot.url)
      if (base.origin === image.origin && base.hostname === 'raw.githubusercontent.com') {
        try { path = decodeURIComponent(posix.relative(posix.dirname(base.pathname), image.pathname)) } catch { /* omit */ }
      }
      for (const [alias, url] of Object.entries(declared ?? {}).slice(0, 32)) {
        const key = alias.replace(/^\.\//, '')
        if (url === screenshot.url && isPluginAssetPath(key)) images[key] = index
      }
    }
    if (path && isPluginAssetPath(path)) images[path] = index
  })
  return { ...resources, ...(Object.keys(images).length ? { readmeImages: images } : {}) }
}

export function catalogResourceMime(path: string, kind: CatalogResource['kind']): string | undefined {
  const extension = extname(path).toLowerCase()
  return kind === 'image' ? IMAGE_TYPES[extension]
    : ['.md', '.txt'].includes(extension) ? 'text/markdown; charset=utf-8' : undefined
}

/** A local source is selected as a whole; missing slots never borrow another version's media. */
export function localCatalogResources(
  manifest: PluginManifest, rootPath: string, source: 'dev' | 'installed', devSource = false
): CatalogResources {
  const resource = (path: unknown, kind: CatalogResource['kind']): CatalogResource | undefined =>
    typeof path === 'string' && isPluginAssetPath(path) && path.startsWith('assets/') && catalogResourceMime(path, kind)
      ? { pluginId: manifest.id, version: manifest.version, kind, source, rootPath, path, devSource }
      : undefined
  return withReadmeImages({
    icon: resource(manifest.icon, 'image'),
    screenshots: (manifest.market?.screenshots ?? []).slice(0, 8).flatMap(path => resource(path, 'image') ?? []),
    readme: resource(manifest.market?.readme, 'readme')
  })
}

function httpsUrl(value: string): URL | null {
  try {
    if (value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash ? url : null
  } catch { return null }
}

/** Only the official repository and this plugin's public media/release filename are valid entry URLs. */
export function registeredCatalogUrl(value: string, pluginId: string, version: string, kind: CatalogResource['kind']): URL | null {
  const url = httpsUrl(value)
  if (!url || url.search || !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)) return null
  let parts: string[]
  try { parts = url.pathname.slice(1).split('/').map(decodeURIComponent) } catch { return null }
  if (parts.some(part => !part || part === '.' || part === '..' || /[/\\%\u0000-\u001f\u007f]/.test(part))) return null
  if (parts[0]?.toLowerCase() !== MARKET_REPO_OWNER.toLowerCase() || parts[1]?.toLowerCase() !== MARKET_REPO_NAME.toLowerCase()) return null
  if (!catalogResourceMime(parts.at(-1) ?? '', kind)) return null
  const shortId = pluginId.split('.').pop()
  const publicPath = (start: number): boolean =>
    /^[\w.-]{1,128}$/.test(parts[start] ?? '') && parts[start + 1] === 'plugins' && parts[start + 2] === shortId &&
    parts[start + 3] === 'public' && parts[start + 4] === 'assets' && parts[start + 5] === 'market' && parts.length > start + 6
  if (url.hostname === 'raw.githubusercontent.com') return publicPath(2) ? url : null
  if (parts[2] === 'raw') return publicPath(3) ? url : null
  const release = parts.length === 6 && parts[2] === 'releases' &&
    (parts[3] === 'download' || parts[3] === 'latest' && parts[4] === 'download')
  return release && parts[5].startsWith(`${shortId}@${version}-`) ? url : null
}

/** Redirects may enter GitHub's exact public CDN hosts, never arbitrary *.githubusercontent.com. */
export function catalogRedirectUrl(value: string, resource: Extract<CatalogResource, { source: 'remote' }>): URL | null {
  const url = httpsUrl(value)
  if (!url) return null
  if (RELEASE_CDNS.has(url.hostname) || resource.kind === 'image' && IMAGE_CDNS.has(url.hostname)) return url
  return registeredCatalogUrl(value, resource.pluginId, resource.version, resource.kind)
}

/** Callers pass the current registry row, not any renderer-provided URL. */
export function remoteCatalogResources(remote: MarketPluginSummary): CatalogResources {
  const resource = (value: unknown, kind: CatalogResource['kind']): CatalogResource | undefined => {
    if (typeof value !== 'string') return undefined
    const url = registeredCatalogUrl(value, remote.id, remote.version, kind)
    return url ? { pluginId: remote.id, version: remote.version, kind, source: 'remote', url: url.href } : undefined
  }
  return withReadmeImages({
    icon: resource(remote.icon, 'image'),
    screenshots: (remote.screenshots ?? []).slice(0, 8).flatMap(path => resource(path, 'image') ?? []),
    readme: resource(remote.readmeUrl, 'readme')
  }, remote.readmeImages)
}

export function catalogResourceKey(resource: CatalogResource): string {
  return JSON.stringify(resource)
}

/** Match MIME and file signatures as well as extensions; HTML with an image label is not media. */
export function validCatalogImage(body: Uint8Array, mime: string): boolean {
  const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/gif') return /^(?:GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString('ascii'))
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mime === 'image/avif') return bytes.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 40).toString('ascii'))
  if (mime === 'image/x-icon') return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))
  return mime === 'image/svg+xml' && /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|\/?>)/i.test(bytes.toString('utf8'))
}
