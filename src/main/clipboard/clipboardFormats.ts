import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'

/** URI lists are newline-separated file URLs, never shell-escaped paths. */
export function parseFileUris(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).flatMap(line => {
    if (!line || line.startsWith('#') || line === 'copy' || line === 'cut') return []
    try { const url = new URL(line.trim()); return url.protocol === 'file:' && (!url.hostname || url.hostname === 'localhost') ? [fileURLToPath(url)] : [] } catch { return [] }
  }))].filter(path => isAbsolute(path) && !path.includes('\0')).slice(0, 1000)
}
export function formatFileUris(paths: string[]): string {
  return paths.filter(path => isAbsolute(path) && !path.includes('\0')).map(path => pathToFileURL(path).href).join('\r\n') + '\r\n'
}
