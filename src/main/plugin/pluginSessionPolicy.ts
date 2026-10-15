/** Restricts renderer networking, devices, downloads and restricted-directory access. */
import type { Session } from 'electron'

export interface PluginSessionPolicy { pluginId: string; devUrl?: string }
type EndpointKind = 'webSocket' | 'subFrame'
const endpoints = new Map<string, Map<symbol, { url: URL; kind: EndpointKind }>>()
const installed = new WeakSet<Session>()

/** Only a host service may grant its actual listening endpoint after obtaining its capability. */
export function allowPluginEndpoint(pluginId: string, url: string, kind: EndpointKind): () => void {
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password ||
      !(kind === 'webSocket' ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(parsed.protocol)) {
    throw new Error('plugin endpoint must be an explicit host-owned loopback service')
  }
  const token = Symbol(pluginId)
  const bag = endpoints.get(pluginId) ?? new Map()
  bag.set(token, { url: parsed, kind }); endpoints.set(pluginId, bag)
  return () => {
    bag.delete(token)
    if (!bag.size && endpoints.get(pluginId) === bag) endpoints.delete(pluginId)
  }
}
export function releasePluginEndpoints(pluginId: string): void { endpoints.delete(pluginId) }

function devOrigin(devUrl?: string): URL | undefined {
  try {
    const url = new URL(devUrl ?? '')
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url
  } catch { /* absent or invalid developer configuration */ }
  return undefined
}

export function isPluginPageUrl(url: string, pluginId: string, devUrl?: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return false
    if (parsed.protocol === 'enest:') return parsed.hostname === 'plugin' && parsed.pathname.split('/')[1] === pluginId
    const dev = devOrigin(devUrl)
    return !!dev && parsed.origin === dev.origin
  } catch { return false }
}

/** Exported pure predicate makes denied network/file/other-plugin routes testable without Electron. */
export function pluginRequestAllowed(policy: PluginSessionPolicy, url: string, resourceType: string): boolean {
  if (isPluginPageUrl(url, policy.pluginId, policy.devUrl)) return true
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password || resourceType === 'mainFrame') return false
    if (['data:', 'blob:'].includes(parsed.protocol)) return resourceType !== 'subFrame'
    const dev = devOrigin(policy.devUrl)
    if (dev && resourceType === 'webSocket' && parsed.host === dev.host && parsed.protocol === (dev.protocol === 'https:' ? 'wss:' : 'ws:')) return true
    for (const endpoint of endpoints.get(policy.pluginId)?.values() ?? []) {
      if (endpoint.kind === 'webSocket' && resourceType === 'webSocket' && parsed.origin === endpoint.url.origin && parsed.pathname === endpoint.url.pathname) return true
      // Embedded host services need assets and their own sockets; only this dynamically minted origin is allowed.
      if (endpoint.kind === 'subFrame' && parsed.host === endpoint.url.host &&
          (parsed.protocol === endpoint.url.protocol || resourceType === 'webSocket' && parsed.protocol === (endpoint.url.protocol === 'https:' ? 'wss:' : 'ws:'))) return true
    }
  } catch { /* reject malformed URLs */ }
  return false
}

/** CSP reserves loopback transports; onBeforeRequest still requires a live host endpoint grant. */
export function getPluginContentSecurityPolicy(policy: PluginSessionPolicy): string {
  const dev = devOrigin(policy.devUrl)
  // Chromium CSP host sources do not accept bracketed IPv6 literals. Same-origin
  // development assets still use 'self'; host services bind IPv4 loopback.
  const literalHostSupported = dev && !dev.hostname.includes(':')
  const sources = literalHostSupported ? ` ${dev.origin}` : ''
  const websocket = literalHostSupported ? ` ${dev.protocol === 'https:' ? 'wss:' : 'ws:'}//${dev.host}` : ''
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ''}${sources}; style-src 'self' 'unsafe-inline'${sources}; img-src 'self' data: blob:${sources}; media-src 'self' blob:; font-src 'self' data:${sources}; connect-src 'self'${sources}${websocket} http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'self'; form-action 'none'`
}

export function configurePluginSession(ses: Session, policy: PluginSessionPolicy): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  ses.webRequest.onBeforeRequest((details, callback) => {
    // Electron's inspector shares the inspected session. Its own native remote
    // WebContents must be able to load bundled UI; plugin pages get no exemption.
    const inspectorResource = details.url.startsWith('devtools://devtools/bundled/') &&
      details.webContents?.getType() === 'remote'
    callback({ cancel: !inspectorResource && !pluginRequestAllowed(policy, details.url, details.resourceType) })
  })
  // Remote development servers do not pass through pluginProtocol; enforce the same document policy here.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    if (details.resourceType === 'mainFrame' && isPluginPageUrl(details.url, policy.pluginId, policy.devUrl)) {
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-security-policy') delete headers[name]
      headers['Content-Security-Policy'] = [getPluginContentSecurityPolicy(policy)]
    }
    callback({ responseHeaders: headers })
  })
  if (!installed.has(ses)) {
    installed.add(ses)
    ses.on('will-download', event => event.preventDefault())
    // This event is only Chromium's restricted-directory gate, not a blanket
    // HTML file-picker interceptor. Official plugins use localFiles capabilities.
    ses.on('file-system-access-restricted', (_event, _details, callback) => callback('deny'))
  }
}
