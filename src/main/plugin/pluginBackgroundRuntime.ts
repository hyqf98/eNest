import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { ipcMain, session, WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import { BACKGROUND_MESSAGE_LIMIT, type BackgroundRequest, type BackgroundResponse } from '@shared/types/pluginBackgroundProtocol'
import type { PluginBackgroundManifest, PluginBackgroundSearchItem } from '@shared/types/pluginBackground'
import type { PluginManifest, PluginPermission } from '@shared/types/plugin'
import { isPluginAssetPath } from '@shared/pluginContract'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'
import { pluginRegistry } from './PluginRegistry'
import { getRuntimeScope } from './PluginRuntimeScope'
import { permissionService } from './PermissionService'
import { pluginHost } from './PluginHost'
import { resolvePluginFile } from './pluginPaths'
import { pluginFileResponse } from './pluginFileResponse'
import { getPrivateBlob, putPrivateBlob, readPrivateDocument, removePrivateBlob, writePrivateDocument, grantPrivateMigrationBudget, type PrivateDocumentOwner } from './pluginPrivateDocuments'
import { resolvePreload } from '@main/window/createShellWindow'
import { settingsStore } from '@main/settings/SettingsStore'
import { subscribeClipboardChanges } from '@main/clipboard/clipboardNativeEvents'
import { readLegacyClipboardDocument, getLegacyClipboardBlob, commitLegacyClipboardMigration, getLegacyClipboardImportBudget } from '@main/clipboard/legacyClipboardMigration'
import { logInfo, logWarn } from '@main/logs/logService'

const SCHEME = 'enest-background'
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const IDLE_MS = 30_000
const MAX_QUEUE_BYTES = 32 * 1024 * 1024
const NATIVE_EVENT_PERMISSIONS: Readonly<Record<string, PluginPermission>> = { 'clipboard.changed': 'clipboard.history' }
interface Configuration { pluginId: string; manifest: PluginManifest; background: PluginBackgroundManifest; root: string; source: boolean; signature: string }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
const entries = new Map<string, BackgroundRuntime>()
const sessionOwners = new WeakMap<Session, BackgroundRuntime>()
const senders = new Map<number, BackgroundRuntime>()
const subscriptions = new Map<string, { signature: string; dispose(): void }>()
const stoppedPlugins = new Map<string, { buildRevision: string; disabled: boolean }>()
const builtConfigurations = new Map<string, { identity: string; root: string }>()
let generation = 0, registered = false, stopping = false
let unregisterRegistry: (() => void) | undefined

function configuration(pluginId: string, includeStopped = false): Configuration | null {
  if ((!includeStopped && stoppedPlugins.has(pluginId)) || pluginHost.isBlockedForOpen(pluginId)) return null
  const item = pluginRegistry.getInstalledDescriptors().find(item => item.id === pluginId && item.enabled)
  const background = item?.manifest.background
  if (!item || !background || !isPluginAssetPath(background.entry) || !background.entry.startsWith('assets/')
    || !background.entry.endsWith('.html') || background.events?.some(event => !NATIVE_EVENT_PERMISSIONS[event])) return null
  if (Object.entries(background.eventSettings ?? {}).some(([event, key]) => !background.events?.includes(event)
    || !isPluginSettingKey(key) || !item.manifest.contributes?.settings?.some(section => section.items.some(field => field.key === key && field.type === 'switch')))) return null
  let root = item.rootPath
  if (item.dev && pluginRegistry.get(pluginId)?.devSource === true) {
    const identity = JSON.stringify([item.buildRevision, item.rootPath, item.manifest.id, item.manifest.version, background])
    const cached = builtConfigurations.get(pluginId)
    if (cached?.identity === identity) root = cached.root
    else {
      try {
        root = join(item.rootPath, 'dist')
        const directory = lstatSync(root), metadata = lstatSync(join(root, 'plugin.json'))
        if (directory.isSymbolicLink() || !directory.isDirectory() || metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 1024 * 1024) return null
        const built = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')) as PluginManifest
        if (built.id !== item.manifest.id || built.version !== item.manifest.version || JSON.stringify(built.background) !== JSON.stringify(background)) return null
        const entry = lstatSync(join(root, background.entry))
        if (entry.isSymbolicLink() || !entry.isFile()) return null
        builtConfigurations.set(pluginId, { identity, root })
      } catch { return null }
    }
  }
  return { pluginId, manifest: item.manifest, background, root, source: false,
    signature: JSON.stringify([item.buildRevision, root, background, item.manifest.permissions, item.manifest.version]) }
}
function permissions(config: Configuration): PluginPermission[] {
  return [...new Set((config.background.events ?? []).map(event => NATIVE_EVENT_PERMISSIONS[event]))]
}
function authorized(config: Configuration, persistent: boolean): boolean {
  return permissions(config).every(permission => config.manifest.permissions?.includes(permission)
    && (settingsStore.getPermissionGrant(config.pluginId, permission) === 'allow'
      || !persistent && permissionService.isGranted(config.pluginId, permission)))
}
function enabled(config: Configuration, event: string): boolean {
  const binding = config.background.eventSettings?.[event]
  return !binding || resolvedSettings(config)[binding] === true
}
function resolvedSettings(config: Configuration): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const section of config.manifest.contributes?.settings ?? []) for (const item of section.items) {
    if (item.type !== 'page' && isPluginSettingKey(item.key)) values[item.key] = item.default
  }
  for (const [key, value] of Object.entries(settingsStore.getPluginSettings(config.pluginId))) {
    if (isPluginSettingKey(key)) values[key] = value
  }
  return values
}
function size(value: unknown): number {
  const encoded = JSON.stringify(value)
  const bytes = encoded === undefined ? 0 : Buffer.byteLength(encoded)
  if (bytes > BACKGROUND_MESSAGE_LIMIT) throw new Error('Background message budget exceeded')
  return bytes
}
function methodName(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) }
function assetPath(raw: string, token: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== `${SCHEME}:` || url.hostname !== token || url.username || url.password || url.search || url.hash) return null
    const path = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/')
    return isPluginAssetPath(path) && path.startsWith('assets/') ? path : null
  } catch { return null }
}

