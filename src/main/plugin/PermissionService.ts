/** Native host-owned permission arbitration. Renderer IPC can never grant access. */
import { dialog } from 'electron'
import type { PluginPermission, PluginPermissionGrant } from '@shared/types/plugin'
import { PLUGIN_PERMISSIONS } from '@shared/types/plugin'
import { permissionLabel } from '@shared/permissionLabels'
import { isBuiltinCapability } from '@shared/pluginPermissionPolicy'
import { settingsStore } from '@main/settings/SettingsStore'
import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { getMainWindow } from '@main/window/createShellWindow'
import { logWarn } from '@main/logs/logService'

export type PermissionDecision = 'once' | 'always' | 'deny'
interface Request {
  pluginId: string
  permission: PluginPermission
  osHint?: string
  scope: PluginRuntimeScope
  promise: Promise<boolean>
  resolve: (allowed: boolean) => void
  cleanup: () => void
  controller: AbortController
  sourceSignal?: AbortSignal
  settled: boolean
}

function waitForConsent<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); resolve(null) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export class PermissionService {
  private queue: Request[] = []
  private active: Request | null = null
  // A plugin reload/hibernate creates a new scope and cannot inherit temporary consent.
  private runtimeDecisions = new WeakMap<PluginRuntimeScope, Map<PluginPermission, boolean>>()

  private decision(scope: PluginRuntimeScope, permission: PluginPermission): boolean | undefined {
    if (!scope.isCurrent() || scope.isClosing) return false
    const grant = settingsStore.getPermissionGrant(scope.owner.pluginId, permission)
    if (grant !== 'ask') return grant === 'allow'
    return this.runtimeDecisions.get(scope)?.get(permission)
  }

  /** Synchronous gate for launching an already-consented native backend, including once grants. */
  isGranted(pluginId: string, permission: PluginPermission): boolean {
    const scope = getRuntimeScope(pluginId)
    return !!scope && this.decision(scope, permission) === true
  }

  /** Callers verify the manifest and sender before asking the host to arbitrate consent. */
  request(pluginId: string, permission: PluginPermission, _summary: string, osHint?: 'system-pending' | 'denied', signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    if (isBuiltinCapability(permission)) return Promise.resolve(true)
    const scope = getRuntimeScope(pluginId)
    if (!PLUGIN_PERMISSIONS.includes(permission) || !scope?.isCurrent() || scope.isClosing) return Promise.resolve(false)
    const decision = this.decision(scope, permission)
    if (decision !== undefined) return Promise.resolve(decision)
    const pending = [this.active, ...this.queue].find(item => item && !item.settled && item.scope === scope && item.permission === permission && item.sourceSignal === signal)
    if (pending) return pending.promise
    if (this.queue.length >= 64 || this.queue.filter(item => item.pluginId === pluginId).length >= 8) return Promise.resolve(false)

    let resolve!: Request['resolve']
    const promise = new Promise<boolean>(done => { resolve = done })
    const releaseActivity = scope.acquireActivity('plugin permission request')
    const request: Request = { pluginId, permission, osHint, scope, promise, resolve, cleanup: () => {}, controller: new AbortController(), sourceSignal: signal, settled: false }
    const abort = (): void => {
      this.cancelRequest(request)
    }
    request.cleanup = () => { scope.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); releaseActivity() }
    scope.signal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (scope.signal.aborted || signal?.aborted || !scope.isCurrent() || scope.isClosing) { abort(); return promise }
    this.queue.push(request)
    void this.presentNext()
    return promise
  }

  private settle(request: Request, allowed: boolean): void {
    if (request.settled) return
    request.settled = true
    request.cleanup()
    request.resolve(allowed)
  }

  private cancelRequest(request: Request): void {
    this.settle(request, false)
    request.controller.abort()
    this.queue = this.queue.filter(item => item !== request)
  }

  private async presentNext(): Promise<void> {
    if (this.active) return
    const request = this.queue.shift()
    if (!request) return
    this.active = request
    let timer: ReturnType<typeof setTimeout> | undefined
    let releaseInteraction = (): void => {}
    try {
      const decision = this.decision(request.scope, request.permission)
      if (decision !== undefined) { this.settle(request, decision); return }
      const [{ pluginHost }, { pluginRegistry }, { acquireQuickInteraction }] = await Promise.all([
        import('@main/plugin/PluginHost'), import('@main/plugin/PluginRegistry'), import('@main/window/createQuickWindow')
      ])
      if (request.settled) return
      const manifest = pluginRegistry.getManifest(request.pluginId)
      if (!manifest?.permissions?.includes(request.permission)) { this.settle(request, false); return }
      // Only explicitly declared, known and undecided capabilities appear in this consent.
      // Previously denied capabilities stay denied; later additions require another consent.
      const permissions = [...new Set(manifest.permissions)].filter(permission =>
        PLUGIN_PERMISSIONS.includes(permission) && !isBuiltinCapability(permission) && this.decision(request.scope, permission) === undefined
      )
      const currentDecision = this.decision(request.scope, request.permission)
      if (currentDecision !== undefined) { this.settle(request, currentDecision); return }
      const win = pluginHost.getContainerWindow(request.pluginId) || getMainWindow()
      if (!win || win.isDestroyed()) { this.settle(request, false); return }
      if (win.isMinimized()) win.restore()
      win.show()
      const releaseWindow = pluginHost.acquireWindowInteraction(request.pluginId)
      const releaseQuick = acquireQuickInteraction()
      releaseInteraction = () => { releaseWindow(); releaseQuick() }
      timer = setTimeout(() => { this.cancelRequest(request) }, 60_000)
      timer.unref?.()
      const detail = [
        `插件 ID：${request.pluginId}`,
        '本次将统一授权以下能力：',
        ...permissions.map(permission => `• ${permissionLabel(permission)}`),
        ...(permissions.includes('backend.node') ? ['本机后端拥有 Node.js 的文件、网络和系统访问能力，不受页面沙箱限制。仅授权你信任的插件。'] : []),
        '',
        '“授权并记住”后，同样的能力不再重复询问。',
        '“本次运行允许”或“暂不允许”仅对当前插件实例有效，结束运行后失效。',
        ...(permissions.includes('clipboard.history') ? ['剪贴板历史的持续后台采集仅在选择“授权并记住”后开启。'] : []),
        ...(request.osHint || permissions.some(permission => permission === 'screen.capture' || permission === 'screen.record')
          ? ['屏幕等系统权限仍需在操作系统中授权。'] : [])
      ].join('\n')
      const response = await waitForConsent(dialog.showMessageBox(win, {
        type: 'question', title: 'eNest 插件授权',
        message: `允许「${manifest.name || request.pluginId}」使用以下能力？`,
        detail,
        buttons: ['暂不允许', '本次运行允许', '授权并记住'], defaultId: 0, cancelId: 0, noLink: true,
        signal: request.controller.signal
      }), request.controller.signal)
      if (!response || request.settled || request.controller.signal.aborted || !request.scope.isCurrent() || request.scope.isClosing) return
      if (response.response !== 0 && response.response !== 1 && response.response !== 2) { this.settle(request, false); return }
      if (response.response === 2) {
        for (const permission of permissions) {
          if (request.settled || !request.scope.isCurrent() || request.scope.isClosing) return
          // A decision changed through Settings while the dialog was open takes precedence.
          if (this.decision(request.scope, permission) === undefined) await settingsStore.setPermissionGrant(request.pluginId, permission, 'allow')
        }
        const { refreshPluginBackgrounds } = await import('@main/plugin/pluginBackgroundRuntime')
        refreshPluginBackgrounds()
      } else {
        const decisions = this.runtimeDecisions.get(request.scope) ?? new Map<PluginPermission, boolean>()
        for (const permission of permissions) if (this.decision(request.scope, permission) === undefined) decisions.set(permission, response.response === 1)
        this.runtimeDecisions.set(request.scope, decisions)
      }
      this.settle(request, this.decision(request.scope, request.permission) === true)
    } catch (error) { logWarn('permission', String(error)); this.cancelRequest(request) }
    finally {
      this.settle(request, false)
      releaseInteraction()
      if (timer) clearTimeout(timer)
      this.active = null
      void this.presentNext()
    }
  }

  /** Legacy shell replies are deliberately rejected: only the native dialog can grant. */
  resolveRequest(_requestId: string, _decision: PermissionDecision): boolean { return false }

  cancelFor(pluginId: string): void {
    const scope = getRuntimeScope(pluginId)
    if (scope) this.runtimeDecisions.delete(scope)
    for (const request of this.queue.filter(item => item.pluginId === pluginId)) this.settle(request, false)
    this.queue = this.queue.filter(item => item.pluginId !== pluginId)
    if (this.active?.pluginId === pluginId) { this.settle(this.active, false); this.active.controller.abort() }
  }
}
export const permissionService = new PermissionService()
export function normalizeGrant(value: unknown): PluginPermissionGrant { return value === 'allow' || value === 'deny' ? value : 'ask' }
