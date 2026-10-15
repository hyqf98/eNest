import type { DetachedWindowSession, PluginWindowGeometry } from '@shared/types/plugin'

/** Settings are untrusted and may come from older versions or a removed display. */
export function normalizeWindowGeometry(value: unknown): PluginWindowGeometry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const state = value as Partial<PluginWindowGeometry>, bounds = state.bounds
  if (!bounds || typeof bounds !== 'object') return undefined
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]) || Math.abs(bounds[key]) > 100000) return undefined
  }
  if (bounds.width < 1 || bounds.height < 1 || bounds.width > 20000 || bounds.height > 20000) return undefined
  return {
    bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) },
    maximized: state.maximized === true, minimized: state.minimized === true, alwaysOnTop: state.alwaysOnTop === true
  }
}

export function normalizeDetachedWindowSession(value: unknown): DetachedWindowSession | undefined {
  const geometry = normalizeWindowGeometry(value)
  const mode = (value as Partial<DetachedWindowSession> | null)?.mode
  return geometry && (mode === 'shell' || mode === 'quick') ? { ...geometry, mode } : undefined
}
