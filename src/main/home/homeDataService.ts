import { randomBytes } from 'node:crypto'
import type { ResolvedAppearance } from '@shared/types/appearance'
import { CONTRIB_SCHEMA_VERSION, PLUGIN_PERMISSIONS, type BackgroundConfig } from '@shared/types/plugin'
import type {
  HomeAction,
  HomeActionResponse,
  HomeAppearanceSnapshot,
  HomeCatalog,
  HomeCatalogCard,
  HomeCatalogItem,
  HomeDetail,
  HomeRuntimeConfig,
  HomeSearchEntry,
  HomeSearchResult
} from '@shared/types/home'
import type { WorkspaceRoute } from '@shared/types/workspace'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import type { CatalogResources } from '@main/plugin/catalogResources'
import { settingsStore } from '@main/settings/SettingsStore'
import { enqueueInstallFromUrl } from '@main/plugin/installQueue'
import { executePluginCommand, launchPlugin } from '@main/launcher/pluginLauncher'
import { launchLocalApp } from '@main/launcher/appLauncher'
import { scanApplications } from '@main/launcher/appScanner'
import { cancelQuickProviderSession, getLaunchDirectorySnapshot, onLaunchDirectoryChanged, quickOpenedIdentity, searchQuickCommands, validateQuickOpenTarget } from '@main/launcher/commandIndex'
import { createSearchInputSession } from '@main/launcher/quickInputContext'
import { quickProviderStates } from '@main/theme/quickStateService'
import { IpcChannels } from '@shared/types/ipc'
import { refreshPluginBackgrounds, stopPluginBackground } from '@main/plugin/pluginBackgroundRuntime'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import type { WebContents } from 'electron'
import type { QuickCommand, QuickInputSelection } from '@shared/types/quick'
import { logInfo, logWarn } from '@main/logs/logService'
import { pluginHost } from '@main/plugin/PluginHost'
import { uninstallPlugin } from '@main/plugin/PluginUninstaller'
import { cancelPluginDeadlineTasks } from '@main/timer/deadlineTaskService'
import { applyPluginLaunchHotkeys, clearPluginLaunch, releasePluginLaunchHotkey } from '@main/hotkey/pluginLaunchHotkeys'
import { publicAppearanceFonts, publicAppearanceMedia } from '@main/theme/appearanceResources'
import { declaredPalettePaints } from '@shared/theme/appearance'
import type { ThemePackV2 } from '@shared/types/appearance'
import { themePackRegistry } from '@main/theme/themePacks'
import { openNativeModal } from '@main/window/modalSurface'
import { homeCatalogResourceUrl } from './homeSecurity'

export interface HomeActionContext {
  wcId: number
  generation: number
  owner: WebContents
  stateOwner?: { source: string; packId: string }
  isCurrent(): boolean
  setHomeVisible(visible: boolean): void
  navigateWorkspace(route: WorkspaceRoute): Promise<void>
}

let revision = 0

function nextRevision(): number {
  revision += 1
  return revision
}

function boundedBackgroundValue(value: unknown, minimum = 0, maximum = 1): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined
}

function homeMedia(value: BackgroundConfig | null, declaredPaints?: ReadonlySet<string>): HomeAppearanceSnapshot['appearance']['background']['media'] {
  const media = publicAppearanceMedia(value, declaredPaints)
  if (!media) return null
  if (media.type === 'color') return { type: 'color', value: media.value, fit: 'cover', opacity: boundedBackgroundValue(media.opacity) ?? 0.8 }
  const pattern = media.type === 'video'
    ? /^enest:\/\/appearance\/media\/([a-f0-9]{64}\.(?:mp4|webm|mov))$/
    : /^enest:\/\/appearance\/media\/([a-f0-9]{64}\.(?:png|jpe?g|gif|webp|svg|ico))$/
  const match = pattern.exec(media.value)
  if (!match) return null
  return {
    type: media.type,
    value: `enest-home://appearance/media/${match[1]}`,
    fit: media.fit === 'contain' ? 'contain' : 'cover',
    opacity: boundedBackgroundValue(media.opacity) ?? 0.8
  }
}

