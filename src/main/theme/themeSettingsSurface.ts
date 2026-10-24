import { createHash, randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Session, WebContents, WebFrameMain } from 'electron'
import { IpcChannels } from '@shared/types/ipc'
import type { ThemePackV2 } from '@shared/types/appearance'
import type { ThemeSettingsAction, ThemeSettingsActionResult, ThemeSettingsConfig, ThemeSettingsFieldDescriptor, ThemeSettingsSnapshot, ThemeSettingsValue } from '@shared/types/themeSettings'
import { themeProfileKey } from '@shared/theme/appearance'
import { isPluginSettingKey } from '@shared/pluginSettingsKeys'
import { parseThemeColor } from '@shared/theme/colors'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { settingsStore } from '@main/settings/SettingsStore'
import { pluginSettingsBridge } from '@main/settings/PluginSettingsBridge'
import { pluginHost } from '@main/plugin/PluginHost'
import { refreshPluginBackgrounds } from '@main/plugin/pluginBackgroundRuntime'
import { openNativeModal } from '@main/window/modalSurface'
import { getMainWindow, sendShellEvent } from '@main/window/createShellWindow'
import { handleShellIpc } from '@main/ipc/ipcSecurity'
import { appearanceService } from './appearanceService'
import { themePackRegistry } from './themePacks'
import { publicAppearance } from './quickThemeProtocol'
import { SETTINGS_THEME_BRIDGE_SOURCE } from './quickThemeBridge'
import { chromeAssetPath, readChromeAsset } from './themeChromeAssets'

export const THEME_SETTINGS_SCHEME = 'enest-settings'
const ORIGIN = `${THEME_SETTINGS_SCHEME}://surface`
const BRIDGE = '__bridge.js'
const MAX_BYTES = 8 * 1024 * 1024
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' }
interface Selection { signature: string; rootInput: string; entry: string }
type FieldTarget = { type: 'general'; key: 'locale' | 'closeBehavior' | 'notifyPosition' }
  | { type: 'appearance'; source: string; themeId: string; key: string }
  | { type: 'plugin'; pluginId: string; key: string; label: string; name: string }
interface Grant extends Selection { key: string; root: string; fields: Map<string, { descriptor: ThemeSettingsFieldDescriptor; target: FieldTarget }> }
interface InputPolicy { contents: WebContents; key: string | null; bounds: { x: number; y: number; width: number; height: number } | null; gestureAt: number; busy: boolean; active: boolean; activationEpoch: number }
let grant: Grant | null = null, revision = 0, registered = false, watching = false
const sessions = new WeakSet<Session>()
const policies = new Map<number, InputPolicy>()
function retireGrant(): void {
  if (!grant) return
  grant = null
  for (const policy of policies.values()) {
    policy.gestureAt = 0
    policy.activationEpoch++
    policy.active = false
  }
}

