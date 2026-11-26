import type {
  EnestWorkspaceApi, HomeAction, HomeAppearanceSnapshot, HomeCatalog, HomeCommand,
  HomeDetail, HomeRuntimeConfig, HomeSearchEntry, HomeSearchResult, HomeSearchScope, HomeTabsSnapshot
} from '@shared/types/home'
import type { QuickCommandKind, QuickImageContext } from '@shared/types/quick'
import type { WorkspaceRoute } from '@shared/types/workspace'
import type { WindowControl } from '@shared/windowFrame'
import { normalizeSearchText } from '@shared/search'
import { buildQuickInputSelection } from '@renderer/components/quickCatalog'
import { loadWorkspaceReadme } from '@renderer/services/workspaceReadme'
import { asQuickNameMatch, assembleDefaultQuickResults, matchDefaultQuickMedia, quickNameRow, rankDefaultQuickHome, type DefaultQuickMatch } from '@renderer/themes/default/quick/catalogPolicy'
import { createNameSearch } from '@renderer/themes/default/quick/nameSearchClient'
import type { QuickNameRow } from '@renderer/themes/default/quick/nameSearchTypes'
import { matchDefaultQuickContent } from '@renderer/themes/default/quick/patternMatching'
import { defaultQuickPreferredKey, emptyDefaultQuickUsage, projectDefaultQuickUsage } from '@renderer/themes/default/quick/usagePolicy'
import { createDefaultQuickUsageSession } from '@renderer/themes/default/quick/usageState'

type WorkspaceCommand = HomeSearchEntry & { id: string; kind: QuickCommandKind; lastUsedTs?: number; useCount?: number }
export type WorkspaceSearchScope = HomeSearchScope | 'files'

export interface DefaultWorkspaceState {
  appearance?: HomeAppearanceSnapshot
  config?: HomeRuntimeConfig
  catalog?: HomeCatalog
  detail?: HomeDetail | null
  detailReadme?: { status: 'loading' | 'ok' | 'empty' | 'error'; text?: string }
  runtimeGeneration: number
  route: WorkspaceRoute
  basePage: 'catalog' | 'installed'
  query: string
  category: string
  scope: WorkspaceSearchScope
  results?: HomeSearchResult
  searching: boolean
  searchError?: string
  input: QuickImageContext[]
  inputBusy: boolean
  loading: boolean
  refreshing: boolean
  busy: ReadonlySet<string>
  message?: string
  visible: boolean
  /** classic 模式顶部 Tab 条的投影；orb 模式也有值但首页不渲染。 */
  tabs?: HomeTabsSnapshot
}

interface Callbacks {
  searchFiles?: import('@shared/types/fileSearch').SearchFiles
  applyAppearance?: (snapshot: HomeAppearanceSnapshot) => void
  applyConfig?: (config: HomeRuntimeConfig) => void
  afterPaint?: () => Promise<void>
}

// Hidden warm-up views never fire rAF (visibilityState stays 'hidden' until commit),
// so the paint barrier races a short timer: visible surfaces keep the real
// double-rAF gate, hidden ones fall through without stalling the ready handshake.
function paintBarrier(custom?: () => Promise<void>): Promise<void> {
  const hasRaf = typeof requestAnimationFrame === 'function'
  const fallback = () => new Promise<void>(resolve => {
    let raf = 0
    const done = (): void => { clearTimeout(timer); if (hasRaf) cancelAnimationFrame(raf); resolve() }
    if (hasRaf) {
      const tick = (): void => { raf = requestAnimationFrame(done) }
      raf = requestAnimationFrame(tick)
    }
    const timer = setTimeout(done, 60)
  })
  return custom ? Promise.race([custom(), fallback()]) : fallback()
}

/** Catalog-internal view preference. Provider state, so it lives in provider storage, not the host route. */
const BASE_PAGE_KEY = 'enest.home.default.basePage'
function readBasePage(): 'catalog' | 'installed' {
  try { return localStorage.getItem(BASE_PAGE_KEY) === 'installed' ? 'installed' : 'catalog' } catch { return 'catalog' }
}
function persistBasePage(page: 'catalog' | 'installed'): void {
  try { localStorage.setItem(BASE_PAGE_KEY, page) } catch { /* preference is best-effort */ }
}