/** Keep only rendering values; the theme/profile/font bags stay host-private. */
export function getHomeAppearanceSnapshot(candidate: ResolvedAppearance): HomeAppearanceSnapshot {
  const selectedFonts = new Set([candidate.fonts.body, candidate.fonts.heading, candidate.fonts.mono].flatMap(stack => stack.split(',').map(value => value.trim().replace(/^(["'])(.*)\1$/, '$2'))))
  // The snapshot re-applies the publication filter after appearanceService; carry the active
  // pack's declared palette paints so a theme's own atmosphere is not dropped here. Match on
  // source + id, because another plugin may register a pack with the same id.
  const pack = themePackRegistry.getByIdentity(candidate.theme)
  const activePack = (pack as Partial<ThemePackV2> | null)?.schemaVersion === 2 ? pack as ThemePackV2 : undefined
  const declaredPaints = declaredPalettePaints(activePack)
  const fonts = (candidate.resources?.fonts ?? publicAppearanceFonts(candidate.fonts)).slice(0, 8)
    .filter(font => typeof font.family === 'string' && font.family.length <= 128 && !/[\u0000-\u001f\u007f]/.test(font.family) && selectedFonts.has(font.family) && /^enest:\/\/appearance\/font\/[a-f0-9]{64}$/.test(font.url))
    .map(font => ({ family: font.family, url: font.url.replace('enest://', 'enest-home://') }))
  return {
    resources: { fonts },
    appearance: {
      version: candidate.version,
      revision: candidate.revision,
      theme: {
        source: candidate.theme.source,
        id: candidate.theme.id,
        name: candidate.theme.name,
        version: candidate.theme.version,
        legacy: candidate.theme.legacy
      },
      requestedMode: candidate.requestedMode,
      mode: candidate.mode,
      tokens: { ...candidate.tokens },
      fonts: { body: candidate.fonts.body, heading: candidate.fonts.heading, mono: candidate.fonts.mono, scale: candidate.fonts.scale,
        cjk: candidate.fonts.cjk, latin: candidate.fonts.latin },
      components: {
        controlRadius: candidate.components.controlRadius,
        cardRadius: candidate.components.cardRadius,
        panelRadius: candidate.components.panelRadius,
        borderWidth: candidate.components.borderWidth
      },
      notifications: {
        layout: candidate.notifications.layout,
        accent: candidate.notifications.accent,
        radius: candidate.notifications.radius,
        borderWidth: candidate.notifications.borderWidth,
        density: candidate.notifications.density,
        shadow: candidate.notifications.shadow
      },
      background: {
        media: homeMedia(candidate.background.media, declaredPaints),
        kind: candidate.background.kind,
        palette: candidate.background.palette,
        color: candidate.background.color,
        opacity: boundedBackgroundValue(candidate.background.opacity),
        fit: candidate.background.fit,
        effect: candidate.background.effect,
        texture: candidate.background.texture,
        intensity: candidate.background.intensity,
        speed: candidate.background.speed,
        direction: candidate.background.direction,
        warmth: boundedBackgroundValue(candidate.background.warmth),
        grain: boundedBackgroundValue(candidate.background.grain),
        scale: boundedBackgroundValue(candidate.background.scale, 0.25, 2),
        wash: boundedBackgroundValue(candidate.background.wash)
      },
      splash: candidate.splash ? { type: candidate.splash.type, media: homeMedia(candidate.splash.media, declaredPaints), opacity: boundedBackgroundValue(candidate.splash.opacity) ?? 0.55 } : undefined,
      layout: {
        variant: candidate.layout.variant,
        tabStyle: candidate.layout.tabStyle,
        density: candidate.layout.density,
        gap: candidate.layout.gap,
        sidebarWidth: candidate.layout.sidebarWidth,
        contentWidth: candidate.layout.contentWidth,
        columns: candidate.layout.columns
      },
      animation: {
        requested: candidate.animation.requested,
        effective: candidate.animation.effective,
        continuous: candidate.animation.continuous
      }
    }
  }
}

function offlineStatus(): { offline: boolean } {
  // A cacheless market is not proof of network failure, but avoids a blocking
  // status fetch during first paint. The next explicit refresh reconciles it.
  return { offline: pluginRegistry.getRemoteMarket().length === 0 }
}

export function getHomeConfig(): HomeRuntimeConfig {
  const general = settingsStore.getAll().general
  return {
    locale: general.locale === 'en-US' ? 'en-US' : 'zh-CN',
    installedFirst: true,
    ...offlineStatus(),
    warmInstall: false,
    revision
  }
}

function safePublicIcon(pluginId: string, resources = pluginRegistry.getCatalogResources(pluginId)): string | null {
  return resources.icon ? homeCatalogResourceUrl(pluginId, 'icon') : null
}

function safeColor(value: string | undefined): string | undefined {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined
}

function publicText(value: string | undefined, maximum: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) ? undefined : value
}

function declaredHomeCards(pluginId: string): Array<{ card: HomeCatalogCard; openCode?: string }> {
  const summary = pluginRegistry.get(pluginId)
  if (!summary?.installed || summary.enabled === false) return []
  const manifest = pluginRegistry.getManifest(pluginId)
  const declarations = manifest?.id === pluginId ? manifest.contributes?.homeCards : undefined
  if (!Array.isArray(declarations)) return []
  const bounded = declarations.slice(0, 16)
  const counts = new Map<string, number>()
  for (const entry of bounded) {
    if (typeof entry?.id === 'string') counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }
  return bounded.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || entry.schemaVersion !== undefined && entry.schemaVersion !== CONTRIB_SCHEMA_VERSION) return []
    const id = publicText(entry.id, 128), title = publicText(entry.title, 128)
    if (!id?.trim() || !title?.trim() || counts.get(id) !== 1) return []
    const openCode = publicText(entry.openCode, 128)
    if (entry.openCode !== undefined && entry.openCode !== '' && !openCode?.trim()) return []
    const glyph = publicText(entry.glyph, 8), color = safeColor(entry.color), explain = publicText(entry.explain, 512)
    return [{ card: {
      id, title,
      ...(glyph?.trim() && Array.from(glyph).length <= 2 ? { glyph } : {}),
      ...(color ? { color } : {}),
      ...(explain ? { explain } : {})
    }, ...(openCode ? { openCode } : {}) }]
  })
}

function catalogItem(id: string): HomeCatalogItem | null {
  const summary = pluginRegistry.get(id)
  if (!summary) return null
  const resources = pluginRegistry.getCatalogResources(id)
  return {
    pluginId: id,
    name: publicText(summary.name, 256) ?? id,
    description: publicText(summary.description, 2000),
    category: publicText(summary.category, 128),
    author: publicText(summary.author, 256),
    version: publicText(summary.version, 64),
    installed: Boolean(summary.installed),
    enabled: summary.enabled !== false,
    icon: safePublicIcon(id, resources),
    color: safeColor(summary.color),
    glyph: publicText(summary.glyph, 12) ?? publicText(summary.name, 256)?.slice(0, 1) ?? '',
    tags: publicTags(summary.tags),
    featured: summary.featured === true,
    latestVersion: publicText(summary.latestVersion, 64),
    installs: publicText(summary.installs, 32),
    packageSize: typeof summary.packageSize === 'number' && Number.isSafeInteger(summary.packageSize) && summary.packageSize > 0 ? summary.packageSize : undefined,
    screenshots: resources.screenshots.map((_resource, index) => homeCatalogResourceUrl(id, 'screenshot', index)),
    homeCards: declaredHomeCards(id).map(({ card }) => card),
  }
}

function catalogItems(): HomeCatalogItem[] {
  return pluginRegistry.list()
    .map(item => catalogItem(item.id))
    .filter((item): item is HomeCatalogItem => item !== null)
}

export function getHomeCatalog(reason: 'manual' | 'boot' = 'boot'): Promise<HomeCatalog> {
  // Boot/read paths are offline-first. Only explicit refresh awaits the market.
  if (reason !== 'manual') return Promise.resolve({ items: catalogItems(), revision: nextRevision() })
  return pluginRegistry.refreshRemoteMarket(true)
    .catch(error => logWarn('home', `market refresh failed: ${(error as Error).message}`))
    .then(() => ({ items: catalogItems(), revision: nextRevision() }))
}

export async function getHomeDetail(id: string): Promise<HomeDetail | null> {
  if (typeof id !== 'string' || !id || id.length > 256) return null
  const summary = pluginRegistry.get(id)
  const item = catalogItem(id)
  if (!summary || !item) return null
  const resources: CatalogResources = pluginRegistry.getCatalogResources(id)
  const { homeCards: _homeCards, ...detail } = item
  return {
    ...detail,
    permissions: summary.permissions?.filter(permission => PLUGIN_PERMISSIONS.includes(permission)).slice(0, 64),
    readmeUrl: resources.readme ? homeCatalogResourceUrl(id, 'readme') : undefined,
    readmeImages: resources.readmeImages ? Object.fromEntries(Object.entries(resources.readmeImages)
      .map(([path, index]) => [path, homeCatalogResourceUrl(id, 'screenshot', index)])) : undefined
  }
}

interface SearchFlight {
  command: QuickCommand | { kind: 'market'; pluginId: string }
  wcId: number
  generation: number
  expiresAt: number
}

interface HomeSearchSession {
  generation: number
  id: string
  signature: string
  directoryRevision: string
  items: HomeSearchEntry[]
  catalogHandles: Set<string>
  catalogEntries: Map<string, { signature: string; item: HomeSearchEntry }>
  providerHandles: Set<string>
  queryRevision: number
  providerEpoch: number
  opening?: AbortController
  input: ReturnType<typeof createSearchInputSession>
}
const homeSearchSessions = new Map<number, HomeSearchSession>()
const homePasteGestures = new Map<number, number>()
function searchSession(context: Pick<HomeActionContext, 'wcId' | 'generation'>): HomeSearchSession {
  let session = homeSearchSessions.get(context.wcId)
  if (!session || session.generation !== context.generation) {
    invalidateHomeSearchHandles(context.wcId)
    session = { generation: context.generation, id: `workspace:${context.wcId}:${context.generation}`, signature: '', directoryRevision: '', items: [],
      catalogHandles: new Set(), catalogEntries: new Map(), providerHandles: new Set(), queryRevision: 0, providerEpoch: 0, input: createSearchInputSession() }
    homeSearchSessions.set(context.wcId, session)
  }
  return session
}

const searchHandles = new Map<string, SearchFlight>()
const SEARCH_HANDLE_TTL_MS = 120_000
const SEARCH_HANDLE_LIMIT = 262_144

function pruneSearchHandles(now = Date.now()): void {
  for (const [handle, flight] of searchHandles) {
    if (flight.expiresAt <= now) searchHandles.delete(handle)
  }
  while (searchHandles.size > SEARCH_HANDLE_LIMIT) {
    searchHandles.delete(searchHandles.keys().next().value!)
  }
}

export function invalidateHomeSearchHandles(wcId?: number): void {
  for (const [handle, flight] of searchHandles) {
    if (wcId === undefined || flight.wcId === wcId) searchHandles.delete(handle)
  }
  for (const [id, session] of homeSearchSessions) if (wcId === undefined || id === wcId) {
    session.opening?.abort(); session.input.clear(); cancelQuickProviderSession(session.id); homeSearchSessions.delete(id); homePasteGestures.delete(id)
  }
}

function cancelHomeProviders(session: HomeSearchSession): void {
  session.providerEpoch++
  for (const handle of session.providerHandles) searchHandles.delete(handle)
  session.providerHandles.clear()
  cancelQuickProviderSession(session.id)
}

/** Hiding a Workspace retires paste/provider authority, not its immutable name directory. */
export function suspendHomeSearch(wcId: number): void {
  const session = homeSearchSessions.get(wcId)
  if (session) { session.opening?.abort(); cancelHomeProviders(session); session.input.clear() }
  homePasteGestures.delete(wcId)
}

function makeSearchHandle(): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const handle = randomBytes(24).toString('base64url')
    if (!searchHandles.has(handle)) return handle
  }
  // The 192-bit handle space makes this practically unreachable; refusing is safer than reusing.
  throw new Error('unable to allocate home search handle')
}

