import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { session, type Session } from 'electron'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { pluginFileResponse } from '@main/plugin/pluginFileResponse'
import { resolvePluginFile } from '@main/plugin/pluginPaths'
import { fetchMarketResource } from '@main/plugin/marketResources'
import {
  CATALOG_README_LIMIT, catalogResourceKey, catalogResourceMime, type CatalogResource
} from '@main/plugin/catalogResources'
import { resolveAppearanceResource } from '@main/theme/appearanceResources'
import { BUILT_IN_HOME_SOURCE, validateHomeContribution } from './homeContract'
import type { ResolvedHomePage } from './homeRegistry'
import { isInsideDirectory } from './homeSecurity'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}
const RESOURCE_LIMIT_BYTES = 16 * 1024 * 1024
const HOME_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' enest-home: data:; media-src enest-home://appearance; font-src 'self' enest-home://appearance; connect-src 'self' enest-home://catalog enest-home://appearance; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const cleanups = new WeakMap<Session, () => void>()

function relativeEntry(page: ResolvedHomePage): string {
  const entry = relative(page.rootPath, page.entryPath).split('\\').join('/')
  if (!entry || entry.startsWith('../') || entry.startsWith('/') || !isInsideDirectory(page.rootPath, page.entryPath)) {
    throw new Error('Home entry is outside its resource root')
  }
  return entry
}

export function homeEntryUrl(page: ResolvedHomePage): string {
  return `enest-home://surface/${relativeEntry(page).split('/').map(encodeURIComponent).join('/')}`
}

function safePathSegments(url: URL): string[] | null {
  if (url.username || url.password || url.search || url.hash) return null
  try {
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent)
    return parts.length && parts.every(part => part && part !== '.' && part !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(part)) ? parts : null
  } catch {
    return null
  }
}

async function containedFile(root: string, path: string, maximumBytes = RESOURCE_LIMIT_BYTES): Promise<{ path: string; root: string } | null> {
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return null
  const candidate = resolve(root, path)
  if (!isInsideDirectory(root, candidate)) return null
  try {
    const [canonicalRoot, canonicalPath, info] = await Promise.all([realpath(root), realpath(candidate), stat(candidate)])
    if (!info.isFile() || info.size > maximumBytes || !isInsideDirectory(canonicalRoot, canonicalPath) || canonicalPath !== resolve(canonicalRoot, path)) return null
    return { path: canonicalPath, root: canonicalRoot }
  } catch {
    return null
  }
}

/**
 * 源码预览的资产根是插件源码目录，而 manifest 里的路径按打包后的布局声明
 * （`assets/...`）。这里复用 @main/plugin/pluginPaths 的同一条规则，让 catalog
 * 的图标/截图/README 与 enest://plugin/ 协议读的是同一个文件。
 */
async function catalogFile(resource: Exclude<CatalogResource, { source: 'remote' }>): Promise<{ path: string; root: string } | null> {
  try {
    const root = await realpath(resource.rootPath)
    const path = await resolvePluginFile(root, resource.path, resource.devSource)
    if (!path) return null
    return containedFile(root, relative(root, path), resource.kind === 'readme' ? CATALOG_README_LIMIT : RESOURCE_LIMIT_BYTES)
  } catch { return null }
}

function catalogSlot(parts: string[]): CatalogResource | null {
  const [pluginId, kind, index] = parts
  if (!pluginId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(pluginId)) return null
  const resources = pluginRegistry.getCatalogResources(pluginId)
  if (kind === 'icon' && parts.length === 2) return resources.icon ?? null
  if (kind === 'readme' && parts.length === 2) return resources.readme ?? null
  if (kind === 'screenshot' && parts.length === 3 && /^(?:0|[1-7])$/.test(index)) return resources.screenshots[Number(index)] ?? null
  return null
}