function selection(): Selection | null {
  const appearance = appearanceService.getAppearance(), source = appearance.theme.source
  const pack = themePackRegistry.list().find(pack => pack.source === source && pack.id === appearance.theme.id) as ThemePackV2 | undefined
  const page = pack?.settingsPage, rootInput = pluginRegistry.getAssetRootPath(source)
  if (source === 'enest.builtin' || !page || page.version !== 1 || !page.entry.endsWith('.html') || !chromeAssetPath(page.entry)
    || !pack || pack.source !== source || pack.schemaVersion !== 2 || !pluginRegistry.isEnabled(source) || !rootInput) { retireGrant(); return null }
  const selected = { rootInput, entry: page.entry, signature: JSON.stringify([source, appearance.theme.id, appearance.theme.version, page, rootInput, pluginRegistry.getBuildRevision(source)]) }
  if (grant && grant.signature !== selected.signature) retireGrant()
  return selected
}
function live(key?: string): Grant | null { return selection() && grant && (!key || key === grant.key) ? grant : null }
function watch(): void {
  if (watching) return
  watching = true
  const retire = (): void => { selection() }
  appearanceService.subscribeAppearance(retire)
  pluginRegistry.onInstalledChanged(retire)
}
function urlFor(key: string, path: string): string { return `${ORIGIN}/${key}/${path.split('/').map(encodeURIComponent).join('/')}` }
function parseUrl(raw: string, entryOnly = false): { key: string; path: string } | null {
  try {
    const url = new URL(raw), [key, ...parts] = url.pathname.slice(1).split('/').map(decodeURIComponent)
    if (url.protocol !== `${THEME_SETTINGS_SCHEME}:` || url.hostname !== 'surface' || url.port || url.username || url.password || url.search || !/^[a-f0-9]{64}$/.test(key)
      || parts.some(part => /[/\\]/.test(part)) || url.hash && (!entryOnly || !/^#generation=[A-Za-z0-9_-]{16,160}$/.test(url.hash))) return null
    const path = parts.join('/'), current = live(key)
    if (!current || !chromeAssetPath(path) || urlFor(key, path) !== raw.split('#')[0] || entryOnly && path !== current.entry) return null
    return { key, path }
  } catch { return null }
}
function resourceResponse(request: Request, status: number, body: Uint8Array | string | null, path = ''): Response {
  return new Response(request.method === 'HEAD' ? null : body, { status, headers: {
    'Content-Type': MIME[extname(path)] ?? 'text/plain; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src ${ORIGIN}; script-src-attr 'none'; style-src ${ORIGIN} 'unsafe-inline'; img-src ${ORIGIN} data:; font-src ${ORIGIN} data:; connect-src ${ORIGIN}; frame-src 'none'; child-src 'none'; media-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
    'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), fullscreen=()'
  } })
}
function registerProtocol(ses: Session): void {
  if (sessions.has(ses)) return
  sessions.add(ses)
  void ses.protocol.handle(THEME_SETTINGS_SCHEME, async request => {
    try {
      const parsed = parseUrl(request.url), current = live()
      if (!parsed || !current || !['GET', 'HEAD'].includes(request.method) || parsed.path.endsWith('.html') && parsed.path !== current.entry) return resourceResponse(request, 403, 'forbidden')
      if (parsed.path === BRIDGE) return resourceResponse(request, 200, SETTINGS_THEME_BRIDGE_SOURCE, BRIDGE)
      if (await realpath(current.rootInput) !== current.root || live() !== current) return resourceResponse(request, 403, 'retired')
      let bytes = await readChromeAsset(current.rootInput, current.root, parsed.path)
      if (!bytes || live() !== current) return resourceResponse(request, 403, 'forbidden')
      if (parsed.path === current.entry) {
        const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
        const doctype = /^\s*<!doctype\s+html\s*>/i.exec(html)
        bytes = new TextEncoder().encode(`${doctype ? doctype[0] : '<!doctype html>'}\n<script src="${urlFor(current.key, BRIDGE)}"></script>\n${doctype ? html.slice(doctype[0].length) : html}`)
        if (bytes.byteLength > MAX_BYTES) return resourceResponse(request, 403, 'resource too large')
      }
      return resourceResponse(request, 200, bytes, parsed.path)
    } catch { return resourceResponse(request, 403, 'forbidden') }
  })
}
export async function getThemeSettingsConfig(): Promise<ThemeSettingsConfig | null> {
  watch()
  const chosen = selection()
  if (!chosen) return null
  try {
    const root = await realpath(chosen.rootInput)
    if (!await readChromeAsset(chosen.rootInput, root, chosen.entry) || selection()?.signature !== chosen.signature) return null
    if (!grant) grant = { ...chosen, root, key: randomBytes(32).toString('hex'), fields: new Map() }
    return { key: grant.key, url: urlFor(grant.key, grant.entry) }
  } catch { return null }
}
function safeValue(value: unknown): value is ThemeSettingsValue {
  return value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 512
}
function widget(type: string): ThemeSettingsFieldDescriptor['type'] | null {
  return ['switch', 'boolean', 'bool'].includes(type) ? 'switch' : type === 'select' ? 'select'
    : type === 'slider' || type === 'number' ? 'number' : type === 'color' || type === 'token' ? 'color' : null
}
function snapshot(key: string): ThemeSettingsSnapshot {
  const current = live(key)
  if (!current) throw new Error('Settings surface retired')
  const all = settingsStore.getAll(), appearance = appearanceService.getAppearance(), en = all.general.locale === 'en-US'
  const fields = new Map<string, { descriptor: ThemeSettingsFieldDescriptor; target: FieldTarget }>()
  const add = (id: string, input: Omit<ThemeSettingsFieldDescriptor, 'id'>, target: FieldTarget): ThemeSettingsFieldDescriptor => {
    // IDs are scoped by the unguessable selected surface grant and resolve only through this map.
    const descriptor = { ...input, id: createHash('sha256').update(`${current.key}:${id}`).digest('hex') }
    fields.set(descriptor.id, { descriptor, target })
    return descriptor
  }
  const groups: ThemeSettingsSnapshot['groups'] = [{ id: 'general', title: en ? 'General' : '通用', fields: [
    add('locale', { label: en ? 'Language' : '语言', type: 'select', value: all.general.locale, options: [{ label: '简体中文', value: 'zh-CN' }, { label: 'English', value: 'en-US' }] }, { type: 'general', key: 'locale' }),
    add('close', { label: en ? 'Close button' : '关闭窗口时', type: 'select', value: all.general.closeBehavior === 'quit' ? 'quit' : 'minimize-tray', options: [{ label: en ? 'Keep in tray' : '最小化到托盘', value: 'minimize-tray' }, { label: en ? 'Quit' : '退出软件', value: 'quit' }] }, { type: 'general', key: 'closeBehavior' }),
    add('notify', { label: en ? 'Notifications' : '通知位置', type: 'select', value: all.general.notifyPosition === 'center' ? 'center' : 'bottom-right', options: [{ label: en ? 'Center' : '居中', value: 'center' }, { label: en ? 'Bottom right' : '右下角', value: 'bottom-right' }] }, { type: 'general', key: 'notifyPosition' })
  ] }]
  const pack = themePackRegistry.list().find(pack => pack.source === appearance.theme.source && pack.id === appearance.theme.id) as ThemePackV2 | undefined
  if (pack?.schemaVersion === 2) {
    const stored = settingsStore.getAppearanceSettings().profiles[themeProfileKey({ source: pack.source, id: pack.id })]
    for (const group of pack.settings.groups) {
      const rows: ThemeSettingsFieldDescriptor[] = []
      for (const field of group.fields) {
        const type = widget(field.type)
        // Media/font import and any raw local path remain in the native picker UI.
        if (!type || field.type === 'media' || field.type === 'font') continue
        if (field.visibleWhen && (stored?.values[field.visibleWhen.field] ?? pack.settings.groups.flatMap(row => row.fields).find(row => row.key === field.visibleWhen!.field)?.default) !== field.visibleWhen.equals) continue
        const value = field.binding.target === 'token' ? appearance.tokens[field.binding.key] : stored?.values[field.key] ?? field.default
        if (!safeValue(value)) continue
        rows.push(add(`a:${field.key}`, { label: field.label, type, value, options: field.options?.map(option => ({ label: option.label, value: option.value })), min: field.min, max: field.max, step: field.step }, { type: 'appearance', source: pack.source, themeId: pack.id, key: field.key }))
      }
      if (rows.length) groups.push({ id: `appearance:${group.id}`, title: group.title, fields: rows })
    }
  }
  const plugins = pluginRegistry.getInstalledDescriptors().filter(item => item.enabled)
  for (const section of pluginSettingsBridge.listAll().slice(0, 256)) {
    const plugin = plugins.find(item => item.id === section.pluginId)
    if (!plugin) continue
    const rows: ThemeSettingsFieldDescriptor[] = []
    for (const field of section.items.slice(0, 128)) {
      const type = widget(field.type)
      if (!type || field.shareWithThemes !== true || !isPluginSettingKey(field.key) || typeof field.label !== 'string' || fields.size >= 1024) continue
      const value = Object.hasOwn(all.plugins?.[plugin.id] ?? {}, field.key) ? all.plugins![plugin.id][field.key] : field.default
      const options = Array.isArray(field.options) ? field.options.slice(0, 64).filter(option => option && typeof option.label === 'string' && safeValue(option.value)).map(option => ({ label: option.label.slice(0, 128), value: option.value as ThemeSettingsValue })) : undefined
      if (!safeValue(value) || type === 'select' && (!options?.length || !options.some(option => option.value === value))) continue
      const min = Number.isFinite(field.min) ? field.min : undefined, max = Number.isFinite(field.max) ? field.max : undefined, step = Number.isFinite(field.step) && field.step! > 0 ? field.step : undefined
      rows.push(add(`p:${plugin.id}:${section.id}:${field.key}`, { label: field.label.slice(0, 256), type, value, options, min, max, step, confirmation: true }, { type: 'plugin', pluginId: plugin.id, key: field.key, label: field.label.slice(0, 256), name: plugin.manifest.name }))
    }
    if (rows.length) groups.push({ id: `plugin:${plugin.id}:${section.id}`, title: `${plugin.manifest.name} · ${String(section.title).slice(0, 256)}`, fields: rows })
  }
  const published = groups.slice(0, 256)
  const publishedIds = new Set(published.flatMap(group => group.fields.map(field => field.id)))
  current.fields = new Map([...fields].filter(([id]) => publishedIds.has(id)))
  return { version: 1, revision: ++revision, locale: all.general.locale, appearance: publicAppearance(appearance), groups: published,
    nativeSections: [{ id: 'general', title: en ? 'System, account, performance and security' : '系统、账号、性能与安全' }, { id: 'theme', title: en ? 'Theme selection and local media' : '主题切换与本地媒体' }, { id: 'dev', title: en ? 'Developer tools' : '开发者工具' },
      ...plugins.slice(0, 128).map(plugin => ({ id: `p:${plugin.id}` as const, title: plugin.manifest.name }))] }
}
function validValue(descriptor: ThemeSettingsFieldDescriptor, value: unknown): value is ThemeSettingsValue {
  if (!safeValue(value)) return false
  if (descriptor.type === 'switch') return typeof value === 'boolean'
  if (descriptor.type === 'select') return !!descriptor.options?.some(option => option.value === value)
  if (descriptor.type === 'color') return typeof value === 'string' && value.length <= 96 && !!parseThemeColor(value)
  return typeof value === 'number' && Number.isFinite(value) && value >= (descriptor.min ?? -1e9) && value <= (descriptor.max ?? 1e9)
}
function directFrame(policy: InputPolicy, frame: WebFrameMain | null | undefined): boolean {
  try { return !!frame && !frame.detached && frame.parent?.frameTreeNodeId === policy.contents.mainFrame.frameTreeNodeId && !!parseUrl(frame.url, true) }
  catch { return false }
}
function interactive(policy: InputPolicy): boolean {
  const window = getMainWindow()
  return policy.active && !!policy.key && !!live(policy.key) && !!window && !window.isDestroyed() && window.isVisible() && window.isFocused()
}
/** Binds real native input to one current direct iframe; synthetic DOM events never mint authority. */
export function registerThemeSettingsPolicy(contents: WebContents): void {
  registerProtocol(contents.session)
  if (policies.has(contents.id)) return
  const policy: InputPolicy = { contents, key: null, bounds: null, gestureAt: 0, busy: false, active: false, activationEpoch: 0 }
  policies.set(contents.id, policy)
  let downAt = 0
  const inside = (x: number, y: number): boolean => !!policy.bounds && x >= policy.bounds.x && y >= policy.bounds.y && x < policy.bounds.x + policy.bounds.width && y < policy.bounds.y + policy.bounds.height
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.button !== 'left') return
    if (mouse.type === 'mouseDown') { policy.gestureAt = 0; downAt = interactive(policy) && inside(mouse.x, mouse.y) ? performance.now() : 0 }
    else if (mouse.type === 'mouseUp') {
      if (downAt && performance.now() - downAt <= 10000 && interactive(policy) && inside(mouse.x, mouse.y) && directFrame(policy, contents.focusedFrame)) policy.gestureAt = performance.now()
      downAt = 0
    }
  })
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && !input.isAutoRepeat && !input.isComposing && ['Enter', ' ', 'Space'].includes(input.key) && interactive(policy) && directFrame(policy, contents.focusedFrame)) policy.gestureAt = performance.now()
  })
  const retireInput = (): void => { policy.gestureAt = 0; downAt = 0 }
  contents.on('blur', retireInput)
  contents.on('did-start-navigation', retireInput)
  const restrictFrame = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
    if (!event.isMainFrame && (!event.frame || event.frame.parent?.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId || !parseUrl(event.url, true))) event.preventDefault()
  }
  contents.on('will-frame-navigate', restrictFrame)
  contents.on('will-redirect', restrictFrame)
  // External links use the trusted document's explicit shell API, never a popup from a child frame.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.once('destroyed', () => { retireInput(); policies.delete(contents.id) })
}
export function registerThemeSettingsHandlers(): void {
  if (registered) return
  registered = true
  handleShellIpc(IpcChannels.ThemeSettingsConfig, () => getThemeSettingsConfig())
  handleShellIpc(IpcChannels.ThemeSettingsSnapshot, (_event, key: string) => snapshot(key))
  handleShellIpc(IpcChannels.ThemeSettingsActive, (event, input: { key?: unknown; bounds?: unknown; active?: unknown }) => {
    const policy = policies.get(event.sender.id), bounds = input?.bounds as InputPolicy['bounds']
    if (!policy) return false
    if (input?.active !== true && typeof input?.key === 'string' && policy.key !== input.key) return false
    policy.gestureAt = 0
    policy.activationEpoch++
    if (input?.active !== true || typeof input.key !== 'string' || !live(input.key) || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
      policy.active = false; policy.key = null; policy.bounds = null; return false
    }
    policy.active = true; policy.key = input.key; policy.bounds = bounds; return true
  })
  handleShellIpc(IpcChannels.ThemeSettingsAction, async (event, key: string, action: ThemeSettingsAction): Promise<ThemeSettingsActionResult> => {
    const policy = policies.get(event.sender.id), current = live(key)
    if (!policy || policy.key !== key || !current || !interactive(policy) || !policy.gestureAt || performance.now() - policy.gestureAt > 1500 || policy.busy) return { ok: false, error: 'A current native user gesture is required' }
    policy.gestureAt = 0
    if (!action || typeof action !== 'object') return { ok: false, error: 'Invalid settings action' }
    if (action.type === 'native') {
      const native = snapshot(key).nativeSections.find(section => section.id === action.section)
      return native ? { ok: true, nativeSection: native.id } : { ok: false, error: 'Unknown native settings section' }
    }
    if (action.type !== 'set' || typeof action.fieldId !== 'string' || action.fieldId.length > 512) return { ok: false, error: 'Invalid settings field' }
    // Rebuild the allowlist so stale fields cannot write after a schema/permission/visibility change.
    snapshot(key)
    const field = current.fields.get(action.fieldId)
    if (!field || !validValue(field.descriptor, action.value)) return { ok: false, error: 'Invalid settings value' }
    policy.busy = true
    try {
      const target = field.target
      if (target.type === 'plugin') {
        const epoch = policy.activationEpoch, fingerprint = JSON.stringify(field)
        const build = pluginRegistry.getBuildRevision(target.pluginId)
        const confirmed = await openNativeModal(event.sender, { kind: 'confirm', options: { title: '插件设置', message: `允许当前主题修改「${target.name}」的「${target.label}」为 ${String(action.value).slice(0, 256)}？`, confirmLabel: '修改' } })
        if (!confirmed || event.sender.isDestroyed() || policies.get(event.sender.id) !== policy || live(key) !== current || !policy.active || policy.key !== key || policy.activationEpoch !== epoch || !pluginRegistry.isEnabled(target.pluginId) || pluginRegistry.getBuildRevision(target.pluginId) !== build) return { ok: false, error: 'cancelled or settings surface retired' }
        // Confirmation is asynchronous: a plugin may have withdrawn public access, changed its
        // schema or already edited the value while the native dialog was open.
        snapshot(key)
        const latest = current.fields.get(action.fieldId)
        if (!latest || JSON.stringify(latest) !== fingerprint || !validValue(latest.descriptor, action.value) || !pluginSettingsBridge.isWritableKey(target.pluginId, target.key)) return { ok: false, error: 'settings changed during confirmation' }
        pluginSettingsBridge.set(target.pluginId, target.key, action.value)
        await settingsStore.setPluginSetting(target.pluginId, target.key, action.value)
        refreshPluginBackgrounds()
        pluginHost.sendEvent(target.pluginId, { type: 'settings-change', key: target.key, value: action.value })
        sendShellEvent({ type: 'plugin-settings-changed', pluginId: target.pluginId })
      } else if (target.type === 'appearance') {
        appearanceService.updateThemeProfile({ theme: { source: target.source, id: target.themeId }, values: { [target.key]: action.value } })
      } else {
        if (target.key === 'locale') settingsStore.commitGeneralPreferences({ locale: action.value as 'zh-CN' | 'en-US' })
        else if (target.key === 'closeBehavior') settingsStore.commitGeneralPreferences({ closeBehavior: action.value as 'quit' | 'minimize-tray' })
        else settingsStore.commitGeneralPreferences({ notifyPosition: action.value as 'center' | 'bottom-right' })
        sendShellEvent({ type: 'settings-changed', generalKeys: [target.key] })
        if (target.key === 'locale') {
          const { broadcastPluginLocale } = await import('@main/ipc/pluginHandlers')
          broadcastPluginLocale(action.value as 'zh-CN' | 'en-US')
          event.sender.send(IpcChannels.ShellEvent, { type: 'locale-changed', locale: action.value })
        }
      }
      return { ok: true }
    } catch { return { ok: false, error: 'Could not apply settings' } }
    finally { policy.busy = false }
  })
}
