import { getRuntimeScope, type PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { isBuiltinCapability } from '@shared/pluginPermissionPolicy'
/**
 * PluginPermissions — 插件权限校验
 * 职责：放行内置基础能力，检查敏感能力的 manifest 声明，断言调用是否被授权。
 * 被 pluginHandlers 在分发前调用。
 * 关键依赖：@shared/types/plugin 的 PluginManifest / PluginPermission。
 */
import type { PluginManifest, PluginPermission } from '@shared/types/plugin'

/** 基础能力无需声明；敏感能力必须出现在 manifest 白名单内。 */
export function hasPermission(manifest: PluginManifest, perm: PluginPermission): boolean {
  return isBuiltinCapability(perm) || (manifest.permissions?.includes(perm) ?? false)
}

/** 权限不足时抛出 Error，由 pluginHandlers 捕获后返回给插件 */
export function assertPermission(manifest: PluginManifest, perm: PluginPermission): void {
  if (!hasPermission(manifest, perm)) {
    throw new Error(`permission denied: ${perm}`)
  }
}

/** Secondary capabilities (credentials, local I/O) are checked by the owning host service too. */
export async function authorizePluginPermission(pluginId: string, permission: PluginPermission, summary: string): Promise<void> {
  const scope = getRuntimeScope(pluginId)
  const [{ pluginRegistry }, { permissionService }] = await Promise.all([
    import('@main/plugin/PluginRegistry'), import('@main/plugin/PermissionService')
  ])
  const manifest = pluginRegistry.getManifest(pluginId)
  if (!manifest || !scope?.isCurrent() || scope.isClosing) throw new Error('plugin runtime unavailable')
  assertPermission(manifest, permission)
  if (!(await permissionService.request(pluginId, permission, summary))) throw new Error(`permission denied: ${permission}`)
  if (!scope.isCurrent() || scope.isClosing) throw new Error('plugin runtime is closing or stale')
}

const confirmationPending = new WeakSet<PluginRuntimeScope>()
/** Destructive operations require a fresh host confirmation, never a renderer supplied boolean. */
export async function confirmPluginOperation(pluginId: string, message: string, detail: string): Promise<void> {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing) throw new Error('plugin runtime unavailable')
  if (confirmationPending.has(scope)) throw new Error('another operation is awaiting native confirmation')
  confirmationPending.add(scope)
  let releaseInteraction = (): void => {}
  try {
    const [{ dialog }, { pluginHost }, { acquireQuickInteraction }] = await Promise.all([
      import('electron'), import('@main/plugin/PluginHost'), import('@main/window/createQuickWindow')
    ])
    const win = pluginHost.getContainerWindow(pluginId)
    if (!scope.isCurrent() || scope.isClosing || !win || win.isDestroyed()) throw new Error('plugin runtime unavailable')
    releaseInteraction = acquireQuickInteraction()
    const result = await dialog.showMessageBox(win, { type: 'warning', message, detail: `插件：${pluginId}\n${detail.slice(0, 1000)}`, buttons: ['取消', '确认操作'], defaultId: 0, cancelId: 0, signal: scope.signal })
    if (result.response !== 1 || !scope.isCurrent() || scope.isClosing) throw new Error('operation cancelled')
  } finally { releaseInteraction(); confirmationPending.delete(scope) }
}
