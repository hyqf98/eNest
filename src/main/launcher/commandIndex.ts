/** Native launch directory and provider transport. Search policy belongs to the selected theme. */
import type { QuickCommand, QuickCommandKind, QuickContentMatch, QuickContentType, QuickOpenRequest, QuickSearchPhase } from '@shared/types/quick'
import type { PluginManifest } from '@shared/types/plugin'
import { pluginProtocolUrl } from '@shared/constants'
import { parsePluginCommandPattern } from '@shared/pluginCommands'
import { resolvePluginFeatureInput } from '@shared/pluginTextInput'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { getPluginLaunchAliases, getPluginLaunchAliasRevision } from '@main/hotkey/pluginLaunchHotkeys'
import { searchAll } from '@main/plugin/pluginBackgroundRuntime'
import { quickProviderStates } from '@main/theme/quickStateService'
import { getCachedApps, scanApplications } from './appScanner'
import { getAppIconDataUrl } from './appLauncher'
import { queryQuickProviders, type QuickProviderItem } from './quickProviders'
import { randomUUID } from 'node:crypto'
import { getLaunchIndexRevision, initializeLaunchIndex, launchIndexEntries, onLaunchIndexChanged, resolveLaunchIndexEntry } from './launchIndex'
import { getCatalogPluginIcon } from './catalogIcons'

const DIRECTORY_LIMIT = 65_536
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
        subtitle: manifest.description || '', pluginId, icon, aliases: [...userAliases, manifest.name, manifest.id], type: 'text', buildRevision: pluginRegistry.getBuildRevision(pluginId) })
      continue
    }
    const primary = features.find(feature => feature.cmds?.some(command => typeof command === 'string' && command.trim())) ?? features[0]
    for (const feature of features) {
      if (!feature.cmds?.length && feature.activation) continue
      const names = (feature.cmds ?? []).filter((command): command is string => typeof command === 'string' && Boolean(command.trim()))
      const base: QuickCommand = {
        kind: 'plugin', id: `plugin:${pluginId}:${feature.code}`, title: names[0] || manifest.name,
        subtitle: feature.explain ? `${manifest.name} · ${feature.explain}` : manifest.name,
        pluginId, code: feature.code, icon, type: 'text', buildRevision: pluginRegistry.getBuildRevision(pluginId),
        aliases: [...names, ...(feature === primary ? [...userAliases, manifest.name, manifest.id] : [])],
        textInput: resolvePluginFeatureInput(feature)
      }
      items.push(base)
      for (const [index, command] of (feature.cmds ?? []).entries()) {
        if (typeof command !== 'object' || command === null) continue
        const content = contentDeclaration(command as ContentDeclaration)
        if (content) items.push({ ...base, id: `${base.id}:content:${index}`, title: command.label,
          aliases: [], type: content.type, content,
          textInput: content.type === 'regex' || content.type === 'over' ? { type: 'text', trigger: 'none' } : undefined })
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

let directoryCache: { plugins: QuickCommand[]; apps: QuickCommand[]; indexRevision: number; items: QuickCommand[] } | null = null
let directoryRevision = 0

function nativeDirectory(): QuickCommand[] {
  const plugins = buildPluginCommands(), apps = buildAppCommands()
  const indexRevision = getLaunchIndexRevision()
  if (directoryCache?.plugins === plugins && directoryCache.apps === apps && directoryCache.indexRevision === indexRevision) return directoryCache.items
  // Command arrays change with registry/alias revisions or the application scan.
  // The identity store (and its secret) has the same process lifetime as this cache.
  const indexed: QuickCommand[] = launchIndexEntries().map(({ pluginId, buildRevision, indexRevision, entry }) => ({
    kind: 'plugin', id: `entry:${pluginId}:${entry.id}`, pluginId, entryId: entry.id, code: entry.code,
    title: entry.title, subtitle: entry.subtitle ?? '', aliases: entry.aliases, payload: entry.payload,
    icon: pluginProtocolUrl(pluginId, pluginRegistry.getManifest(pluginId)!.icon), type: 'text', buildRevision, indexRevision
  }))
  const directory = [...NATIVE_ACTIONS, ...plugins, ...apps, ...indexed]
  if (directory.length > DIRECTORY_LIMIT) throw new Error('Launch directory exceeds the host resource budget')
  const items = withStateKeys(directory)
  directoryCache = { plugins, apps, indexRevision, items }
  directoryRevision++
  return items
}

/** Identity encoding does not grant launch authority or interpret provider-private state. */
function launchIdentity(item: QuickCommand | QuickOpenRequest): string {
  if (item.kind === 'app') return `app:${item.path}`
  if (item.kind === 'plugin') return item.entryId ? JSON.stringify(['plugin-entry', item.pluginId, item.code ?? '', item.entryId]) : `plugin:${item.pluginId}:${item.code ?? ''}`
  if (item.kind === 'action') return `action:${item.action}`
  return ''
}

function withStateKeys(items: QuickCommand[]): QuickCommand[] {
  const keys: string[] = []
  for (let start = 0; start < items.length; start += 8192) keys.push(...quickProviderStates.encodeIdentities(items.slice(start, start + 8192).map(launchIdentity)))
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
      let payload: unknown
      if (item.payload !== undefined) {
        try {
          const encoded = JSON.stringify(item.payload)
          if (encoded === undefined || Buffer.byteLength(encoded) > 4096) continue
          payload = JSON.parse(encoded)
        } catch { continue }
      }
      const id = `provider:${result.pluginId}:${result.providerId}:${String(item.id ?? title).slice(0, 256)}`
      if (seen.has(id)) continue
      seen.add(id)
      items.push({ kind: 'plugin', id, title, subtitle: String(item.subtitle ?? item.explain ?? '').slice(0, 512),
        pluginId: result.pluginId, code: typeof item.code === 'string' ? item.code.slice(0, 256) : undefined,
        payload, aliases: [title], buildRevision: pluginRegistry.getBuildRevision(result.pluginId), icon: manifest ? pluginProtocolUrl(result.pluginId, manifest.icon) : undefined,
        group: 'provider', type: 'text' })
    }
  }
  return items
}

