import { get } from 'node:http'
import { win32 } from 'node:path'
import { session } from 'electron'

const maximumBytes = 256 * 1024

export function everythingPaths(payload: unknown, term: string, limit: number): string[] {
  if (!payload || typeof payload !== 'object' || !('totalResults' in payload) || !Number.isSafeInteger(payload.totalResults) || Number(payload.totalResults) < 0 || !('results' in payload) || !Array.isArray(payload.results) || payload.results.length > limit) throw new Error('Invalid local file index response')
  const paths: string[] = [], needle = term.normalize('NFC').toLowerCase()
  for (const row of payload.results) {
    if (!row || row.type !== 'file' && row.type !== 'folder' || typeof row.name !== 'string' || typeof row.path !== 'string' || row.name.length > 255 || row.path.length > 4096) continue
    if (!/^[a-z]:[\\/]/i.test(row.path) || /[\u0000-\u001f\u007f<>:"|?*]/u.test(row.path.slice(2)) || row.path.split(/[\\/]/u).some((part: string) => part === '..') || !row.name || /[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(row.name) || row.name === '.' || row.name === '..') continue
    if (row.name.normalize('NFC').toLowerCase().includes(needle)) paths.push(win32.join(row.path, row.name))
  }
  return paths
}

async function directRoute(port: number, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  let cancel = () => {}
  const aborted = new Promise<boolean>(resolve => { cancel = () => resolve(false); signal.addEventListener('abort', cancel, { once: true }) })
  try { return await Promise.race([aborted, session.defaultSession.resolveProxy(`http://127.0.0.1:${port}/`).then(route => route === 'DIRECT')]) }
  finally { signal.removeEventListener('abort', cancel) }
}

export async function everythingFileNames(term: string, port: number, limit: number, owner: AbortSignal): Promise<string[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || /[\u0000-\u001f<>:"/\\|?*]/u.test(term)) throw new Error('Invalid local file index request')
  const signal = AbortSignal.any([owner, AbortSignal.timeout(1200)])
  if (!await directRoute(port, signal)) throw new Error('Local file index requires a direct loopback route')
  signal.throwIfAborted()
  const parameters = new URLSearchParams({ search: `"${term}"`, json: '1', path_column: '1', count: String(limit) })
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', family: 4, port, path: `/?${parameters}`, agent: false, signal, headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } }, response => {
      void (async () => {
        const encoding = response.headers['content-encoding'], mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase()
        if (response.statusCode !== 200 || Number(response.headers['content-length']) > maximumBytes || encoding && encoding !== 'identity' || mime !== 'application/json' && mime !== 'text/plain') throw new Error('Local file index unavailable')
        const chunks: Buffer[] = []; let bytes = 0
        for await (const chunk of response) {
          const buffer = Buffer.from(chunk); bytes += buffer.length
          if (bytes > maximumBytes) throw new Error('Local file index response too large')
          chunks.push(buffer)
        }
        signal.throwIfAborted()
        return everythingPaths(JSON.parse(Buffer.concat(chunks).toString('utf8')), term, limit)
      })().then(resolve, reject).finally(() => response.destroy())
    })
    request.once('error', reject)
  })
}