function publicSearchItem(item: QuickCommand, handle: string): HomeSearchEntry {
  const summary = item.pluginId ? pluginRegistry.get(item.pluginId) : null
  const installed = item.kind === 'plugin' ? summary?.installed === true : undefined
  const enabled = item.kind === 'plugin' ? summary?.enabled !== false : undefined
  return {
    handle,
    stateKey: item.stateKey,
    provider: item.group === 'provider',
    kind: item.kind,
    title: publicText(item.title, 256) ?? '',
    // App subtitles are filesystem paths; expose only a neutral type label.
    subtitle: item.kind === 'app' ? '' : publicText(item.subtitle, 512) ?? '',
    icon: item.kind === 'app' || !item.pluginId ? null : safePublicIcon(item.pluginId),
    color: safeColor(summary?.color),
    glyph: publicText(summary?.glyph, 12) ?? publicText(item.title, 256)?.slice(0, 1) ?? '',
    pluginId: item.pluginId,
    installed,
    enabled,
    disabled: item.kind === 'plugin' ? enabled === false : undefined,
    tags: publicTags(summary?.tags),
    aliases: item.aliases?.slice(0, 32).map(alias => publicText(alias, 256)).filter((alias): alias is string => !!alias),
    action: item.action,
    content: item.content,
    textInput: item.textInput
  }
}

