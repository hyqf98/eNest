import type { ShellApi } from './shellApi'

const ASYNC_METHODS = [
  'getMcpStatus', 'configureMcp', 'copyMcpConnectionConfig', 'resetMcpToken', 'listMcpTools',
  'getPlugins', 'getMarketStatus', 'getPluginDiagnostics', 'getPluginMemorySnapshot',
  'startPerformanceCapture', 'getPerformanceCaptureState', 'stopPerformanceCapture', 'exportPerformanceCapture',
  'restoreTabs', 'openPlugin', 'closePlugin', 'stopPluginResources', 'activatePlugin', 'hidePlugins',
  'setPluginInset', 'setPluginTopInset', 'goHome', 'setShellView', 'setOrbRailExpanded', 'syncOrbState', 'getOrbState',
  'uninstallPlugin', 'setPluginEnabled', 'getPluginShortcuts', 'savePluginShortcut', 'removePluginShortcut',
  'probePluginShortcut', 'launchPluginShortcut', 'beginShortcutCapture', 'endShortcutCapture', 'setPluginLaunch',
  'getOpenWithList', 'setOpenWithDefault', 'clearOpenWithDefault', 'routeOpenWith', 'openOpenWithSystemSettings',
  'installMarketPlugin', 'getTheme', 'getAppearance', 'updateThemeProfile', 'activateTheme', 'setAppearanceMode',
  'setHomeVisible', 'navigateWorkspace', 'retryHome', 'getHomeState', 'pickAppearanceMedia', 'importAppearanceFont',
  'removeAppearanceFont', 'openNativeModal', 'setAppearancePerformanceLimited', 'setTheme', 'loadDevPlugin',
  'forgetDevPlugin', 'reloadPlugin', 'setDevKillOnHide', 'setDevPluginMode', 'rebuildDevPlugin', 'openDevTools',
  'getPluginCallTrace', 'getThemeSettingsConfig', 'getThemeSettingsSnapshot', 'setThemeSettingsActive',
  'dispatchThemeSettingsAction', 'getSettings', 'setSettings', 'getSettingsSections', 'setPluginSetting', 'getPaths',
  'pickFile', 'getPluginReadme', 'getHardwareAcceleration', 'setHardwareAcceleration', 'getProxy', 'setProxy',
  'testProxy', 'saveCustomFont', 'readCustomFont', 'deleteCustomFont', 'installPlugin', 'getInstallQueue',
  'checkForUpdates', 'downloadUpdate', 'installUpdate', 'getUpdateState', 'getPluginsDirty', 'saveAllPlugins',
  'getAccountState', 'loginAccount', 'cancelAccountLogin', 'logoutAccount', 'githubLogin', 'githubCancelLogin',
  'getGithubProfile', 'githubLogout', 'systemNotify', 'respondPermissionRequest', 'getPluginPermissionGrants',
  'setPluginPermissionGrant', 'openScreenCaptureSettings', 'openPath', 'openExternal', 'quickToggle', 'quickSearch', 'quickOpen',
  'quickScanApps', 'quickGetConfig', 'quickGetTheme', 'quickAuthorizeTheme', 'quickProviderState', 'quickSetHotkeys', 'quickProbeHotkey', 'quickInput', 'quickInputContext',
  'createPanel', 'listPanels', 'closePanel', 'setPanelHotkey',
] as const satisfies ReadonlyArray<keyof ShellApi>
const SUBSCRIPTION_METHODS = ['onEvent', 'onInstallProgress', 'onOrbEvent', 'onQuickThemeKey', 'onQuickShown'] as const satisfies ReadonlyArray<keyof ShellApi>
const SYNC_METHODS = ['getPathForFile', 'minimizeWindow', 'maximizeWindow', 'closeWindow', 'quickHide', 'quickResize'] as const satisfies ReadonlyArray<keyof ShellApi>
export const SHELL_API_METHODS = [...ASYNC_METHODS, ...SUBSCRIPTION_METHODS, ...SYNC_METHODS] as const
type Method = typeof SHELL_API_METHODS[number]
type SubscriptionMethod = typeof SUBSCRIPTION_METHODS[number]
// A newly declared API cannot accidentally disappear from either transport adapter.
const complete: Exclude<keyof ShellApi, Method> extends never ? true : never = true
void complete

