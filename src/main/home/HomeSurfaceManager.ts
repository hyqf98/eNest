import { WebContentsView } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { ResolvedAppearance } from '@shared/types/appearance'
import { DEFAULT_THEME_IDENTITY } from '@shared/theme/defaultTheme/package'
import { compositeThemeColor, parseThemeColor } from '@shared/theme/colors'
import type { HomeSurfaceState } from '@shared/types/homeSurface'
import type { HomeReadyPayload } from '@shared/types/home'
import type { WorkspaceNavigationAck, WorkspacePage, WorkspaceRoute } from '@shared/types/workspace'
import { appearanceService, getAppearance } from '@main/theme/appearanceService'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { invalidatePluginFileCache } from '@main/plugin/pluginProtocol'
import { registerTrustedSurface, revokeTrustedSurface } from '@main/ipc/ipcSecurity'
import type { ShellEventPayload } from '@shared/types/ipc'
import { getMainWindow, getShellBounds, resolvePreload, sendShellEvent, setHomeEventSink } from '@main/window/createShellWindow'
import { raiseOrbRailViews, buildHomeTabsSnapshot } from '@main/window/orbRailViews'
import { raiseTransientViews } from '@main/window/transientViews'
import { logInfo, logWarn } from '@main/logs/logService'
import { markStartupPhase } from '@main/logs/startupTiming'
import { parseHomeReference } from './homeSecurity'
import { isHomeBuildCurrent, resolveHomePage, type ResolvedHomePage } from './homeRegistry'
import { getHomeAppearanceSnapshot, invalidateHomeSearchHandles, suspendHomeSearch } from './homeDataService'
import { BUILT_IN_HOME_SOURCE } from './homeContract'
import { createHomeSession, disposeHomeSession, homeEntryUrl } from './homeSessionPolicy'
import { normalizeWorkspaceRoute } from './workspaceRoute'

export { normalizeWorkspaceRoute } from './workspaceRoute'

export interface HomeTransaction {
  commit(): void
  rollback(): void
}

interface Runtime {
  generation: number
  buildRevision: string
  themeBuild: string
  reference: { source: string; id: string; variant: string }
  appearance: ResolvedAppearance
  sentAppearanceKey: string
  key: string
  view: WebContentsView
  ready: boolean
  visible: boolean
  activityRevision: number
  readyWaiters: Array<() => void>
  readyRejecters: Array<(error: Error) => void>
  retired: boolean
  workspaceRoutes: Set<WorkspacePage> | null
  route: WorkspaceRoute | null
  navigation: Navigation | null
}

interface Navigation {
  requestId: string
  route: WorkspaceRoute
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

class NavigationSupersededError extends Error {}

type ContentsListener = (contents: Electron.WebContents) => void

const LOAD_TIMEOUT_MS = 8000
// Dev 首次加载需等 Vite 按需变换整个首页模块图（load 与 ready 冷缓存下都常超 8s）；打包产物本地直读不受影响。
const LOAD_TIMEOUT = process.env.ELECTRON_RENDERER_URL ? 60000 : LOAD_TIMEOUT_MS
const WORKSPACE_PAGES = new Set<WorkspacePage>(['catalog', 'detail'])

function routeKey(route: WorkspaceRoute | null): string {
  return route ? JSON.stringify(route) : ''
}

function homeInstallCommand(payload: ShellEventPayload): import('@shared/types/home').HomeEventData['command'] | null {
  const publicIdentity = (value: string | undefined): string | undefined => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined
  const publicName = (value: string): string => typeof value === 'string' && value.length <= 256 && !/[\\/\u0000-\u001f\u007f]/.test(value) ? value : '插件'
  if (payload.type === 'install-progress') {
    return {
      type: 'install', jobId: publicIdentity(payload.jobId), name: publicName(payload.name), status: 'progress',
      progress: Number.isFinite(payload.progress) ? Math.max(0, Math.min(100, payload.progress)) : 0,
      error: '正在安装'
    }
  }
  if (payload.type === 'install-result') {
    if (!payload.ok && payload.error) logWarn('home', `installation failed: ${payload.error}`)
    return {
      type: 'install',
      jobId: publicIdentity(payload.jobId),
      name: publicName(payload.name),
      status: payload.ok ? 'done' : 'error',
      error: payload.ok ? undefined : '安装失败，请在宿主查看详情'
    }
  }
  if (payload.type === 'plugins-changed' || payload.type === 'uninstall-result') {
    return { type: 'refresh', reason: 'boot', revision: Date.now() % 2147483647 }
  }
  // General directory changes reach each current/preparing view via bindHomeContents.
  if (payload.type === 'plugin-launch-changed') return { type: 'searchDirectoryChanged' }
  if (payload.type === 'settings-changed' || payload.type === 'settings-sections') return { type: 'settingsChanged' }
  return null
}

export class HomeSurfaceManager {
  private current: Runtime | null = null
  private preparing: Runtime | null = null
  private nextGeneration = 1
  private nextNavigation = 1
  private readonly devRevisions = new Map<string, number>()
  private readonly providerReloads = new Map<string, Promise<void>>()
  private desiredVisible = false
  private desiredRoute: WorkspaceRoute = { page: 'catalog' }
  private recoverySuspended = false
  private recoveryRevision = 0
  private retryFlight: Promise<void> | null = null
  private windowVisible = true
  private readonly contentsListeners = new Set<ContentsListener>()
  private readonly faultListeners = new Set<(message: string) => void>()
  private state: HomeSurfaceState = { status: 'idle', generation: 0 }

