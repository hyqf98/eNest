/** Native launch directory and provider transport. Search policy belongs to the selected theme. */
import type { QuickCommand, QuickCommandKind, QuickContentMatch, QuickContentType, QuickOpenRequest, QuickSearchPhase } from '@shared/types/quick'
import type { PluginManifest } from '@shared/types/plugin'
import { pluginProtocolUrl } from '@shared/constants'
import { parsePluginCommandPattern } from '@shared/pluginCommands'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getPluginLaunchAliases, getPluginLaunchAliasRevision } from '@main/hotkey/pluginLaunchHotkeys'
import { searchAll } from '@main/plugin/pluginBackgroundRuntime'
import { quickProviderStates } from '@main/theme/quickStateService'
import { getCachedApps, scanApplications } from './appScanner'
import { getAppIconDataUrl } from './appLauncher'
import { queryQuickProviders, type QuickProviderItem } from './quickProviders'
import { getCatalogPluginIcon } from './catalogIcons'

const DIRECTORY_LIMIT = 8_192
const ACTION_IDS = ['open-market', 'open-settings', 'refresh-apps'] as const
const NATIVE_ACTIONS: QuickCommand[] = ACTION_IDS.map(action => ({
  kind: 'action', id: `action:${action}`, action, title: action, subtitle: '', aliases: [], type: 'text'
}))

interface ContentDeclaration {
  type: 'regex' | 'over' | 'img' | 'files'
  label: string
  match?: string
  regex?: string
  exclude?: string
  minLength?: number
  maxLength?: number
  extensions?: string[]
  allowDirectory?: boolean
  minCount?: number
  maxCount?: number
}

/** Manifest validation is a host boundary; expressions are never executed here. */
function contentDeclaration(value: ContentDeclaration): QuickContentMatch | null {
  if (!value || !['regex', 'over', 'img', 'files'].includes(value.type) || !value.label?.trim()) return null
  if (value.extensions !== undefined && (value.extensions.length > 16 ||
      value.extensions.some(extension => typeof extension !== 'string' || !/^[a-z0-9]{1,10}$/.test(extension)))) return null
  if (value.type === 'img' || value.type === 'files') {
    const minCount = value.minCount ?? 1
    const maxCount = value.maxCount ?? 20
    if (!Number.isSafeInteger(minCount) || minCount < 1 || minCount > 20) return null
    if (!Number.isSafeInteger(maxCount) || maxCount < minCount || maxCount > 20) return null
    return {
      type: value.type, minLength: 0,
      ...(value.extensions?.length ? { extensions: [...value.extensions] } : {}),
      ...(value.type === 'files' ? { allowDirectory: value.allowDirectory === true, minCount, maxCount } : {})
    }
  }
  const expression = value.type === 'regex' ? value.match ?? value.regex : value.exclude
  const parsed = expression === undefined ? null : parsePluginCommandPattern(expression)
  if ((value.type === 'regex' && !parsed) || (expression !== undefined && !parsed)) return null
  return {
    type: value.type, source: parsed?.source, flags: parsed?.flags,
    minLength: value.minLength ?? 1,
    maxLength: value.type === 'over' ? value.maxLength ?? 10_000 : undefined
  }
}

function installedManifests(): PluginManifest[] {
  return pluginRegistry.getInstalledDescriptors().filter(entry => entry.enabled).map(entry => entry.manifest)
}

let commandCache: { registry: number; aliases: number; items: QuickCommand[] } | null = null
let commandCacheHits = 0
let commandCacheMisses = 0
let commandCacheBuilds = 0

export function getCommandCacheMetrics() {
  return {
    hits: commandCacheHits, misses: commandCacheMisses, builds: commandCacheBuilds,
    entries: commandCache?.items.length ?? 0, snapshots: commandCache ? 1 : 0, snapshotCapacity: 1,
    registryRevision: commandCache?.registry ?? null, aliasRevision: commandCache?.aliases ?? null
  }
}

