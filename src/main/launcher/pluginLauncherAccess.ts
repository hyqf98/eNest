import { randomUUID } from 'node:crypto'
import { dialog, Menu, type BaseWindow, type MenuItemConstructorOptions } from 'electron'
import { kvGet, kvSet } from '@main/db/sqliteService'
import { getAppPathsGeneration } from '@main/paths/pathsService'
import { pluginHost, type McpRuntime } from '@main/plugin/PluginHost'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { permissionService } from '@main/plugin/PermissionService'
import { getInteractionEpoch, hasNativeInteraction, isNonInteractive, onDocumentRetired, trackNativeInteraction } from '@main/plugin/pluginInteractionPolicy'
import type { PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { settingsStore } from '@main/settings/SettingsStore'
import type { LauncherTarget } from '@shared/types/pluginApi'
import { scanApplications, getCachedApps } from './appScanner'
import { getAppIconDataUrl, launchLocalApp } from './appLauncher'
import { getCatalogPluginIcon } from './catalogIcons'
import { launchPlugin } from './pluginLauncher'

interface Choice { kind: 'app' | 'plugin'; title: string; key: string }
type Pin = Pick<Choice, 'kind' | 'key'> & { id: string }
const session = new WeakMap<PluginRuntimeScope, { document: number; root: number }>()
const sessionRevisions = new WeakMap<PluginRuntimeScope, number>()
const pending = new WeakSet<PluginRuntimeScope>()
const lastLaunch = new WeakMap<PluginRuntimeScope, number>()
const keyFor = (owner: string) => `launcher.pinned:${owner}`

function pins(owner: string): Pin[] {
  const rows: unknown = JSON.parse(kvGet(keyFor(owner)) ?? '[]')
  if (!Array.isArray(rows) || rows.length > 64 || !rows.every(row => row && ['app', 'plugin'].includes(row.kind)
    && typeof row.key === 'string' && typeof row.id === 'string')) throw new Error('Invalid saved launcher targets')
  return rows
}

function choose(parent: BaseWindow, runtime: McpRuntime, apps: Choice[], plugins: Choice[], english: boolean): Promise<Choice | null> {
  return new Promise((resolve, reject) => {
    let resolved = false, detach = () => {}, cancel = () => {}
    const finish = (value: Choice | null) => {
      if (resolved) return
      resolved = true
      detach()
      resolve(value)
    }
    const items = (choices: Choice[]): MenuItemConstructorOptions[] => {
      const sorted = choices.sort((left, right) => left.title.localeCompare(right.title))
      const rows = sorted.map(choice => ({ label: choice.title.replaceAll('&', '&&').slice(0, 140), click: () => finish(choice) }))
      if (rows.length <= 32) return rows
      return Array.from({ length: Math.ceil(rows.length / 32) }, (_, index) => {
        const group = rows.slice(index * 32, index * 32 + 32)
        return { label: `${group[0].label} … ${group.at(-1)!.label}`, submenu: group }
      })
    }
    const menu = Menu.buildFromTemplate([
      { label: english ? 'Choose a shortcut' : '选择要固定的程序', enabled: false }, { type: 'separator' },
      { label: english ? 'Applications' : '系统应用', enabled: apps.length > 0, submenu: items(apps) },
      { label: english ? 'Installed plugins' : '已安装的插件', enabled: plugins.length > 0, submenu: items(plugins) }
    ])
    cancel = () => { finish(null); if (!parent.isDestroyed()) menu.closePopup(parent) }
    detach = onDocumentRetired(runtime.contents, runtime.scope.signal, cancel)
    if (resolved) return
    try { menu.popup({ window: parent, callback: () => finish(null) }) }
    catch (error) { detach(); reject(error) }
  })
}

export function prepareLauncherCall(owner: string, method: string) {
  const runtime = pluginHost.getMcpRuntime(owner)
  if (!runtime) throw new Error('Launcher owner is unavailable')
  const { scope, documentEpoch } = runtime
  const epoch = getInteractionEpoch(scope), root = getAppPathsGeneration()
  const revision = sessionRevisions.get(scope)
  const current = () => pluginHost.getMcpRuntime(owner)?.documentEpoch === documentEpoch && scope.isCurrent() && !scope.isClosing
    && getAppPathsGeneration() === root && getInteractionEpoch(scope) === epoch && !isNonInteractive(scope) && sessionRevisions.get(scope) === revision
  const delegated = () => session.get(scope)?.document === documentEpoch && session.get(scope)?.root === root
  if (method === 'launcher.endSession') return async () => {
    session.delete(scope)
    sessionRevisions.set(scope, (sessionRevisions.get(scope) ?? 0) + 1)
  }
  const needsPicker = method === 'launcher.authorizeSession' || method === 'launcher.pickTarget'
  const gesture = pluginHost.consumeLauncherInput(owner)
  if (!current() || (!gesture && (needsPicker || !delegated()))) throw new Error('请先在插件窗口中点击操作或授权当前启动栏会话')
  if (!gesture && !permissionService.isGranted(owner, 'launcher.access')) throw new Error('需要重新授权启动栏')
  return async (args: unknown[]) => {
    const allowed = () => current() && permissionService.isGranted(owner, 'launcher.access') && (gesture || delegated())
    if (!allowed()) throw new Error('Launcher request is stale')
    if (pending.has(scope)) throw new Error('Another launcher request is in progress')
    pending.add(scope)
    try {
      const english = settingsStore.getLocale() === 'en-US'
      if (needsPicker) {
        const parent = pluginHost.getContainerWindow(owner)
        if (!parent || parent.isDestroyed() || !pluginHost.isPluginVisible(owner)) return method === 'launcher.pickTarget' ? null : false
        const visible = () => allowed() && !parent.isDestroyed() && pluginHost.getContainerWindow(owner) === parent && pluginHost.isPluginVisible(owner)
        const release = pluginHost.acquireWindowInteraction(owner)
        try {
          if (method === 'launcher.authorizeSession') {
            const name = pluginRegistry.get(owner)?.name ?? owner
            const controller = new AbortController()
            const detach = onDocumentRetired(runtime.contents, scope.signal, () => controller.abort())
            const answer = await trackNativeInteraction(dialog.showMessageBox(parent, { type: 'question',
              message: english ? `Allow ${name} to use the launcher for this session?` : `允许「${name}」在本次会话使用启动栏？`,
              detail: english ? 'It can return to its own workspace, show Quick and open shortcuts you choose, even when another tab is visible. Closing the plugin ends access.' : '即使切到其他标签页，它也可以回到自己的工作区、呼出 Quick，或启动你亲自固定的项目。关闭插件后授权终止。',
              buttons: english ? ['Cancel', 'Allow this session'] : ['取消', '允许本次会话'], defaultId: 0, cancelId: 0, signal: controller.signal })).finally(detach)
            if (answer.response !== 1 || !visible()) return false
            session.set(scope, { document: documentEpoch, root }); return true
          }
          const scanned = await scanApplications()
          if (!visible()) return null
          const choice = await trackNativeInteraction(choose(parent, runtime,
            scanned.apps.map(app => ({ kind: 'app', title: app.name, key: app.path })),
            pluginRegistry.list().filter(plugin => plugin.id !== owner && plugin.installed && plugin.enabled !== false)
              .map(plugin => ({ kind: 'plugin', title: plugin.name, key: plugin.id })), english))
          if (!choice || !visible()) return null
          const app = choice.kind === 'app' && getCachedApps()?.apps.find(app => app.path === choice.key)
          if (choice.kind === 'app' ? !app : !pluginRegistry.isEnabled(choice.key)) return null
          const icon = await (app ? getAppIconDataUrl(app.path, app.iconName) : getCatalogPluginIcon(choice.key)).catch(() => undefined)
          if (!visible()) return null
          const saved = pins(owner), existing = saved.find(item => item.kind === choice.kind && item.key === choice.key)
          const id = existing?.id ?? randomUUID()
          if (!existing) {
            if (saved.length >= 64) throw new Error('最多固定 64 个项目，请先移除一个项目')
            kvSet(keyFor(owner), JSON.stringify([...saved, { kind: choice.kind, key: choice.key, id }]))
          }
          return { id, title: choice.title, kind: choice.kind, ...(icon ? { icon } : {}) } satisfies LauncherTarget
        } finally { release() }
      }
      const id = args[0]
      if (method === 'launcher.forgetTarget') {
        if (typeof id === 'string') kvSet(keyFor(owner), JSON.stringify(pins(owner).filter(pin => pin.id !== id)))
        return
      }
      if (hasNativeInteraction() || Date.now() - (lastLaunch.get(scope) ?? 0) < 500) return false
      lastLaunch.set(scope, Date.now())
      if (method === 'launcher.showQuick') return pluginHost.showQuickSearch(allowed)
      if (method === 'launcher.showWorkspace') return pluginHost.showExistingWorkspace(owner)
      const pin = typeof id === 'string' && pins(owner).find(pin => pin.id === id)
      if (!pin || method !== 'launcher.activateTarget') return false
      if (pin.kind === 'app') {
        const apps = await scanApplications()
        if (!allowed() || !apps.apps.some(app => app.path === pin.key)) return false
        await launchLocalApp(pin.key); return true
      }
      const revision = pluginRegistry.getBuildRevision(pin.key)
      const targetCurrent = () => allowed() && pluginRegistry.get(pin.key)?.installed === true && pluginRegistry.isEnabled(pin.key)
        && pluginRegistry.getBuildRevision(pin.key) === revision
      if (!targetCurrent()) return false
      await pluginHost.ensureRunningForMcp(pin.key, scope.signal)
      return targetCurrent() && (await launchPlugin({ pluginId: pin.key, source: 'launcher', mode: 'shell', guard: targetCurrent })).ok
    } finally { pending.delete(scope) }
  }
}