  constructor(private readonly loadTimeout = LOAD_TIMEOUT) {}

  getMemoryOwners(): Array<{ pluginId: string; generation: number; wcId: number }> {
    return [this.current, this.preparing].flatMap(runtime => runtime && runtime.reference.source !== BUILT_IN_HOME_SOURCE
      && !runtime.view.webContents.isDestroyed() ? [{ pluginId: runtime.reference.source, generation: runtime.generation, wcId: runtime.view.webContents.id }] : [])
  }

  async prepare(candidate: ResolvedAppearance, mayStart: () => boolean = () => true): Promise<HomeTransaction> {
    if (!candidate || candidate.version !== 2) throw new Error('Invalid appearance candidate')
    const reference = parseHomeReference(candidate.home)
    if (!reference) throw new Error('Invalid home reference')
    const themeSource = candidate.theme.source
    const themeBuild = themeSource === BUILT_IN_HOME_SOURCE ? 'builtin' : pluginRegistry.getBuildRevision(themeSource)
    const page = await resolveHomePage(reference.source, reference.id, reference.variant)
    if (!page || !mayStart() || !isHomeBuildCurrent(themeSource, themeBuild)) throw new Error('Home page is unavailable')
    const trustedUrl = this.entryUrl(page)
    const runtimeKey = this.runtimeKey(page)
    if (
      this.current &&
      this.current.key === runtimeKey &&
      !this.current.view.webContents.isDestroyed()
    ) {
      const current = this.current
      await this.ensureDesiredRoute(current)
      let settled = false
      return {
        commit: () => {
          if (settled || this.current !== current || current.retired) return
          settled = true
          current.appearance = candidate
          current.themeBuild = themeBuild
          current.reference = reference
          this.sendAppearance(current, candidate)
          this.setRuntimeVisible(this.desiredVisible)
          this.publishRuntimeState(current)
        },
        rollback: () => { settled = true }
      }
    }

    this.closePreparing()
    const generation = this.nextGeneration++
    if (!this.hasCurrent) this.publishState({ status: 'loading', generation, route: { ...this.desiredRoute } })
    const view = new WebContentsView({
      webPreferences: {
        preload: resolvePreload('homePreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: createHomeSession(page, generation)
      }
    })
    this.setViewBackground(view, candidate)
    const homeSession = view.webContents.session
    const runtime: Runtime = {
      generation,
      buildRevision: page.buildRevision,
      themeBuild,
      reference,
      appearance: candidate,
      sentAppearanceKey: '',
      key: runtimeKey,
      view,
      ready: false,
      visible: false,
      activityRevision: 0,
      retired: false,
      readyWaiters: [],
      readyRejecters: [],
      workspaceRoutes: null,
      route: null,
      navigation: null
    }
    this.preparing = runtime
    registerTrustedSurface(view.webContents, 'home', trustedUrl)
    for (const listener of [...this.contentsListeners]) {
      try { listener(view.webContents) } catch { /* Subscriber cleanup must not break surface creation. */ }
    }
    view.webContents.once('render-process-gone', () => {
      if (this.current === runtime) {
        this.current = null
        this.recoverySuspended = true
        this.recoveryRevision++
        logWarn('home', 'active renderer crashed; retry surface remains available')
        this.publishState({ status: 'error', generation, message: '工作区进程意外退出', recovery: true, route: { ...this.desiredRoute } })
        for (const listener of this.faultListeners) listener('首页进程意外退出')
      }
      if (this.preparing === runtime) this.preparing = null
      this.retireRuntime(runtime)
    })
    view.webContents.once('destroyed', () => {
      const wasCurrent = this.current === runtime
      const unexpected = !runtime.retired
      if (wasCurrent) this.current = null
      if (this.preparing === runtime) this.preparing = null
      if (unexpected) this.retireRuntime(runtime)
      if (wasCurrent && unexpected) {
        this.recoverySuspended = true
        this.recoveryRevision++
        this.publishState({ status: 'error', generation, message: '工作区已关闭，请重试或进入设置', recovery: true, route: { ...this.desiredRoute } })
        for (const listener of this.faultListeners) listener('首页视图意外关闭')
      }
      void disposeHomeSession(homeSession)
    })
    try {
      this.attachHidden(runtime)
      this.applyRuntimePolicy(runtime, trustedUrl)
      markStartupPhase('home-load-start', `generation=${generation} source=${reference.source}`)
      await this.load(runtime, trustedUrl)
      markStartupPhase('home-did-finish-load', `generation=${generation} source=${reference.source}`)
      await this.waitForReady(runtime)
      await this.ensureDesiredRoute(runtime)
      if (!isHomeBuildCurrent(reference.source, runtime.buildRevision) || !isHomeBuildCurrent(themeSource, themeBuild)) throw new Error('Workspace provider changed during preparation')
      if (this.preparing !== runtime) return this.retiringTransaction(runtime)
      return {
        commit: () => {
          if (this.preparing !== runtime || runtime.retired) return
          this.preparing = null
          this.retireRuntime(this.current)
          this.current = runtime
          this.setRuntimeVisible(this.desiredVisible)
          this.sendAppearance(runtime, candidate)
          this.publishRuntimeState(runtime)
          if (routeKey(runtime.route) !== routeKey(this.desiredRoute)) void this.restoreDesiredRoute(runtime)
        },
        rollback: () => { this.retireRuntime(runtime); if (this.preparing === runtime) this.preparing = null }
      }
    } catch (error) {
      if (this.preparing === runtime) this.preparing = null
      this.retireRuntime(runtime)
      if (!this.hasCurrent) this.publishState({ status: 'error', generation, message: '工作区未能完成加载，请重试或进入设置', recovery: true, route: { ...this.desiredRoute } })
      throw error
    }
  }

  private entryUrl(page: ResolvedHomePage): string {
    const dev = process.env.ELECTRON_RENDERER_URL
    return page.contribution.source === BUILT_IN_HOME_SOURCE && dev
      ? `${dev.replace(/\/$/, '')}/home.html`
      : homeEntryUrl(page)
  }

  private applyRuntimePolicy(runtime: Runtime, entry: string): void {
    const wc = runtime.view.webContents
    wc.on('will-navigate', (event, url) => {
      if (url !== entry) event.preventDefault()
    })
    wc.on('will-attach-webview', event => event.preventDefault())
  }

  private load(runtime: Runtime, url: string): Promise<void> {
    return new Promise((resolveLoad, rejectLoad) => {
      const wc = runtime.view.webContents
      let settled = false
      const finish = (ok: boolean, error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wc.removeListener('did-finish-load', onLoad)
        wc.removeListener('did-fail-load', onFail)
        wc.removeListener('destroyed', onDestroyed)
        if (ok) resolveLoad()
        else rejectLoad(error ?? new Error('Home load failed'))
      }
      const onLoad = (): void => finish(true)
      const onFail = (_event: unknown, code: number, description: string): void =>
        finish(false, new Error(`Home load failed: ${code} ${description}`))
      const onDestroyed = (): void => finish(false, new Error('Home preparation was retired'))
      const timer = setTimeout(() => finish(false, new Error('Home load timed out')), this.loadTimeout)
      timer.unref?.()
      wc.once('did-finish-load', onLoad)
      wc.once('did-fail-load', onFail)
      wc.once('destroyed', onDestroyed)
      void wc.loadURL(url).catch(error => finish(false, error as Error))
    })
  }

  private runtimeKey(page: ResolvedHomePage): string {
    return JSON.stringify({
      entryPath: page.entryPath,
      rootPath: page.rootPath,
      contribution: page.contribution,
      buildRevision: page.buildRevision,
      devRevision: this.devRevisions.get(page.contribution.source) ?? 0,
    })
  }

  /** Source edits replace only this provider, with the existing ready/route transaction. */
  reloadDevSource(pluginId: string): Promise<void> {
    const plugin = pluginRegistry.get(pluginId)
    if (!plugin?.dev) return Promise.resolve()
    if (plugin.rootPath) invalidatePluginFileCache(plugin.rootPath)
    this.devRevisions.set(pluginId, (this.devRevisions.get(pluginId) ?? 0) + 1)
    return this.refreshProvider(pluginId)
  }

  refreshInstalledSource(): void {
    const current = this.current
    if (!current || this.recoverySuspended || this.preparing) return
    const source = current.appearance.theme.source
    if (source === BUILT_IN_HOME_SOURCE) return
    if (pluginRegistry.getInstalledPackage(source) && !pluginRegistry.get(source)?.dev && pluginRegistry.isEnabled(source)
      && current.themeBuild !== pluginRegistry.getBuildRevision(source)) void this.refreshProvider(source)
  }

  private refreshProvider(pluginId: string): Promise<void> {
    const running = this.providerReloads.get(pluginId)
    if (running) return running
    const revision = () => JSON.stringify([pluginRegistry.getBuildRevision(pluginId), this.devRevisions.get(pluginId) ?? 0])
    const operation = (async () => {
      let observed: string
      do {
        observed = revision()
        await pluginRegistry.waitForThemeContributions(pluginId)
        if (revision() !== observed) continue
        const current = this.current
        if (!current || current.retired || current.appearance.theme.source !== pluginId || this.recoverySuspended || this.preparing) return
        const recoveryRevision = this.recoveryRevision
        const appearance = getAppearance()
        if (appearance.theme.source !== pluginId) return
        let transaction: HomeTransaction | null = null
        try {
          transaction = await this.prepare(appearance, () => this.current === current && !this.preparing && !this.recoverySuspended
            && recoveryRevision === this.recoveryRevision && observed === revision())
          if (this.current !== current || current.retired || recoveryRevision !== this.recoveryRevision || this.recoverySuspended) {
            transaction.rollback()
            return
          }
          if (observed !== revision()) {
            transaction.rollback()
            continue
          }
          const latest = getAppearance()
          if (latest.theme.source !== appearance.theme.source || latest.theme.id !== appearance.theme.id
            || latest.home.source !== appearance.home.source || latest.home.id !== appearance.home.id
            || latest.home.variant !== appearance.home.variant) {
            transaction.rollback()
            return
          }
          transaction.commit()
          this.updateAppearance(latest)
          this.setRuntimeVisible(this.desiredVisible)
          logInfo('home', `workspace refreshed: ${pluginId}`)
        } catch (error) {
          transaction?.rollback()
          if (observed !== revision()) continue
          logWarn('home', `workspace refresh ${pluginId}: ${String(error)}`)
          if (!pluginRegistry.get(pluginId)?.dev && this.current === current && !this.preparing && !this.recoverySuspended && recoveryRevision === this.recoveryRevision) {
            this.current = null
            this.retireRuntime(current)
            this.publishState({ status: 'error', generation: current.generation, message: '更新后的工作区未能完成加载', recovery: true, route: { ...this.desiredRoute } })
            for (const listener of this.faultListeners) listener('更新后的工作区未能完成加载')
          }
        }
      } while (observed !== revision())
    })().finally(() => {
      if (this.providerReloads.get(pluginId) === operation) this.providerReloads.delete(pluginId)
    })
    this.providerReloads.set(pluginId, operation)
    return operation
  }

  handleReady(wcId: number, payload: HomeReadyPayload): void {
    const runtime = this.current?.view.webContents.id === wcId ? this.current : this.preparing?.view.webContents.id === wcId ? this.preparing : null
    if (!runtime || runtime.view.webContents.id !== wcId) return
    if (runtime.retired || payload?.revision !== runtime.appearance.revision) {
      logWarn('home', `ready revision mismatch: ${payload.revision} != ${runtime.appearance.revision}`)
      return
    }
    if (runtime.ready) return
    if (payload.workspaceVersion !== undefined) {
      if (payload.workspaceVersion !== 1 || !Array.isArray(payload.routes) || payload.routes.length === 0 || payload.routes.length > WORKSPACE_PAGES.size || new Set(payload.routes).size !== payload.routes.length || !payload.routes.every(page => WORKSPACE_PAGES.has(page))) return
      runtime.workspaceRoutes = new Set(payload.routes)
    } else {
      // Older Home providers can still display their catalog, never host settings.
      runtime.route = { page: 'catalog' }
    }
    runtime.ready = true
    markStartupPhase('home-ready', `generation=${runtime.generation} source=${runtime.reference.source}`)
    // 首页就绪后补推一次 Tab 投影：Provider 自己也会 getTabs()，
    // 但 ready 是「可以收事件」的确定时点，避免初次挂载时 Tab 条短暂为空。
    this.sendTabs(runtime)
    for (const resolve of runtime.readyWaiters.splice(0)) resolve()
    runtime.readyRejecters.splice(0)
    if (runtime === this.current) this.setRuntimeVisible(this.desiredVisible)
  }

  isContentsActive(wcId: number): boolean {
    const runtime = this.current
    return Boolean(runtime && runtime.view.webContents.id === wcId && !runtime.retired && runtime.visible
      && isHomeBuildCurrent(runtime.reference.source, runtime.buildRevision) && !runtime.navigation && routeKey(runtime.route) === routeKey(this.desiredRoute))
  }

  getContentsGeneration(wcId: number): number | null {
    const runtime = [this.current, this.preparing].find(item => item?.view.webContents.id === wcId)
    return runtime && !runtime.retired && !runtime.view.webContents.isDestroyed() && isHomeBuildCurrent(runtime.reference.source, runtime.buildRevision) ? runtime.generation : null
  }

  getContentsActivityRevision(wcId: number): number | null {
    const runtime = [this.current, this.preparing].find(item => item?.view.webContents.id === wcId)
    return runtime && !runtime.retired ? runtime.activityRevision : null
  }

  onContents(listener: ContentsListener): () => void {
    this.contentsListeners.add(listener)
    return () => { this.contentsListeners.delete(listener) }
  }

  onFault(listener: (message: string) => void): () => void {
    this.faultListeners.add(listener)
    return () => { this.faultListeners.delete(listener) }
  }

  getState(): HomeSurfaceState { return { ...this.state, ...(this.state.route ? { route: { ...this.state.route } } : {}) } }

  private publishState(state: HomeSurfaceState): void {
    this.state = state
    sendShellEvent({ type: 'home-status', state: this.getState() })
  }

  private publishRuntimeState(runtime: Runtime): void {
    this.publishState({
      status: this.recoverySuspended ? 'error' : routeKey(runtime.route) === routeKey(this.desiredRoute) ? 'ready' : 'loading',
      generation: runtime.generation,
      recovery: this.recoverySuspended,
      route: { ...this.desiredRoute }
    })
  }

  async navigate(input: WorkspaceRoute): Promise<void> {
    const route = normalizeWorkspaceRoute(input)
    const changedRoute = routeKey(this.desiredRoute) !== routeKey(route)
    this.desiredRoute = route
    this.recoverySuspended = false
    if (changedRoute && this.current) this.current.activityRevision++
    const runtime = this.current ?? this.preparing
    if (!runtime) {
      try { await this.retry() }
      catch (error) { this.suspendForRecovery(); throw error }
      return
    }
    const preparingFlight = runtime === this.preparing ? this.retryFlight : null
    this.setRuntimeVisible(this.desiredVisible)
    if (runtime === this.current) this.publishRuntimeState(runtime)
    try {
      if (!runtime.ready) await this.waitForReady(runtime)
      await this.ensureDesiredRoute(runtime)
      // Startup owns the commit; appearance transactions must remain caller-owned.
      if (preparingFlight) await preparingFlight
      if (runtime === this.current) {
        this.setRuntimeVisible(this.desiredVisible)
        this.publishRuntimeState(runtime)
      }
    } catch (error) {
      if (runtime === this.current && !runtime.retired) this.suspendForRecovery()
      throw error
    }
  }

  handleNavigationAck(wcId: number, payload: WorkspaceNavigationAck): void {
    const runtime = [this.current, this.preparing].find(item => item?.view.webContents.id === wcId)
    const pending = runtime?.navigation
    if (!runtime || runtime.retired || !pending || !payload || payload.generation !== runtime.generation || payload.requestId !== pending.requestId || typeof payload.ok !== 'boolean') return
    runtime.navigation = null
    clearTimeout(pending.timer)
    if (payload.ok) {
      runtime.route = { ...pending.route }
      markStartupPhase('home-route-ack', `generation=${runtime.generation} route=${pending.route.page}`)
      pending.resolve()
    } else pending.reject(new Error('Workspace route was rejected'))
  }

  private async ensureDesiredRoute(runtime: Runtime): Promise<void> {
    while (!runtime.retired) {
      try { await this.requestNavigation(runtime, this.desiredRoute) }
      catch (error) {
        if (error instanceof NavigationSupersededError && !runtime.retired) continue
        throw error
      }
      if (routeKey(runtime.route) === routeKey(this.desiredRoute)) return
    }
    throw new Error('Workspace surface is retired')
  }

  private requestNavigation(runtime: Runtime, route: WorkspaceRoute): Promise<void> {
    if (runtime.retired || !runtime.ready) return Promise.reject(new Error('Workspace surface is not ready'))
    if (routeKey(runtime.route) === routeKey(route) && !runtime.navigation) return Promise.resolve()
    if (!runtime.workspaceRoutes?.has(route.page)) return Promise.reject(new Error('Workspace route is unavailable'))
    if (runtime.navigation && routeKey(runtime.navigation.route) === routeKey(route)) return runtime.navigation.promise
    this.cancelNavigation(runtime, new NavigationSupersededError('Workspace navigation was replaced'))
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse })
    const requestId = `${runtime.generation}:${this.nextNavigation++}`
    const navigation: Navigation = {
      requestId, route: { ...route }, promise, resolve, reject,
      timer: setTimeout(() => {
        if (runtime.navigation !== navigation) return
        runtime.navigation = null
        reject(new Error('Workspace navigation timed out'))
      }, this.loadTimeout)
    }
    runtime.navigation = navigation
    if (runtime === this.current) {
      runtime.activityRevision++
      this.setRuntimeVisible(this.desiredVisible)
    }
    this.sendCommand(runtime, { type: 'navigate', route: { ...route }, requestId, generation: runtime.generation, revision: runtime.appearance.revision })
    return promise
  }

