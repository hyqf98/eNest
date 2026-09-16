/**
 * PluginPermissions — 插件权限校验
 * 职责：检查插件 manifest 中声明的权限白名单，断言调用是否被授权。
 * 被 pluginHandlers 在分发前调用。
 * 关键依赖：@shared/types/plugin 的 PluginManifest / PluginPermission。
 */
import type { PluginManifest, PluginPermission } from '@shared/types/plugin'

/** 检查 manifest 是否声明了指定权限 */
export function hasPermission(manifest: PluginManifest, perm: PluginPermission): boolean {
  return manifest.permissions?.includes(perm) ?? false
}

/** 权限不足时抛出 Error，由 pluginHandlers 捕获后返回给插件 */
export function assertPermission(manifest: PluginManifest, perm: PluginPermission): void {
  if (!hasPermission(manifest, perm)) {
    throw new Error(`permission denied: ${perm}`)
  }
}
