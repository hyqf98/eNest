import type { DetachedWindowSession, SessionTabRef } from '@shared/types/plugin'
import { normalizeDetachedWindowSession } from '@shared/windowState'

const copyTab = (tab: SessionTabRef): SessionTabRef => ({ ...tab, ...(tab.detached ? { detached: { ...tab.detached, bounds: { ...tab.detached.bounds } } } : {}) })

export interface PluginWindowSessionSnapshot {
  sessionTabs: SessionTabRef[]
  sessionActivePluginId: string
}

/** One main-process writer; placement never determines whether a session survives restart. */
export class PluginWindowSession {
  private tabs = new Map<string, SessionTabRef>()
  private active = ''
  private loaded = false
  private frozen = false
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false

  constructor(
    private read: () => Partial<PluginWindowSessionSnapshot>,
    private write: (snapshot: PluginWindowSessionSnapshot) => void
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const saved = this.read()
    for (const tab of Array.isArray(saved.sessionTabs) ? saved.sessionTabs : []) {
      if (typeof tab?.pluginId !== 'string' || !tab.pluginId) continue
      const detached = normalizeDetachedWindowSession(tab.detached)
      this.tabs.set(tab.pluginId, { pluginId: tab.pluginId, title: typeof tab.title === 'string' ? tab.title : undefined, ...(detached ? { detached } : {}) })
    }
    this.active = this.tabs.has(saved.sessionActivePluginId ?? '') ? saved.sessionActivePluginId! : ''
  }

  get(pluginId: string): SessionTabRef | undefined {
    this.load()
    const tab = this.tabs.get(pluginId)
    return tab ? copyTab(tab) : undefined
  }

  retain(pluginId: string, title: string): void {
    if (this.frozen) return
    this.load()
    if (this.tabs.get(pluginId)?.title === title) return
    this.tabs.set(pluginId, { ...this.tabs.get(pluginId), pluginId, title })
    this.schedule()
  }

  setDetached(pluginId: string, value: DetachedWindowSession): void {
    if (this.frozen) return
    this.load()
    const tab = this.tabs.get(pluginId), detached = normalizeDetachedWindowSession(value)
    if (!tab || !detached || JSON.stringify(tab.detached) === JSON.stringify(detached)) return
    this.tabs.set(pluginId, { ...tab, detached })
    this.schedule()
  }

  clearDetached(pluginId: string): void {
    if (this.frozen) return
    this.load()
    const tab = this.tabs.get(pluginId)
    if (!tab?.detached) return
    const { detached: _detached, ...rest } = tab
    this.tabs.set(pluginId, rest)
    this.schedule()
  }

  remove(pluginId: string): void {
    if (this.frozen) return
    this.load()
    if (!this.tabs.delete(pluginId)) return
    if (this.active === pluginId) this.active = ''
    this.schedule()
  }

  focus(pluginId: string): void {
    if (this.frozen) return
    this.load()
    if (!this.tabs.has(pluginId) || this.active === pluginId) return
    this.active = pluginId
    this.schedule()
  }

  reorder(pluginId: string, index: number): void {
    if (this.frozen) return
    this.load()
    const tab = this.tabs.get(pluginId)
    if (!tab) return
    const entries = [...this.tabs].filter(([id]) => id !== pluginId)
    entries.splice(Math.max(0, Math.min(entries.length, Math.floor(index))), 0, [pluginId, tab])
    this.tabs = new Map(entries)
    this.schedule()
  }

  /** Reorder only shell slots; independent/Quick sessions keep their relative anchors. */
  orderShell(ids: string[]): void {
    if (this.frozen) return
    this.load()
    const ordered = ids.filter((id, index) => this.tabs.has(id) && ids.indexOf(id) === index)
    const shell = new Set(ordered)
    let index = 0
    this.tabs = new Map([...this.tabs].map(([id, tab]) => {
      if (!shell.has(id)) return [id, tab]
      const next = ordered[index++]
      return [next, this.tabs.get(next)!]
    }))
    this.schedule()
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, 400)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    this.dirty = false
    this.write({ sessionTabs: [...this.tabs.values()].map(copyTab), sessionActivePluginId: this.active })
  }

  /** Freeze before destroyAll, so application cleanup cannot erase the restart snapshot. */
  prepareShutdown(): void { this.flush(); this.frozen = true }
}
