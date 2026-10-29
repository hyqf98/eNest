import { resolvePluginViews, type PluginLaunchMode, type PluginLaunchTarget, type PluginViewsConfig } from '@shared/types/plugin'

/** A panel is opt-in; ordinary launch fallback must never make a workbench a widget. */
export function supportsPanelLayout(views: Partial<PluginViewsConfig> | null | undefined): boolean {
  return resolvePluginViews(views).layouts.includes('panel')
}

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
  // A widget-only plugin can run in a Tab; a launch never creates a user's panel.
  return { target: layoutMode === 'quick' ? 'quick' : 'shell', layoutMode }
}