function publicTags(tags: string[] | undefined): string[] | undefined {
  if (!Array.isArray(tags) || !tags.length) return undefined
  return tags.slice(0, 24).map(tag => publicText(tag, 64)).filter((tag): tag is string => Boolean(tag))
}

export async function searchHome(
  request: { query?: unknown; scope?: unknown; limit?: unknown; phase?: unknown; knownRevision?: unknown; queryRevision?: unknown },
  context: Pick<HomeActionContext, 'wcId' | 'generation' | 'isCurrent'>
): Promise<HomeSearchResult> {
  if (!context.isCurrent()) return { items: [], revision: nextRevision() }
  const session = searchSession(context)
  const current = () => context.isCurrent() && homeSearchSessions.get(context.wcId) === session
  const query = typeof request?.query === 'string' ? request.query.slice(0, 4096) : ''
  if (request?.phase === 'providers') {
    const sequence = typeof request.queryRevision === 'number' && Number.isSafeInteger(request.queryRevision) ? request.queryRevision : session.queryRevision + 1
    if (sequence < session.queryRevision) return { items: [], revision: nextRevision(), queryRevision: sequence }
    if (sequence > session.queryRevision) session.opening?.abort()
    session.queryRevision = sequence
    cancelHomeProviders(session)
    const providerEpoch = session.providerEpoch
    const commands = query.trim() ? await searchQuickCommands(query, 100, 'plugin', 'providers', undefined, { sessionId: session.id }) : []
    if (!current() || sequence !== session.queryRevision || providerEpoch !== session.providerEpoch) return { items: [], revision: nextRevision(), queryRevision: sequence }
    const items = commands.slice(0, 100).map(command => {
      const handle = makeSearchHandle()
      searchHandles.set(handle, { command, wcId: context.wcId, generation: context.generation, expiresAt: Date.now() + SEARCH_HANDLE_TTL_MS })
      session.providerHandles.add(handle)
      return publicSearchItem(command, handle)
    })
    return { items, revision: nextRevision(), queryRevision: sequence }
  }
  const directory = await getLaunchDirectorySnapshot()
  if (!current()) return { items: [], revision: nextRevision() }
  const market = catalogItems()
  const signature = JSON.stringify([directory.revision, market])
  if (session.signature !== signature) {
    const previous = session.catalogEntries, entries: HomeSearchSession['catalogEntries'] = new Map()
    const publish = (key: string, command: SearchFlight['command'], entry: (handle: string) => HomeSearchEntry, descriptor: unknown = command): HomeSearchEntry => {
      const signature = JSON.stringify(descriptor), existing = previous.get(key)
      if (existing?.signature === signature && searchHandles.has(existing.item.handle)) {
        entries.set(key, existing)
        return existing.item
      }
      const handle = makeSearchHandle()
      searchHandles.set(handle, { command, wcId: context.wcId, generation: context.generation, expiresAt: Number.POSITIVE_INFINITY })
      const item = entry(handle)
      entries.set(key, { signature, item })
      return item
    }
    session.items = directory.items.filter(command => {
      const plugin = command.kind === 'plugin' ? pluginRegistry.get(command.pluginId ?? '') : undefined
      return command.kind !== 'plugin' || plugin?.installed === true && plugin.enabled !== false
    })
      .slice(0, 65_536).map(command => publish(command.id, command, handle => publicSearchItem(command, handle)))
    for (const item of market.slice(0, 4096)) session.items.push(publish(`market:${item.pluginId}`, { kind: 'market', pluginId: item.pluginId }, handle => ({
      ...item, handle, kind: 'market', title: item.name, subtitle: item.description,
      aliases: [item.name, item.pluginId, item.description, item.category, item.author, ...(item.tags ?? [])].filter((value): value is string => typeof value === 'string')
    }), item))
    const handles = new Set(session.items.map(item => item.handle))
    for (const handle of session.catalogHandles) if (!handles.has(handle)) searchHandles.delete(handle)
    session.catalogHandles = handles
    session.catalogEntries = entries
    session.signature = signature
    session.directoryRevision = randomBytes(16).toString('base64url')
  }
  pruneSearchHandles()
  const directoryRevision = session.directoryRevision
  return { items: request?.knownRevision === directoryRevision ? [] : session.items, revision: nextRevision(), directoryRevision,
    unchanged: request?.knownRevision === directoryRevision }
}