  private cancelNavigation(runtime: Runtime, error: Error): void {
    const navigation = runtime.navigation
    if (!navigation) return
    runtime.navigation = null
    clearTimeout(navigation.timer)
    navigation.reject(error)
  }

  private async restoreDesiredRoute(runtime: Runtime): Promise<void> {
    try {
      await this.ensureDesiredRoute(runtime)
      if (runtime !== this.current) return
      this.setRuntimeVisible(this.desiredVisible)
      this.publishRuntimeState(runtime)
    } catch {
      if (runtime === this.current && !runtime.retired) this.suspendForRecovery()
    }
  }

  suspendForRecovery(): void {
    this.recoverySuspended = true
    this.recoveryRevision++
    this.closePreparing()
    if (this.current) this.cancelNavigation(this.current, new Error('Workspace is suspended for recovery'))
    this.setRuntimeVisible(false)
    this.publishState({ status: 'error', generation: this.current?.generation ?? this.preparing?.generation ?? this.state.generation, recovery: true, route: { ...this.desiredRoute }, message: '工作区已暂停，可在设置中恢复' })
  }

  get hasCurrent(): boolean {
    return this.current !== null && !this.current.view.webContents.isDestroyed()
  }

  get isRecoverySuspended(): boolean { return this.recoverySuspended }
  get recoveryEpoch(): number { return this.recoveryRevision }

