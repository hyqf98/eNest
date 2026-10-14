/** Native host-owned permission arbitration. Renderer IPC can never grant access. */
import { dialog } from 'electron'
import type { PluginPermission, PluginPermissionGrant } from '@shared/types/plugin'
import { permissionLabel } from '@shared/permissionLabels'
import { isBuiltinCapability } from '@shared/pluginPermissionPolicy'
import { settingsStore } from '@main/settings/SettingsStore'
import { getMainWindow } from '@main/window/createShellWindow'
import { logWarn } from '@main/logs/logService'

export type PermissionDecision = 'once' | 'always' | 'deny'
interface Request { pluginId: string; permission: PluginPermission; summary: string; osHint?: string; resolve: (allowed: boolean) => void; controller: AbortController; settled: boolean }
export class PermissionService {
  private queue: Request[] = []
  private active: Request | null = null
  request(pluginId: string, permission: PluginPermission, summary: string, osHint?: 'system-pending' | 'denied'): Promise<boolean> {
    // Built-in capabilities are always available, including after old installs
    // persisted a denial for storage, settings or presentation-only APIs.
    if (isBuiltinCapability(permission)) return Promise.resolve(true)
    const grant = settingsStore.getPermissionGrant(pluginId, permission)
    if (grant !== 'ask') return Promise.resolve(grant === 'allow')
    if (this.queue.length >= 64 || this.queue.filter(item => item.pluginId === pluginId).length >= 8) return Promise.resolve(false)
    return new Promise(resolve => {
      this.queue.push({ pluginId, permission, summary, osHint, resolve, controller: new AbortController(), settled: false })
      void this.presentNext()
    })
  }
  private settle(request: Request, allowed: boolean): void {
    if (request.settled) return
    request.settled = true
    request.resolve(allowed)
  }
  private async presentNext(): Promise<void> {
    if (this.active) return
    const request = this.queue.shift()
    if (!request) return
    this.active = request
    let timer: ReturnType<typeof setTimeout> | undefined
    let releaseInteraction = (): void => {}
    try {
      // Re-evaluate a saved decision made while this request was queued.
      const grant = settingsStore.getPermissionGrant(request.pluginId, request.permission)
      if (grant !== 'ask') { this.settle(request, grant === 'allow'); return }
      const [{ pluginHost }, { acquireQuickInteraction }] = await Promise.all([import('@main/plugin/PluginHost'), import('@main/window/createQuickWindow')])
      if (request.settled) return
      const win = pluginHost.getContainerWindow(request.pluginId) || getMainWindow()
      if (!win || win.isDestroyed()) { this.settle(request, false); return }
      if (win.isMinimized()) win.restore()
      win.show()
      releaseInteraction = acquireQuickInteraction()
      timer = setTimeout(() => { this.settle(request, false); request.controller.abort() }, 60_000)
      timer.unref?.()
      const response = await dialog.showMessageBox(win, {
        type: 'question', title: 'eNest 插件权限',
        message: `插件「${request.pluginId}」请求：${permissionLabel(request.permission)}`,
        detail: `${request.summary.slice(0, 500)}${request.osHint ? '\n系统权限还需在操作系统设置中授权。' : ''}`,
        buttons: ['拒绝', '本次允许', '总是允许'], defaultId: 0, cancelId: 0, noLink: true,
        signal: request.controller.signal
      })
      if (request.settled || request.controller.signal.aborted) return
      if (response.response === 2 || response.response === 0) {
        await settingsStore.setPermissionGrant(request.pluginId, request.permission, response.response === 2 ? 'allow' : 'deny')
        const { revalidateClipboardPolling } = await import('@main/clipboard/clipboardHistory')
        revalidateClipboardPolling()
      }
      this.settle(request, response.response === 1 || response.response === 2)
    } catch (error) { logWarn('permission', String(error)); this.settle(request, false) }
    finally { releaseInteraction(); if (timer) clearTimeout(timer); this.active = null; void this.presentNext() }
  }
  /** Legacy shell replies are deliberately rejected: only the native dialog can grant. */
  resolveRequest(_requestId: string, _decision: PermissionDecision): boolean { return false }
  cancelFor(pluginId: string): void {
    for (const request of this.queue.filter(item => item.pluginId === pluginId)) this.settle(request, false)
    this.queue = this.queue.filter(item => item.pluginId !== pluginId)
    if (this.active?.pluginId === pluginId) { this.settle(this.active, false); this.active.controller.abort() }
  }
}
export const permissionService = new PermissionService()
export function normalizeGrant(value: unknown): PluginPermissionGrant { return value === 'allow' || value === 'deny' ? value : 'ask' }