function publicHostResult(result: { ok: boolean; error?: string; cancelled?: boolean }): { ok: boolean; error?: string } {
  if (result.ok) return { ok: true }
  if (result.error) logWarn('home', `host operation failed: ${result.error}`)
  return { ok: false, error: result.cancelled ? 'cancelled' : 'home operation failed' }
}

function focusMainWindow(): void {
  const window = getMainWindow()
  if (!window || window.isDestroyed()) return
  window.show()
  if (window.isMinimized()) window.restore()
  window.focus()
}

async function confirmHomeAction(context: HomeActionContext, message: string, detail: string, danger = false): Promise<boolean> {
  if (!context.isCurrent() || context.owner.isDestroyed()) return false
  return openNativeModal(context.owner, {
    kind: 'confirm',
    options: { title: '插件管理', message: `${message}\n${detail.slice(0, 1000)}`, confirmLabel: '继续', danger }
  })
}

async function installPlugin(id: string, context: HomeActionContext): Promise<{ ok: boolean; error?: string }> {
  const summary = pluginRegistry.get(id)
  if (!summary) return { ok: false, error: `plugin not found: ${id}` }
  if (summary.installed) return { ok: true }
  if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
  if (!await confirmHomeAction(context, `安装插件 ${summary.name}?`, `来源：eNest 插件市场\nID：${id}`)) {
    return { ok: false, error: 'cancelled' }
  }
  if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
  const remote = pluginRegistry.getRemoteEntry(id)
  if (!remote?.assetUrl) return { ok: false, error: `plugin not installable: ${id}` }
  const job = enqueueInstallFromUrl(remote.assetUrl, {
    name: remote.name || id,
    sha256: remote.assetSha256,
    identity: { id, version: remote.version }
  })
  logInfo('home', `queued remote install job=${job.id}`)
  return { ok: true }
}

