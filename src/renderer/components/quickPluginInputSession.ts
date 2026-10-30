import type { QuickInputMessage, QuickInputState } from '@shared/types/plugin-tools'

type InputChangeMessage = Extract<QuickInputMessage, { type: 'change' }>
export interface QuickPluginInputSnapshot {
  status: 'idle' | 'hydrating' | 'ready' | 'unsupported' | 'failed'
  input: QuickInputState | null
  value: string
}
export interface QuickPluginInputUpdate { accepted: boolean; message?: InputChangeMessage }
type QueryChange = { target: 'search' | 'ignored' } | { target: 'plugin'; message?: InputChangeMessage }

/** A mode announcement restores input ownership; it never requests a return to search. */
export class QuickPluginInputSession {
  private owner: string | null = null
  private input: QuickInputState | null = null
  private status: QuickPluginInputSnapshot['status'] = 'idle'
  private draft: { value: string; generation: number | null } | null = null
  private version = 0

  get revision(): number { return this.version }
  get activeInput(): QuickInputState | null { return this.status === 'ready' ? this.input : null }
  get snapshot(): QuickPluginInputSnapshot {
    return { status: this.status, input: this.input, value: this.draft?.value ?? this.input?.value ?? '' }
  }

  restore(pluginId: string | null): number {
    if (!pluginId || pluginId !== this.owner) { this.input = null; this.draft = null }
    this.owner = pluginId
    this.status = pluginId ? 'hydrating' : 'idle'
    return ++this.version
  }

  receive(state: QuickInputState | null, revision = this.version): QuickPluginInputUpdate {
    if (revision !== this.version || !this.owner || state && state.pluginId !== this.owner) return { accepted: false }
    this.version++
    this.input = state ? { ...state } : null
    this.status = state ? 'ready' : 'unsupported'
    const draft = this.draft
    this.draft = null
    if (!this.input || !draft || draft.generation !== null && draft.generation !== this.input.generation) return { accepted: true }
    this.input.value = draft.value
    return { accepted: true, message: this.changeMessage(this.input) }
  }

  fail(revision: number): boolean {
    if (revision !== this.version || !this.owner) return false
    this.version++
    this.status = 'failed'
    this.draft = null
    return true
  }

  change(value: string): QueryChange {
    if (!this.owner) return { target: 'search' }
    if (this.status === 'hydrating') {
      // Revalidate the runtime before forwarding text typed during a hidden-window restore.
      this.draft = { value, generation: this.input?.generation ?? null }
      return { target: 'plugin' }
    }
    if (this.status !== 'ready' || !this.input) return { target: 'ignored' }
    this.input = { ...this.input, value }
    return { target: 'plugin', message: this.changeMessage(this.input) }
  }

  private changeMessage(input: QuickInputState): InputChangeMessage {
    return { pluginId: input.pluginId, generation: input.generation, type: 'change', value: input.value }
  }
}
