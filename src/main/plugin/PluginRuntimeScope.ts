/** Runtime resources belong to one incarnation, never merely to a plugin id. */
export interface RuntimeOwner {
  readonly pluginId: string
  readonly generation: number
  readonly wcId: number
}

type Disposer = () => void | Promise<void>
const scopes = new Map<string, PluginRuntimeScope>()

export class PluginRuntimeScope {
  private controller = new AbortController()
  private disposers = new Set<Disposer>()
  private activities = new Map<number, string>()
  private nextActivity = 0
  private completion?: Promise<void>
  private disposed = false
  private closing = false
  private activityChanged?: () => void
  readonly failures: string[] = []

  constructor(readonly owner: RuntimeOwner) {}

  get signal(): AbortSignal { return this.controller.signal }
  get isClosing(): boolean { return this.closing }
  get activityCount(): number { return this.activities.size }
  isCurrent(): boolean { return !this.disposed && scopes.get(this.owner.pluginId) === this }

  onActivityChanged(callback: () => void): void { this.activityChanged = callback }

  acquireActivity(reason: string): () => void {
    if (!this.isCurrent() || this.closing) throw new Error('plugin runtime is closing')
    const id = ++this.nextActivity
    this.activities.set(id, reason.slice(0, 160))
    let released = false
    return () => {
      if (released) return
      released = true
      this.activities.delete(id)
      if (!this.closing) this.activityChanged?.()
    }
  }

  addDisposer(disposer: Disposer): () => void {
    if (this.disposed || this.closing) {
      void Promise.resolve().then(disposer).catch((error) => this.failures.push(String(error)))
      return () => {}
    }
    this.disposers.add(disposer)
    return () => { this.disposers.delete(disposer) }
  }

  /** Abort resource creation immediately. Persistence remains available during the grace period. */
  markClosing(): void {
    if (this.closing) return
    this.closing = true
    this.activityChanged = undefined
    this.controller.abort(new Error('plugin runtime closed'))
  }

  /** Every release starts even if another release fails; all share an absolute deadline. */
  dispose(deadlineMs = Date.now() + 1500): Promise<void> {
    if (this.completion) return this.completion
    this.markClosing()
    const releases = [...this.disposers]
    this.disposers.clear()
    this.completion = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.allSettled(releases.map((release) => Promise.resolve().then(release))).then((results) => {
          for (const result of results) if (result.status === 'rejected') this.failures.push(String(result.reason))
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => { this.failures.push('resource disposal deadline exceeded'); resolve() }, Math.max(0, deadlineMs - Date.now()))
        })
      ])
      if (timer) clearTimeout(timer)
      this.activities.clear()
      this.disposed = true
      if (scopes.get(this.owner.pluginId) === this) scopes.delete(this.owner.pluginId)
    })()
    return this.completion
  }

  diagnostics() {
    return { ...this.owner, closing: this.closing, activities: [...this.activities.values()], resources: this.disposers.size }
  }
}

export function createRuntimeScope(owner: RuntimeOwner): PluginRuntimeScope {
  if (scopes.has(owner.pluginId)) throw new Error(`plugin runtime already exists: ${owner.pluginId}`)
  const scope = new PluginRuntimeScope(owner)
  scopes.set(owner.pluginId, scope)
  return scope
}

export function getRuntimeScope(pluginId: string): PluginRuntimeScope | undefined { return scopes.get(pluginId) }
export function getRuntimeDiagnostics() { return [...scopes.values()].map((scope) => scope.diagnostics()) }
