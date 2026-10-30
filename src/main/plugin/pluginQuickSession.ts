export interface QuickSessionToken { pluginId: string; revision: number }

/** Logical ownership survives auto-hide; visibility alone never ends a session. */
export class PluginQuickSession {
  private owner: string | null = null
  private visible = false
  private revision = 0

  get pluginId(): string | null { return this.owner }
  get visiblePluginId(): string | null { return this.visible ? this.owner : null }

  retains(pluginId: string): boolean { return this.owner === pluginId }

  show(pluginId: string): void {
    if (this.owner !== pluginId) this.revision++
    this.owner = pluginId
    this.visible = true
  }

  hide(): string | null {
    const pluginId = this.visiblePluginId
    this.visible = false
    return pluginId
  }

  release(pluginId = this.owner): boolean {
    if (!pluginId || this.owner !== pluginId) return false
    this.owner = null
    this.visible = false
    this.revision++
    return true
  }

  capture(): QuickSessionToken | null {
    return this.owner ? { pluginId: this.owner, revision: this.revision } : null
  }

  matches(token: QuickSessionToken): boolean {
    return this.owner === token.pluginId && this.revision === token.revision
  }
}
