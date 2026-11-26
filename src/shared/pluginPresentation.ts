import { resolvePluginViews, type PluginLaunchMode, type PluginLaunchTarget, type PluginViewsConfig } from '@shared/types/plugin'

/** Layout fallback is independent of the native container that will own the View. */
export function resolvePluginLayoutMode(
  views: Partial<PluginViewsConfig> | null | undefined,
  requested: PluginLaunchMode
): PluginLaunchMode {
  const resolved = resolvePluginViews(views)
  return resolved.layouts.includes(requested) ? requested : resolved.default
}

export function resolvePluginLaunchPresentation(
  views: Partial<PluginViewsConfig> | null | undefined,
  requested: PluginLaunchTarget
): { target: PluginLaunchTarget; layoutMode: PluginLaunchMode } {
  const layoutMode = resolvePluginLayoutMode(views, requested)
  return { target: layoutMode, layoutMode }
}
