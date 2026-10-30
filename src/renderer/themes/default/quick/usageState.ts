import type { QuickProviderStateSnapshot } from '@shared/types/quickTheme'
import {
  defaultQuickLegacyIdentities,
  emptyDefaultQuickUsage,
  migrateDefaultQuickUsage,
  readDefaultQuickUsage,
  recordDefaultQuickOpened,
  type DefaultQuickOpened,
  type DefaultQuickUsage
} from './usagePolicy'

export type DefaultQuickStateSnapshot = QuickProviderStateSnapshot
export interface DefaultQuickStateClient {
  read(): Promise<DefaultQuickStateSnapshot>
  write(expectedRevision: number, value: unknown): Promise<DefaultQuickStateSnapshot>
  encodeIdentities(identities: string[]): Promise<string[]>
}

/** Serializes this provider's model updates without putting usage policy in the native controller. */
export function createDefaultQuickUsageSession(client: DefaultQuickStateClient, changed: (usage: DefaultQuickUsage) => void) {
  let disposed = false, pending = 0, published = false
  let current = { revision: 0, usage: emptyDefaultQuickUsage() }
  let loaded: Promise<void> | undefined
  let tail = Promise.resolve()
  const seen = new Set<number>()

  const publish = (snapshot: DefaultQuickStateSnapshot) => {
    if (published && snapshot.revision <= current.revision) return
    published = true
    current = { revision: snapshot.revision, usage: readDefaultQuickUsage(snapshot.value) }
    if (!disposed) changed(current.usage)
  }
  const read = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await client.read()
      if (disposed) return
      if (snapshot.revision !== 0 || snapshot.legacy === undefined) { publish(snapshot); return }
      const identities = defaultQuickLegacyIdentities(snapshot.legacy)
      const keys = identities.length ? await client.encodeIdentities(identities) : []
      if (disposed) return
      const usage = migrateDefaultQuickUsage(snapshot.legacy, new Map(identities.map((identity, index) => [identity, keys[index] ?? ''])))
      try { publish(await client.write(snapshot.revision, usage)); return }
      catch (error) { if (attempt === 2 || disposed) throw error }
    }
  }
  const initialize = () => loaded ??= read().catch(error => { loaded = undefined; throw error })

  return {
    initialize,
    refresh(): Promise<void> {
      const task = tail.catch(() => undefined).then(async () => { if (!disposed) { await initialize(); await read() } })
      tail = task
      return task
    },
    recordOpened(opened: DefaultQuickOpened): Promise<void> {
      if (disposed || !Number.isSafeInteger(opened.sequence) || opened.sequence <= 0 || seen.has(opened.sequence)) return Promise.resolve()
      if (pending >= 64) return Promise.reject(new Error('Default Quick usage update queue is full'))
      if (!opened.stateKey) return Promise.resolve()
      seen.add(opened.sequence)
      if (seen.size > 128) seen.delete(seen.values().next().value!)
      pending++
      const task = tail.catch(() => undefined).then(async () => {
        if (disposed) return
        await initialize()
        for (let attempt = 0; attempt < 3 && !disposed; attempt++) {
          const next = recordDefaultQuickOpened(current.usage, opened)
          if (next === current.usage) return
          try {
            const saved = await client.write(current.revision, next)
            if (!disposed) publish(saved)
            return
          } catch (error) {
            if (attempt === 2 || disposed) throw error
            await read()
          }
        }
      }).catch(error => { seen.delete(opened.sequence); throw error }).finally(() => { pending-- })
      tail = task
      return task
    },
    dispose() { disposed = true; seen.clear() }
  }
}
