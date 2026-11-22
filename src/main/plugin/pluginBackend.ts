import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDevCommandPlan } from '@main/dev/devCommandResolver'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { permissionService } from '@main/plugin/PermissionService'
import type { PluginSummary } from '@shared/types/plugin'
import { resolveBackendFile } from './pluginBackendPath'

const DEFAULT_BUILD_COMMAND = 'npm run build'

/** Missing output is a build-state problem, not a filesystem error; name the exact command. */
function missingBackendEntry(summary: PluginSummary, entry: string, outputPath: string): Error {
  if (!summary.sourcePath) {
    return new Error(`插件「${summary.name}」缺少本机后端入口 ${entry}（${outputPath}）；请重新安装插件后再试`)
  }
  const build = resolveDevCommandPlan(summary.sourcePath, pluginRegistry.getManifest(summary.id) ?? undefined).build?.label ?? DEFAULT_BUILD_COMMAND
  return new Error(`插件「${summary.name}」的本机后端尚未构建：缺少 ${entry}（产物目录 ${outputPath}）。请在 ${summary.sourcePath} 运行 ${build}，然后重载插件（Ctrl+R）。`)
}

/** Only the live caller's installed package may supply its native entry. No host driver fallback. */
export function resolvePluginBackendPackage(pluginId: string): { entry: string; root: string } {
  const scope = getRuntimeScope(pluginId)
  if (!scope?.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime is closing or stale')
  const manifest = pluginRegistry.getManifest(pluginId), summary = pluginRegistry.get(pluginId), root = pluginRegistry.getRootPath(pluginId)
  if (!manifest?.backend || !summary || !root) throw new Error('插件缺少本机后端，请更新或重新构建插件')
  if (!manifest.permissions?.includes('backend.node') || !permissionService.isGranted(pluginId, 'backend.node')) throw new Error('permission denied: backend.node')
  // Dev source runs compiled output; an installed or built-preview plugin is already rooted at its package.
  const runtimeRoot = summary.devSource === true
    ? summary.devOutputPath ?? join(summary.sourcePath ?? root, 'dist')
    : root
  const entry = manifest.backend.entry
  if (!existsSync(join(runtimeRoot, entry))) throw missingBackendEntry(summary, entry, runtimeRoot)
  return { entry: resolveBackendFile(runtimeRoot, entry), root: runtimeRoot }
}