  getAppearanceForContents(wcId: number): unknown {
    const runtime = [this.current, this.preparing].find(item => item?.view.webContents.id === wcId)
    return runtime && !runtime.retired
      ? { ...getHomeAppearanceSnapshot(runtime.appearance), generation: runtime.generation }
      : null
  }

  getSearchStateOwner(wcId: number): { source: string; packId: string } | undefined {
    const runtime = [this.current, this.preparing].find(item => item?.view.webContents.id === wcId)
    if (!runtime || runtime.retired) return undefined
    return { source: runtime.reference.source, packId: runtime.reference.source === BUILT_IN_HOME_SOURCE ? 'default' : `home:${runtime.reference.id}` }
  }

  private setViewBackground(view: WebContentsView, appearance: ResolvedAppearance): void {
    const fallback = parseThemeColor(appearance.mode === 'dark' ? '#17191b' : '#f6f6f4')!
    const color = compositeThemeColor(parseThemeColor(appearance.tokens['--bg'] ?? '') ?? fallback, fallback)
    view.setBackgroundColor(`#${color.slice(0, 3).map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`)
  }

  private sendAppearance(runtime: Runtime, appearance: ResolvedAppearance): void {
    const wc = runtime.view.webContents
    if (runtime.retired || wc.isDestroyed()) return
    const snapshot = { ...getHomeAppearanceSnapshot(appearance), generation: runtime.generation }
    // Prepared and committed payloads can share a revision but differ in public resources.
    const key = JSON.stringify(snapshot)
    if (runtime.sentAppearanceKey === key) return
    this.setViewBackground(runtime.view, appearance)
    wc.send(IpcChannels.HomeEvent, { appearance: snapshot })
    runtime.sentAppearanceKey = key
  }