function openedFact(command: QuickCommand): Pick<HomeActionResponse, 'opened'> {
  try {
    const stateKey = command.stateKey || (command.kind === 'plugin'
      ? quickOpenedIdentity({ kind: 'plugin', pluginId: command.pluginId ?? '', code: command.code, entryId: command.entryId })
      : command.kind === 'app' ? quickOpenedIdentity({ kind: 'app', path: command.path ?? '' })
        : command.action ? quickOpenedIdentity({ kind: 'action', action: command.action }) : null)
    return stateKey ? { opened: { stateKey, at: Date.now() } } : {}
  } catch { return {} }
}

async function activateSearchResult(handle: string, context: HomeActionContext, query?: string, selection?: QuickInputSelection): Promise<HomeActionResponse> {
  if (typeof handle !== 'string' || handle.length > 512) return { ok: false, error: 'invalid search handle' }
  const flight = searchHandles.get(handle)
  if (!flight || flight.wcId !== context.wcId || flight.generation !== context.generation || flight.expiresAt <= Date.now()) {
    if (flight && flight.expiresAt <= Date.now()) searchHandles.delete(handle)
    return { ok: false, error: 'search result expired' }
  }
  if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
  const session = searchSession(context)
  if (session.providerHandles.delete(handle)) searchHandles.delete(handle)
  const command = flight.command
  if (command.kind === 'market') {
    if (!pluginRegistry.get(command.pluginId)) return { ok: false, error: 'plugin is no longer available' }
    await context.navigateWorkspace({ page: 'detail', pluginId: command.pluginId })
    // The owned navigation deliberately advances activity; it already awaited the route ACK.
    return { ok: true }
  }
  if (command.kind === 'app') {
    if (!await validateQuickOpenTarget({ kind: 'app', path: command.path ?? '' })) return { ok: false, error: 'application is unavailable' }
    if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
    await launchLocalApp(command.path ?? '')
    return { ok: true, ...openedFact(command) }
  }
  if (command.kind === 'plugin') {
    const summary = pluginRegistry.get(command.pluginId ?? '')
    if (!summary?.installed || summary.enabled === false) return { ok: false, error: 'plugin is not installed or enabled' }
    const inputEpoch = session.input.epoch, queryRevision = session.queryRevision
    session.opening?.abort()
    const opening = new AbortController()
    session.opening = opening
    const guard = () => !opening.signal.aborted && context.isCurrent() && homeSearchSessions.get(context.wcId) === session
      && inputEpoch === session.input.epoch && queryRevision === session.queryRevision
    const result = await executePluginCommand(command, {
      source: 'workspace', defaultTarget: 'shell', sessionId: session.id, signal: opening.signal,
      query: typeof query === 'string' ? query.slice(0, 4096) : '', guard,
      prepareInput: selection ? async () => {
        return session.input.build(command.pluginId ?? '', selection, () => { if (!guard()) throw new Error('Home search retired') })
      } : undefined
    }).finally(() => { if (session.opening === opening) session.opening = undefined })
    if (!result.ok) return publicHostResult(result)
    if (session.input.epoch === inputEpoch) session.input.clear()
    // A completed command may stay hidden; the launcher owns presentation changes.
    return { ok: true, ...openedFact(command) }
  }
  if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
  if (command.action === 'refresh-apps') {
    const result = await scanApplications(true)
    return result.complete ? { ok: true, ...openedFact(command) } : publicHostResult({ ok: false, error: result.errors[0] })
  }
  // A native home overlay must not show shell DOM dialogs.
  focusMainWindow()
  if (command.action === 'open-settings') {
    // 设置由原生壳渲染层独占；请求宿主切换视图，而不是导航 Workspace 路由。
    sendShellEvent({ type: 'set-view', view: 'settings' })
  } else if (command.action === 'open-market') {
    await context.navigateWorkspace({ page: 'catalog' })
  } else return { ok: false, error: 'unsupported action' }
  return { ok: true, ...openedFact(command) }
}

