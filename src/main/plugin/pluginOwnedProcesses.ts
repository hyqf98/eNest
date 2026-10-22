import type { PluginProcessKind } from '@shared/types/pluginMemory'

export interface PluginOwnedProcess {
  pluginId: string
  generation?: number
  kind: Exclude<PluginProcessKind, 'renderer'>
  pid: number
}

interface Registration {
  pluginId: string
  generation?: number
  kind: PluginOwnedProcess['kind']
  getPid: () => number | undefined
  stop?: () => void | Promise<void>
}

const owned = new Set<Registration>()

/** Only host-created children may be attributed or stopped; discovered PIDs never grant ownership. */
export function registerPluginProcess(registration: Registration): () => void {
  owned.add(registration)
  return () => { owned.delete(registration) }
}

export function getPluginOwnedProcesses(): PluginOwnedProcess[] {
  return [...owned].flatMap(entry => {
    const pid = entry.getPid()
    return Number.isInteger(pid) && pid! > 0
      ? [{ pluginId: entry.pluginId, generation: entry.generation, kind: entry.kind, pid: pid! }]
      : []
  })
}

export async function stopPluginProcesses(pluginId: string, generation?: number): Promise<void> {
  const entries = [...owned].filter(entry => entry.pluginId === pluginId
    && (generation === undefined || entry.generation === generation))
  const results = await Promise.allSettled(entries.map(entry => {
    try { return Promise.resolve(entry.stop?.()) }
    catch (error) { return Promise.reject(error) }
  }))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new Error(failures.map(result => String(result.reason)).join('; '))
}
