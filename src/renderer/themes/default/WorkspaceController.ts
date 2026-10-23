import type {
  EnestWorkspaceApi, HomeAction, HomeAppearanceSnapshot, HomeCatalog, HomeCommand,
  HomeDetail, HomeRuntimeConfig, HomeSearchResult, HomeSearchScope
} from '@shared/types/home'
import type { WorkspaceRoute } from '@shared/types/workspace'
import { loadWorkspaceReadme } from '@renderer/services/workspaceReadme'

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
  scope: HomeSearchScope
  results?: HomeSearchResult
  searching: boolean
  searchError?: string
  loading: boolean
  refreshing: boolean
  busy: ReadonlySet<string>
  message?: string
  visible: boolean
}

interface Callbacks {
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
    scope: 'all', searching: false, loading: true, refreshing: false, busy: new Set(), visible: false,
  }
  const listeners = new Set<() => void>()
  let disposed = false
  let bootstrapping = true
  let searchSequence = 0
  let detailSequence = 0
  let navigationSequence = 0
  let refreshSequence = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let readmeController: AbortController | undefined
  const pendingCommands: HomeCommand[] = []
  let offAppearance: (() => void) | undefined
  let offCommand: (() => void) | undefined
  const patch = (next: Partial<DefaultWorkspaceState>) => {
    if (disposed) return
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  }
  const message = (zh: string, en: string) => state.config?.locale === 'en-US' ? en : zh
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

  async function runSearch(query = state.query) {
    const sequence = ++searchSequence
    const scope = state.scope
    if (!query.trim() || disposed) return
    const generation = state.runtimeGeneration
    patch({ searching: true, searchError: undefined })
    try {
      const results = await bridge.search({ query: query.trim(), scope, limit: 60 })
      if (disposed || sequence !== searchSequence || generation !== state.runtimeGeneration) return
      patch({ results, searching: false })
    } catch {
      if (!disposed && sequence === searchSequence) patch({ searching: false, searchError: message('搜索失败，请重试。', 'Search failed. Please retry.') })
    }
  }

  function queueSearch(query: string, scope = state.scope, composing = false) {
    searchSequence++
    clearTimeout(searchTimer)
    patch({ query, scope, results: undefined, searching: Boolean(query.trim()) && !composing, searchError: undefined })
    if (query.trim() && !composing) searchTimer = setTimeout(() => void runSearch(query), 80)
  }

  async function refreshCatalog(reason: 'manual' | 'boot' = 'manual') {
    const sequence = ++refreshSequence
    patch({ refreshing: true })
    try {
      const catalog = await bridge.refresh({ reason })
      if (!disposed && sequence === refreshSequence) acceptCatalog(catalog)
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
    if (command.type === 'visibility') { patch({ visible: command.visible }); return }
    if (bootstrapping) { if (pendingCommands.length < 32) pendingCommands.push(command); return }
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
      void bridge.getConfig().then(config => { if (!disposed) { patch({ config }); callbacks.applyConfig?.(config) } }).catch(() => undefined)
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
    const [appearance, config, catalog] = await Promise.allSettled([bridge.getAppearance(), bridge.getConfig(), bridge.getCatalog()])
    if (disposed) return
    if (appearance.status === 'fulfilled') acceptAppearance(appearance.value)
    if (config.status === 'fulfilled') { patch({ config: config.value }); callbacks.applyConfig?.(config.value) }
    if (catalog.status === 'fulfilled') acceptCatalog(catalog.value)
    patch({ loading: false })
    if (!state.appearance) { patch({ message: message('外观服务暂时不可用，请从宿主重试。', 'Appearance is unavailable. Retry from the host.') }); return }
    if (config.status === 'rejected' || catalog.status === 'rejected') patch({ message: message('部分数据读取失败，可刷新重试。', 'Some data failed to load. Refresh to retry.') })
    bootstrapping = false
    pendingCommands.splice(0).forEach(handleCommand)
    await afterPaint()
    if (!disposed) await bridge.ready({ revision: state.appearance.appearance.revision, workspaceVersion: 1, routes: ['catalog', 'detail'] })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    navigationSequence++; searchSequence++; detailSequence++; refreshSequence++
    clearTimeout(searchTimer)
    cancelReadme()
    pendingCommands.length = 0
    offAppearance?.(); offCommand?.(); listeners.clear()
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    start, dispose, showDetail, queueSearch, runSearch, refreshCatalog, action, navigate, manage, setBasePage,
    setCategory: (category: string) => patch({ category }),
    dismissMessage: () => patch({ message: undefined }),
    reportError: (error: unknown) => patch({ message: error instanceof Error ? error.message : message('操作失败，请重试。', 'Action failed. Please retry.') }),
  }
}

export type DefaultWorkspaceController = ReturnType<typeof createDefaultWorkspaceController>
