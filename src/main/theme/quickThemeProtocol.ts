import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { Session, WebContents, WebFrameMain } from 'electron'
import { isPluginAssetPath } from '@shared/pluginContract'
import { parseThemeColor } from '@shared/theme/colors'
import type { ResolvedAppearance, ThemePackV2 } from '@shared/types/appearance'
import { IpcChannels } from '@shared/types/ipc'
import type { QuickThemeAppearance, QuickThemeConfig } from '@shared/types/quickTheme'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { appearanceService, getAppearance } from '@main/theme/appearanceService'
import { themePackRegistry } from '@main/theme/themePacks'
import { QUICK_THEME_BRIDGE_FILE, QUICK_THEME_BRIDGE_SOURCE } from './quickThemeBridge'

export const QUICK_THEME_PROTOCOL = 'enest-quick'
const ORIGIN = `${QUICK_THEME_PROTOCOL}://surface`
const MAX_BYTES = 16 * 1024 * 1024
const GENERATION = /^[A-Za-z0-9_-]{16,160}$/
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
}
const CSP = `default-src 'none'; script-src ${ORIGIN}; script-src-attr 'none'; style-src ${ORIGIN} 'unsafe-inline'; img-src ${ORIGIN} data:; font-src ${ORIGIN} data:; connect-src ${ORIGIN}; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`
const HEADERS = {
  'Content-Security-Policy': CSP,
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-DNS-Prefetch-Control': 'off',
  'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), payment=(), fullscreen=()'
}
const COLOR_TOKENS = new Set(['--bg', '--surface', '--surface-2', '--surface-3', '--text', '--text-2', '--text-3', '--accent', '--ok', '--danger', '--border', '--border-strong', '--link'])
const FONT_STACK = /^[\p{L}\p{N}_ '".,\-]{0,512}$/u
interface Selection { signature: string; rootInput: string; entry: string; appearance: ResolvedAppearance }
interface ResourceGrant { signature: string; rootInput: string; root: string; entry: string; key: string; url: string }
interface QuickPolicy {
  contents: WebContents
  isActive: () => boolean
  gesture: { key: string; at: number } | null
}
let currentGrant: ResourceGrant | null = null
const policies = new Map<number, QuickPolicy>()
const installedSessions = new WeakSet<Session>()
let watchingChanges = false

function watchChanges(): void {
  if (watchingChanges) return
  watchingChanges = true
  // Observe retirement even when no resource was requested while disabled or on
  // another theme. Returning to an older identity must not resurrect its key.
  const retireChangedGrant = (): void => { if (currentGrant) currentSelection() }
  pluginRegistry.onInstalledChanged(retireChangedGrant)
  appearanceService.subscribeAppearance(retireChangedGrant)
}

function safePackagePath(path: string): boolean {
  return path.length <= 512 && !['plugin.json', 'package.json', 'package-lock.json'].includes(path.toLowerCase())
    && isPluginAssetPath(path) && path.split('/').every(part =>
    !['backend', 'node_modules', 'runtime'].includes(part.toLowerCase()))
}

/** Never use a renderer identity or a merely browsable checkout as executable provenance. */
function currentSelection(): Selection | null {
  const appearance = getAppearance()
  const quick = appearance.quick
  const source = appearance.theme.source
  const pack = themePackRegistry.get(appearance.theme.id) as ThemePackV2 | null
  const rootInput = pluginRegistry.getAssetRootPath(source)
  if (!quick || quick.version !== 1 || !safePackagePath(quick.entry) || extname(quick.entry).toLowerCase() !== '.html' ||
      !pack || pack.schemaVersion !== 2 || pack.source !== source || pack.quick?.version !== 1 || pack.quick.entry !== quick.entry ||
      !pluginRegistry.isEnabled(source) || !pluginRegistry.getManifest(source) || !rootInput) {
    currentGrant = null
    return null
  }
  const signature = JSON.stringify([source, appearance.theme.id, appearance.theme.version, appearance.revision,
    quick, rootInput, pluginRegistry.getBuildRevision(source)])
  if (currentGrant && currentGrant.signature !== signature) currentGrant = null
  return { signature, rootInput, entry: quick.entry, appearance }
}

function liveGrant(): ResourceGrant | null {
  return currentSelection() && currentGrant
}

function entryUrl(key: string, path: string): string {
  return `${ORIGIN}/${key}/${path.split('/').map(encodeURIComponent).join('/')}`
}

function parseResourceUrl(raw: string, allowFragment = false): { key: string; path: string; generation: string | null } | null {
  try {
    if (raw.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(raw)) return null
    const url = new URL(raw)
    if (url.protocol !== `${QUICK_THEME_PROTOCOL}:` || url.hostname !== 'surface' || url.port || url.username || url.password || url.search || raw !== url.href) return null
    const parts = url.pathname.slice(1).split('/').map(part => decodeURIComponent(part))
    const [key, ...pathParts] = parts
    if (!/^[a-f0-9]{64}$/.test(key) || !pathParts.length || pathParts.some(part => /[/\\]/.test(part))) return null
    const path = pathParts.join('/')
    if (!safePackagePath(path) || !MIME[extname(path).toLowerCase()]) return null
    let generation: string | null = null
    if (url.hash) {
      if (!allowFragment || !url.hash.startsWith('#generation=')) return null
      generation = url.hash.slice('#generation='.length)
      if (!GENERATION.test(generation)) return null
    }
    // Reject alternate encodings rather than accepting a second spelling of a capability.
    if (url.href !== entryUrl(key, path) + (generation ? `#generation=${generation}` : '')) return null
    return { key, path, generation }
  } catch { return null }
}

/** Hash generations identify parent/iframe channels, not a different filesystem asset. */
export function isCurrentQuickThemeEntryUrl(url: string, key?: string): boolean {
  const grant = liveGrant(), parsed = parseResourceUrl(url, true)
  return !!grant && !!parsed && parsed.key === grant.key && (!key || key === grant.key) && parsed.path === grant.entry
}

function publicAppearance(appearance: ResolvedAppearance): QuickThemeAppearance {
  const font = (value: string | undefined): string => typeof value === 'string' && FONT_STACK.test(value) ? value : ''
  const bounded = (value: number, fallback: number, minimum: number, maximum: number): number =>
    Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback
  const fonts = appearance.fonts, components = appearance.components
  return {
    mode: appearance.mode === 'dark' ? 'dark' : 'light',
    tokens: Object.fromEntries(Object.entries(appearance.tokens).filter(([key, value]) =>
      COLOR_TOKENS.has(key) && typeof value === 'string' && value.length <= 96 && !!parseThemeColor(value))),
    fonts: { body: font(fonts.body), heading: font(fonts.heading), mono: font(fonts.mono),
      cjk: font(fonts.cjk), latin: font(fonts.latin), scale: bounded(fonts.scale, 1, 0.9, 1.3) },
    components: { controlRadius: bounded(components.controlRadius, 8, 0, 48), cardRadius: bounded(components.cardRadius, 12, 0, 48),
      panelRadius: bounded(components.panelRadius, 16, 0, 48), borderWidth: bounded(components.borderWidth, 1, 0, 4) },
    animation: ['low', 'medium', 'high'].includes(appearance.animation.effective) ? appearance.animation.effective : 'low',
    resources: { fonts: [] }
  }
}

async function inspectFile(root: string, path: string): Promise<{ path: string; info: Awaited<ReturnType<typeof stat>> } | null> {
  if (!safePackagePath(path)) return null
  const candidate = resolve(root, path), delta = relative(root, candidate)
  if (!delta || delta === '..' || delta.startsWith('../') || isAbsolute(delta)) return null
  try {
    let cursor = root
    const parts = path.split('/')
    for (let index = 0; index < parts.length; index++) {
      cursor = resolve(cursor, parts[index])
      const info = await lstat(cursor)
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) return null
    }
    if (await realpath(candidate) !== candidate) return null
    const info = await stat(candidate)
    return info.isFile() && info.size <= MAX_BYTES ? { path: candidate, info } : null
  } catch { return null }
}