  private attachHidden(runtime: Runtime): void {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) throw new Error('Main window is unavailable')
    runtime.view.setVisible(false)
    runtime.view.setBounds(this.bounds())
    win.contentView.addChildView(runtime.view)
  }

  private bounds() {
    const shell = getShellBounds()
    /*
     * 首页表面铺满整个窗口（含标题栏那一条）。
     *
     * 它是原生 WebContentsView，DOM 的 z-index 管不到它。两种做法都不行：
     *   · 让主壳标题栏浮在首页之上 —— 原生视图永远盖住 DOM，浮不上去；
     *   · 让首页顶部切掉 36px 露出标题栏 —— 那条由主壳单独绘制、与首页自己的
     *     背景动效不同源，接缝处会出现一条可见分割线。
     * 所以首页照旧铺满，窗口控件由首页自己画在左上角（见 DefaultWorkspace 的
     * WindowControls），主壳那组在首页时用 CSS 隐藏，避免两套并存。
     */
    return {
      x: 0,
      y: 0,
      width: Math.max(0, shell.width),
      height: Math.max(0, shell.height)
    }
  }

  private setRuntimeVisible(visible: boolean): void {
    const current = this.current
    if (!current) return
    const acknowledged = !current.navigation && routeKey(current.route) === routeKey(this.desiredRoute)
    // Keep the last acknowledged page painted during same-provider navigation.
    // isContentsActive still denies actions until the new route is acknowledged.
    const nextVisible = visible && this.windowVisible && current.ready && !current.retired && !this.recoverySuspended
      && (acknowledged || current.visible)
    const changed = nextVisible !== current.visible
    if (changed) current.activityRevision++
    current.visible = nextVisible
    if (changed) {
      if (!nextVisible) suspendHomeSearch(current.view.webContents.id)
      try {
        current.view.setVisible(nextVisible)
        if (nextVisible && acknowledged) markStartupPhase('home-visible', `generation=${current.generation} source=${current.reference.source}`)
      }
      catch { /* retired concurrently */ }
      this.sendCommand(current, { type: 'visibility', visible: nextVisible, revision: current.appearance.revision })
    }
    if (nextVisible) { raiseOrbRailViews(); raiseTransientViews() }
  }

  private retireRuntime(runtime: Runtime | null): void {
    if (!runtime) return
    if (runtime.retired) return
    runtime.retired = true
    invalidateHomeSearchHandles(runtime.view.webContents.id)
    this.cancelNavigation(runtime, new Error('Workspace surface is retired'))
    this.failReadyWaiters(runtime, new Error('Home preparation was retired'))
    try { runtime.view.setVisible(false) } catch { /* already retired */ }
    try {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) win.contentView.removeChildView(runtime.view)
    } catch { /* window may be closing */ }
    try {
      const wc = runtime.view.webContents
      if (!wc.isDestroyed()) {
        revokeTrustedSurface(wc)
        wc.close({ waitForBeforeUnload: false })
      }
    } catch { /* teardown may race */ }
  }

  private closePreparing(): void {
    const runtime = this.preparing
    this.preparing = null
    this.retireRuntime(runtime)
  }

  private waitForReady(runtime: Runtime): Promise<void> {
    if (runtime.ready) return Promise.resolve()
    if (this.preparing !== runtime) return Promise.reject(new Error('Home preparation was replaced'))
    return new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        runtime.readyWaiters = runtime.readyWaiters.filter(fn => fn !== resolve)
        runtime.readyRejecters = runtime.readyRejecters.filter(fn => fn !== reject)
        rejectReady(new Error('Home ready handshake timed out'))
      }, this.loadTimeout)
      const resolve = (): void => { clearTimeout(timer); resolveReady() }
      const reject = (error: Error): void => { clearTimeout(timer); rejectReady(error) }
      runtime.readyWaiters.push(resolve)
      runtime.readyRejecters.push(reject)
    })
  }

  private failReadyWaiters(runtime: Runtime | null, error: Error): void {
    if (!runtime) return
    const rejecters = runtime.readyRejecters.splice(0)
    runtime.readyWaiters.splice(0)
    for (const reject of rejecters) reject(error)
  }

  private retiringTransaction(runtime: Runtime): HomeTransaction {
    return {
      commit: () => undefined,
      rollback: () => this.retireRuntime(runtime)
    }
  }

  setVisible(visible: boolean): void {
    this.desiredVisible = visible
    this.setRuntimeVisible(visible)
  }

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible
    this.setRuntimeVisible(this.desiredVisible)
  }

  /** Visibility/startup may prepare a missing surface, but never unlock recovery. */
  ensure(): Promise<void> {
    if (this.recoverySuspended || this.hasCurrent) return Promise.resolve()
    return this.startRetry()
  }

  retry(recover = false): Promise<void> {
    this.recoverySuspended = false
    return this.startRetry(recover)
  }

  private startRetry(recover = false): Promise<void> {
    if (!this.retryFlight) this.retryFlight = this.retryRuntime(recover).finally(() => { this.retryFlight = null })
    return this.retryFlight
  }

  private async retryRuntime(recover = false): Promise<void> {
    if (recover && appearanceService.hasRecovery()) {
      await appearanceService.retryRecovery()
      return
    }
    if (!appearanceService.isActiveThemeAvailable()) {
      await appearanceService.recoverToBuiltin('当前主题已不可用')
      return
    }
    const appearance = getAppearance()
    const transaction = await this.prepare(appearance)
    transaction.commit()
    this.setVisible(this.desiredVisible)
  }

  layout(): void {
    for (const runtime of [this.current, this.preparing]) {
      if (!runtime || runtime.view.webContents.isDestroyed()) continue
      try { runtime.view.setBounds(this.bounds()) } catch { /* window may be closing */ }
    }
  }

  updateAppearance(appearance: ResolvedAppearance): void {
    if (!this.current || this.current.retired || appearance.revision < this.current.appearance.revision) return
    if (appearance.home.source !== this.current.reference.source || appearance.home.id !== this.current.reference.id) return
    this.current.appearance = appearance
    this.sendAppearance(this.current, appearance)
  }

  private sendCommand(runtime: Runtime | null, command: NonNullable<import('@shared/types/home').HomeEventData['command']>): void {
    if (!runtime || runtime.view.webContents.isDestroyed()) return
    runtime.view.webContents.send(IpcChannels.HomeEvent, { command })
  }

  /**
   * classic 模式下把 Tab 投影推给首页。首页自绘 Tab 条用同一份数据，
   * 与主壳/圆轨不产生第二套状态：来源是 orbRailViews 的 lastState。
   * orb 模式首页没有 Tab 条，但照样下发（首页按 tabStyle 自行决定是否渲染）。
   */
  private sendTabs(runtime: Runtime | null): void {
    if (!runtime || runtime.retired || runtime.view.webContents.isDestroyed()) return
    /*
     * 只在 ready 之后发。首页 WebContents 在 did-finish-load 之前收不到 preload 桥的
     * 监听注册，早发的消息会被直接丢掉——这正是"刷新进首页没有 Tab 条"的成因之一。
     * 未 ready 时不必在这里补：handleReady 会紧跟着再推一次。
     */
    if (!runtime.ready) return
    runtime.view.webContents.send(IpcChannels.HomeEvent, { tabs: buildHomeTabsSnapshot() })
  }

  /**
   * 对外暴露：Tab 投影变化时由 orbRailViews 调用。
   *
   * 同时覆盖 current 与 preparing —— 启动期首页还在 preparing 时就可能收到
   * Tab 变化通知，只发 current 会让首屏缺数据。
   */
  publishTabs(): void {
    this.sendTabs(this.current)
    if (this.preparing && this.preparing !== this.current) this.sendTabs(this.preparing)
  }

  handleShellEvent(payload: ShellEventPayload): void {
    const command = homeInstallCommand(payload)
    if (command) this.sendCommand(this.current, command)
    // Tab 集合或激活项变化时同步首页自绘 Tab 条。
    if (payload.type === 'plugin-tabs' || payload.type === 'plugin-active'
      || payload.type === 'plugin-title' || payload.type === 'plugin-icon'
      || payload.type === 'plugin-badge' || payload.type === 'tab-closed') {
      this.publishTabs()
    }
    if (payload.type === 'plugins-changed' || payload.type === 'theme-packs-changed') {
      if (!appearanceService.isActiveThemeAvailable()) {
        for (const listener of this.faultListeners) listener('当前主题已不可用')
      }
      const current = this.current
      this.refreshInstalledSource()
      if (current && this.providerReloads.has(current.appearance.theme.source) && appearanceService.isActiveThemeAvailable()) return
      if (current) void resolveHomePage(current.reference.source, current.reference.id, current.reference.variant).then(page => {
        if (page || this.current !== current || current.retired) return
        this.current = null
        this.retireRuntime(current)
        this.publishState({ status: 'error', generation: current.generation, message: '配套工作区已不可用', recovery: true, route: { ...this.desiredRoute } })
        for (const listener of this.faultListeners) listener('配套首页已不可用')
      }).catch(error => logWarn('home', `provider revalidation failed: ${String(error)}`))
    }
  }

  destroy(): void {
    this.recoveryRevision++
    this.closePreparing()
    this.retireRuntime(this.current)
    this.current = null
    this.desiredVisible = false
    this.desiredRoute = { page: 'catalog' }
    this.recoverySuspended = false
    this.state = { status: 'idle', generation: this.nextGeneration }
  }
}