class BackgroundRuntime {
  readonly generation = ++generation
  readonly controller = new AbortController()
  readonly view: WebContentsView
  readonly wcId: number
  readonly owner: PrivateDocumentOwner
  private readonly token = randomUUID()
  private readonly url: string
  private readonly isolated: Session
  private readonly preventDownload = (event: { preventDefault(): void }): void => event.preventDefault()
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readyPromise = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
  private readyTimer: NodeJS.Timeout
  private idleTimer: NodeJS.Timeout | undefined
  private readonly pending = new Map<number, Pending>()
  private searchTask: { query: string; promise: Promise<unknown> } | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private nextId = 0
  private queued = 0
  private queuedBytes = 0
  private hostRequests = 0
  private hostBytes = 0
  private settled = false
  private readyFlag = false
  completed = 0
  failed = 0

  constructor(readonly config: Configuration) {
    this.url = `${SCHEME}://${this.token}/${config.background.entry}`
    this.owner = { pluginId: config.pluginId, signal: this.controller.signal, current: () => this.current() }
    // Electron retains Session partitions until exit. Reuse one per plugin, not one per idle wakeup.
    const isolated = session.fromPartition(`enest-background-${createHash('sha256').update(config.pluginId).digest('hex')}`, { cache: false })
    this.isolated = isolated
    sessionOwners.set(isolated, this)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.on('will-download', this.preventDownload)
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const path = assetPath(details.url, this.token)
      const allowed = ['GET', 'HEAD'].includes(details.method) && path && this.current()
        && (details.resourceType === 'mainFrame' ? path === config.background.entry
          : ['script', 'stylesheet', 'image', 'font'].includes(details.resourceType) && extname(path) !== '.html')
      callback({ cancel: !allowed })
    })
    void isolated.protocol.handle(SCHEME, async request => {
      try {
        const path = assetPath(request.url, this.token)
        if (!path || !this.current() || path.endsWith('.html') && path !== config.background.entry) return new Response('forbidden', { status: 403 })
        const file = await resolvePluginFile(config.root, path, config.source)
        if (!file || !this.current()) return new Response('retired', { status: 403 })
        const mime = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)]
        if (!mime) return new Response('forbidden', { status: 403 })
        return pluginFileResponse(request, file, { root: config.root, dev: config.source, mime, csp: CSP, revision: config.signature })
      } catch { return new Response('not found', { status: 404 }) }
    })
    this.view = new WebContentsView({ webPreferences: { session: isolated, preload: resolvePreload('backgroundPreload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: true, spellcheck: false, navigateOnDragDrop: false } })
    this.view.setVisible(false)
    const contents = this.view.webContents
    this.wcId = contents.id
    senders.set(contents.id, this)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-navigate', (event, url) => { if (url !== this.url) event.preventDefault() })
    contents.on('will-frame-navigate', event => { if (!event.isMainFrame || event.url !== this.url) event.preventDefault() })
    contents.on('will-redirect', event => event.preventDefault())
    contents.on('render-process-gone', () => this.dispose('background renderer exited'))
    contents.once('destroyed', () => this.dispose('background renderer destroyed'))
    this.readyTimer = setTimeout(() => this.dispose('background registration timed out'), 5000)
    this.readyTimer.unref()
    void this.readyPromise.catch(() => {})
    void contents.loadURL(this.url).catch(() => this.dispose('background page failed to load'))
  }
  current(): boolean {
    return !stopping && !this.settled && entries.get(this.config.pluginId) === this
      && configuration(this.config.pluginId)?.signature === this.config.signature && authorized(this.config, false)
  }
  accepts(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    return this.current() && event.sender === this.view.webContents && !event.sender.isDestroyed()
      && event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === this.url
  }
  ready(): void {
    if (this.readyFlag) return
    this.readyFlag = true
    clearTimeout(this.readyTimer)
    this.readyResolve()
    this.scheduleIdle()
  }
  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.settled || this.queued || this.hostRequests) return
    this.idleTimer = setTimeout(() => this.dispose('idle'), IDLE_MS)
    this.idleTimer.unref()
  }
  request(input: Omit<Extract<BackgroundRequest, { kind: 'call' }>, 'id'> | Omit<Extract<BackgroundRequest, { kind: 'event' }>, 'id'>
    | Omit<Extract<BackgroundRequest, { kind: 'search' }>, 'id'>, timeoutMs: number): Promise<unknown> {
    const bytes = size(input)
    if (!this.current()) return Promise.reject(new Error('Background is retired or unauthorized'))
    if (this.queued >= 32 || this.queuedBytes + bytes > MAX_QUEUE_BYTES) return Promise.reject(new Error('Background operation queue is full'))
    this.queued++
    this.queuedBytes += bytes
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const task = this.tail.catch(() => {}).then(async () => {
      await this.readyPromise
      if (!this.current()) throw new Error('Background is retired or unauthorized')
      return new Promise<unknown>((resolve, reject) => {
        const id = ++this.nextId
        const timer = setTimeout(() => { this.dispose('background operation timed out') }, timeoutMs)
        timer.unref()
        this.pending.set(id, { resolve, reject, timer })
        this.view.webContents.send(IpcChannels.PluginBackgroundRequest, { ...input, id } satisfies BackgroundRequest)
      })
    }).finally(() => { this.queued--; this.queuedBytes -= bytes; this.scheduleIdle() })
    this.tail = task
    return task
  }
  async search(query: string, limit: number): Promise<unknown> {
    // A short Quick deadline must not kill a cold migration or a foreground mutation ahead of it.
    if (this.searchTask && this.searchTask.query !== query) return []
    if (!this.searchTask) {
      const promise = this.request({ kind: 'search', query, limit }, 600_000)
      const task = { query, promise }
      this.searchTask = task
      void promise.finally(() => { if (this.searchTask === task) this.searchTask = undefined }).catch(() => {})
    }
    const work = this.searchTask.promise
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve([]), 1500)
      timer.unref()
      void work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
  }
  response(response: BackgroundResponse): void {
    if (!response || !Number.isSafeInteger(response.id) || typeof response.ok !== 'boolean') return this.dispose('invalid background response')
    try { size(response) } catch { return this.dispose('background response budget exceeded') }
    const pending = this.pending.get(response.id)
    if (!pending) return this.dispose('unknown background response')
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.ok) { this.completed++; pending.resolve(response.data) }
    else { this.failed++; pending.reject(new Error(typeof response.error === 'string' ? response.error.slice(0, 500) : 'Background operation failed')) }
  }
  async host(method: unknown, args: unknown): Promise<unknown> {
    if (!methodName(method) || !Array.isArray(args)) throw new Error('Invalid background host request')
    if (!this.current()) throw new Error('Background owner retired')
    const bytes = size(args)
    if (this.hostRequests >= 16 || this.hostBytes + bytes > BACKGROUND_MESSAGE_LIMIT) throw new Error('Background host request quota exceeded')
    this.hostRequests++; this.hostBytes += bytes
    if (this.idleTimer) clearTimeout(this.idleTimer)
    try {
      if (method.startsWith('legacy.') && (!this.config.manifest.permissions?.includes('clipboard.history')
        || settingsStore.getPermissionGrant(this.config.pluginId, 'clipboard.history') !== 'allow' && !permissionService.isGranted(this.config.pluginId, 'clipboard.history'))) {
        throw new Error('Legacy clipboard migration requires its declared history authorization')
      }
      let result: unknown
      switch (method) {
        case 'private.readDocument': result = await readPrivateDocument(this.owner, String(args[0] ?? '')); break
        case 'private.writeDocument': result = await writePrivateDocument(this.owner, String(args[0] ?? ''), args[1]); break
        case 'private.getBlob': result = await getPrivateBlob(this.owner, String(args[0] ?? '')); break
        case 'private.putBlob': result = await putPrivateBlob(this.owner, args[0] as { id?: string; dataUrl: string }); break
        case 'private.removeBlob': result = await removePrivateBlob(this.owner, String(args[0] ?? '')); break
        case 'settings.get': result = resolvedSettings(this.config); break
        case 'emit': {
          if (!methodName(args[0])) throw new Error('Invalid background event')
          size(args[1])
          pluginHost.sendEvent(this.config.pluginId, { type: 'background.event', event: args[0], data: args[1] })
          break
        }
        case 'legacy.read': {
          result = await readLegacyClipboardDocument(this.config.pluginId, String(args[0] ?? ''))
          if (result) {
            const source = String(args[0]), token = (result as { token: string }).token
            const budget = await getLegacyClipboardImportBudget(this.config.pluginId, source, token)
            if (!this.current()) throw new Error('Background retired during migration')
            await grantPrivateMigrationBudget(this.owner, source, token, budget.bytes)
          }
          break
        }
        case 'legacy.getBlob': result = await getLegacyClipboardBlob(this.config.pluginId, String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] ?? '')); break
        case 'legacy.commit': result = await commitLegacyClipboardMigration(this.config.pluginId, String(args[0] ?? ''), String(args[1] ?? ''), () => {
          if (!this.current()) throw new Error('Background owner retired during migration')
        }); break
        default: throw new Error('Unknown background host capability')
      }
      if (!this.current()) throw new Error('Background owner retired')
      size(result)
      return result
    } finally { this.hostRequests--; this.hostBytes -= bytes; this.scheduleIdle() }
  }
  dispose(reason: string): void {
    if (this.settled) return
    this.settled = true
    this.controller.abort(new Error(reason))
    clearTimeout(this.readyTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.readyReject(new Error(reason))
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)) }
    this.pending.clear()
    senders.delete(this.wcId)
    if (entries.get(this.config.pluginId) === this) entries.delete(this.config.pluginId)
    if (sessionOwners.get(this.isolated) === this) {
      sessionOwners.delete(this.isolated)
      this.isolated.protocol.unhandle(SCHEME)
      this.isolated.webRequest.onBeforeRequest(null)
      this.isolated.removeListener('will-download', this.preventDownload)
      // Keep deny-only permission handlers. Clearing only the retired nonce origin cannot erase a newer generation.
      void this.isolated.clearStorageData({ origin: `${SCHEME}://${this.token}` }).catch(() => {})
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false })
    logInfo('plugin-background', `stop plugin=${this.config.pluginId} generation=${this.generation} reason=${reason}`)
  }
  diagnostics() {
    return { pluginId: this.config.pluginId, generation: this.generation, wcId: this.wcId, queued: this.queued,
      pending: this.pending.size, hostRequests: this.hostRequests, hostBytes: this.hostBytes, completed: this.completed, failed: this.failed, ready: this.readyFlag }
  }
}