/** The default plugin only consumes the restricted Workspace bridge, never shell state. */
export function createDefaultWorkspaceController(bridge: EnestWorkspaceApi, callbacks: Callbacks = {}) {
  let state: DefaultWorkspaceState = {
    runtimeGeneration: 0, route: { page: 'catalog' }, basePage: readBasePage(), query: '', category: '全部',
    scope: 'all', searching: false, input: [], inputBusy: false, loading: true, refreshing: false, busy: new Set(), visible: false,
  }
  const listeners = new Set<() => void>()
  let disposed = false
  let bootstrapping = true
  let searchSequence = 0
  let configSequence = 0
  let detailSequence = 0
  let navigationSequence = 0
  let refreshSequence = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let readmeController: AbortController | undefined
  let searchController: AbortController | undefined
  let composing = false
  let inputEpoch = 0, inputReadRevision = 0, pendingInputs = 0, openedSequence = 0
  let directoryRevision = '', directoryDirty = true, directorySequence = 0
  let directoryFlight: Promise<void> | undefined
  let directoryItems: HomeSearchEntry[] = [], nativeItems: WorkspaceCommand[] = [], nameEntries: HomeSearchEntry[] = []
  let nativeByHandle = new Map<string, WorkspaceCommand>()
  /*
   * 应用图标的本地缓存，键是搜索结果 handle。
   *
   * handle 在目录签名不变时对同一条目保持稳定（宿主复用飞行记录），所以这张表
   * 能在多次搜索之间复用同一张位图：既省掉重复 IPC，也让 content/provider 这些
   * 后到的阶段重新发布时不会把图标冲掉。
   * 目录失效（应用列表/插件列表变化）时清空——handle 会随之换代。
   */
  const appIcons = new Map<string, string>()
  let nameRows: QuickNameRow[] = [], nameRevision = 0
  let statePositions = new Map<string, number[]>()
  let nameClient: ReturnType<typeof createNameSearch> | undefined
  let usage = emptyDefaultQuickUsage()
  const pendingCommands: HomeCommand[] = []
  let offAppearance: (() => void) | undefined
  let offCommand: (() => void) | undefined
  let offTabs: (() => void) | undefined
  const patch = (next: Partial<DefaultWorkspaceState>) => {
    if (disposed) return
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  }
  /** 把已取到的应用图标贴回结果条目；没有缓存就保持原样（渲染层回退首字母）。 */
  const withAppIcons = <T extends { handle: string; kind?: string; icon?: string | null }>(items: T[]): T[] =>
    items.some(item => item.kind === 'app' && !item.icon && appIcons.has(item.handle))
      ? items.map(item => item.kind === 'app' && !item.icon && appIcons.has(item.handle) ? { ...item, icon: appIcons.get(item.handle)! } : item)
      : items
  const message = (zh: string, en: string) => state.config?.locale === 'en-US' ? en : zh
  const usageSession = createDefaultQuickUsageSession({
    read: async () => {
      const result = await bridge.action({ type: 'searchState', operation: 'read' })
      if (!result.ok || !result.state) throw new Error('Search state unavailable')
      return result.state
    },
    write: async (expectedRevision, value) => {
      const result = await bridge.action({ type: 'searchState', operation: 'write', expectedRevision, value })
      if (!result.ok || !result.state) throw new Error('Search state unavailable')
      return result.state
    },
    encodeIdentities: async () => []
  }, value => {
    usage = value
    updateUsageCatalog()
    if (!disposed && state.visible && (state.query.trim() || state.input.length)) queueSearch(state.query, state.scope, composing)
  })
  const afterPaint = () => paintBarrier(callbacks.afterPaint)
  const acceptAppearance = (snapshot: HomeAppearanceSnapshot) => {
    if (disposed || !snapshot?.appearance) return false
    const generation = snapshot.generation ?? state.runtimeGeneration
    if (!Number.isSafeInteger(generation) || generation < state.runtimeGeneration ||
      !Number.isFinite(snapshot.appearance.revision) || snapshot.appearance.revision < (state.appearance?.appearance.revision ?? -1)) return false
    patch({ appearance: snapshot, runtimeGeneration: generation })
    callbacks.applyAppearance?.(snapshot)
    return true
  }
  const acceptCatalog = (catalog: HomeCatalog) => {
    if (disposed || catalog.revision < (state.catalog?.revision ?? -1)) return
    patch({ catalog })
  }
  const cancelReadme = () => { readmeController?.abort(); readmeController = undefined }

  async function readDetailReadme(detail: HomeDetail, sequence: number, generation: number) {
    const current = () => !disposed && sequence === detailSequence && generation === state.runtimeGeneration &&
      state.route.page === 'detail' && state.route.pluginId === detail.pluginId && state.detail?.pluginId === detail.pluginId
    if (!detail.readmeUrl || !current()) return
    const controller = new AbortController()
    readmeController = controller
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const text = await loadWorkspaceReadme(detail.pluginId, detail.readmeUrl, controller.signal)
      if (current()) patch({ detailReadme: { status: text ? 'ok' : 'empty', text } })
    } catch {
      if (current()) patch({ detailReadme: { status: 'error' } })
    } finally {
      clearTimeout(timer)
      if (readmeController === controller) readmeController = undefined
    }
  }

  async function showDetail(id: string): Promise<boolean> {
    const sequence = ++detailSequence
    const generation = state.runtimeGeneration
    cancelReadme()
    patch({ detail: null, detailReadme: undefined })
    try {
      const detail = await bridge.getDetail(id)
      if (disposed || sequence !== detailSequence || generation !== state.runtimeGeneration) return false
      patch({ detail, detailReadme: { status: detail?.readmeUrl ? 'loading' : 'empty' } })
      if (detail?.readmeUrl) void readDetailReadme(detail, sequence, generation)
      return Boolean(detail)
    } catch {
      if (!disposed && sequence === detailSequence) patch({ message: message('详情暂时无法读取。', 'Unable to load details.') })
      return false
    }
  }

  function updateUsageCatalog() {
    nativeItems = projectDefaultQuickUsage(directoryItems.filter((item): item is HomeSearchEntry & { kind: QuickCommandKind } =>
      item.kind === 'app' || item.kind === 'plugin' || item.kind === 'action').map(item => ({ ...item, id: item.handle })), usage, '')
    nativeByHandle = new Map(nativeItems.map(item => [item.handle, item]))
  }

  async function loadSearchDirectory(): Promise<void> {
    if (!directoryDirty || disposed) return
    if (directoryFlight) return directoryFlight
    const sequence = ++directorySequence, generation = state.runtimeGeneration
    const flight = bridge.search({ query: '', phase: 'catalog', knownRevision: directoryRevision || undefined }).then(result => {
      if (disposed || sequence !== directorySequence || generation !== state.runtimeGeneration) return
      if (!result.unchanged) {
        // 目录换代 → handle 全部重签，旧图标对不上任何新条目。
        appIcons.clear()
        directoryItems = result.items
        updateUsageCatalog()
        nameEntries = directoryItems.filter(item => !item.content && !item.provider)
        nameRows = nameEntries.map(item => item.kind === 'market'
          ? { key: item.handle, kind: 'market', title: item.title, names: [item.title, ...(item.aliases ?? [])] }
          : quickNameRow({ ...item, id: item.handle, kind: item.kind ?? 'plugin' }))
        statePositions = new Map()
        nameEntries.forEach((item, index) => { if (item.stateKey) statePositions.set(item.stateKey, [...(statePositions.get(item.stateKey) ?? []), index]) })
        nameRevision++
      }
      directoryRevision = result.directoryRevision ?? ''
      directoryDirty = false
    }).finally(() => { if (directoryFlight === flight) directoryFlight = undefined })
    directoryFlight = flight
    return flight
  }

  function invalidateSearchDirectory() {
    directoryDirty = true; directorySequence++; directoryFlight = undefined
    // Handles 换代后旧图标再也对不上新条目，留着只会撑内存。
    appIcons.clear()
    if (state.visible) {
      if (state.query.trim() || state.input.length) queueSearch(state.query, state.scope, composing)
      else void loadSearchDirectory().catch(() => undefined)
    }
  }

  async function runSearch(query = state.query) {
    if (state.scope === 'files') return
    if (disposed || !state.visible || composing || !query.trim() && !state.input.length) return
    const sequence = ++searchSequence, scope = state.scope, generation = state.runtimeGeneration
    searchController?.abort()
    const controller = new AbortController()
    searchController = controller
    const current = () => !disposed && state.visible && !composing && sequence === searchSequence && generation === state.runtimeGeneration && !controller.signal.aborted
    patch({ searching: true, searchError: undefined })
    try {
      await loadSearchDirectory()
      if (!current()) return
      const catalog = nativeItems
      const filter = scope === 'installed' ? 'plugin' : scope === 'app' || scope === 'plugin' || scope === 'action' ? scope : null
      const media = matchDefaultQuickMedia(catalog, state.input)
      let named: Array<DefaultQuickMatch<WorkspaceCommand>> = [], market: HomeSearchEntry[] = [], providers: WorkspaceCommand[] = []
      let namesReady = !query.trim()
      let content = new Set<string>()
      /** 本轮首屏里还没有图标的应用 handle；图标只在首屏发布之后才去取。 */
      let iconHandles: string[] = []
      const publish = () => {
        if (!current() || !namesReady) return
        const matches = scope === 'market' ? [] : query.trim()
          ? assembleDefaultQuickResults([...catalog, ...providers], normalizeSearchText(query).length <= 32 || !media.mediaPresent ? named : named.filter(item => item.prefix), filter, 60, content, media.matches, media.mediaPresent)
          : rankDefaultQuickHome(catalog, filter, 60, media.matches)
        const represented = new Set(matches.flatMap(item => item.kind === 'plugin' && item.pluginId ? [item.pluginId] : []))
        const discovery = scope === 'market' ? market : scope === 'all' ? market.filter(item => !item.pluginId || !represented.has(item.pluginId)) : []
        const items = withAppIcons([...matches, ...discovery].slice(0, 60))
        iconHandles = items.filter(item => item.kind === 'app' && !item.icon).map(item => item.handle).slice(0, 100)
        patch({ results: { items, revision: sequence, directoryRevision }, searching: false })
      }
      /*
       * 应用图标由宿主原生抽取（macOS ICNS/NSWorkspace、Windows 快捷方式、
       * Linux Icon= 主题查找），渲染层既拿不到路径也无权读文件，所以只把
       * 首屏已列出条目的 handle 递回去换位图。目录阶段不带图标是为了不让
       * 每条目录条目都背一张 96² 位图；插件图标在目录阶段已是宿主代理 URL。
       *
       * 图标是锦上添花：失败只让该条目回退首字母，不影响搜索本身可用性。
       */
      const applyIcons = async () => {
        if (!iconHandles.length || !query.trim()) return
        const result = await bridge.search({ query, scope, phase: 'enriched', ids: iconHandles })
        if (!current() || !result.items.length) return
        let changed = false
        for (const item of result.items) {
          if (!item.icon || appIcons.get(item.handle) === item.icon) continue
          appIcons.set(item.handle, item.icon)
          changed = true
        }
        if (!changed) return
        /*
         * 只就地贴图标，不重新跑 publish()：
         * publish 会按当前 named/content/providers 重算整轮，而图标到达时这些
         * 阶段可能还没结算，重发会把已出现的行暂时收掉。图标并入只改 icon 字段。
         */
        if (state.results) patch({ results: { ...state.results, items: withAppIcons(state.results.items) } })
      }
      const contentWork = scope === 'market' ? Promise.resolve() : matchDefaultQuickContent(catalog, query, controller.signal)
        .then(matches => { content = matches; publish() })
      const providerWork = query.trim() && (scope === 'all' || filter === 'plugin')
        ? bridge.search({ query, scope, phase: 'providers', queryRevision: sequence }).then(result => {
          if (!current() || result.queryRevision !== sequence) return
          providers = result.items.filter(item => item.kind === 'plugin').map(item => ({ ...item, id: item.handle, kind: 'plugin' }))
          publish()
        }).catch(() => { if (current()) patch({ searchError: message('部分动态搜索来源暂时不可用。', 'Some dynamic search sources are unavailable.') }) })
        : Promise.resolve()
      if (query.trim() && nameRows.length) {
        if (!nameClient || nameClient.disposed) nameClient = createNameSearch()
        const preferredKey = defaultQuickPreferredKey(usage, query)
        const hits = await nameClient.search(nameRows, String(nameRevision), query, scope === 'market' ? 'market' : filter,
          preferredKey ? statePositions.get(preferredKey) ?? [] : [], controller.signal)
        if (!current()) return
        for (const hit of hits) {
          const entry = nameEntries[hit.index]
          if (!entry) continue
          if (entry.kind === 'market') market.push(entry)
          else {
            const item = nativeByHandle.get(entry.handle)
            if (item) named.push(asQuickNameMatch(item, hit.prefix))
          }
        }
      }
      namesReady = true
      publish()
      await Promise.all([contentWork, providerWork, applyIcons()])
    } catch {
      if (current()) patch({ searching: false, searchError: message('搜索失败，请重试。', 'Search failed. Please retry.') })
    }
  }

  function queueSearch(query: string, scope = state.scope, paused = false) {
    const sequence = ++searchSequence
    composing = paused
    searchController?.abort()
    clearTimeout(searchTimer)
    void bridge.action({ type: 'cancelSearch', queryRevision: sequence }).catch(() => undefined)
    const requested = scope !== 'files' && Boolean(query.trim() || state.input.length)
    patch({ query, scope, results: undefined, searching: requested && !paused && state.visible, searchError: undefined })
    if (requested && !paused && state.visible) searchTimer = setTimeout(() => void runSearch(query), 80)
  }

  async function changeInput(operation: 'read-clipboard' | 'clear', id?: string) {
    const epoch = inputEpoch
    inputReadRevision++
    pendingInputs++; patch({ inputBusy: true })
    try {
      const result = await bridge.action({ type: 'searchInput', operation, ...(id ? { id } : {}) })
      if (disposed || epoch !== inputEpoch) return
      if (!result.ok) throw new Error(message('粘贴内容不可用，请重试。', 'Paste context unavailable. Please retry.'))
      const revision = ++inputReadRevision
      const latest = await bridge.action({ type: 'searchInput', operation: 'list' })
      if (disposed || epoch !== inputEpoch || revision !== inputReadRevision) return
      if (!latest.ok) throw new Error(message('粘贴内容不可用，请重试。', 'Paste context unavailable. Please retry.'))
      const input = latest.input ?? []
      patch({ input })
      queueSearch(state.query, state.scope === 'files' && input.length ? 'all' : state.scope, composing)
    } catch (error) {
      if (!disposed && epoch === inputEpoch) patch({ message: error instanceof Error ? error.message : message('无法读取剪贴板。', 'Unable to read the clipboard.') })
    } finally { if (epoch === inputEpoch) { pendingInputs--; patch({ inputBusy: pendingInputs > 0 }) } }
  }

  async function openSearchResult(item: HomeSearchEntry) {
    const query = state.query
    const contextRevision = inputReadRevision
    const input = item.kind === 'plugin' ? buildQuickInputSelection(state.input, { content: item.content, group: item.provider ? 'provider' : undefined }, query) : undefined
    const result = await bridge.action({ type: 'activateSearchResult', handle: item.handle, query, ...(input ? { input } : {}) })
    if (!result.ok) throw new Error(result.error || message('操作失败或已取消。', 'The action failed or was cancelled.'))
    if (result.opened) void usageSession.recordOpened({ ...result.opened, sequence: ++openedSequence, query }).catch(() => {
      patch({ message: message('已打开，但使用记录暂未保存。', 'Opened, but usage history could not be saved.') })
    })
    if (item.kind === 'plugin' && contextRevision === inputReadRevision) { inputEpoch++; inputReadRevision++; pendingInputs = 0; patch({ input: [], inputBusy: false }) }
  }

  async function refreshCatalog(reason: 'manual' | 'boot' = 'manual') {
    const sequence = ++refreshSequence
    patch({ refreshing: true })
    try {
      const catalog = await bridge.refresh({ reason })
      if (!disposed && sequence === refreshSequence) { acceptCatalog(catalog); invalidateSearchDirectory() }
    } catch {
      if (!disposed && sequence === refreshSequence) patch({ message: message('刷新失败，本地目录仍可使用。', 'Refresh failed. Your local library is still available.') })
    } finally {
      if (!disposed && sequence === refreshSequence) patch({ refreshing: false })
    }
  }

  async function action(request: HomeAction): Promise<void> {
    const result = await bridge.action(request)
    if (!result.ok) throw new Error(result.error || message('操作失败或已取消。', 'The action failed or was cancelled.'))
  }

  /**
   * 窗口控制（Windows/Linux 自绘红绿灯）：把主题层的点击转成宿主认可的三种语义。
   * macOS 用系统原生按钮，不会调用这里。
   *
   * 失败必须报出来：静默 catch 会让用户点完毫无反馈、也无从判断原因
   * （宿主可能拒绝、可能首页视图被判非 active），所以把原因落到页面提示上。
   */
  async function windowControl(control: WindowControl): Promise<void> {
    try { await action({ type: 'window', control }) }
    catch (error) {
      patch({ message: error instanceof Error ? error.message : message('窗口操作失败。', 'Window action failed.') })
    }
  }

  async function navigate(route: WorkspaceRoute): Promise<void> {
    try { await action({ type: 'navigate', route }) }
    catch (error) { patch({ message: error instanceof Error ? error.message : message('无法打开页面。', 'Unable to open this page.') }) }
  }

  /**
   * Browse/installed are two views of the same catalog surface. Switching filters locally so the
   * page (background, header, scroll) is never torn down or round-tripped through host navigation.
   * The host route stays on `catalog`; this preference is provider state and survives reloads
   * through the provider's own storage, never through the host route.
   */
  function setBasePage(page: 'catalog' | 'installed'): void {
    if (disposed || state.basePage === page) return
    queueSearch(state.query, page === 'installed' ? 'plugin' : 'all')
    patch({ basePage: page, detail: null, detailReadme: undefined })
    persistBasePage(page)
  }

  async function manage(request: HomeAction, pluginId: string): Promise<void> {
    if (state.busy.has(pluginId)) return
    patch({ busy: new Set([...state.busy, pluginId]), message: undefined })
    try {
      await action(request)
      await refreshCatalog('boot')
      // Keep the mounted dialog and its geometry/focus while metadata changes.
      if (!disposed && state.route.page === 'detail' && state.route.pluginId === pluginId) {
        const detail = await bridge.getDetail(pluginId)
        if (!disposed && state.route.page === 'detail' && state.route.pluginId === pluginId && detail) patch({ detail })
      }
    } finally {
      patch({ busy: new Set([...state.busy].filter(id => id !== pluginId)) })
    }
  }

  async function navigateWorkspace(command: Extract<HomeCommand, { type: 'navigate' }>) {
    if (!Number.isSafeInteger(command.generation) || !Number.isFinite(command.revision) ||
      state.runtimeGeneration && command.generation !== state.runtimeGeneration ||
      command.revision < (state.appearance?.appearance.revision ?? 0)) return
    const sequence = ++navigationSequence
    detailSequence++
    cancelReadme()
    const route = command.route
    if (route.page === 'catalog') queueSearch(state.query, 'all')
    patch({ route, runtimeGeneration: command.generation, detail: null, detailReadme: undefined })
    try {
      if (route.page === 'detail' && !await showDetail(route.pluginId)) throw new Error('Workspace detail unavailable')
      await afterPaint()
      if (disposed || sequence !== navigationSequence) return
      await bridge.ackNavigation({ requestId: command.requestId, generation: command.generation, ok: true })
    } catch {
      if (!disposed && sequence === navigationSequence) {
        await bridge.ackNavigation({ requestId: command.requestId, generation: command.generation, ok: false }).catch(() => undefined)
      }
    }
  }

  function handleCommand(command: HomeCommand) {
    if (disposed) return
    if (command.type === 'visibility') {
      patch({ visible: command.visible })
      if (!command.visible) {
        inputEpoch++; inputReadRevision++; pendingInputs = 0
        patch({ input: [], inputBusy: false })
        queueSearch(state.query, state.scope)
      } else {
        void usageSession.refresh().catch(() => undefined)
        if (state.query.trim()) queueSearch(state.query, state.scope)
        else void loadSearchDirectory().catch(() => undefined)
      }
      return
    }
    if (bootstrapping) { if (pendingCommands.length < 32) pendingCommands.push(command); return }
    if (command.type === 'searchDirectoryChanged') { invalidateSearchDirectory(); return }
    if (command.type === 'navigate') { void navigateWorkspace(command); return }
    if (command.type === 'openMarket') {
      if (!Number.isSafeInteger(command.generation) || !Number.isFinite(command.revision) ||
        state.runtimeGeneration && command.generation !== state.runtimeGeneration ||
        command.revision < (state.appearance?.appearance.revision ?? 0)) return
      navigationSequence++
      detailSequence++
      cancelReadme()
      queueSearch('', 'market')
      patch({ route: command.pluginId ? { page: 'detail', pluginId: command.pluginId } : { page: 'catalog' },
        runtimeGeneration: command.generation, detail: null, detailReadme: undefined })
      if (command.pluginId) void showDetail(command.pluginId)
    } else if (command.type === 'refresh') void refreshCatalog(command.reason)
    else if (command.type === 'settingsChanged') {
      const sequence = ++configSequence
      void bridge.getConfig().then(config => {
        if (disposed || sequence !== configSequence) return
        const filesChanged = Boolean(config.fileSearchEnabled) !== Boolean(state.config?.fileSearchEnabled)
        patch({ config }); callbacks.applyConfig?.(config)
        if (filesChanged && state.scope === 'all' && state.query.trim()) queueSearch(state.query, state.scope, composing)
      }).catch(() => undefined)
    } else if (command.type === 'install') {
      if (command.pluginId) {
        const busy = new Set(state.busy)
        if (command.status === 'queued' || command.status === 'progress') busy.add(command.pluginId)
        else busy.delete(command.pluginId)
        patch({ busy })
      }
      if (command.status === 'done' || command.status === 'error') void refreshCatalog('boot')
      if (command.status === 'error') patch({ message: message('安装失败，请在宿主查看详情或重试。', 'Installation failed. Check the host for details or retry.') })
    }
  }

  async function start() {
    offAppearance = bridge.onAppearance(acceptAppearance)
    offCommand = bridge.onCommand(handleCommand)
    offTabs = bridge.onTabs(tabs => patch({ tabs }))
    const [appearance, config, catalog, tabs] = await Promise.allSettled([
      bridge.getAppearance(), bridge.getConfig(), bridge.getCatalog(), bridge.getTabs()
    ])
    if (disposed) return
    if (appearance.status === 'fulfilled') acceptAppearance(appearance.value)
    if (config.status === 'fulfilled') { patch({ config: config.value }); callbacks.applyConfig?.(config.value) }
    if (catalog.status === 'fulfilled') acceptCatalog(catalog.value)
    if (tabs.status === 'fulfilled') patch({ tabs: tabs.value })
    void usageSession.initialize().catch(() => undefined)
    patch({ loading: false })
    if (!state.appearance) { patch({ message: message('外观服务暂时不可用，请从宿主重试。', 'Appearance is unavailable. Retry from the host.') }); return }
    if (config.status === 'rejected' || catalog.status === 'rejected') patch({ message: message('部分数据读取失败，可刷新重试。', 'Some data failed to load. Refresh to retry.') })
    bootstrapping = false
    pendingCommands.splice(0).forEach(handleCommand)
    await afterPaint()
    if (!disposed) await bridge.ready({ revision: state.appearance.appearance.revision, workspaceVersion: 1, routes: ['catalog', 'detail'] })
    /*
     * ready 之后补拉一次 Tab 投影。
     *
     * 首页通常比主壳先就绪：上面那次 getTabs() 拉到的是空投影，而此时主壳还没
     * hydrate 完、也不会向一个尚未 ready 的首页推送。等主壳把 tabs 推上来时，
     * 这条链路才通；但用户看到的是"首屏没有 Tab 条，切去设置再回来才有"。
     * ready 是宿主认可的确定时点，这里再拉一次即可补上首屏缺的那份数据。
     */
    if (!disposed) {
      void bridge.getTabs().then(tabs => { if (!disposed) patch({ tabs }) }).catch(() => undefined)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    navigationSequence++; searchSequence++; detailSequence++; refreshSequence++
    clearTimeout(searchTimer)
    searchController?.abort()
    inputEpoch++; directorySequence++
    nameClient?.dispose(); usageSession.dispose()
    void bridge.action({ type: 'cancelSearch', queryRevision: searchSequence }).catch(() => undefined)
    void bridge.action({ type: 'searchInput', operation: 'clear' }).catch(() => undefined)
    cancelReadme()
    pendingCommands.length = 0
    offAppearance?.(); offCommand?.(); offTabs?.(); listeners.clear()
  }

  return {
    getState: () => state,
    searchFiles: callbacks.searchFiles,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    start, dispose, showDetail, queueSearch, runSearch, refreshCatalog, action, navigate, manage, setBasePage, openSearchResult,
    windowControl,
    pasteInput: () => changeInput('read-clipboard'), clearInput: (id?: string) => changeInput('clear', id),
    setCategory: (category: string) => patch({ category }),
    dismissMessage: () => patch({ message: undefined }),
    reportError: (error: unknown) => patch({ message: error instanceof Error ? error.message : message('操作失败，请重试。', 'Action failed. Please retry.') }),
  }
}

export type DefaultWorkspaceController = ReturnType<typeof createDefaultWorkspaceController>
