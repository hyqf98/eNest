import { isAbsolute } from 'node:path'

/** Legacy DROPFILES codec for historical fixtures, not the native clipboard path. */
export function encodeDropFiles(paths) {
  const header = Buffer.alloc(20); header.writeUInt32LE(20, 0); header.writeUInt32LE(1, 16)
  return Buffer.concat([header, Buffer.from(paths.join('\0') + '\0\0', 'utf16le')])
}

export function decodeDropFiles(bytes) {
  if (bytes.length < 20) return []
  const offset = bytes.readUInt32LE(0)
  if (offset < 20 || offset >= bytes.length) return []
  return bytes.subarray(offset).toString(bytes.readUInt32LE(16) ? 'utf16le' : 'latin1').split('\0').filter(path => isAbsolute(path) && !path.includes('\0')).slice(0, 1000)
}
