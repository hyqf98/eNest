import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'

interface OpenFile {
  file: FileHandle
  identity: BigIntStats
  reads: Set<Promise<unknown>>
  closing?: Promise<void>
}
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => b.isFile()
  && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** Read-only streaming grants belong to one backend incarnation, not to a plugin id. */
export class PluginBackendFiles {
  private files = new Map<string, OpenFile>()
  private openings = new Set<Promise<unknown>>()
  private reading = 0
  private closed = false

  constructor(private resolve: (handleId: string) => Promise<string>, private assertCurrent: () => void) {}

  private assertOpen(): void {
    this.assertCurrent()
    if (this.closed) throw new Error('Backend file scope is closed')
  }

  async open(handleId: unknown): Promise<{ token: string; name: string; size: number }> {
    this.assertOpen()
    if (typeof handleId !== 'string' || !handleId || handleId.length > 512) throw new Error('Invalid file handle')
    if (this.files.size + this.openings.size >= 64) throw new Error('Backend open file limit reached')
    const operation = (async () => {
      const path = await this.resolve(handleId)
      this.assertOpen()
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const identity = await file.stat({ bigint: true })
        this.assertOpen()
        if (!identity.isFile() || identity.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Selected target is not a supported regular file')
        const token = randomUUID()
        this.files.set(token, { file, identity, reads: new Set() })
        return { token, name: basename(path), size: Number(identity.size) }
      } catch (error) { await file.close(); throw error }
    })()
    this.openings.add(operation)
    try { return await operation } finally { this.openings.delete(operation) }
  }

  async read(input: { token?: unknown; offset?: unknown; length?: unknown }): Promise<{ bytes: Uint8Array; bytesRead: number }> {
    this.assertOpen()
    const entry = typeof input.token === 'string' ? this.files.get(input.token) : undefined
    if (!entry || entry.closing) throw new Error('Invalid or closed backend file token')
    const { offset, length } = input
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(length)
      || Number(length) < 1 || Number(length) > 256 * 1024 || Number(offset) > Number.MAX_SAFE_INTEGER - Number(length)) throw new Error('Invalid bounded file read')
    if (this.reading >= 8) throw new Error('Backend file read limit reached')
    this.reading++
    const operation = (async () => {
      if (!sameFile(entry.identity, await entry.file.stat({ bigint: true }))) throw new Error('Selected file changed')
      this.assertOpen()
      if (entry.closing) throw new Error('Backend file is closing')
      const bytes = new Uint8Array(Number(length))
      const { bytesRead } = await entry.file.read(bytes, 0, bytes.length, Number(offset))
      if (!sameFile(entry.identity, await entry.file.stat({ bigint: true }))) throw new Error('Selected file changed')
      this.assertOpen()
      if (entry.closing) throw new Error('Backend file is closing')
      return { bytes: bytes.slice(0, bytesRead), bytesRead }
    })()
    entry.reads.add(operation)
    try { return await operation } finally { entry.reads.delete(operation); this.reading-- }
  }

  async close(token: unknown): Promise<void> {
    if (typeof token !== 'string' || !token || token.length > 128) throw new Error('Invalid backend file token')
    const entry = this.files.get(token)
    if (!entry) return
    entry.closing ??= (async () => {
      await Promise.allSettled([...entry.reads])
      await entry.file.close()
      this.files.delete(token)
    })().catch(error => { entry.closing = undefined; throw error })
    await entry.closing
  }

  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.openings])
    const results = await Promise.allSettled([...this.files.keys()].map(token => this.close(token)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