async function launchHomePlugin(pluginId: string, context: HomeActionContext, cardId?: string): Promise<{ ok: boolean; error?: string }> {
  const summary = pluginRegistry.get(pluginId)
  if (!summary?.installed || summary.enabled === false) return { ok: false, error: 'plugin is not installed or enabled' }
  const manifest = pluginRegistry.getManifest(pluginId)
  if (!manifest || manifest.id !== pluginId) return { ok: false, error: 'plugin is no longer available' }
  const buildRevision = pluginRegistry.getBuildRevision(pluginId)
  const declaration = cardId === undefined ? undefined : declaredHomeCards(pluginId).find(({ card }) => card.id === cardId)
  if (cardId !== undefined && !declaration) return { ok: false, error: 'home card is no longer available' }
  const fingerprint = JSON.stringify(declaration)
  const guard = (): boolean => {
    if (!context.isCurrent() || pluginRegistry.getBuildRevision(pluginId) !== buildRevision || pluginRegistry.getManifest(pluginId) !== manifest) return false
    const current = pluginRegistry.get(pluginId)
    if (!current?.installed || current.enabled === false) return false
    return cardId === undefined || JSON.stringify(declaredHomeCards(pluginId).find(({ card }) => card.id === cardId)) === fingerprint
  }
  const result = await launchPlugin({ pluginId, source: 'settings', mode: 'shell', guard,
    ...(declaration?.openCode ? { enter: { code: declaration.openCode } } : {}) })
  if (result.ok) {
    // Presentation may already hide this Workspace; never hide a replacement surface.
    if (context.isCurrent() && result.presentation !== 'none' && result.presentation !== 'quick') context.setHomeVisible(false)
    return publicHostResult(result)
  }
  return context.isCurrent() ? publicHostResult(result) : { ok: false, error: 'home surface retired' }
}

