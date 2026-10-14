/** Bounded immutable asset cache. In-flight reads never repopulate invalidated generations. */
export class PluginAssetCache {
  private entries = new Map<string, { root: string; body: Buffer }>()
  private pending = new Map<string, { root: string; promise: Promise<Buffer> }>()
  private bytes = 0
  private hits = 0
  private misses = 0
  private sharedReads = 0
  private evictions = 0
  private staleReads = 0

  constructor(
    readonly maxBytes = 32 * 1024 * 1024,
    readonly maxFileBytes = 512 * 1024
  ) {}

  async read(root: string, key: string, loader: () => Promise<Buffer>): Promise<Buffer> {
    const hit = this.entries.get(key)
    if (hit) {
      this.hits++
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit.body
    }
    const existing = this.pending.get(key)
    if (existing) { this.sharedReads++; return existing.promise }
    this.misses++
    const record = { root, promise: undefined as unknown as Promise<Buffer> }
    record.promise = Promise.resolve().then(loader).then((body) => {
      // An old read must neither fill the cache nor answer a request after replacement.
      if (this.pending.get(key) !== record) {
        this.staleReads++
        throw new Error('plugin asset invalidated during read')
      }
      if (this.pending.get(key) === record && body.byteLength <= this.maxFileBytes) {
        this.entries.set(key, { root, body })
        this.bytes += body.byteLength
        while (this.bytes > this.maxBytes && this.entries.size) {
          const oldest = this.entries.keys().next().value!
          this.bytes -= this.entries.get(oldest)!.body.byteLength
          this.entries.delete(oldest)
          this.evictions++
        }
      }
      return body
    }).finally(() => {
      if (this.pending.get(key) === record) this.pending.delete(key)
    })
    this.pending.set(key, record)
    return record.promise
  }

  invalidate(root?: string): void {
    for (const [key, entry] of this.entries) {
      if (root === undefined || entry.root === root) {
        this.bytes -= entry.body.byteLength
        this.entries.delete(key)
      }
    }
    for (const [key, entry] of this.pending) {
      if (root === undefined || entry.root === root) this.pending.delete(key)
    }
  }

  getMetrics() { return { ...this.getStats(), hits: this.hits, misses: this.misses, sharedReads: this.sharedReads, evictions: this.evictions, staleReads: this.staleReads, maxBytes: this.maxBytes, maxFileBytes: this.maxFileBytes } }

  getStats(): { bytes: number; entries: number; pending: number } {
    return { bytes: this.bytes, entries: this.entries.size, pending: this.pending.size }
  }
}