export const homeSurfaceManager = new HomeSurfaceManager()
// 与 createShellWindow 成环（经 appearanceService 等路径），微任务注册避开环内
// 模块体顺序不确定导致的 TDZ。
queueMicrotask(() => {
  setHomeEventSink(payload => homeSurfaceManager.handleShellEvent(payload))
  pluginRegistry.onInstalledChanged(() => homeSurfaceManager.refreshInstalledSource())
})
appearanceService.subscribeAppearance(({ appearance }) => homeSurfaceManager.updateAppearance(appearance))
homeSurfaceManager.onFault(message => {
  const { theme } = getAppearance()
  if (theme.source === DEFAULT_THEME_IDENTITY.source && theme.id === DEFAULT_THEME_IDENTITY.id && appearanceService.isActiveThemeAvailable()) return
  void appearanceService.recoverToBuiltin(message)
    .catch(error => logWarn('home', `paired fallback failed: ${String(error)}`))
})
export function setHomeSurfaceVisible(visible: boolean): void {
  homeSurfaceManager.setVisible(visible)
  if (visible && !homeSurfaceManager.hasCurrent) {
    void requestHomeSurface(true).catch(error => logWarn('home', `boot prepare failed: ${(error as Error).message}`))
  }
}
let homeRetry: Promise<void> | null = null
function requestHomeSurface(automatic: boolean, recover = false): Promise<void> {
  if (automatic && homeSurfaceManager.isRecoverySuspended) return Promise.resolve()
  if (!homeRetry) {
    homeRetry = (automatic ? homeSurfaceManager.ensure() : homeSurfaceManager.retry(recover))
      .catch(async error => {
        // A safety panel opened during preparation also cancels automatic fallback.
        if (homeSurfaceManager.isRecoverySuspended) throw error
        logWarn('home', `home failed; trying paired default fallback: ${(error as Error).message}`)
        await appearanceService.recoverToBuiltin('配套首页未能完成加载')
      })
      .finally(() => { homeRetry = null })
  }
  return homeRetry
}
/** Prepare the selected Workspace without changing visibility or recovery state. */
export function prewarmHomeSurface(): Promise<void> { return requestHomeSurface(true) }
export function retryHomeSurface(recover = false): Promise<void> { return requestHomeSurface(false, recover) }
export function layoutHomeSurface(): void { homeSurfaceManager.layout() }
export function destroyHomeSurface(): void { homeSurfaceManager.destroy() }