const providerSearches = new Map<string, AbortController>()
const providerTokens = new Map<string, { sessionId: string; command: QuickCommand; expiresAt: number }>()
export interface QuickProviderSearchContext { sessionId: string; signal?: AbortSignal }
export function cancelQuickProviderSession(sessionId: string): void {
  providerSearches.get(sessionId)?.abort()
  providerSearches.delete(sessionId)
  for (const [token, value] of providerTokens) if (value.sessionId === sessionId) providerTokens.delete(token)
}
function signedProviderCommands(commands: QuickCommand[], sessionId: string): QuickCommand[] {
  const now = Date.now()
  for (const [token, value] of providerTokens) if (value.expiresAt <= now) providerTokens.delete(token)
  return commands.map(command => {
    while (providerTokens.size >= 2048) providerTokens.delete(providerTokens.keys().next().value!)
    const providerToken = randomUUID(), signed = { ...command, providerToken }
    providerTokens.set(providerToken, { sessionId, command: signed, expiresAt: now + 120_000 })
    return signed
  })
}

export async function getLaunchDirectorySnapshot(): Promise<{ revision: string; items: QuickCommand[] }> {
  initializeLaunchIndex()
  if (!getCachedApps()) await scanApplications(false)
  const items = nativeDirectory()
  return { revision: String(directoryRevision), items }
}
export function onLaunchDirectoryChanged(listener: () => void): () => void {
  const index = onLaunchIndexChanged(listener), registry = pluginRegistry.onInstalledChanged(listener)
  return () => { index(); registry() }
}

/** Resolve a trusted surface's current handle again; caller-supplied private payloads have no authority. */
export function resolveQuickOpenCommand(request: QuickOpenRequest, sessionId = 'legacy-quick'): QuickCommand | null {
  if (request.kind !== 'plugin' || !pluginRegistry.isEnabled(request.pluginId)) return null
  if (request.providerToken) {
    const value = providerTokens.get(request.providerToken)
    return value && value.sessionId === sessionId && value.expiresAt > Date.now() && value.command.pluginId === request.pluginId
      && value.command.buildRevision === pluginRegistry.getBuildRevision(request.pluginId) ? value.command : null
  }
  if (request.entryId) {
    const entry = resolveLaunchIndexEntry(request.pluginId, request.entryId, request.buildRevision, request.indexRevision)
    return entry ? { kind: 'plugin', id: `entry:${request.pluginId}:${entry.id}`, pluginId: request.pluginId, entryId: entry.id,
      code: entry.code, title: entry.title, subtitle: entry.subtitle ?? '', aliases: entry.aliases, payload: entry.payload,
      type: 'text', buildRevision: request.buildRevision, indexRevision: request.indexRevision } : null
  }
  if (request.buildRevision && request.buildRevision !== pluginRegistry.getBuildRevision(request.pluginId)) return null
  const command = buildPluginCommands().find(item => item.pluginId === request.pluginId && item.code === request.code && (!request.type || item.type === request.type))
  return command ? { ...command, ...(request.query ? { payload: request.query.slice(0, 4096) } : {}) } : null
}

/** Compatibility name for existing bridges. No query matching, ranking or recommendations run in main. */
export async function searchQuickCommands(
  query: string, limit = 20, kind?: QuickCommandKind, phase?: QuickSearchPhase, ids?: string[], context?: QuickProviderSearchContext
): Promise<QuickCommand[]> {
  if (phase === 'providers') {
    const sessionId = context?.sessionId ?? 'legacy-quick'
    if (!sessionId || sessionId.length > 256) return []
    cancelQuickProviderSession(sessionId)
    const text = String(query ?? '').slice(0, 4_096)
    if (!text.trim() || kind && kind !== 'plugin') return []
    const controller = new AbortController()
    providerSearches.set(sessionId, controller)
    const abort = () => controller.abort()
    context?.signal?.addEventListener('abort', abort, { once: true })
    if (context?.signal?.aborted) abort()
    try {
      const work = Promise.allSettled([queryQuickProviders(text, controller.signal), searchAll(text, 20, controller.signal)])
      let onAbort = () => {}
      const cancelled = new Promise<null>(resolve => {
        onAbort = () => resolve(null)
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      const settled = await Promise.race([work, cancelled]).finally(() => controller.signal.removeEventListener('abort', onAbort))
      if (!settled || controller.signal.aborted) return []
      const live = settled[0].status === 'fulfilled' ? settled[0].value : []
      const background = settled[1].status === 'fulfilled' ? settled[1].value.map(result => ({ ...result, providerId: 'background' })) : []
      const cap = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20
      return withStateKeys(signedProviderCommands(providerCommands([...live, ...background]).slice(0, cap), sessionId))
    } finally {
      context?.signal?.removeEventListener('abort', abort)
      if (providerSearches.get(sessionId) === controller) providerSearches.delete(sessionId)
    }
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
    return items
  }
  return directory
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