/** Resource identity/revision is opaque; only the current selected, enabled build can mint it. */
export async function getQuickThemeConfig(): Promise<QuickThemeConfig | null> {
  watchChanges()
  const selected = currentSelection()
  if (!selected) return null
  try {
    const root = await realpath(selected.rootInput)
    if (!await inspectFile(root, selected.entry)) return null
    const latest = currentSelection()
    if (!latest || latest.signature !== selected.signature) return null
    if (!currentGrant || currentGrant.root !== root) {
      const key = randomBytes(32).toString('hex')
      currentGrant = { signature: latest.signature, rootInput: latest.rootInput, root, entry: latest.entry, key, url: entryUrl(key, latest.entry) }
    }
    return { key: currentGrant.key, url: currentGrant.url, appearance: publicAppearance(latest.appearance) }
  } catch { return null }
}

/** Reject link components and pin reads to the inspected inode, including racing replacements. */
async function readResource(grant: ResourceGrant, path: string): Promise<Uint8Array | null> {
  if (await realpath(grant.rootInput) !== grant.root) return null
  const inspected = await inspectFile(grant.root, path)
  if (!inspected) return null
  const file = await open(inspected.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat(), expected = inspected.info
    if (!before.isFile() || before.size > MAX_BYTES || before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size) return null
    const bytes = new Uint8Array(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat(), checked = await inspectFile(grant.root, path)
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        !checked || checked.info.dev !== before.dev || checked.info.ino !== before.ino || await realpath(grant.rootInput) !== grant.root) return null
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}

function response(request: Request, status: number, body: Uint8Array | string | null, mime = 'text/plain; charset=utf-8'): Response {
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: {
    ...HEADERS, 'Content-Type': mime, ...(body === null ? {} : { 'Content-Length': String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength) })
  } })
}

