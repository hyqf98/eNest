import type { AppearanceColorMode, AppearanceComponents, AppearanceFonts } from './appearance'
import type { AnimationLevel } from './plugin'
import type { QuickCommandKind } from './quick'

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
/** Opaque handles expire whenever the current result set changes. No launch paths or payloads. */
export interface QuickThemeItem {
  id: string
  kind: QuickCommandKind
  title: string
  subtitle: string
  group: string
}
export interface QuickThemeSnapshot {
  version: 1
  revision: number
  query: string
  filter: QuickCommandKind | null
  searching: boolean
  loading: boolean
  busy: boolean
  error: string | null
  items: QuickThemeItem[]
  selectedId: string | null
  expanded: boolean
  hiddenCount: number
  emptyMarket: boolean
  plugin: { title: string; loading: boolean; placeholder: string } | null
  appearance: QuickThemeAppearance
  bounds: { width: number; height: number; inputHeight: number }
}
export type QuickThemeAction =
  | { type: 'query'; query: string }
  | { type: 'filter'; kind: QuickCommandKind | null }
  | { type: 'select'; id: string }
  | { type: 'open'; id: string; container?: 'quick' | 'shell' }
  | { type: 'expand'; expanded: boolean }
  | { type: 'open-market' | 'hide' | 'plugin-back' | 'plugin-pin' | 'plugin-focus' }
  | { type: 'layout'; columns: number; height: number }
  | { type: 'key'; key: string; shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean }
export interface QuickThemeActionResult { ok: boolean; error?: string }
/** Only available inside an isolated ThemePackV2.quick page, never an ordinary plugin page. */
export interface EnestQuickApi {
  ready(): void
  getState(): Promise<QuickThemeSnapshot>
  onState(listener: (state: QuickThemeSnapshot) => void): () => void
  onFocus(listener: (request: { selectAll: boolean }) => void): () => void
  action(action: QuickThemeAction): Promise<QuickThemeActionResult>
}
