interface QuickSourceRead<T> {
  readonly promise: Promise<T>
  isCurrent: () => boolean
}

interface QuickSourceEntry<T> extends QuickSourceRead<T> {
  key: number
  failed: boolean
}

/** Share pending reads and retain successful snapshots until an authoritative change. */
export class QuickSourceCache<T> {
  private entry: QuickSourceEntry<T> | null = null

  read(key: number, load: () => Promise<T>): QuickSourceRead<T> {
    if (this.entry?.key === key && !this.entry.failed) return this.entry
    const entry: QuickSourceEntry<T> = {
      key,
      failed: false,
      promise: Promise.resolve().then(() => {
        if (this.entry !== entry) throw new Error('Quick source read was invalidated')
        return load()
      }),
      isCurrent: () => this.entry === entry
    }
    this.entry = entry
    // Keep a failed read current long enough for its subscribers to report it.
    // The next read retries; invalidation still retires all older subscribers.
    void entry.promise.catch(() => { entry.failed = true })
    return entry
  }

  invalidate(): void {
    this.entry = null
  }
}