export function buildPluginCommands(): QuickCommand[] {
  const registry = pluginRegistry.getInstalledRevision(), aliases = getPluginLaunchAliasRevision()
  if (commandCache?.registry === registry && commandCache.aliases === aliases) { commandCacheHits++; return commandCache.items }
  commandCacheMisses++
  const items: QuickCommand[] = []
  for (const manifest of installedManifests()) {
    const pluginId = manifest.id, icon = pluginProtocolUrl(pluginId, manifest.icon)
    const features = manifest.features ?? [], userAliases = getPluginLaunchAliases(pluginId)
    if (!features.length) {
      items.push({ kind: 'plugin', id: `plugin:${pluginId}:`, title: manifest.name,
        subtitle: manifest.description || '', pluginId, icon, aliases: [...userAliases, manifest.name, manifest.id], type: 'text' })
      continue
    }
    const primary = features.find(feature => feature.cmds?.some(command => typeof command === 'string' && command.trim())) ?? features[0]
    for (const feature of features) {
      const names = (feature.cmds ?? []).filter((command): command is string => typeof command === 'string' && Boolean(command.trim()))
      const base: QuickCommand = {
        kind: 'plugin', id: `plugin:${pluginId}:${feature.code}`, title: names[0] || manifest.name,
        subtitle: feature.explain ? `${manifest.name} · ${feature.explain}` : manifest.name,
        pluginId, code: feature.code, icon, type: 'text',
        aliases: [...names, ...(feature === primary ? [...userAliases, manifest.name, manifest.id] : [])]
      }
      items.push(base)
      for (const [index, command] of (feature.cmds ?? []).entries()) {
        if (typeof command !== 'object' || command === null) continue
        const content = contentDeclaration(command as ContentDeclaration)
        if (content) items.push({ ...base, id: `${base.id}:content:${index}`, title: command.label,
          aliases: [], type: content.type, content })
      }
    }
  }
  commandCache = { registry, aliases, items }
  commandCacheBuilds++
  return items
}

let appCache: { source: ReturnType<typeof getCachedApps>; items: QuickCommand[] } | null = null
export function buildAppCommands(): QuickCommand[] {
  const source = getCachedApps()
  if (!source) return []
  if (appCache?.source === source) return appCache.items
  const items: QuickCommand[] = source.apps.map(app => ({
    kind: 'app', id: `app:${app.path}`, title: app.name, subtitle: '', path: app.path,
    icon: app.icon, iconName: app.iconName, aliases: [...new Set([app.name, app.alias].filter((name): name is string => Boolean(name)))], type: 'text'
  }))
  appCache = { source, items }
  return items
}

function nativeDirectory(): QuickCommand[] {
  return [...NATIVE_ACTIONS, ...buildPluginCommands(), ...buildAppCommands()].slice(0, DIRECTORY_LIMIT)
}

/** Identity encoding does not grant launch authority or interpret provider-private state. */
function launchIdentity(item: QuickCommand | QuickOpenRequest): string {
  if (item.kind === 'app') return `app:${item.path}`
  if (item.kind === 'plugin') return `plugin:${item.pluginId}:${item.code ?? ''}`
  if (item.kind === 'action') return `action:${item.action}`
  return ''
}

function withStateKeys(items: QuickCommand[]): QuickCommand[] {
  const keys = quickProviderStates.encodeIdentities(items.map(launchIdentity))
  return items.map((item, index) => ({ ...item, stateKey: keys[index] }))
}

export function quickOpenedIdentity(request: QuickOpenRequest): string | null {
  const identity = launchIdentity(request)
  return identity ? quickProviderStates.encodeIdentities([identity])[0] : null
}