const unavailable = (name: string, native: boolean) => new Error(native
  ? `当前宿主未提供 ${name}，请重启 eNest 以更新原生接口`
  : `Browser preview does not support ${name}`)

/** Native transport is deliberately complete and fail-closed; it never consults preview state. */
export function createNativeShellApi(raw: ShellApi): ShellApi {
  const api: Partial<Record<Method, (...args: unknown[]) => unknown>> = {}
  for (const name of ASYNC_METHODS) api[name] = (...args) => {
    const method = raw[name]
    return typeof method === 'function' ? Reflect.apply(method, raw, args) : Promise.reject(unavailable(name, true))
  }
  for (const name of [...SUBSCRIPTION_METHODS, ...SYNC_METHODS]) api[name] = (...args) => {
    const method = raw[name]
    if (typeof method !== 'function') throw unavailable(name, true)
    return Reflect.apply(method, raw, args)
  }
  return Object.freeze(api) as unknown as ShellApi
}

interface PendingSubscription {
  method: SubscriptionMethod
  args: unknown[]
  active: boolean
  attached: boolean
  off?: () => void
}

/** Keep sync unsubscribe semantics while the preview registry and icons remain in a separate chunk. */
export function createLazyPreviewShellApi(load: () => Promise<ShellApi>, environment: Pick<Window, 'close'> = window): ShellApi {
  let loaded: ShellApi | undefined
  let loading: Promise<ShellApi> | undefined
  let reportedFailure = false
  const subscriptions = new Set<PendingSubscription>()
  const api: Partial<Record<Method, (...args: unknown[]) => unknown>> = {}
  const attach = (entry: PendingSubscription, target: ShellApi) => {
    if (!entry.active || entry.attached) return
    entry.attached = true
    const method = target[entry.method]
    if (typeof method !== 'function') {
      if (entry.method === 'onEvent') throw unavailable(entry.method, false)
      return
    }
    const [listener, ...rest] = entry.args
    const callback = (...args: unknown[]) => {
      if (entry.active && typeof listener === 'function') Reflect.apply(listener, undefined, args)
    }
    const off: unknown = Reflect.apply(method, target, [callback, ...rest])
    if (typeof off === 'function') entry.off = off as () => void
    if (!entry.active) entry.off?.()
  }
  const ready = () => loading ??= Promise.resolve().then(load).then(target => {
    loaded = target
    // Register early subscribers before queued writes can publish their first event.
    for (const entry of subscriptions) attach(entry, target)
    return target
  })
  for (const name of ASYNC_METHODS) api[name] = async (...args) => {
    const target = await ready(), method = target[name]
    if (typeof method !== 'function') throw unavailable(name, false)
    return Reflect.apply(method, target, args)
  }
  for (const name of SUBSCRIPTION_METHODS) api[name] = (...args) => {
    const entry: PendingSubscription = { method: name, args, active: true, attached: false }
    subscriptions.add(entry)
    if (loaded) attach(entry, loaded)
    else void ready().catch(error => {
      if (!reportedFailure) { reportedFailure = true; console.error('Unable to initialize eNest browser preview', error) }
    })
    return () => {
      if (!entry.active) return
      entry.active = false
      subscriptions.delete(entry)
      entry.off?.()
    }
  }
  for (const name of SYNC_METHODS) api[name] = (...args) => {
    const method = loaded?.[name]
    if (typeof method === 'function') return Reflect.apply(method, loaded, args)
    if (name === 'getPathForFile') return ''
    if (name === 'closeWindow') environment.close()
    // Browser preview has no native minimize/maximize/Quick geometry to manage.
    return undefined
  }
  return Object.freeze(api) as unknown as ShellApi
}
