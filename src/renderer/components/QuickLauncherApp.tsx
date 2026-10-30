/** Native Quick controller. Providers own rendering, matching, ranking and result layout. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { QuickCommand, QuickCommandKind, QuickImageContext, QuickInputContextRequest, QuickOpenRequest, QuickPluginModeInfo } from '@shared/types/quick'
import type { QuickProviderStateRequest, QuickThemeAction, QuickThemeActionResult, QuickThemeConfig, QuickThemeItem, QuickThemeOpenedReceipt, QuickThemeSnapshot } from '@shared/types/quickTheme'
import { QUICK_BAR_AREA_H, QUICK_CORNER_RADIUS } from '@shared/constants'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { shellApi } from '@renderer/services/shellApi'
import { bindPluginDragSource, bindPluginDropTarget } from '@renderer/services/pluginWindowDrag'
import type { DefaultQuickSurfaceHandle } from '@renderer/themes/default/quick/DefaultQuickSurface'
import type { DefaultQuickStateClient } from '@renderer/themes/default/quick/usageState'
import { QuickThemeSurface, type QuickThemeSurfaceHandle } from './QuickThemeSurface'
import { QuickPluginInputSession, type QuickPluginInputUpdate } from './quickPluginInputSession'
import { buildQuickInputSelection, projectQuickThemeResults, publicQuickCatalog, quickRequestFromRecord, safeQuickIcon, updateQuickCatalog, type QuickCatalogRecord } from './quickCatalog'
import '@renderer/styles/plugin-window-drag.css'
import './quickHost.css'

const DefaultQuickSurface = lazy(() => import('@renderer/themes/default/quick/DefaultQuickSurface').then(module => ({ default: module.DefaultQuickSurface })))
type ThemeKey = Extract<QuickThemeAction, { type: 'key' }>
interface DirectoryState { revision: number; records: QuickCatalogRecord[] }
const catalogIconCache = new Map<string, string>()
const iconKey = (record: QuickCatalogRecord) => record.command.icon ?? record.command.id
const providerState = (request: QuickProviderStateRequest) => {
  if (!shellApi.quickProviderState) return Promise.reject(new Error('Native Quick private state is unavailable'))
  return shellApi.quickProviderState(request)
}
const cachedRecords = (records: QuickCatalogRecord[]) => records.map(record => ({ ...record,
  icon: record.icon ?? (safeQuickIcon(record.command.icon) ? record.command.icon : catalogIconCache.get(iconKey(record))) }))
const sameItems = (left: QuickThemeItem[], right: QuickThemeItem[]) => left.length === right.length && left.every((item, index) => {
  const next = right[index]
  return item.id === next.id && item.title === next.title && item.subtitle === next.subtitle && item.kind === next.kind
    && item.group === next.group && item.icon === next.icon && item.action === next.action
})

export function QuickLauncherApp() {
  const appearance = useAppearanceStore(state => state.appearance)
  const [themeConfig, setThemeConfig] = useState<QuickThemeConfig | null>(null)
  const [themeReady, setThemeReady] = useState(false)
  const themeReadyRef = useRef(false)
  const [customSearch, setCustomSearch] = useState(false)
  const customSearchRef = useRef(false)
  const remoteView = useRef<QuickThemeSurfaceHandle>(null)
  const defaultView = useRef<DefaultQuickSurfaceHandle>(null)
  const [providerOpened, setProviderOpened] = useState<{ owner: string; receipt: QuickThemeOpenedReceipt } | null>(null)
  const openedSequence = useRef(0)
  const themeKey = useRef(themeConfig?.key)
  const root = useRef<HTMLDivElement>(null)
  const nativeBar = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<QuickCommandKind | null>(null)
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const [directory, setDirectory] = useState<DirectoryState>({ revision: 0, records: [] })
  const [items, setItems] = useState<QuickThemeItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [hiddenCount, setHiddenCount] = useState(0)
  const [emptyMarket, setEmptyMarket] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [providersLoading, setProvidersLoading] = useState(false)
  const loading = catalogLoading || providersLoading
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [shown, setShown] = useState(0)
  const [visible, setVisible] = useState(() => !document.hidden)
  const [pluginMode, setPluginMode] = useState<QuickPluginModeInfo | null>(null)
  const modeRef = useRef(pluginMode)
  const [inputSession] = useState(() => new QuickPluginInputSession())
  const [pluginInput, setPluginInput] = useState(() => inputSession.snapshot)
  const [inputContext, setInputContext] = useState<QuickImageContext[]>([])
  const contextRef = useRef(inputContext)
  contextRef.current = inputContext
  const contextEpoch = useRef(0)
  const contextReadRevision = useRef(0)
  const queryRevision = useRef(0)
  const searchSequence = useRef(0)
  const catalogFetchRevision = useRef(0)
  const nativeCatalog = useRef<{ commands: QuickCommand[]; signature: string } | null>(null)
  const catalogFlight = useRef<{ refresh: number; promise: Promise<QuickCommand[]> } | null>(null)
  const catalogNonce = useRef('')
  const iconRequests = useRef(new Set<string>())
  const iconController = useRef<AbortController | null>(null)
  const openingRef = useRef(false)
  const escaping = useRef<Promise<boolean> | null>(null)
  const snapshotRevision = useRef(0)
  const [bounds, setBounds] = useState({ width: innerWidth, height: innerHeight, inputHeight: QUICK_BAR_AREA_H })
  const current = useRef({ directory, items, selectedId })
  current.current = { directory, items, selectedId }
  const defaultPrivateState = useMemo<DefaultQuickStateClient>(() => ({
    read: async () => {
      const result = await providerState({ providerKey: null, operation: 'read' })
      if ('keys' in result) throw new Error('Invalid Quick state response')
      return result
    },
    write: async (expectedRevision, value) => {
      const result = await providerState({ providerKey: null, operation: 'write', expectedRevision, value })
      if ('keys' in result) throw new Error('Invalid Quick state response')
      return result
    },
    encodeIdentities: async identities => {
      const result = await providerState({ providerKey: null, operation: 'keys', identities })
      if (!('keys' in result) || result.keys.length !== identities.length) throw new Error('Invalid Quick identity response')
      return result.keys
    }
  }), [])

  const focus = useCallback((selectAll = false) => {
    ;(themeReadyRef.current ? remoteView : defaultView).current?.focus(selectAll)
  }, [])

  const invalidate = useCallback(() => {
    queryRevision.current++
    searchSequence.current++
    void shellApi.quickSearch?.('', 0, undefined, 'cancel').catch(() => undefined)
    const previous = current.current.directory
    const records = previous.records.filter(record => record.command.group !== 'provider')
    const next = records.length === previous.records.length ? previous : { revision: previous.revision + 1, records }
    // Retire authority synchronously, before another queued theme action can run.
    current.current = { directory: next, items: [], selectedId: null }
    if (next !== previous) setDirectory(next)
    setItems([]); setSelectedId(null); setExpanded(false); setHiddenCount(0); setEmptyMarket(false)
    setCatalogLoading(!nativeCatalog.current); setProvidersLoading(false); setError(null)
  }, [])

  const refreshSources = useCallback((dropCatalog = false) => {
    catalogFetchRevision.current++
    catalogFlight.current = null
    catalogIconCache.clear()
    iconController.current?.abort()
    iconRequests.current.clear()
    if (dropCatalog) nativeCatalog.current = null
    invalidate(); setRefresh(value => value + 1)
  }, [invalidate])

  const applyThemeConfig = useCallback((config: QuickThemeConfig | null) => {
    if (themeKey.current !== config?.key) {
      themeKey.current = config?.key
      themeReadyRef.current = false; setThemeReady(false)
      customSearchRef.current = false; setCustomSearch(false)
      composingRef.current = false; setComposing(false)
      setProviderOpened(null)
      invalidate()
    }
    setThemeConfig(config)
  }, [invalidate])

  const applyContext = useCallback((items: QuickImageContext[] | undefined) => {
    const next = Array.isArray(items) ? items.slice(0, 12) : []
    contextRef.current = next
    setInputContext(next)
    // Media changes rerank the existing catalog; clearing it would leave an empty
    // directory until the query changes because no native search was requested.
    queryRevision.current++
    current.current = { ...current.current, items: [], selectedId: null }
    setItems([]); setSelectedId(null); setExpanded(false); setHiddenCount(0); setEmptyMarket(false)
    setError(null)
  }, [])
  const resetContext = useCallback(() => {
    contextEpoch.current++
    contextReadRevision.current++
    applyContext([])
  }, [applyContext])
  const refreshContext = useCallback(async (epoch = contextEpoch.current) => {
    const revision = ++contextReadRevision.current
    const result = await shellApi.quickInputContext?.({ operation: 'list' })
    if (epoch !== contextEpoch.current || revision !== contextReadRevision.current) return
    if (!result?.ok) throw new Error('Quick context unavailable')
    applyContext(result.items)
  }, [applyContext])
  const mutateContext = useCallback(async (request: QuickInputContextRequest): Promise<QuickThemeActionResult> => {
    const epoch = contextEpoch.current
    contextReadRevision.current++
    try {
      const result = await shellApi.quickInputContext?.(request)
      if (epoch !== contextEpoch.current) return { ok: false }
      if (!result?.ok) throw new Error('Quick context unavailable')
      // Mutation responses may arrive out of order. Read the current host snapshot
      // instead of restoring an older paste/clear response over newer thumbnails.
      await refreshContext(epoch)
      return { ok: true }
    } catch {
      const error = request.operation === 'read-clipboard' ? '无法读取剪贴板内容。' : '无法移除粘贴内容，请重试。'
      if (epoch === contextEpoch.current) setError(error)
      return { ok: false, error }
    }
  }, [refreshContext])

  useEffect(() => {
    const sync = () => {
      setVisible(!document.hidden)
      if (document.hidden) { invalidate(); resetContext() }
    }
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [invalidate, resetContext])

  useEffect(() => {
    let disposed = false
    void shellApi.quickGetTheme?.().then(config => {
      if (disposed) return
      applyThemeConfig(config)
    }).catch(() => { if (!disposed) applyThemeConfig(null) })
    return () => { disposed = true }
  }, [appearance.revision, refresh, shown, applyThemeConfig])

  useEffect(() => {
    const resize = () => setBounds({ width: innerWidth, height: innerHeight, inputHeight: QUICK_BAR_AREA_H })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    const container = root.current, bar = nativeBar.current
    if (!container || !bar) return
    const source = bindPluginDragSource(container, target => {
      const element = target.closest<HTMLElement>('[data-quick-native-drag]'), pluginId = modeRef.current?.pluginId
      return element && pluginId ? { element, pluginId } : null
    })
    // Geometry is host-owned, so a native plugin can also be dropped onto an isolated theme.
    const target = bindPluginDropTarget(bar, { kind: 'quick' })
    return () => { source(); target.dispose() }
  }, [])

  useEffect(() => {
    const revision = ++catalogFetchRevision.current
    setCatalogLoading(!nativeCatalog.current)
    if (!catalogFlight.current || catalogFlight.current.refresh !== refresh) {
      const promise = Promise.resolve(shellApi.quickSearch?.('', 65_536, undefined, 'catalog'))
        .then(result => (result?.items ?? []).filter(command => command.group !== 'provider'))
      const flight = { refresh, promise }
      catalogFlight.current = flight
      void promise.finally(() => { if (catalogFlight.current === flight) catalogFlight.current = null }).catch(() => undefined)
    }
    void catalogFlight.current.promise.then(commands => {
      if (revision !== catalogFetchRevision.current) return
      const signature = JSON.stringify(commands)
      if (nativeCatalog.current?.signature === signature) return
      nativeCatalog.current = { commands, signature }
      const providers = current.current.directory.records.filter(record => record.command.group === 'provider').map(record => record.command)
      if (!catalogNonce.current) catalogNonce.current = crypto.randomUUID()
      const next = { revision: current.current.directory.revision + 1,
        records: cachedRecords(updateQuickCatalog([...commands, ...providers], catalogNonce.current, current.current.directory.records)) }
      current.current = { directory: next, items: [], selectedId: null }
      setDirectory(next); setItems([]); setSelectedId(null)
    }).catch(() => {
      if (revision === catalogFetchRevision.current) setError('部分搜索来源暂时不可用，请重试。')
    }).finally(() => { if (revision === catalogFetchRevision.current) setCatalogLoading(false) })
    return () => { catalogFetchRevision.current++ }
  }, [refresh, shown])

  useEffect(() => {
    const sequence = ++searchSequence.current
    if (!visible || pluginMode || composing || !query.trim() || filter && filter !== 'plugin') { setProvidersLoading(false); return }
    setProvidersLoading(true)
    const timer = setTimeout(async () => {
      try {
        const providers = await shellApi.quickSearch?.(query, 100, 'plugin', 'providers')
        if (sequence !== searchSequence.current) return
        if (providers?.items.length) {
          const previous = current.current.directory
          const next = { revision: previous.revision + 1,
            records: cachedRecords(updateQuickCatalog([...previous.records.filter(record => record.command.group !== 'provider').map(record => record.command), ...providers.items], catalogNonce.current, previous.records)) }
          current.current = { ...current.current, directory: next }
          setDirectory(next)
        }
      } catch {
        if (sequence === searchSequence.current) setError('部分搜索来源暂时不可用，请重试。')
      } finally { if (sequence === searchSequence.current) setProvidersLoading(false) }
    }, 80)
    return () => { clearTimeout(timer); searchSequence.current++; void shellApi.quickSearch?.('', 0, undefined, 'cancel').catch(() => undefined) }
  }, [query, filter, pluginMode, composing, refresh, shown, themeConfig?.key, visible])

  const execute = useCallback(async (request: QuickOpenRequest): Promise<boolean> => {
    if (openingRef.current) return false
    const inputEpoch = contextEpoch.current, inputRevision = contextReadRevision.current
    const owner = themeReadyRef.current ? themeKey.current : undefined
    const defaultPolicy = !themeReadyRef.current || !customSearchRef.current
    openingRef.current = true; setOpening(true); setError(null)
    try {
      const result = await shellApi.quickOpen?.(request)
      if (!result?.ok) { setError('无法打开，请稍后重试。'); return false }
      if (request.kind === 'plugin' && request.input && inputEpoch === contextEpoch.current && inputRevision === contextReadRevision.current) {
        resetContext()
      }
      if (result.opened) {
        const receipt = { ...result.opened, sequence: ++openedSequence.current, query: 'query' in request ? request.query ?? '' : '' }
        if (defaultPolicy) defaultView.current?.recordOpened(receipt)
        if (owner && owner === themeKey.current && themeReadyRef.current) setProviderOpened({ owner, receipt })
      }
      if (request.kind === 'action' && request.action === 'refresh-apps') refreshSources(true)
      return true
    } catch { setError('无法打开，请稍后重试。'); return false }
    finally { openingRef.current = false; setOpening(false) }
  }, [refreshSources, resetContext])

  const escapePlugin = useCallback((): Promise<boolean> => {
    if (escaping.current) return escaping.current
    const mode = modeRef.current
    if (!mode) return Promise.resolve(true)
    escaping.current = (async () => {
      try {
        const result = await shellApi.quickOpen?.({ kind: 'plugin-escape', pluginId: mode.pluginId })
        if (!result?.ok) throw new Error('escape failed')
        return true
      } catch { setError('无法返回搜索，请重试。'); return false }
      finally { escaping.current = null }
    })()
    return escaping.current
  }, [])

  const applyPluginInput = useCallback((update: QuickPluginInputUpdate) => {
    if (!update.accepted) return
    const snapshot = inputSession.snapshot
    setPluginInput(snapshot); setQuery(snapshot.value)
    if (update.message) void shellApi.quickInput?.(update.message).catch(() => undefined)
  }, [inputSession])

  const restorePluginInput = useCallback((pluginId: string | null) => {
    const revision = inputSession.restore(pluginId)
    applyPluginInput({ accepted: true })
    if (!pluginId) return
    void Promise.resolve(shellApi.quickInput?.()).then(state => {
      if (state !== null && (typeof state !== 'object' || !state)) throw new Error('Invalid Quick input snapshot')
      applyPluginInput(inputSession.receive(state, revision))
    }).catch(() => {
      if (!inputSession.fail(revision)) return
      applyPluginInput({ accepted: true }); setError('无法恢复插件输入，请重试。')
    })
  }, [applyPluginInput, inputSession])

  const changeQuery = useCallback((value: string): boolean => {
    const result = inputSession.change(value)
    if (result.target === 'ignored') return false
    if (result.target === 'plugin') applyPluginInput({ accepted: true, message: result.message })
    else { invalidate(); setQuery(value) }
    return true
  }, [applyPluginInput, inputSession, invalidate])

  useEffect(() => {
    const offEvent = shellApi.onEvent?.(event => {
      if (event.type === 'quick-plugin-mode') {
        modeRef.current = event.mode; setPluginMode(event.mode)
        restorePluginInput(event.mode?.pluginId ?? null)
        setFilter(null); invalidate(); setOpening(false)
        requestAnimationFrame(() => focus())
      } else if (event.type === 'quick-input') {
        applyPluginInput(inputSession.receive(event.state))
      } else if (event.type === 'plugin-ready' && modeRef.current?.pluginId === event.pluginId) {
        setPluginMode(mode => mode ? { ...mode, loading: false } : mode)
      } else if (event.type === 'plugin-error' && modeRef.current?.pluginId === event.pluginId) {
        setPluginMode(mode => mode ? { ...mode, loading: false } : mode); setError('插件暂时无法启动，请重试。')
      } else if (event.type === 'quick-focus-search') focus(true)
      else if (event.type === 'plugins-changed' || event.type === 'plugin-launch-changed' || event.type === 'launch-directory-changed') {
        refreshSources(true)
      }
    })
    const offShown = shellApi.onQuickShown?.(() => {
      setQuery(inputSession.snapshot.value); setFilter(null); invalidate(); setShown(value => value + 1)
      // 主进程在隐藏时清空上下文，呼出后镜像必须与宿主对齐。
      resetContext()
      void refreshContext().catch(() => undefined)
      requestAnimationFrame(() => focus())
    })
    return () => { inputSession.restore(null); contextEpoch.current++; contextReadRevision.current++; offEvent?.(); offShown?.() }
  }, [applyPluginInput, focus, inputSession, invalidate, refreshContext, refreshSources, resetContext, restorePluginInput])

  const catalog = useMemo(() => publicQuickCatalog(directory.records), [directory.records])
  useEffect(() => {
    const controller = new AbortController()
    iconController.current = controller
    iconRequests.current.clear()
    return () => { controller.abort(); if (iconController.current === controller) iconController.current = null }
  }, [refresh])
  useEffect(() => { iconRequests.current.clear() }, [shown, refresh])
  useEffect(() => {
    const records = items.map(item => directory.records.find(record => record.id === item.id))
      .filter((record): record is QuickCatalogRecord => Boolean(record && !record.icon && !iconRequests.current.has(iconKey(record))))
      .slice(0, Math.max(0, 256 - iconRequests.current.size))
    if (!records.length) return
    for (const record of records) iconRequests.current.add(iconKey(record))
    const signal = iconController.current?.signal
    if (!signal || signal.aborted) return
    void (async () => {
      const native = [...new Set(records.flatMap(record => {
        const command = record.command.group === 'provider'
          ? directory.records.find(entry => entry.command.kind === 'plugin' && entry.command.group !== 'provider' && entry.command.pluginId === record.command.pluginId)?.command
          : record.command
        return command && (command.kind === 'app' || command.kind === 'plugin') ? [command.id] : []
      }))]
      const enriched = native.length ? await shellApi.quickSearch?.('', 100, undefined, 'enriched', native) : undefined
      if (signal.aborted) return
      const identity = (command: QuickCommand) => command.kind === 'plugin' ? `plugin:${command.pluginId}` : command.id
      const icons = new Map(enriched?.items.map(command => [identity(command), command.icon]))
      const published = records.map(record => {
        const icon = icons.get(identity(record.command)) ?? record.command.icon
        return [iconKey(record), safeQuickIcon(icon) ? icon : undefined] as const
      })
      if (signal.aborted || !published.some(([, icon]) => icon)) return
      const byId = new Map(published)
      for (const [id, icon] of published) {
        if (!icon) continue
        if (catalogIconCache.size >= 256) catalogIconCache.delete(catalogIconCache.keys().next().value!)
        catalogIconCache.set(id, icon)
      }
      setDirectory(previous => ({ ...previous, records: previous.records.map(record => byId.get(iconKey(record)) ? { ...record, icon: byId.get(iconKey(record)) } : record) }))
      setItems(previous => previous.map(item => {
        const record = current.current.directory.records.find(record => record.id === item.id)
        const icon = record && byId.get(iconKey(record))
        return icon ? { ...item, icon } : item
      }))
    })().catch(() => undefined)
  }, [items, directory.records])

  const authorized = useCallback(async (trusted: boolean) => trusted || Boolean(themeConfig && await shellApi.quickAuthorizeTheme?.(themeConfig.key)), [themeConfig])
  const pasteFromClipboard = useCallback(() => mutateContext({ operation: 'read-clipboard' }), [mutateContext])
  const openHandle = useCallback(async (id: string, container?: 'quick' | 'shell') => {
    if (!current.current.items.some(item => item.id === id)) return false
    const record = current.current.directory.records.find(record => record.id === id)
    const request = record && quickRequestFromRecord(record, query, container)
    if (!request) return false
    const selection = request.kind === 'plugin' && record
      ? buildQuickInputSelection(contextRef.current, record.command, query) : undefined
    return execute(selection ? { ...request, ...(selection ? { input: selection } : {}) } : request)
  }, [execute, query])

  const keyAction = useCallback(async (input: ThemeKey, trusted: boolean): Promise<QuickThemeActionResult> => {
    if (composingRef.current) return { ok: false }
    const epoch = queryRevision.current, inputEpoch = inputSession.revision, provider = themeKey.current, modeBefore = modeRef.current?.pluginId
    const authorizeCurrent = async () => await authorized(trusted) && epoch === queryRevision.current
      && inputEpoch === inputSession.revision && provider === themeKey.current && modeBefore === modeRef.current?.pluginId
    if (input.key === 'Escape') {
      if (!trusted) return { ok: false }
      if (modeRef.current) return { ok: await escapePlugin() }
      if (query) changeQuery('')
      else if (filter) { invalidate(); setFilter(null) }
      else if (contextRef.current.length) {
        resetContext()
        return mutateContext({ operation: 'clear' })
      }
      else shellApi.quickHide?.()
      return { ok: true }
    }
    if ((input.meta || input.ctrl) && input.key.toLowerCase() === 'k') { focus(true); return { ok: true } }
    const mode = modeRef.current
    if (mode) {
      if (input.key === 'Enter' && (input.meta || input.ctrl)) {
        if (!await authorizeCurrent()) return { ok: false }
        return { ok: await execute({ kind: 'plugin-pin', pluginId: mode.pluginId }) }
      }
      const plugin = inputSession.activeInput
      if (plugin && ['ArrowDown', 'ArrowUp', 'Enter'].includes(input.key)) {
        if (input.key === 'Enter' && !await authorizeCurrent()) return { ok: false }
        await shellApi.quickInput?.({ pluginId: plugin.pluginId, generation: plugin.generation, type: 'action',
          action: input.key === 'ArrowDown' ? 'next' : input.key === 'ArrowUp' ? 'previous' : 'submit' })
        return { ok: true }
      }
      if (input.key === 'Tab') { await shellApi.quickOpen?.({ kind: 'plugin-tab', pluginId: mode.pluginId, shift: input.shift }); return { ok: true } }
      return { ok: false }
    }
    if (!customSearchRef.current && !input.meta && !input.ctrl && !input.alt) {
      const id = defaultView.current?.navigate(input.key, input.shift)
      if (id && current.current.items.some(item => item.id === id)) { setSelectedId(id); return { ok: true } }
    }
    if (input.key !== 'Enter' || input.alt || input.shift || !await authorizeCurrent()) return { ok: false }
    if (current.current.selectedId) return { ok: await openHandle(current.current.selectedId, input.meta || input.ctrl ? 'shell' : undefined) }
    return emptyMarket ? { ok: await execute({ kind: 'action', action: 'open-market', query }) } : { ok: false }
  }, [authorized, changeQuery, emptyMarket, escapePlugin, execute, filter, focus, inputSession, invalidate, mutateContext, openHandle, query, resetContext])
  useEffect(() => shellApi.onQuickThemeKey?.(input => { if (themeReadyRef.current) void keyAction({ type: 'key', ...input }, true) }), [keyAction])

  const action = useCallback(async (request: QuickThemeAction, trusted = false): Promise<QuickThemeActionResult> => {
    const privateStateAction = request.type === 'state-read' || request.type === 'state-write'
    if (trusted ? !privateStateAction && themeReadyRef.current && (request.type !== 'results' || customSearchRef.current)
      : !themeReadyRef.current || !themeConfig || themeConfig.key !== themeKey.current) return { ok: false }
    if (privateStateAction) {
      const providerKey = trusted ? null : themeConfig!.key
      try {
        const result = await providerState({ providerKey,
          ...(request.type === 'state-read' ? { operation: 'read' as const } : { operation: 'write' as const, expectedRevision: request.expectedRevision, value: request.value }) })
        if ('keys' in result || !trusted && (providerKey !== themeKey.current || !themeReadyRef.current)) return { ok: false }
        return { ok: true, state: { revision: result.revision, value: result.value } }
      } catch { return { ok: false, error: '无法读写主题的私有状态，请重试。' } }
    }
    if (request.type === 'query') return { ok: request.query === query || changeQuery(request.query.slice(0, 4_096)) }
    if (request.type === 'composition') {
      if (composingRef.current !== request.active) searchSequence.current++
      composingRef.current = request.active; setComposing(request.active); return { ok: true }
    }
    if (request.type === 'filter') { if (request.kind !== filter) { invalidate(); setFilter(request.kind) }; return { ok: true } }
    if (request.type === 'layout') {
      if (!trusted && !customSearchRef.current) defaultView.current?.layout(request.columns)
      if (!modeRef.current) shellApi.quickResize?.(Math.max(QUICK_BAR_AREA_H + 1, Math.min(545, Math.round(request.height))))
      return { ok: true }
    }
    if (request.type === 'results') {
      const visible = projectQuickThemeResults(catalog, request, { queryRevision: queryRevision.current, catalogRevision: current.current.directory.revision })
      if (!visible) return { ok: false }
      const seen = new Set(visible.map(item => item.id))
      if (!trusted) { customSearchRef.current = true; setCustomSearch(true) }
      setItems(previous => sameItems(previous, visible) ? previous : visible)
      setSelectedId(previous => request.selectedId !== undefined ? request.selectedId && seen.has(request.selectedId) ? request.selectedId : null : previous && seen.has(previous) ? previous : visible[0]?.id ?? null)
      setHiddenCount(request.hiddenCount ?? 0); setEmptyMarket(request.emptyMarket === true)
      if (request.expanded !== undefined) setExpanded(request.expanded)
      return { ok: true }
    }
    if (request.type === 'select') {
      if (!current.current.items.some(item => item.id === request.id)) return { ok: false }
      setSelectedId(request.id); return { ok: true }
    }
    if (request.type === 'expand') { setExpanded(request.expanded); return { ok: true } }
    if (request.type === 'input-clear') {
      if (!request.id) resetContext()
      return mutateContext({ operation: 'clear', ...(request.id ? { id: request.id } : {}) })
    }
    if (request.type === 'key') return keyAction(request, trusted)
    if (request.type === 'retry') {
      if (modeRef.current) restorePluginInput(modeRef.current.pluginId)
      refreshSources(); return { ok: true }
    }
    const before = queryRevision.current, modeBefore = modeRef.current?.pluginId, providerBefore = themeKey.current
    if (!await authorized(trusted)) return { ok: false, error: '请通过点击或按键执行此操作。' }
    if (queryRevision.current !== before || modeRef.current?.pluginId !== modeBefore || themeKey.current !== providerBefore) return { ok: false }
    if (request.type === 'open') return { ok: await openHandle(request.id, request.container) }
    if (request.type === 'paste') return pasteFromClipboard()
    if (request.type === 'open-market' || request.type === 'open-settings' || request.type === 'refresh-apps') {
      return { ok: await execute({ kind: 'action', action: request.type, query }) }
    }
    if (request.type === 'hide') { shellApi.quickHide?.(); return { ok: true } }
    const mode = modeRef.current
    if (!mode) return { ok: false }
    if (request.type === 'plugin-back') return { ok: await escapePlugin() }
    if (request.type === 'plugin-pin') return { ok: await execute({ kind: 'plugin-pin', pluginId: mode.pluginId }) }
    if (request.type === 'plugin-focus') { await shellApi.quickOpen?.({ kind: 'plugin-tab', pluginId: mode.pluginId }); return { ok: true } }
    if (request.type === 'plugin-detach') {
      const result = await window.enestWindows?.command({ action: 'detach', pluginId: mode.pluginId })
      if (!result?.ok) setError('无法创建独立窗口，请重试。')
      return { ok: result?.ok === true }
    }
    return { ok: false }
  }, [authorized, catalog, changeQuery, escapePlugin, execute, filter, invalidate, keyAction, mutateContext, openHandle, pasteFromClipboard, query, refreshSources, resetContext, restorePluginInput, themeConfig])

  const snapshot = useMemo<QuickThemeSnapshot>(() => ({
    version: 1, revision: ++snapshotRevision.current, query, filter, searching: Boolean(query.trim()), loading, busy: opening, composing,
    error, items, catalog, catalogRevision: directory.revision, queryRevision: queryRevision.current, shown,
    opened: providerOpened && providerOpened.owner === themeConfig?.key ? providerOpened.receipt : null,
    selectedId, expanded, hiddenCount, emptyMarket,
    plugin: pluginMode ? { title: pluginMode.title, loading: pluginMode.loading === true,
      placeholder: pluginInput.input?.placeholder?.slice(0, 256) || (pluginInput.status === 'hydrating' ? '正在恢复插件输入…'
        : pluginInput.status === 'ready' ? '输入内容…' : '按 Esc 或返回按钮回到搜索'),
      acceptsInput: pluginInput.status === 'hydrating' || pluginInput.status === 'ready' } : null,
    input: inputContext.length ? { items: inputContext, hasText: Boolean(query.trim()) } : null,
    appearance: themeConfig?.appearance ?? { mode: appearance.mode, tokens: appearance.tokens, fonts: appearance.fonts,
      components: appearance.components, animation: appearance.animation.effective, resources: { fonts: [] } }, bounds
  }), [query, filter, loading, opening, composing, error, items, catalog, directory.revision, queryRevision.current,
    shown, providerOpened, themeConfig, selectedId, expanded, hiddenCount, emptyMarket, pluginMode, pluginInput, inputContext, appearance, bounds])

  return <div ref={root} className="quick-host" data-mode={pluginMode ? 'plugin' : 'list'}
    style={{ '--quick-bar-h': `${QUICK_BAR_AREA_H}px`, '--quick-radius': `${QUICK_CORNER_RADIUS}px` } as CSSProperties}>
    <div className="quick-default-provider" hidden={themeReady}>
      <Suspense fallback={<div role="status" aria-label="正在加载快捷启动" />}>
        <DefaultQuickSurface ref={defaultView} snapshot={snapshot} active={visible && !themeReady} searchActive={!themeReady || !customSearch}
          retryRevision={refresh} privateState={defaultPrivateState} onAction={request => action(request, true)} />
      </Suspense>
    </div>
    {themeConfig && <QuickThemeSurface key={themeConfig.key} ref={remoteView} config={themeConfig} snapshot={snapshot}
      onAction={request => action(request)} onReady={ready => {
        if (themeKey.current !== themeConfig.key) return
        themeReadyRef.current = ready; setThemeReady(ready); if (ready) requestAnimationFrame(() => remoteView.current?.focus())
      }}
      onFailure={() => {
        if (themeKey.current !== themeConfig.key) return
        applyThemeConfig(null); requestAnimationFrame(() => defaultView.current?.focus())
      }} />}
    <div ref={nativeBar} className="quick-host-native-bar" aria-hidden />
  </div>
}
