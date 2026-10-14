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
export function encodeDropFiles(paths: string[]): Buffer {
  const header = Buffer.alloc(20); header.writeUInt32LE(20, 0); header.writeUInt32LE(1, 16)
  return Buffer.concat([header, Buffer.from(paths.join('\0') + '\0\0', 'utf16le')])
}
export function decodeDropFiles(bytes: Buffer): string[] {
  if (bytes.length < 20) return []
  const offset = bytes.readUInt32LE(0)
  if (offset < 20 || offset >= bytes.length) return []
  return bytes.subarray(offset).toString(bytes.readUInt32LE(16) ? 'utf16le' : 'latin1').split('\0').filter(path => isAbsolute(path) && !path.includes('\0')).slice(0, 1000)
}