function publicHeaders(response: Response, page: ResolvedHomePage): Response {
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  response.headers.set('Access-Control-Allow-Origin', builtinDevOrigin(page)?.origin ?? 'enest-home://surface')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

/** Public slots are resolved on the host. Remote bytes never redirect the page or relax its CSP. */
export async function serveHomeResource(page: ResolvedHomePage, request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  if (page.contribution.source !== BUILT_IN_HOME_SOURCE) {
    const source = page.contribution.source
    const installed = pluginRegistry.getInstalledDescriptors().find(item => item.id === source && item.enabled)
    const declared = validateHomeContribution(
      pluginRegistry.getManifest(source)?.contributes?.homePages?.find(item => item.id === page.contribution.id), source
    )
    if (!installed || !declared || JSON.stringify(declared) !== JSON.stringify(page.contribution)) return new Response('retired', { status: 403 })
  }
  let url: URL
  try { url = new URL(request.url) } catch { return new Response('forbidden', { status: 403 }) }
  const parts = safePathSegments(url)
  if (url.protocol !== 'enest-home:' || !parts) return new Response('forbidden', { status: 403 })
  let file: { path: string; root: string } | null
  let resourceMime: string | undefined
  if (url.hostname === 'surface') {
    const path = parts.join('/')
    if (parts.some(part => part.startsWith('.') || ['backend', 'node_modules', 'runtime'].includes(part))) return new Response('forbidden', { status: 403 })
    if (['.md', '.txt'].includes(extname(path).toLowerCase())) return new Response('forbidden', { status: 403 })
    if (extname(path).toLowerCase() === '.html' && path !== relativeEntry(page)) return new Response('forbidden', { status: 403 })
    file = await containedFile(page.rootPath, path)
  } else if (url.hostname === 'catalog') {
    const slot = catalogSlot(parts)
    if (!slot) return new Response('not found', { status: 404 })
    if (slot.source === 'remote') {
      try {
        const resource = await fetchMarketResource(slot)
        // Installation/refresh while fetching must not publish the previous source's bytes.
        const current = catalogSlot(parts)
        if (!current || catalogResourceKey(current) !== catalogResourceKey(slot)) return new Response('retired', { status: 404 })
        return publicHeaders(new Response(request.method === 'HEAD' ? null : resource.body, { headers: {
          'Content-Type': resource.mime, 'Content-Length': String(resource.body.byteLength),
          'Content-Security-Policy': HOME_CSP, 'Cache-Control': 'no-store'
        } }), page)
      } catch { return new Response('not found', { status: 404 }) }
    }
    resourceMime = catalogResourceMime(slot.path, slot.kind)
    if (!resourceMime) return new Response('forbidden', { status: 403 })
    file = await catalogFile(slot)
    const current = catalogSlot(parts)
    if (!current || catalogResourceKey(current) !== catalogResourceKey(slot)) return new Response('retired', { status: 404 })
  } else if (url.hostname === 'appearance' && parts.length === 2 && (parts[0] === 'media' || parts[0] === 'font')) {
    const resource = await resolveAppearanceResource(parts[0], parts[1])
    file = resource
    resourceMime = resource?.mime
  } else return new Response('forbidden', { status: 403 })
  if (!file) return new Response('not found', { status: 404 })
  const mime = resourceMime ?? CONTENT_TYPES[extname(file.path).toLowerCase()]
  if (!mime) return new Response('forbidden', { status: 403 })
  try {
    const source = page.contribution.source
    const devSource = source !== BUILT_IN_HOME_SOURCE && pluginRegistry.get(source)?.devSource === true
    const response = await pluginFileResponse(request, file.path, {
      mime, csp: HOME_CSP, root: file.root, dev: devSource,
      revision: source === BUILT_IN_HOME_SOURCE ? undefined : pluginRegistry.getBuildRevision(source),
    })
    return publicHeaders(response, page)
  } catch {
    return new Response('not found', { status: 404 })
  }
}

function builtinDevOrigin(page: ResolvedHomePage): URL | null {
  if (page.contribution.source !== BUILT_IN_HOME_SOURCE || !process.env.ELECTRON_RENDERER_URL) return null
  try {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password ? url : null
  } catch { return null }
}

export function createHomeSession(page: ResolvedHomePage, generation: number): Session {
  const ses = session.fromPartition(`enest-home-${generation}-${randomUUID()}`, { cache: false })
  ses.protocol.handle('enest-home', request => serveHomeResource(page, request))
  const dev = builtinDevOrigin(page)
  const entry = homeEntryUrl(page)
  ses.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const url = new URL(details.url)
      const segments = safePathSegments(url)
      if (url.protocol === 'enest-home:' && segments && ['surface', 'catalog', 'appearance'].includes(url.hostname)) {
        allowed = details.resourceType !== 'subFrame' && (details.resourceType !== 'mainFrame' || url.href === entry)
      } else if (dev && url.host === dev.host && !url.username && !url.password) {
        allowed = url.protocol === dev.protocol || (dev.protocol === 'https:' ? url.protocol === 'wss:' : url.protocol === 'ws:')
        if (details.resourceType === 'mainFrame') allowed = url.href === new URL('home.html', `${dev.href.replace(/\/$/, '')}/`).href
        if (details.resourceType === 'subFrame') allowed = false
      } else if (url.protocol === 'data:') allowed = details.resourceType === 'image' || details.resourceType === 'font'
    } catch { /* Deny malformed and non-resource URLs. */ }
    callback({ cancel: !allowed })
  })
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  const refuseDownload = (event: Electron.Event): void => event.preventDefault()
  ses.on('will-download', refuseDownload)
  cleanups.set(ses, () => {
    ses.protocol.unhandle('enest-home')
    ses.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
    ses.removeListener('will-download', refuseDownload)
  })
  return ses
}

/** Revoke protocol closures and ephemeral storage after the last Home frame closes. */
export async function disposeHomeSession(ses: Session): Promise<void> {
  const cleanup = cleanups.get(ses)
  if (!cleanup) return
  cleanups.delete(ses)
  cleanup()
  await Promise.allSettled([ses.closeAllConnections(), ses.clearStorageData()])
}
