import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { PluginAssetCache } from './pluginAssetCache'

export const pluginAssetCache = new PluginAssetCache()

/** Serve large assets/media without whole-file allocation; support seeking and cancellation. */
export async function pluginFileResponse(
  request: Request,
  path: string,
  options: { mime: string; csp: string; root?: string; revision?: string; dev?: boolean }
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  const info = await stat(path)
  if (!info.isFile()) return new Response('not found', { status: 404 })
  const etag = `W/"${options.revision ?? ''}-${info.size}-${info.mtimeMs}"`
  const headers = new Headers({
    'Content-Type': options.mime,
    'Content-Security-Policy': options.csp,
    'Content-Length': String(info.size),
    'Accept-Ranges': 'bytes',
    'Last-Modified': info.mtime.toUTCString(),
    ETag: etag,
    // Existing plugin URLs are not content-addressed; never mark them immutable.
    'Cache-Control': options.dev ? 'no-store' : 'no-cache'
  })
  if (!options.dev && request.headers.get('if-none-match')?.split(',').some((value) => {
    const candidate = value.trim()
    return candidate === '*' || candidate.replace(/^W\//, '') === etag.replace(/^W\//, '')
  })) {
    headers.delete('Content-Length')
    return new Response(null, { status: 304, headers })
  }
  let start = 0
  let end = info.size - 1
  let partial = false
  const range = request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  // Weak ETags cannot validate If-Range. A matching modification date can.
  if (range && (!ifRange || ifRange === info.mtime.toUTCString())) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    // Multiple ranges may legally be ignored; never accidentally stream the wrong slice.
    if (match) {
      if (match[1]) {
        start = Number(match[1])
        end = match[2] ? Math.min(Number(match[2]), end) : end
      } else if (match[2]) {
        start = Math.max(0, info.size - Number(match[2]))
      }
      if ((!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        headers.set('Content-Range', `bytes */${info.size}`)
        headers.set('Content-Length', '0')
        return new Response(null, { status: 416, headers })
      }
      partial = true
      headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
      headers.set('Content-Length', String(end - start + 1))
    }
  }
  const status = partial ? 206 : 200
  if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers })
  if (!partial && options.root && !options.dev && info.size <= pluginAssetCache.maxFileBytes && pluginAssetCache.getStats().pending < 8) {
    const key = JSON.stringify([options.root, path, etag])
    const body = await pluginAssetCache.read(options.root, key, () => readFile(path))
    return new Response(body, { status, headers })
  }
  const stream = createReadStream(path, { start, end, signal: request.signal })
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
}