/** No redirects, arbitrary HTML, backend, local media, settings or host resources are exposed. */
async function handleQuickThemeResource(request: Request): Promise<Response> {
  try {
    const grant = liveGrant(), parsed = parseResourceUrl(request.url)
    if (!grant || !parsed || parsed.key !== grant.key || (extname(parsed.path).toLowerCase() === '.html' && parsed.path !== grant.entry)) return response(request, 403, 'forbidden')
    if (!['GET', 'HEAD'].includes(request.method)) return response(request, 405, 'method not allowed')
    if (await realpath(grant.rootInput) !== grant.root || liveGrant() !== grant) return response(request, 403, 'retired')
    if (parsed.path === QUICK_THEME_BRIDGE_FILE) return response(request, 200, QUICK_THEME_BRIDGE_SOURCE, MIME['.js'])
    let bytes = await readResource(grant, parsed.path)
    if (!bytes || liveGrant() !== grant) return response(request, 403, 'forbidden')
    if (parsed.path === grant.entry) {
      // A leading external script runs before authored scripts/base/meta markup. Do
      // not insert inside an author-controlled head or rely on inline/eval code.
      const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
      const bridge = `<script src="${entryUrl(grant.key, QUICK_THEME_BRIDGE_FILE)}"></script>`
      const doctype = /^\s*<!doctype\s+html\s*>/i.exec(html)
      const prefix = doctype ? `${doctype[0]}\n` : '<!doctype html>\n'
      bytes = new TextEncoder().encode(`${prefix}${bridge}\n${doctype ? html.slice(doctype[0].length) : html}`)
      if (bytes.byteLength > MAX_BYTES) return response(request, 403, 'resource too large')
    }
    return response(request, 200, bytes, MIME[extname(parsed.path).toLowerCase()])
  } catch { return response(request, 403, 'forbidden') }
}

function sameFrame(a: WebFrameMain | null | undefined, b: WebFrameMain | null | undefined): boolean {
  try { return !!a && !!b && !a.isDestroyed() && !b.isDestroyed() && a.frameTreeNodeId === b.frameTreeNodeId }
  catch { return false }
}

function directThemeFrame(policy: QuickPolicy, frame: WebFrameMain | null | undefined): boolean {
  try {
    return !!frame && !frame.detached && sameFrame(frame.parent, policy.contents.mainFrame) &&
      !!parseResourceUrl(frame.url, true)?.generation && isCurrentQuickThemeEntryUrl(frame.url)
  } catch { return false }
}

function hasThemeFrame(policy: QuickPolicy): boolean {
  try { return policy.contents.mainFrame.frames.some(frame => directThemeFrame(policy, frame)) }
  catch { return false }
}

function allowRequest(policy: QuickPolicy, details: Electron.OnBeforeRequestListenerDetails): boolean {
  const frame = details.frame, main = policy.contents.mainFrame
  // Missing frame identity must not turn into a shared-partition wide grant.
  if (!frame || frame.detached || frame.isDestroyed() || !sameFrame(frame.top, main)) return false
  if (details.resourceType === 'subFrame') {
    return details.method === 'GET' && (sameFrame(frame, main) || sameFrame(frame.parent, main)) && isCurrentQuickThemeEntryUrl(details.url)
  }
  if (sameFrame(frame, main)) return !details.url.startsWith(`${QUICK_THEME_PROTOCOL}:`)
  if (!directThemeFrame(policy, frame) || !['GET', 'HEAD'].includes(details.method)) return false
  if (details.url.startsWith('data:')) return details.resourceType === 'image' || details.resourceType === 'font'
  const grant = liveGrant(), parsed = parseResourceUrl(details.url)
  if (!grant || !parsed || parsed.key !== grant.key || extname(parsed.path).toLowerCase() === '.html') return false
  const mime = MIME[extname(parsed.path).toLowerCase()]
  if (details.resourceType === 'script') return mime === MIME['.js'] || mime === MIME['.mjs']
  if (details.resourceType === 'stylesheet') return mime === MIME['.css']
  if (details.resourceType === 'image') return mime.startsWith('image/')
  if (details.resourceType === 'font') return mime.startsWith('font/')
  return details.resourceType === 'xhr'
}

