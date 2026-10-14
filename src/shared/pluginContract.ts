/** Public plugin layout. Paths always describe the runtime root, never the source project. */
export const PLUGIN_ENTRY = 'index.html'
export const PLUGIN_ICON = 'assets/market/icon.svg'
export const PLUGIN_README = 'assets/market/README.md'
export const PLUGIN_SCREENSHOTS = 'assets/market/screenshots/'

/** Manifest paths are decoded filesystem names. URL encoding happens only when serving them. */
export function isPluginAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f\u007f?#%:]/.test(value)) return false
  const parts = value.split('/')
  return parts.every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.'))
}

/** A development endpoint is explicit and credential-free; LAN hosts are supported. */
export function normalizePluginDevUrl(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw new Error('开发地址必须是 HTTP(S) URL')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('开发地址必须是无凭据、无片段的 HTTP(S) URL')
  }
  return url.href
}
