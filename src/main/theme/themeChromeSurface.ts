import { createHash, randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { ipcMain, session, WebContentsView, type IpcMainInvokeEvent, type Session } from 'electron'
import { ThemeChromeChannels, type ThemeChromeAction, type ThemeChromePart, type ThemeChromeSnapshot } from '@shared/types/themeChrome'
import type { OrbRailState } from '@shared/types/ipc'
import type { ThemePackV2 } from '@shared/types/appearance'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { activateRailContribution } from '@main/contrib/railContributions'
import { getMainWindow, resolvePreload, sendShellEvent } from '@main/window/createShellWindow'
import { logInfo, logWarn } from '@main/logs/logService'
import { appearanceService } from './appearanceService'
import { themePackRegistry } from './themePacks'
import { chromeAssetPath, chromeAssetResponse, chromeAssetUrl, parseChromeAssetUrl, readChromeAsset, THEME_CHROME_SCHEME } from './themeChromeAssets'

interface Selection { signature: string; source: string; entry: string; rootInput: string }
export function selectThemeChrome(part: ThemeChromePart): Selection | null {
  const appearance = appearanceService.getAppearance()
  if (appearance.theme.source === 'enest.builtin') return null
  const pack = themePackRegistry.get(appearance.theme.id) as ThemePackV2 | null
  const descriptor = appearance.chrome?.[part]
  const source = appearance.theme.source, rootInput = pluginRegistry.getAssetRootPath(source)
  if (!descriptor || appearance.chrome?.version !== 1 || !pack || pack.source !== source ||
    pack.chrome?.version !== 1 || pack.chrome[part]?.entry !== descriptor.entry ||
    !descriptor.entry.endsWith('.html') || !chromeAssetPath(descriptor.entry) ||
    !pluginRegistry.isEnabled(source) || !pluginRegistry.getManifest(source) || !rootInput) return null
  return { source, entry: descriptor.entry, rootInput,
    signature: JSON.stringify([source, appearance.theme.id, appearance.theme.version, descriptor.entry, rootInput, pluginRegistry.getBuildRevision(source)]) }
}

interface Options {
  state(): OrbRailState
  active(): boolean
  expand(value: boolean): void
  changed(): void
  failed(signature: string): void
}
const surfaces = new Map<number, ThemeChromeSurface>()
const sessionOwners = new WeakMap<Session, ThemeChromeSurface>()
const denyPermissionRequest: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> = (_contents, _permission, callback) => callback(false)
const denyPermissionCheck = (): boolean => false
let registered = false
function registerHandlers(): void {
  if (registered) return
  registered = true
  const own = (event: IpcMainInvokeEvent): ThemeChromeSurface => {
    const surface = surfaces.get(event.sender.id)
    if (!surface || !surface.accepts(event)) throw new Error('Retired or foreign theme chrome surface')
    return surface
  }
  ipcMain.handle(ThemeChromeChannels.Snapshot, event => own(event).snapshot())
  ipcMain.handle(ThemeChromeChannels.Ready, event => own(event).ready())
  ipcMain.handle(ThemeChromeChannels.Action, (event, action: unknown) => own(event).dispatch(action))
}

/** No plugin preload, shell bridge, account data, local paths or general settings enter this renderer. */
export class ThemeChromeSurface {
  readonly view: WebContentsView
  readonly signature: string
  private readonly key = randomBytes(24).toString('hex')
  private readonly url: string
  private readonly isolated: Session
  private readonly preventDownload = (event: { preventDefault(): void }): void => event.preventDefault()
  private readyFlag = false
  private disposed = false
  private gestureAt = -Infinity
  private downAt = -Infinity
  private requestWindow = 0
  private requests = 0
  private timeout: ReturnType<typeof setTimeout> | null = null

  constructor(readonly part: ThemeChromePart, private selected: Selection, private options: Options) {
    registerHandlers()
    this.signature = selected.signature
    this.url = chromeAssetUrl(this.key, selected.entry)
    // Electron retains Sessions until exit. A provider owns at most one partition per chrome part.
    const isolated = session.fromPartition(`enest-chrome-${createHash('sha256').update(selected.source).digest('hex')}-${part}`, { cache: false })
    this.isolated = isolated
    sessionOwners.get(isolated)?.dispose()
    sessionOwners.set(isolated, this)
    isolated.setPermissionRequestHandler(denyPermissionRequest)
    isolated.setPermissionCheckHandler(denyPermissionCheck)
    isolated.on('will-download', this.preventDownload)
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const path = parseChromeAssetUrl(details.url, this.key)
      const frame = details.frame
      const ours = details.webContentsId === this.view?.webContents.id && !!frame && !frame.detached && frame === this.view.webContents.mainFrame
      const kindAllowed = details.resourceType === 'mainFrame' ? path === selected.entry
        : ['script', 'stylesheet', 'image', 'font', 'xhr'].includes(details.resourceType) && !!path && !path.endsWith('.html')
      // Data images/fonts are permitted by CSP; every network request remains local to this grant.
      callback({ cancel: !ours || !this.current() || !['GET', 'HEAD'].includes(details.method) || !kindAllowed })
    })
    const rootPromise = realpath(selected.rootInput)
    void isolated.protocol.handle(THEME_CHROME_SCHEME, async request => {
      try {
        const path = parseChromeAssetUrl(request.url, this.key)
        if (!this.current() || !path || path.endsWith('.html') && path !== selected.entry) return chromeAssetResponse(request, 403, 'forbidden')
        if (!['GET', 'HEAD'].includes(request.method)) return chromeAssetResponse(request, 405, 'method not allowed')
        const bytes = await readChromeAsset(selected.rootInput, await rootPromise, path)
        return bytes && this.current() ? chromeAssetResponse(request, 200, bytes, path) : chromeAssetResponse(request, 403, 'retired')
      } catch { return chromeAssetResponse(request, 403, 'forbidden') }
    })
    this.view = new WebContentsView({ webPreferences: {
      session: isolated, preload: resolvePreload('themeChromePreload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true,
      navigateOnDragDrop: false, spellcheck: false
    } })
    this.view.setBackgroundColor('#00000000')
    this.view.setVisible(false)
    const contents = this.view.webContents
    surfaces.set(contents.id, this)
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-navigate', (event, url) => { if (url !== this.url) event.preventDefault() })
    contents.on('will-frame-navigate', event => { if (!event.isMainFrame || event.url !== this.url) event.preventDefault() })
    contents.on('will-redirect', event => event.preventDefault())
    contents.on('before-mouse-event', (_event, mouse) => {
      if (this.part === 'classic' && this.isReady() && this.view.getVisible() && ['mouseEnter', 'mouseLeave'].includes(mouse.type)) {
        sendShellEvent({ type: 'titlebar-native-hover', inside: mouse.type === 'mouseEnter' })
      }
      if (mouse.button !== 'left' || !this.interactive()) return
      if (mouse.type === 'mouseDown') this.downAt = performance.now()
      if (mouse.type === 'mouseUp' && performance.now() - this.downAt < 1000) { this.gestureAt = performance.now(); this.downAt = -Infinity }
    })
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && !input.isAutoRepeat && !input.isComposing && ['Enter', ' '].includes(input.key) && this.interactive()) this.gestureAt = performance.now()
    })
    contents.on('blur', () => { this.gestureAt = -Infinity; this.downAt = -Infinity })
    contents.on('render-process-gone', () => this.fail())
    contents.once('destroyed', () => surfaces.delete(contents.id))
    this.timeout = setTimeout(() => this.fail(), 5000)
    this.timeout.unref()
    void contents.loadURL(this.url).catch(() => this.fail())
    void rootPromise.catch(() => this.fail())
  }
  current(): boolean { return !this.disposed && sessionOwners.get(this.isolated) === this && selectThemeChrome(this.part)?.signature === this.signature }
  isReady(): boolean { return this.readyFlag && this.current() }
  accepts(event: IpcMainInvokeEvent): boolean {
    return this.current() && event.sender === this.view.webContents && !event.sender.isDestroyed() &&
      event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === this.url
  }
  private interactive(): boolean {
    const window = getMainWindow()
    return this.isReady() && this.options.active() && this.view.getVisible() && !!window && window.isFocused()
  }
  snapshot(): ThemeChromeSnapshot {
    const state = this.options.state()
    return {
      version: 1, surface: this.part, tabStyle: state.tabStyle, view: state.view, activeTabId: state.activeTabId,
      animationLevel: state.animationLevel,
      theme: { mode: state.theme.mode, tokens: { ...state.theme.tokens } },
      tabs: state.tabs.map(tab => ({ id: tab.id, pluginId: tab.pluginId, title: tab.title, color: tab.color, glyph: tab.glyph,
        lazy: tab.lazy === true, crashed: tab.crashed === true,
        ...(tab.badge ? { badge: tab.badge } : {}) })),
      contribEntries: (state.contribEntries ?? []).map(row => ({ id: row.id, pluginId: row.pluginId, title: row.title, glyph: row.glyph, color: row.color }))
    }
  }
  publish(): void {
    if (this.current() && !this.view.webContents.isDestroyed()) this.view.webContents.send(ThemeChromeChannels.Changed, this.snapshot())
  }
  ready(): void {
    if (this.readyFlag) return
    this.readyFlag = true
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    this.publish()
    logInfo('theme-chrome', `ready surface=${this.part} source=${this.selected.source}`)
    this.options.changed()
  }
  private fail(): void {
    if (this.disposed) return
    logWarn('theme-chrome', `fallback surface=${this.part} source=${this.selected.source}`)
    this.options.failed(this.signature)
  }
  async dispatch(input: unknown): Promise<void> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid chrome action')
    if (!this.interactive()) throw new Error('Chrome is not interactive')
    const now = performance.now()
    if (now - this.requestWindow > 1000) { this.requestWindow = now; this.requests = 0 }
    if (++this.requests > 60) throw new Error('Chrome action rate limit')
    const action = input as ThemeChromeAction
    if (action.type === 'expand') {
      if (this.part !== 'rail' || typeof action.expanded !== 'boolean') throw new Error('Invalid rail action')
      this.options.expand(action.expanded)
      return
    }
    if (this.part === 'dock' && action.type !== 'settings') throw new Error('Settings dock action required')
    const gestureAt = this.gestureAt
    this.gestureAt = -Infinity
    if (now - gestureAt > 1000) throw new Error('A native user gesture is required')
    if (action.type === 'contribution') {
      await activateRailContribution(action.id, () => this.interactive())
      return
    }
    const { pluginHost } = await import('@main/plugin/PluginHost')
    if (!this.interactive()) throw new Error('Chrome retired during action')
    if (action.type === 'home' || action.type === 'settings') {
      const { navigateWorkspace, openShellSettings } = await import('@main/ipc/shellHandlers')
      if (!this.interactive()) throw new Error('Chrome retired during navigation')
      if (action.type === 'home') await navigateWorkspace({ page: 'catalog' })
      else openShellSettings()
      return
    }
    if (!['activate', 'close', 'reorder', 'detach'].includes(action.type) || !('tabId' in action) || typeof action.tabId !== 'string' || action.tabId.length > 300) throw new Error('Unsupported chrome action')
    const tab = this.options.state().tabs.find(tab => tab.id === action.tabId)
    if (!tab || !pluginHost.hasShellTab(tab.id)) throw new Error('Unknown shell tab')
    if (action.type === 'activate') pluginHost.activatePlugin(tab.id)
    else if (action.type === 'close') await pluginHost.closePlugin(tab.id, 'tab-close')
    else if (action.type === 'detach') await pluginHost.detachPlugin(tab.pluginId)
    else if (action.type === 'reorder') {
      if (!Number.isSafeInteger(action.index) || action.index < 0 || action.index >= this.options.state().tabs.length) throw new Error('Invalid tab index')
      pluginHost.reorderPlugin(tab.pluginId, action.index)
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.part === 'classic') sendShellEvent({ type: 'titlebar-native-hover', inside: false })
    if (this.timeout) clearTimeout(this.timeout)
    this.timeout = null
    const contents = this.view.webContents, isolated = contents.session
    surfaces.delete(contents.id)
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
    if (sessionOwners.get(isolated) === this) {
      sessionOwners.delete(isolated)
      for (const detach of [() => isolated.webRequest.onBeforeRequest(null),
        () => isolated.protocol.unhandle(THEME_CHROME_SCHEME),
        () => isolated.removeListener('will-download', this.preventDownload),
        () => isolated.setPermissionRequestHandler(denyPermissionRequest),
        () => isolated.setPermissionCheckHandler(denyPermissionCheck)]) {
        try { detach() } catch { /* Native teardown may already be in progress. */ }
      }
    }
    // A replacement has a new origin even when the provider partition is reused.
    void isolated.clearStorageData({ origin: `${THEME_CHROME_SCHEME}://${this.key}` }).catch(() => {})
  }
}