/** One session listener, scoped by native WC + frame-tree identity; other shell traffic passes. */
export function registerQuickThemeProtocolForSession(ses: Session): void {
  if (installedSessions.has(ses)) return
  ses.protocol.handle(QUICK_THEME_PROTOCOL, handleQuickThemeResource)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const id = details.webContentsId ?? details.webContents?.id
    const policy = id === undefined ? undefined : policies.get(id)
    try {
      callback({ cancel: policy ? !allowRequest(policy, details) : details.url.startsWith(`${QUICK_THEME_PROTOCOL}:`) })
    } catch { callback({ cancel: true }) }
  })
  ses.on('will-download', (event, _item, contents) => {
    // This denies only Quick's native controller, never the shared main-shell WC.
    if (contents && policies.has(contents.id)) event.preventDefault()
  })
  installedSessions.add(ses)
}

/** Parent handlers consume this once; theme-generated key messages cannot mint it. */
export function consumeQuickThemeGesture(key: string): boolean {
  const grant = liveGrant()
  if (!grant || key !== grant.key) return false
  for (const policy of policies.values()) {
    const gesture = policy.gesture
    policy.gesture = null
    if (gesture?.key === key && performance.now() - gesture.at <= 1000 && policy.isActive() && hasThemeFrame(policy)) return true
  }
  return false
}

/** Install before loading the trusted Quick controller. isActive must be native window state. */
export function registerQuickThemeWebContentsPolicy(contents: WebContents, isActive: () => boolean = () => false): void {
  if (policies.has(contents.id)) return
  registerQuickThemeProtocolForSession(contents.session)
  // Per-controller best effort only; this is not a claim of zero-network RTC isolation.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  const policy: QuickPolicy = { contents, isActive, gesture: null }
  policies.set(contents.id, policy)
  const allowedNavigation = (details: Electron.WebContentsWillFrameNavigateEventParams): boolean => {
    if (details.isMainFrame) return !details.initiator || sameFrame(details.initiator, contents.mainFrame)
    try {
      return !!details.frame && sameFrame(details.frame.parent, contents.mainFrame) &&
        !!parseResourceUrl(details.url, true)?.generation && isCurrentQuickThemeEntryUrl(details.url)
    } catch { return false }
  }
  contents.on('will-frame-navigate', details => { if (!allowedNavigation(details)) details.preventDefault() })
  contents.on('will-redirect', details => { if (!allowedNavigation(details)) details.preventDefault() })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const grantGesture = (): void => {
    const grant = liveGrant()
    if (grant && isActive() && hasThemeFrame(policy)) policy.gesture = { key: grant.key, at: performance.now() }
  }
  let pendingMouseGesture: { key: string; at: number } | null = null
  contents.on('before-mouse-event', (_event, mouse) => {
    // First click may still report the parent as focused. Only this Quick WC,
    // visible/focused native window and an active direct theme iframe qualify.
    if (mouse.button !== 'left') return
    const grant = liveGrant()
    if (mouse.type === 'mouseDown') {
      policy.gesture = null
      pendingMouseGesture = grant && isActive() && hasThemeFrame(policy) ? { key: grant.key, at: performance.now() } : null
    } else if (mouse.type === 'mouseUp') {
      const down = pendingMouseGesture
      pendingMouseGesture = null
      if (down && down.key === grant?.key && performance.now() - down.at <= 1000) grantGesture()
    }
  })
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || !isActive() || !directThemeFrame(policy, contents.focusedFrame)) return
    const lower = input.key.toLowerCase()
    const command = input.meta || (process.platform !== 'darwin' && input.control)
    if (input.key === 'Escape' || (command && (lower === 'k' || lower === 'enter'))) {
      // A host-owned shortcut must not also authorize a second theme action.
      policy.gesture = null
      event.preventDefault()
      contents.send(IpcChannels.QuickThemeKey, { key: input.key, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift })
      return
    }
    if (!input.isAutoRepeat && ['enter', ' ', 'space'].includes(lower)) grantGesture()
  })
  contents.on('blur', () => { policy.gesture = null; pendingMouseGesture = null })
  contents.on('did-start-navigation', () => { policy.gesture = null; pendingMouseGesture = null })
  contents.once('destroyed', () => { policies.delete(contents.id); policy.gesture = null; pendingMouseGesture = null })
}
