import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { BUILTIN_PLUGIN_ICON_SVGS, LEGACY_PLUGIN_ICONS } from '@shared/builtinPluginIcons'
import { pluginAssetCache } from './pluginFileResponse'

/** Match content, not plugin ID alone: user artwork and ui.setIcon overrides are untouched. */
export function upgradedBuiltinPluginIcon(id: string, source: string): string | undefined {
  const legacy = Object.hasOwn(LEGACY_PLUGIN_ICONS, id) ? LEGACY_PLUGIN_ICONS[id] : undefined
  if (!legacy) return undefined
  const normalized = source.trim().replace(/>\s+</g, '><')
  const hash = createHash('sha256').update(normalized).digest('hex')
  return legacy.sha256.includes(hash) ? BUILTIN_PLUGIN_ICON_SVGS[id] : undefined
}

/** Protocol-only compatibility for old packages; does not modify installed files. */
export async function legacyPluginIconResponse(
  request: Request,
  path: string,
  options: { pluginId?: string; root?: string; revision?: string; dev: boolean; csp: string }
): Promise<Response | null> {
  const { pluginId: id, root } = options
  if (!id || !root || !Object.hasOwn(LEGACY_PLUGIN_ICONS, id) || !['GET', 'HEAD'].includes(request.method)) return null
  let pathname: string
  try { pathname = decodeURIComponent(new URL(request.url).pathname) } catch { return null }
  if (pathname !== `/${id}/assets/market/icon.svg` && pathname !== `/${id}/icon.svg`) return null
  const info = await stat(path)
  if (!info.isFile() || info.size > 16 * 1024) return null
  const key = JSON.stringify(['icon-artwork', root, path, options.revision, info.size, info.mtimeMs])
  const source = options.dev ? await readFile(path) : await pluginAssetCache.read(root, key, () => readFile(path))
  const artwork = upgradedBuiltinPluginIcon(id, source.toString('utf8'))
  if (!artwork) return null
  const etag = `"enest-icon-${createHash('sha256').update(artwork).digest('hex')}"`
  const headers = new Headers({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Security-Policy': options.csp,
    'Content-Length': String(Buffer.byteLength(artwork)),
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': options.dev ? 'no-store' : 'no-cache',
    ETag: etag
  })
  if (!options.dev && request.headers.get('if-none-match')?.split(',').some(value => {
    const candidate = value.trim()
    return candidate === '*' || candidate.replace(/^W\//, '') === etag
  })) {
    headers.delete('Content-Length')
    return new Response(null, { status: 304, headers })
  }
  // SVGs are small; ignoring Range and returning the complete representation is valid.
  return new Response(request.method === 'HEAD' ? null : artwork, { headers })
}
