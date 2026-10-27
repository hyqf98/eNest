import type { AppearanceColorMode, AppearanceComponents, AppearanceFonts } from './appearance'
import type { AnimationLevel } from './plugin'
import type { QuickActionId, QuickCommandKind, QuickContentMatch, QuickImageContext } from './quick'

/** Package-relative entry owned by the declaring theme. The host owns native geometry. */
export interface ThemeQuickReference { version: 1; entry: string }
export interface QuickThemeAppearance {
  mode: AppearanceColorMode
  tokens: Record<string, string>
  fonts: AppearanceFonts
  components: AppearanceComponents
  animation: AnimationLevel
  resources: { fonts: Array<{ family: string; url: string }> }
}
export interface QuickThemeConfig {
  key: string
  url: string
  appearance: QuickThemeAppearance
}
/** Bounded provider-private JSON. The host does not interpret the provider's schema. */
export interface QuickStateSnapshot { revision: number; value: unknown }
/** Legacy data is available only to the trusted bundled provider on its first import. */
export interface QuickProviderStateSnapshot extends QuickStateSnapshot { legacy?: unknown }
export type QuickProviderStateRequest =
  | { providerKey: string | null; operation: 'read' }
  | { providerKey: string | null; operation: 'write'; expectedRevision: number; value: unknown }
  | { providerKey: null; operation: 'keys'; identities: string[] }
/** A successful native launch fact, not an instruction to maintain any particular history model. */
export interface QuickThemeOpenedReceipt {
  sequence: number
  stateKey: string
  at: number
  query: string
}
/** Opaque handles expire whenever the current result set changes. No launch paths or payloads. */
export interface QuickThemeItem {
  id: string
  kind: QuickCommandKind
  title: string
  subtitle: string
  group: string
  /** Host-published image bytes only, never filesystem or plugin package paths. */
  icon?: string
  action?: QuickActionId
}
/** A native directory descriptor. IDs are session capabilities, not launch targets. */
export interface QuickThemeCatalogItem extends Omit<QuickThemeItem, 'group'> {
  /** Stable opaque identity for private state, never a launch capability or local path. */
  stateKey: string
  aliases: string[]
  content?: QuickContentMatch
  provider?: boolean
}
export interface QuickThemeSnapshot {
  version: 1
  revision: number
  query: string
  filter: QuickCommandKind | null
  searching: boolean
  loading: boolean
  busy: boolean
  composing: boolean
  error: string | null
  items: QuickThemeItem[]
  catalog: QuickThemeCatalogItem[]
  catalogRevision: number
  queryRevision: number
  shown: number
  selectedId: string | null
  expanded: boolean
  hiddenCount: number
  emptyMarket: boolean
  plugin: { title: string; loading: boolean; placeholder: string; acceptsInput: boolean } | null
  /**
   * Host-held paste context (bounded thumbnails only; full bytes stay in main).
   * Null when nothing is attached. Items ≤12.
   */
  input: { items: QuickImageContext[]; hasText: boolean } | null
  appearance: QuickThemeAppearance
  bounds: { width: number; height: number; inputHeight: number }
  opened?: QuickThemeOpenedReceipt | null
}
export type QuickThemeAction =
  | { type: 'state-read' }
  | { type: 'state-write'; expectedRevision: number; value: unknown }
  | { type: 'query'; query: string }
  | { type: 'filter'; kind: QuickCommandKind | null }
  | { type: 'select'; id: string }
  /** A provider selects and orders only current catalog handles; it cannot supply launch data. */
  | { type: 'results'; catalogRevision: number; queryRevision: number; items: Array<{ id: string; title?: string; group?: string }>; selectedId?: string | null; hiddenCount?: number; emptyMarket?: boolean; expanded?: boolean }
  | { type: 'composition'; active: boolean }
  | { type: 'open'; id: string; container?: 'quick' | 'shell' }
  | { type: 'expand'; expanded: boolean }
  /** Request the host read clipboard image/file into the paste context; needs a one-shot native gesture. */
  | { type: 'paste' }
  /** Remove one paste-context entry by opaque id; omit id to clear the whole context. */
  | { type: 'input-clear'; id?: string }
  | { type: 'open-market' | 'open-settings' | 'refresh-apps' | 'retry' | 'hide' | 'plugin-back' | 'plugin-pin' | 'plugin-focus' | 'plugin-detach' }
  | { type: 'layout'; columns: number; height: number }
  | { type: 'key'; key: string; shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean }
export interface QuickThemeActionResult { ok: boolean; error?: string; state?: QuickStateSnapshot }
/** Only available inside an isolated ThemePackV2.quick page, never an ordinary plugin page. */
export interface EnestQuickApi {
  ready(): void
  getState(): Promise<QuickThemeSnapshot>
  onState(listener: (state: QuickThemeSnapshot) => void): () => void
  onFocus(listener: (request: { selectAll: boolean }) => void): () => void
  action(action: QuickThemeAction): Promise<QuickThemeActionResult>
  state: {
    read(): Promise<QuickStateSnapshot>
    write(value: unknown, expectedRevision: number): Promise<QuickStateSnapshot>
  }
}