function runtime(pluginId: string): BackgroundRuntime {
  const config = configuration(pluginId)
  if (stopping || !config || !authorized(config, false)) {
    if (!config && pluginRegistry.get(pluginId)?.devSource === true) throw new Error('Background requires matching built output in dist; build the plugin and reload it')
    throw new Error('Background is undeclared, disabled, stopped, or unauthorized')
  }
  let entry = entries.get(pluginId)
  if (entry && !entry.current()) { entry.dispose('configuration retired'); entry = undefined }
  if (!entry) {
    entry = new BackgroundRuntime(config)
    entries.set(pluginId, entry)
    logInfo('plugin-background', `start plugin=${pluginId} generation=${entry.generation}`)
  }
  return entry
}
export function requiredBackgroundPermissions(pluginId: string): PluginPermission[] {
  const config = configuration(pluginId, true)
  if (!config) {
    if (pluginRegistry.get(pluginId)?.devSource === true) throw new Error('Background requires matching built output in dist; build the plugin and reload it')
    throw new Error('Plugin has no available background declaration')
  }
  return permissions(config)
}
export function callPluginBackground(pluginId: string, method: unknown, args: unknown = [], options?: unknown): Promise<unknown> {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing || !methodName(method) || !Array.isArray(args)) throw new Error('Invalid background caller or method')
  const configured = options && typeof options === 'object' ? (options as { timeoutMs?: unknown }).timeoutMs : undefined
  const timeout = configured === undefined ? 30_000 : configured
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 250 || timeout > 86_400_000) throw new Error('Invalid background timeout')
  const config = configuration(pluginId, true)
  if (stopping || !config || !authorized(config, false)) {
    if (!config && pluginRegistry.get(pluginId)?.devSource === true) throw new Error('Background requires matching built output in dist; build the plugin and reload it')
    throw new Error('Background is undeclared, disabled, blocked, or unauthorized')
  }
  size({ kind: 'call', method, args })
  if (stoppedPlugins.delete(pluginId)) refreshPluginBackgrounds()
  return runtime(pluginId).request({ kind: 'call', method, args }, timeout).then(result => {
    if (!scope.isCurrent() || scope.isClosing) throw new Error('Background caller retired')
    return result
  })
}
export async function searchAll(query: string, limit = 20): Promise<Array<{ pluginId: string; items: PluginBackgroundSearchItem[] }>> {
  if (typeof query !== 'string' || query.length > 4096 || !query.trim()) return []
  const maximum = Math.min(20, Math.max(1, Number.isInteger(limit) ? limit : 20))
  const candidates = pluginRegistry.getInstalledDescriptors().filter(item => item.enabled && item.manifest.background?.quickSearch).slice(0, 8)
  return Promise.all(candidates.map(async item => {
    const config = configuration(item.id)
    if (!config || !authorized(config, true)) return { pluginId: item.id, items: [] }
    try {
      const result = await runtime(item.id).search(query, maximum)
      if (!Array.isArray(result) || !authorized(config, true)) return { pluginId: item.id, items: [] }
      return { pluginId: item.id, items: result.slice(0, maximum).filter(value => value && typeof value === 'object'
        && typeof value.id === 'string' && value.id.length <= 256 && typeof value.title === 'string' && value.title.length <= 1000) as PluginBackgroundSearchItem[] }
    } catch { return { pluginId: item.id, items: [] } }
  }))
}
export function refreshPluginBackgrounds(): void {
  if (stopping) return
  for (const [id, stopped] of stoppedPlugins) {
    const item = pluginRegistry.getInstalledDescriptors().find(item => item.id === id)
    if (!item?.enabled) stopped.disabled = true
    else if (stopped.disabled || stopped.buildRevision !== item.buildRevision) stoppedPlugins.delete(id)
  }
  for (const entry of entries.values()) if (!entry.current()) entry.dispose('declaration or permission changed')
  const desired = new Set<string>()
  for (const item of pluginRegistry.getInstalledDescriptors()) {
    const config = configuration(item.id)
    if (!config || !authorized(config, true)) continue
    for (const event of config.background.events ?? []) {
      if (!enabled(config, event)) continue
      const key = `${item.id}:${event}`
      desired.add(key)
      if (subscriptions.get(key)?.signature === config.signature) continue
      subscriptions.get(key)?.dispose()
      subscriptions.delete(key)
      let active = true
      const current = () => active && !stopping && configuration(item.id)?.signature === config.signature && authorized(config, true) && enabled(config, event)
      if (event === 'clipboard.changed') {
        try {
          const dispose = subscribeClipboardChanges({ current, publish: async data => {
            if (!current()) return
            try { await runtime(item.id).request({ kind: 'event', event, data }, 600_000) }
            catch (error) { if (current()) { logWarn('plugin-background', `event failed plugin=${item.id} event=${event}`); throw error } }
          } })
          subscriptions.set(key, { signature: config.signature, dispose: () => { active = false; dispose() } })
        } catch {
          active = false
          logWarn('plugin-background', `subscription unavailable plugin=${item.id} event=${event}`)
        }
      }
    }
  }
  for (const [key, subscription] of subscriptions) if (!desired.has(key)) { subscription.dispose(); subscriptions.delete(key) }
}
export function startPluginBackgrounds(): void {
  stopping = false
  if (!registered) {
    registered = true
    const own = (event: IpcMainInvokeEvent | IpcMainEvent): BackgroundRuntime => {
      const entry = senders.get(event.sender.id)
      if (!entry?.accepts(event)) throw new Error('Foreign or retired background sender')
      return entry
    }
    ipcMain.handle(IpcChannels.PluginBackgroundReady, event => own(event).ready())
    ipcMain.handle(IpcChannels.PluginBackgroundHost, (event, input: unknown) => {
      const entry = own(event), request = input as { method?: unknown; args?: unknown }
      if (!request || typeof request !== 'object') throw new Error('Invalid background host envelope')
      return entry.host(request.method, request.args)
    })
    ipcMain.on(IpcChannels.PluginBackgroundResponse, (event, response: BackgroundResponse) => {
      try { own(event).response(response) } catch { /* Retired page responses have no authority. */ }
    })
  }
  unregisterRegistry?.()
  unregisterRegistry = pluginRegistry.onInstalledChanged(refreshPluginBackgrounds)
  refreshPluginBackgrounds()
}
export function stopPluginBackground(pluginId: string, reason = 'plugin stopped'): void {
  const item = pluginRegistry.getInstalledDescriptors().find(item => item.id === pluginId)
  stoppedPlugins.set(pluginId, { buildRevision: item?.buildRevision ?? '', disabled: !item?.enabled })
  entries.get(pluginId)?.dispose(reason)
  for (const [key, subscription] of subscriptions) if (key.startsWith(`${pluginId}:`)) { subscription.dispose(); subscriptions.delete(key) }
}
export function disposePluginBackgrounds(): void {
  stopping = true
  unregisterRegistry?.()
  unregisterRegistry = undefined
  for (const subscription of subscriptions.values()) subscription.dispose()
  subscriptions.clear()
  for (const entry of [...entries.values()]) entry.dispose('application shutdown')
}
export function getBackgroundDiagnostics() { return [...entries.values()].map(entry => entry.diagnostics()) }
export function getBackgroundMemoryOwners() { return getBackgroundDiagnostics().map(({ pluginId, generation, wcId }) => ({ pluginId, generation, wcId })) }
