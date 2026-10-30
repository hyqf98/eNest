import type { AppearanceBackground, AppearanceColorMode, AppearanceFonts, AppearanceSplash, HomePageContribution, ThemeIdentity, ThemeNotificationStyle } from './appearance'
import type { AnimationLevel, PluginPermission, ThemeMode } from './plugin'
import type { WorkspacePage, WorkspaceRoute, WorkspaceNavigationAck } from './workspace'

/**
 * The home renderer gets rendering values only. Theme/profile bags, custom-font
 * metadata, diagnostics, and local media paths remain host-private.
 */
export interface HomeResolvedAppearance {
  version: 2
  revision: number
  theme: ThemeIdentity & { name: string; version: number; legacy: boolean }
  requestedMode: ThemeMode
  mode: AppearanceColorMode
  tokens: Record<string, string>
  fonts: AppearanceFonts
  components: { controlRadius: number; cardRadius: number; panelRadius: number; borderWidth: number }
  notifications: ThemeNotificationStyle
  background: AppearanceBackground
  splash?: AppearanceSplash
  layout: {
    variant: string
    density: number
    gap: number
    sidebarWidth: number
    contentWidth: number
    columns: number
    tabStyle?: 'classic' | 'orb'
  }
  animation: { requested: AnimationLevel; effective: AnimationLevel; continuous: boolean }
}

export interface HomeAppearanceSnapshot {
  appearance: HomeResolvedAppearance
  generation?: number
  resources?: { fonts: Array<{ family: string; url: string }> }
}

/** Runtime registration confirms an exact manifest declaration; source is host-bound. */
export type HomePageRegistrationInput = Omit<HomePageContribution, 'source'> & { source?: string }

export type HomePageRegistrationResult =
  | { ok: true; contribution: HomePageContribution }
  | { ok: false; error: string }

/** Public presentation only; the host resolves the current declaration's launch code. */
export interface HomeCatalogCard {
  id: string
  title: string
  glyph?: string
  color?: string
  explain?: string
}

export interface HomeCatalogItem {
  pluginId: string
  name: string
  description?: string
  category?: string
  author?: string
  version?: string
  installed?: boolean
  enabled?: boolean
  icon?: string | null
  color?: string
  glyph?: string
  tags?: string[]
  featured?: boolean
  screenshots?: string[]
  packageSize?: number
  installs?: string
  latestVersion?: string
  /** At most 16 validated cards from this installed, enabled plugin. */
  homeCards?: HomeCatalogCard[]
}

export interface HomeCatalog {
  items: HomeCatalogItem[]
  revision: number
}

export interface HomeSearchEntry {
  handle: string
  stateKey?: string
  provider?: boolean
  kind?: 'app' | 'plugin' | 'market' | 'action'
  title: string
  subtitle?: string
  icon?: string | null
  color?: string
  glyph?: string
  pluginId?: string
  installed?: boolean
  enabled?: boolean
  disabled?: boolean
  tags?: string[]
  aliases?: string[]
  action?: import('./quick').QuickActionId
  content?: import('./quick').QuickContentMatch
  textInput?: import('./plugin').PluginFeatureInput
}

export interface HomeDetail {
  pluginId: string
  name: string
  description?: string
  category?: string
  author?: string
  version?: string
  latestVersion?: string
  installs?: string
  installed?: boolean
  enabled?: boolean
  icon?: string | null
  color?: string
  glyph?: string
  tags?: string[]
  permissions?: PluginPermission[]
  packageSize?: number
  readmeUrl?: string
  /** Authored README image references mapped only to declared screenshot resource slots. */
  readmeImages?: Record<string, string>
  screenshots?: string[]
}

export interface HomeSearchResult {
  items: HomeSearchEntry[]
  revision: number
  directoryRevision?: string
  unchanged?: boolean
  queryRevision?: number
}

export interface HomeSearchRequest {
  query: string
  scope?: HomeSearchScope
  limit?: number
  phase?: 'catalog' | 'providers'
  knownRevision?: string
  queryRevision?: number
}

export type HomeSearchScope = 'all' | 'installed' | 'market' | 'action' | 'app' | 'plugin'

/** Present only in a dedicated Home WebContentsView, never an ordinary business plugin. */
export interface EnestHomeApi {
  ready(payload?: HomeReadyPayload): Promise<void>
  ackNavigation(payload: WorkspaceNavigationAck): Promise<void>
  getAppearance(): Promise<HomeAppearanceSnapshot>
  getConfig(): Promise<HomeRuntimeConfig>
  getCatalog(): Promise<HomeCatalog>
  getDetail(id: string): Promise<HomeDetail | null>
  search(request: HomeSearchRequest): Promise<HomeSearchResult>
  refresh(request?: { reason?: 'manual' | 'boot' }): Promise<HomeCatalog>
  action(request: HomeAction): Promise<HomeActionResponse>
  onAppearance(listener: (payload: HomeAppearanceSnapshot) => void): () => void
  onCommand(listener: (payload: HomeCommand) => void): () => void
}

export interface HomeRuntimeConfig {
  locale: 'zh-CN' | 'en-US'
  installedFirst: boolean
  offline: boolean
  warmInstall: boolean
  revision: number
}

export type HomeAction =
  | { type: 'navigate'; route: WorkspaceRoute }
  | { type: 'activateSearchResult'; handle: string; query?: string; input?: import('./quick').QuickInputSelection }
  | { type: 'searchInput'; operation: 'read-clipboard' | 'list' | 'clear'; id?: string }
  | { type: 'searchState'; operation: 'read' | 'write'; expectedRevision?: number; value?: unknown }
  | { type: 'cancelSearch'; queryRevision: number }
  | { type: 'openPlugin'; pluginId: string }
  | { type: 'openHomeCard'; pluginId: string; cardId: string }
  | { type: 'openMarket'; pluginId?: string }
  | { type: 'openSettings' }
  | { type: 'refreshApps' }
  | { type: 'installPlugin'; pluginId: string }
  | { type: 'updatePlugin'; pluginId: string }
  | { type: 'setPluginEnabled'; pluginId: string; enabled: boolean }
  | { type: 'uninstallPlugin'; pluginId: string }
  | { type: 'refreshCatalog'; reason?: 'manual' | 'boot' }
  | { type: 'setHomeVisible'; visible: boolean }

export interface HomeActionResponse {
  ok: boolean
  error?: string
  input?: import('./quick').QuickImageContext[]
  state?: import('./quickTheme').QuickStateSnapshot
  opened?: { stateKey: string; at: number }
}

export interface HomeReadyPayload {
  revision?: number
  workspaceVersion?: 1
  routes?: WorkspacePage[]
}

/** The full workspace bridge. enestHome remains an alias for existing providers. */
export type EnestWorkspaceApi = EnestHomeApi

export type HomeCommand =
  | { type: 'settingsChanged' }
  | { type: 'searchDirectoryChanged' }
  | { type: 'navigate'; route: WorkspaceRoute; requestId: string; generation: number; revision: number }
  | { type: 'visibility'; visible: boolean; revision: number }
  | { type: 'refresh'; reason: 'manual' | 'boot'; revision: number }
  | { type: 'openMarket'; pluginId?: string; revision: number; generation: number }
  | {
      type: 'install'
      pluginId?: string
      jobId?: string
      name?: string
      status: 'queued' | 'progress' | 'done' | 'error'
      progress?: number
      error?: string
    }

export interface HomeEventData {
  appearance?: HomeAppearanceSnapshot
  command?: HomeCommand
}
