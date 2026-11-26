const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function rect(value: Record<string, unknown>) {
  const { x, y, width, height } = value
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
    || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

export function legacyCanvasExport(source: unknown[]) {
  return { version: 1, panels: source.slice(0, 8).flatMap(value => {
    const panel = record(value), bounds = record(panel.bounds), frame = rect(bounds)
    if (!frame || !Array.isArray(panel.widgets)) return []
    return [{ id: typeof panel.id === 'string' ? panel.id.slice(0, 100) : '',
      bounds: { ...frame, displayId: Number.isSafeInteger(bounds.displayId) ? bounds.displayId : -1 },
      widgets: panel.widgets.slice(0, 24).flatMap(value => {
        const widget = record(value), geometry = rect(widget)
        if (!geometry || typeof widget.pluginId !== 'string' || !/^[\w.-]{1,200}$/.test(widget.pluginId)) return []
        return [{ ...geometry, pluginId: widget.pluginId, z: Number.isSafeInteger(widget.z) ? widget.z : 0 }]
      }) }]
  }) }
}
