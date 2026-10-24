import { join } from 'node:path'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { permissionService } from '@main/plugin/PermissionService'
import { resolveBackendFile } from './pluginBackendPath'

/** Only the live caller's installed package may supply its native entry. No host driver fallback. */
export function resolvePluginBackendPackage(pluginId: string): { entry: string; root: string } {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime is closing or stale')
  const manifest = pluginRegistry.getManifest(pluginId), root = pluginRegistry.getRootPath(pluginId)
  if (!manifest?.backend || !root) throw new Error('插件缺少本机后端，请更新或重新构建插件')
  if (!manifest.permissions?.includes('backend.node') || !permissionService.isGranted(pluginId, 'backend.node')) throw new Error('permission denied: backend.node')
  const runtimeRoot = pluginRegistry.get(pluginId)?.devUrl ? join(root, 'dist') : root
  return { entry: resolveBackendFile(runtimeRoot, manifest.backend.entry), root: runtimeRoot }
}

export function resolvePluginBackendEntry(pluginId: string): string { return resolvePluginBackendPackage(pluginId).entry }
