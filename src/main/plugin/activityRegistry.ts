/** Host-owned activity leases. A renderer cannot keep itself alive by claiming work. */
type Activity = { key: string; reason: string; startedAt: number; owners: Set<symbol> }
const activities = new Map<string, Map<string, Activity>>()
const listeners = new Set<(pluginId: string) => void>()

export function acquirePluginActivity(pluginId: string, key: string, reason: string): () => void {
  const token = Symbol(key)
  const bag = activities.get(pluginId) ?? new Map<string, Activity>()
  const item = bag.get(key) ?? { key, reason, startedAt: Date.now(), owners: new Set<symbol>() }
  item.owners.add(token)
  bag.set(key, item)
  activities.set(pluginId, bag)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = activities.get(pluginId)
    const activity = current?.get(key)
    // A stale release must not release a replacement lease after close/reconnect.
    if (!activity?.owners.delete(token)) return
    if (activity.owners.size === 0) current!.delete(key)
    if (current!.size === 0) {
      activities.delete(pluginId)
      for (const listener of listeners) listener(pluginId)
    }
  }
}

export function hasPluginActivity(pluginId: string): boolean {
  return (activities.get(pluginId)?.size ?? 0) > 0
}

export function releasePluginActivities(pluginId: string): void {
  activities.delete(pluginId)
}

export function onPluginActivityIdle(listener: (pluginId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