type ProviderResult = { pluginId: string; providerId: string; items: QuickProviderItem[] }
function providerCommands(results: ProviderResult[]): QuickCommand[] {
  const enabled = new Set(pluginRegistry.getInstalledDescriptors().filter(entry => entry.enabled).map(entry => entry.id))
  const items: QuickCommand[] = [], seen = new Set<string>()
  for (const result of results) {
    if (!enabled.has(result.pluginId)) continue
    const manifest = pluginRegistry.getManifest(result.pluginId)
    for (const item of result.items.slice(0, 100)) {
      const title = typeof item?.title === 'string' ? item.title.trim().slice(0, 256) : ''
      if (!title) continue
      const id = `provider:${result.pluginId}:${result.providerId}:${String(item.id ?? title).slice(0, 256)}`
      if (seen.has(id)) continue
      seen.add(id)
      items.push({ kind: 'plugin', id, title, subtitle: String(item.subtitle ?? item.explain ?? '').slice(0, 512),
        pluginId: result.pluginId, code: typeof item.code === 'string' ? item.code : undefined,
        payload: item.payload, aliases: [], icon: manifest ? pluginProtocolUrl(result.pluginId, manifest.icon) : undefined,
        group: 'provider', type: 'text' })
    }
  }
  return items
}

let providerSearch: AbortController | null = null

/** Compatibility name for existing bridges. No query matching, ranking or recommendations run in main. */
export async function searchQuickCommands(
  query: string, limit = 20, kind?: QuickCommandKind, phase?: QuickSearchPhase, ids?: string[]
): Promise<QuickCommand[]> {
  if (phase === 'providers') {
    providerSearch?.abort()
    const controller = new AbortController()
    providerSearch = controller
    const text = String(query ?? '').slice(0, 4_096)
    if (!text.trim() || kind && kind !== 'plugin') return []
    const settled = await Promise.allSettled([queryQuickProviders(text, controller.signal), searchAll(text, 20)])
    if (controller.signal.aborted) return []
    const live = settled[0].status === 'fulfilled' ? settled[0].value : []
    const background = settled[1].status === 'fulfilled' ? settled[1].value.map(result => ({ ...result, providerId: 'background' })) : []
    const cap = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20
    return withStateKeys(providerCommands([...live, ...background]).slice(0, cap))
  }
  if (!getCachedApps() && (!kind || kind === 'app')) await scanApplications(false)
  const directory = nativeDirectory().filter(item => !kind || item.kind === kind)
  if (phase === 'enriched') {
    const requested = new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.length <= 2_048).slice(0, 100))
    const items = directory.filter(item => requested.has(item.id)).map(item => ({ ...item }))
    // Native icon extraction is constrained to enumerated targets, never a renderer-supplied path.
    await Promise.all(items.map(async item => {
      if (item.kind === 'app' && item.path && !item.icon) item.icon = await getAppIconDataUrl(item.path, item.iconName)
      if (item.kind === 'plugin' && item.pluginId) item.icon = await getCatalogPluginIcon(item.pluginId)
    }))
    return withStateKeys(items)
  }
  return withStateKeys(directory)
}

/** Revalidate immediately before a native open, including after plugin disable/uninstall. */
export async function validateQuickOpenTarget(request: QuickOpenRequest): Promise<boolean> {
  if (!request || typeof request !== 'object') return false
  if (request.kind === 'app') {
    if (typeof request.path !== 'string' || !request.path || request.path.length > 4_096) return false
    if (!getCachedApps()) await scanApplications(false)
    return buildAppCommands().some(item => item.path === request.path)
  }
  if (request.kind === 'action') return ACTION_IDS.includes(request.action)
  if (!['plugin', 'plugin-escape', 'plugin-pin', 'plugin-tab'].includes(request.kind)) return false
  if (typeof request.pluginId !== 'string' || !pluginRegistry.isEnabled(request.pluginId) || !pluginRegistry.getManifest(request.pluginId)) return false
  return request.kind !== 'plugin' || request.code === undefined || typeof request.code === 'string' && request.code.length <= 256
}
