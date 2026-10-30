import type { OrbRailState } from '@shared/types/ipc'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { listRailEntries } from './ContributionRegistry'

type RailEntry = NonNullable<OrbRailState['contribEntries']>[number]
interface RailTarget {
  entry: RailEntry
  openCode?: string
  buildRevision: string
}

function readTargets(): RailTarget[] {
  return listRailEntries().flatMap(row => {
    const plugin = pluginRegistry.get(row.source)
    if (!plugin?.installed || !pluginRegistry.isEnabled(row.source)) return []
    const declared = pluginRegistry.getManifest(row.source)?.contributes?.railEntries
      ?.filter(entry => entry.id === row.id).at(-1)
    if (!declared || declared.openCode !== row.data?.openCode) return []
    // Encode the whole tuple: delimiters in a local id cannot collide with another source.
    const id = `rail:${Buffer.from(JSON.stringify([row.source, row.id]), 'utf8').toString('base64url')}`
    if (id.length > 8192) return []
    return [{
      entry: {
        id, pluginId: row.source,
        glyph: String(row.data?.glyph ?? '\u00b7').slice(0, 2),
        color: row.data?.color || '#5b8cff',
        title: row.data?.title || row.id
      },
      openCode: typeof declared.openCode === 'string' ? declared.openCode : undefined,
      buildRevision: pluginRegistry.getBuildRevision(row.source)
    }]
  })
}

export function readRailContributionEntries(): RailEntry[] {
  return readTargets().map(target => target.entry)
}

/** Both trusted default chrome and isolated themes resolve only host-issued entry ids. */
export async function activateRailContribution(id: unknown, surfaceCurrent: () => boolean): Promise<void> {
  if (typeof id !== 'string' || !id || id.length > 8192) throw new Error('Invalid rail contribution')
  const target = readTargets().find(target => target.entry.id === id)
  if (!target) throw new Error('Unknown or retired rail contribution')
  const source = target.entry.pluginId
  const runtime = getRuntimeScope(source)
  const installedRevision = pluginRegistry.getInstalledRevision()
  const current = (): boolean => {
    if (!surfaceCurrent() || pluginRegistry.getInstalledRevision() !== installedRevision
      || runtime && (!runtime.isCurrent() || runtime.isClosing || getRuntimeScope(source) !== runtime)) return false
    const latest = readTargets().find(row => row.entry.id === id)
    return !!latest && latest.entry.pluginId === source && latest.buildRevision === target.buildRevision
      && latest.openCode === target.openCode
  }
  if (!current()) throw new Error('Rail contribution action retired')
  const { pluginHost } = await import('@main/plugin/PluginHost')
  if (!current()) throw new Error('Rail contribution action retired')
  await pluginHost.openPlugin(source, target.openCode ? { code: target.openCode } : undefined,
    { guard: current, trustedUserNavigation: true })
}