export async function runHomeAction(action: HomeAction, context: HomeActionContext): Promise<HomeActionResponse> {
  if (!action || typeof action !== 'object') return { ok: false, error: 'invalid action' }
  if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
  const pluginId = 'pluginId' in action && typeof action.pluginId === 'string' ? action.pluginId.trim() : ''
  if (pluginId.length > 256) return { ok: false, error: 'invalid plugin id' }
  try {
    if (action.type === 'searchState') {
      if (!context.stateOwner) return { ok: false, error: 'home state owner unavailable' }
      if (action.operation === 'read') return { ok: true, state: quickProviderStates.read(context.stateOwner) }
      if (action.operation === 'write' && typeof action.expectedRevision === 'number') {
        return { ok: true, state: quickProviderStates.write(context.stateOwner, action.expectedRevision, action.value) }
      }
      return { ok: false, error: 'invalid state operation' }
    }
    if (action.type === 'searchInput') {
      const session = searchSession(context)
      if (action.operation === 'list') return { ok: true, input: session.input.list() }
      if (action.operation === 'clear') {
        session.opening?.abort()
        return { ok: true, input: session.input.remove(typeof action.id === 'string' ? action.id : undefined) }
      }
      if (action.operation !== 'read-clipboard') return { ok: false, error: 'invalid input operation' }
      const gesture = homePasteGestures.get(context.wcId)
      homePasteGestures.delete(context.wcId)
      if (gesture === undefined || performance.now() - gesture > 1000) return { ok: false, error: 'native paste gesture required' }
      session.opening?.abort()
      await session.input.readClipboard()
      if (!context.isCurrent() || homeSearchSessions.get(context.wcId) !== session) return { ok: false, error: 'home surface retired' }
      return { ok: true, input: session.input.list() }
    }
    if (action.type === 'cancelSearch') {
      const session = searchSession(context)
      if (!Number.isSafeInteger(action.queryRevision) || action.queryRevision < 0) return { ok: false, error: 'invalid query revision' }
      if (action.queryRevision >= session.queryRevision) {
        session.opening?.abort()
        session.queryRevision = action.queryRevision
        cancelHomeProviders(session)
      }
      return { ok: true }
    }
    if (action.type === 'navigate') {
      await context.navigateWorkspace(action.route)
      return { ok: true }
    }
    if (action.type === 'activateSearchResult') return await activateSearchResult(action.handle, context, action.query, action.input)
    if (action.type === 'openHomeCard') {
      if (!pluginId || typeof action.cardId !== 'string' || !action.cardId.trim() || action.cardId.length > 128
        || Object.keys(action).some(key => !['type', 'pluginId', 'cardId'].includes(key))) return { ok: false, error: 'invalid home card request' }
      // Never accept a launch code or payload from the theme; declarations remain host-owned.
      return await launchHomePlugin(pluginId, context, action.cardId)
    }
    if (action.type === 'openPlugin') {
      if (!pluginId) return { ok: false, error: 'plugin id required' }
      return await launchHomePlugin(pluginId, context)
    }
    if (action.type === 'installPlugin') {
      if (!pluginId) return { ok: false, error: 'plugin id required' }
      return await installPlugin(pluginId, context)
    }
    if (action.type === 'updatePlugin' || action.type === 'setPluginEnabled' || action.type === 'uninstallPlugin') {
      if (!pluginId) return { ok: false, error: 'plugin id required' }
      const summary = pluginRegistry.get(pluginId)
      if (!summary?.installed) return { ok: false, error: 'plugin is not installed' }
      if (action.type === 'setPluginEnabled' && typeof action.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
      const label = action.type === 'updatePlugin' ? '更新' : action.type === 'uninstallPlugin' ? '卸载' : action.enabled ? '启用' : '停用'
      if (!await confirmHomeAction(context, `${label}插件 ${summary.name}?`, `ID：${pluginId}${action.type === 'uninstallPlugin' ? '\n这将删除插件及其本地数据。' : ''}`, action.type === 'uninstallPlugin')) {
        return { ok: false, error: 'cancelled' }
      }
      if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
      if (!pluginRegistry.get(pluginId)?.installed) return { ok: false, error: 'plugin is not installed' }
      if (action.type === 'updatePlugin') {
        const remote = pluginRegistry.getRemoteEntry(pluginId)
        if (!remote?.assetUrl) return { ok: false, error: 'no verified remote update is available' }
        enqueueInstallFromUrl(remote.assetUrl, {
          name: remote.name || pluginId,
          sha256: remote.assetSha256,
          identity: { id: pluginId, version: remote.version }
        })
        return { ok: true }
      }
      if (action.type === 'uninstallPlugin') {
        const result = await uninstallPlugin(pluginId)
        if (result.ok) await clearPluginLaunch(pluginId)
        void refreshPluginBackgrounds()
        return publicHostResult(result)
      }
      const release = !action.enabled ? pluginHost.blockPlugin(pluginId) : () => {}
      try {
        if (!action.enabled) {
          stopPluginBackground(pluginId, 'plugin disabled')
          await cancelPluginDeadlineTasks(pluginId)
          if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
          await pluginHost.closePlugin(pluginId)
        }
        if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
        await pluginRegistry.setPluginEnabled(pluginId, action.enabled)
      } finally { release() }
      if (action.enabled) applyPluginLaunchHotkeys()
      else releasePluginLaunchHotkey(pluginId)
      void refreshPluginBackgrounds()
      sendShellEvent({ type: 'plugins-changed' })
      return { ok: true }
    }
    if (action.type === 'openMarket') {
      if (pluginId && !pluginRegistry.get(pluginId)) return { ok: false, error: `plugin not found: ${pluginId}` }
      focusMainWindow()
      await context.navigateWorkspace(pluginId ? { page: 'detail', pluginId } : { page: 'catalog' })
      return { ok: true }
    }
    if (action.type === 'openSettings') {
      if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
      focusMainWindow()
      // 设置由原生壳渲染层独占；请求宿主切换视图，而不是导航 Workspace 路由。
      sendShellEvent({ type: 'set-view', view: 'settings' })
      return { ok: true }
    }
    if (action.type === 'refreshApps') {
      if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
      const result = await scanApplications(true)
      return context.isCurrent()
        ? publicHostResult({ ok: result.complete, error: result.errors[0] })
        : { ok: false, error: 'home surface retired' }
    }
    if (action.type === 'refreshCatalog') {
      if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
      await getHomeCatalog(action.reason === 'boot' ? 'boot' : 'manual')
      return context.isCurrent()
        ? { ok: true }
        : { ok: false, error: 'home surface retired' }
    }
    if (action.type === 'setHomeVisible') {
      if (!context.isCurrent()) return { ok: false, error: 'home surface retired' }
      context.setHomeVisible(action.visible === true)
      return { ok: true }
    }
    return { ok: false, error: 'unsupported action' }
  }
  catch (error) {
    logWarn('home', `action failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: 'home operation failed' }
  }
}

export function bindHomeContents(contents: WebContents, isActive: () => boolean): void {
  const id = contents.id
  const eligible = () => !contents.isDestroyed() && isActive() && contents.isFocused() && contents.focusedFrame === contents.mainFrame
  let mouseDown = 0
  contents.on('before-input-event', (_event, input) => {
    const command = input.meta || process.platform !== 'darwin' && input.control
    if (input.type === 'keyDown' && !input.isAutoRepeat && !input.isComposing && command && input.key.toLowerCase() === 'v' && eligible()) {
      homePasteGestures.set(id, performance.now())
    }
  })
  contents.on('before-mouse-event', (_event, input) => {
    if (input.button !== 'left') return
    if (input.type === 'mouseDown') { homePasteGestures.delete(id); mouseDown = eligible() ? performance.now() : 0 }
    else if (input.type === 'mouseUp') {
      if (mouseDown && performance.now() - mouseDown <= 1000 && eligible()) homePasteGestures.set(id, performance.now())
      mouseDown = 0
    }
  })
  const clearGesture = () => { homePasteGestures.delete(id); mouseDown = 0 }
  contents.on('blur', clearGesture)
  contents.on('did-start-navigation', clearGesture)
  const unsubscribe = onLaunchDirectoryChanged(() => {
    if (!contents.isDestroyed()) contents.send(IpcChannels.HomeEvent, { command: { type: 'searchDirectoryChanged' } })
  })
  contents.once('destroyed', () => { unsubscribe(); invalidateHomeSearchHandles(id) })
}
