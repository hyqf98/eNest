import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { isPluginAssetPath } from '@shared/pluginContract'

export const THEME_CHROME_SCHEME = 'enest-chrome'
const MAX_BYTES = 8 * 1024 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
}
export function chromeAssetPath(path: string): boolean {
  return path.length <= 512 && isPluginAssetPath(path) && !!MIME[extname(path).toLowerCase()]
    && !['plugin.json', 'package.json', 'package-lock.json'].includes(path.toLowerCase())
    && path.split('/').every(part => !['backend', 'runtime', 'node_modules', 'src', 'test', 'tests'].includes(part.toLowerCase()))
}
export function chromeAssetUrl(key: string, path: string): string {
  return `${THEME_CHROME_SCHEME}://${key}/${path.split('/').map(encodeURIComponent).join('/')}`
}
export function parseChromeAssetUrl(raw: string, key: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== `${THEME_CHROME_SCHEME}:` || url.hostname !== key || url.search || url.hash || url.username || url.password || url.port) return null
    const parts = url.pathname.slice(1).split('/').map(decodeURIComponent)
    if (parts.some(part => /[/\\]/.test(part))) return null
    const path = parts.join('/')
    return chromeAssetPath(path) && chromeAssetUrl(key, path) === raw ? path : null
  } catch { return null }
}
async function inspect(root: string, path: string): Promise<{ file: string; info: Awaited<ReturnType<typeof stat>> } | null> {
  if (!chromeAssetPath(path)) return null
  const file = resolve(root, path), delta = relative(root, file)
  if (!delta || delta === '..' || delta.startsWith('../') || isAbsolute(delta)) return null
  try {
    let cursor = root
    const parts = path.split('/')
    for (let i = 0; i < parts.length; i++) {
      cursor = resolve(cursor, parts[i])
      const info = await lstat(cursor)
      if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) return null
    }
    const info = await stat(file)
    return info.isFile() && info.size <= MAX_BYTES && await realpath(file) === file ? { file, info } : null
  } catch { return null }
}
export async function readChromeAsset(rootInput: string, root: string, path: string): Promise<Uint8Array | null> {
  if (await realpath(rootInput) !== root) return null
  const checked = await inspect(root, path)
  if (!checked) return null
  const file = await open(checked.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > MAX_BYTES || before.dev !== checked.info.dev || before.ino !== checked.info.ino || before.size !== checked.info.size) return null
    const bytes = new Uint8Array(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat(), latest = await inspect(root, path)
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      !latest || latest.info.dev !== before.dev || latest.info.ino !== before.ino || await realpath(rootInput) !== root) return null
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}
export function chromeAssetResponse(request: Request, status: number, body: Uint8Array | string | null, path = ''): Response {
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: {
    'Content-Type': MIME[extname(path).toLowerCase()] ?? 'text/plain; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), fullscreen=()'
  } })
}
