import type { QuickCommand, QuickImageContext, QuickInputSelection, QuickOpenRequest } from '@shared/types/quick'
import type { QuickThemeAction, QuickThemeCatalogItem, QuickThemeItem } from '@shared/types/quickTheme'

export interface QuickCatalogRecord { id: string; command: QuickCommand; icon?: string }

export function updateQuickCatalog(commands: QuickCommand[], nonce: string, previous: QuickCatalogRecord[] = []): QuickCatalogRecord[] {
  const known = new Map(previous.map(record => [record.command.id, record]))
  const seen = new Set<string>()
  return commands.filter(command => { if (seen.has(command.id)) return false; seen.add(command.id); return true }).slice(0, 65_536).map(command => {
    const existing = known.get(command.id)
    return existing ? { ...existing, command } : { id: `${nonce}-${crypto.randomUUID()}`, command }
  })
}

/** A theme can project current descriptors, not mint an executable target or replay another query. */
export function projectQuickThemeResults(
  catalog: QuickThemeCatalogItem[], request: Extract<QuickThemeAction, { type: 'results' }>,
  expected: { catalogRevision: number; queryRevision: number }
): QuickThemeItem[] | null {
  if (request.queryRevision !== expected.queryRevision || request.catalogRevision !== expected.catalogRevision || request.items.length > 100) return null
  const byId = new Map(catalog.map(item => [item.id, item])), seen = new Set<string>(), items: QuickThemeItem[] = []
  for (const item of request.items) {
    const descriptor = byId.get(item.id)
    if (!descriptor || seen.has(item.id)) return null
    seen.add(item.id)
    items.push({ id: item.id, kind: descriptor.kind, title: publicText(item.title ?? descriptor.title, 256),
      subtitle: descriptor.subtitle, group: publicText(item.group ?? '', 64), icon: descriptor.icon, action: descriptor.action })
  }
  if (request.selectedId !== undefined && request.selectedId !== null && !seen.has(request.selectedId)) return null
  return items
}

const publicText = (value: string, cap: number) => value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, cap)
const projectedCatalog = new WeakMap<QuickCommand, { id: string; icon?: string; item: QuickThemeCatalogItem }>()
export function publicQuickCatalog(records: QuickCatalogRecord[]): QuickThemeCatalogItem[] {
  return records.map(({ id, command, icon }) => {
    const cached = projectedCatalog.get(command)
    if (cached?.id === id && cached.icon === icon) return cached.item
    const item: QuickThemeCatalogItem = {
      id, stateKey: command.stateKey ?? '', kind: command.kind, title: publicText(command.title, 256),
      subtitle: command.kind === 'app' ? '本机应用' : command.kind === 'plugin' ? '插件指令' : '系统操作',
      aliases: (command.aliases ?? [command.title]).filter(alias => !/^(?:\/|[a-z]:[\\/])/i.test(alias)).slice(0, 100).map(alias => publicText(alias, 256)),
      ...(command.action ? { action: command.action } : {}),
      ...(command.content ? { content: { ...command.content } } : {}),
      ...(command.textInput ? { textInput: { ...command.textInput } } : {}),
      ...(command.group === 'provider' ? { provider: true } : {}),
      ...(safeQuickIcon(icon) ? { icon } : {})
    }
    projectedCatalog.set(command, { id, icon, item })
    return item
  })
}

export function safeQuickIcon(value: string | undefined): boolean {
  return typeof value === 'string' && value.length <= 1_048_576 && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon);base64,[a-z0-9+/=]+$/i.test(value)
}

export function quickRequestFromRecord(record: QuickCatalogRecord, query: string, container?: 'quick' | 'shell'): QuickOpenRequest | null {
  const command = record.command
  if (command.kind === 'app' && command.path) return { kind: 'app', path: command.path, query }
  if (command.kind === 'action' && command.action) return { kind: 'action', action: command.action, query }
  if (command.kind !== 'plugin' || !command.pluginId) return null
  return { kind: 'plugin', pluginId: command.pluginId, code: command.code, type: command.type,
    entryId: command.entryId, buildRevision: command.buildRevision, indexRevision: command.indexRevision, providerToken: command.providerToken,
    payload: command.content ? query : command.payload, query, ...(container ? { container } : {}) }
}

/**
 * Map the visible paste context to the launch selection for one command:
 * img/files content rows attach their own kind only; plain plugin rows (name/cmds/alias
 * hits) attach everything so "你好" + an image reaches the chosen plugin at once;
 * regex/over and provider rows keep the existing payload path and never attach bytes.
 */
export function buildQuickInputSelection(items: QuickImageContext[], command: Pick<QuickCommand, 'content' | 'group'>, query: string): QuickInputSelection | undefined {
  if (!items.length) return undefined
  const imageIds = items.filter(item => item.kind === 'image').map(item => item.id)
  const fileIds = items.filter(item => item.kind !== 'image').map(item => item.id)
  const type = command.content?.type
  if (type === 'img') return imageIds.length ? { imageIds } : undefined
  if (type === 'files') return fileIds.length ? { fileIds } : undefined
  if (type === 'regex' || type === 'over' || command.group === 'provider') return undefined
  const selection: QuickInputSelection = {}
  if (imageIds.length) selection.imageIds = imageIds
  if (fileIds.length) selection.fileIds = fileIds
  if (query.trim()) selection.text = query.slice(0, 4_096)
  return selection.imageIds || selection.fileIds || selection.text ? selection : undefined
}
