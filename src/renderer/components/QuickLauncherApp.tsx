/** Quick owns navigation; the native plugin view owns everything below the search bar. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import gsap from 'gsap'
import type { QuickCommand, QuickCommandKind, QuickOpenRequest, QuickPluginModeInfo } from '@shared/types/quick'
import type { QuickThemeAction, QuickThemeActionResult, QuickThemeConfig, QuickThemeSnapshot } from '@shared/types/quickTheme'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { QuickThemeSurface, type QuickThemeSurfaceHandle } from './QuickThemeSurface'
import { QUICK_BAR_AREA_H, QUICK_BORDER_WIDTH, QUICK_CONTENT_HEIGHT, QUICK_CORNER_RADIUS, QUICK_GRID_COLUMNS, QUICK_HOME_HEIGHT, QUICK_HOME_ROWS } from '@shared/constants'
import { IS_MAC } from '@shared/platform'
import { d, ease } from '@renderer/gsap/marketMotion'
import { shellApi } from '@renderer/services/shellApi'
import { Button } from '@renderer/components/ui/Button'
import { bindPluginDragSource, bindPluginDropTarget } from '@renderer/services/pluginWindowDrag'
import '@renderer/styles/plugin-window-drag.css'
import { AppBackground } from './AppBackground'
import { SearchField } from './SearchField'
import { QuickAccessMenu } from './QuickAccessMenu'
import { ChevronLeftIcon, HouseIcon, RotateCwIcon, SearchIcon, SettingsIcon } from './icons'
import { appendQuickProviders, groupQuickCommands, mergeQuickEnriched, moveQuickGridSelection, quickSelectionIndex, type QuickGridKey } from './quickGrid'
import { getQuickSearchResults } from './quickSearchResults'
import './quick.css'

const FILTERS: { kind: QuickCommandKind; label: string }[] = [
  { kind: 'app', label: '应用' }, { kind: 'plugin', label: '插件' }, { kind: 'action', label: '操作' }
]

function CategoryIcon({ kind }: { kind: QuickCommandKind }) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {kind === 'app' ? <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></> : kind === 'plugin' ? <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></> : <><path d="m5 7 5 5-5 5M13 17h6" /></>}
  </svg>
}

function ItemIcon({ cmd }: { cmd: QuickCommand }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [cmd.icon])
  return <span className={`quick-icon-tile kind-${cmd.kind}${cmd.icon && !failed ? ' has-icon' : ''}`} aria-hidden>
    {cmd.icon && !failed ? <img src={cmd.icon} alt="" onError={() => setFailed(true)} draggable={false} /> :
      cmd.kind === 'action' ? (cmd.action === 'open-settings' ? <SettingsIcon size={25} /> : cmd.action === 'refresh-apps' ? <RotateCwIcon size={25} /> : <HouseIcon size={25} />) :
        <span>{Array.from(cmd.title || '?')[0].toUpperCase()}</span>}
  </span>
}

function HighlightTitle({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLocaleLowerCase()
  const i = q ? text.toLocaleLowerCase().indexOf(q) : -1
  return i < 0 ? <>{text}</> : <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>
}

export function QuickLauncherApp() {
  const appearanceRevision = useAppearanceStore(state => state.appearance.revision)
  const [themeConfig, setThemeConfig] = useState<QuickThemeConfig | null>(null)
  const [themeReady, setThemeReady] = useState(false)
  const themeReadyRef = useRef(false)
  const themeConfigKeyRef = useRef<string | null>(null)
  const themeViewRef = useRef<QuickThemeSurfaceHandle>(null)
  const themeSnapshotRevision = useRef(0)
  const [themeBounds, setThemeBounds] = useState({ width: window.innerWidth, height: window.innerHeight, inputHeight: QUICK_BAR_AREA_H })
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<QuickCommandKind>()
  const [items, setItems] = useState<QuickCommand[]>([])
  const [resultsExpanded, setResultsExpanded] = useState(false)
  const [columns, setColumns] = useState(QUICK_GRID_COLUMNS)
  const resultsScopeRef = useRef({ query, kind })
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const marketButtonRef = useRef<HTMLButtonElement>(null)
  const [index, setIndex] = useState(0)
  const selectedIdRef = useRef<string | null>(null)
  const focusSearch = useCallback((selectAll = false) => {
    if (themeReadyRef.current) themeViewRef.current?.focus(selectAll)
    else { inputRef.current?.focus(); if (selectAll) inputRef.current?.select() }
  }, [])
  const [busy, setBusy] = useState(false)
  const [backgroundBusy, setBackgroundBusy] = useState(false)
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [shown, setShown] = useState(0)
  const [pluginMode, setPluginMode] = useState<QuickPluginModeInfo | null>(null)
  const [pluginInput, setPluginInput] = useState<import('@shared/types/plugin-tools').QuickInputState | null>(null)
  const pluginInputRef = useRef(pluginInput)
  const inputRevision = useRef(0)
  const modeRef = useRef(pluginMode)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchVersion = useRef(0)
  const openingRef = useRef(false)
  // Typing a new global query exits plugin mode without discarding that query.
  const pendingGlobalQuery = useRef<string | null>(null)
  const escapingRef = useRef<Promise<boolean> | null>(null)
  useEffect(() => {
    let cancelled = false
    void shellApi.quickGetTheme?.().then(config => {
      if (cancelled) return
      if (themeConfigKeyRef.current !== (config?.key ?? null)) {
        themeConfigKeyRef.current = config?.key ?? null
        themeReadyRef.current = false
        setThemeReady(false)
      }
      setThemeConfig(config)
    }).catch(() => { if (!cancelled) { themeConfigKeyRef.current = null; setThemeConfig(null); themeReadyRef.current = false; setThemeReady(false) } })
    return () => { cancelled = true }
  }, [appearanceRevision, revision, shown])
  useEffect(() => {
    const resize = () => setThemeBounds({ width: window.innerWidth, height: window.innerHeight, inputHeight: QUICK_BAR_AREA_H })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useLayoutEffect(() => {
    themeReadyRef.current = themeReady
    const canonical = rootRef.current?.querySelector<HTMLElement>('.quick-shell')
    if (canonical) canonical.inert = themeReady
    if (themeReady) themeViewRef.current?.focus(false)
    return () => { if (canonical) canonical.inert = false }
  }, [themeReady])
  const searching = Boolean(query.trim())
  const showResults = !pluginMode
  const showMarketEmpty = searching && !kind && showResults && !busy && !backgroundBusy && !composing && !error
    && !items.some(item => item.kind === 'app' || item.kind === 'plugin')
  const allGroups = useMemo(() => showResults ? groupQuickCommands(items, searching || kind === 'action', QUICK_GRID_COLUMNS * QUICK_HOME_ROWS) : [], [items, searching, showResults, kind])
  const { groups, visibleItems, overflowCount } = useMemo(
    () => getQuickSearchResults(allGroups, columns, searching, resultsExpanded),
    [allGroups, columns, searching, resultsExpanded]
  )
  // Resolve against the rendered prefix even before selection restoration runs.
  const activeIndex = quickSelectionIndex(visibleItems, selectedIdRef.current, index)
  const selectIndex = (nextIndex: number) => {
    selectedIdRef.current = visibleItems[nextIndex]?.id ?? null
    setIndex(nextIndex)
  }
  const resetResults = useCallback(() => {
    searchVersion.current++
    selectedIdRef.current = null
    setItems([])
    setIndex(0)
    setError('')
    setBusy(false)
    setBackgroundBusy(false)
  }, [])

  useLayoutEffect(() => {
    const previous = resultsScopeRef.current
    resultsScopeRef.current = { query, kind }
    // Incremental phases and same-query refreshes must not collapse expanded results.
    if (previous.query === query && previous.kind === kind) return
    setResultsExpanded(false)
    selectedIdRef.current = null
    setIndex(0)
    if (panelRef.current) panelRef.current.scrollTop = 0
  }, [query, kind])

  useEffect(() => {
    const bar = rootRef.current?.querySelector<HTMLElement>('.quick-search-bar')
    if (!bar) return
    const source = bindPluginDragSource(bar, target => {
      const element = target.closest<HTMLElement>('.quick-plugin-grip')
      const pluginId = modeRef.current?.pluginId
      return element && pluginId ? { element, pluginId } : null
    })
    const target = bindPluginDropTarget(bar, { kind: 'quick' })
    return () => { source(); target.dispose() }
  }, [])

  useEffect(() => {
    const version = ++searchVersion.current
    if (pluginMode || composing) return
    setBusy(true)
    setBackgroundBusy(false)
    setError('')
    const timer = window.setTimeout(async () => {
      try {
        const limit = searching ? 60 : QUICK_GRID_COLUMNS * QUICK_HOME_ROWS
        const result = await shellApi.quickSearch?.(query, limit, kind, 'static')
        if (version !== searchVersion.current) return
        const staticItems = result?.items ?? []
        selectedIdRef.current = groupQuickCommands(staticItems, searching || kind === 'action', limit)[0]?.items[0]?.id ?? null
        setItems(staticItems)
        setIndex(0)
        setBusy(false)
        setBackgroundBusy(true)
        // Neither icon extraction nor a runtime provider can delay the first
        // usable grid. The two follow-up requests settle independently.
        const phases: ('enriched' | 'providers')[] = searching ? ['enriched', 'providers'] : ['enriched']
        const phaseResults = await Promise.allSettled(phases.map(async phase => {
          const additional = await shellApi.quickSearch?.(query, limit, kind, phase)
          if (version !== searchVersion.current) return
          setItems(current => {
            if (version !== searchVersion.current) return current
            return phase === 'enriched'
              ? mergeQuickEnriched(current, additional?.items ?? [])
              : appendQuickProviders(current, additional?.items ?? [])
          })
        }))
        if (version === searchVersion.current && phaseResults.some(result => result.status === 'rejected')) setError('部分搜索来源暂时不可用，请重试。')
      } catch {
        if (version === searchVersion.current) { setItems([]); setError('搜索暂时不可用，请重试。') }
      } finally {
        if (version === searchVersion.current) { setBusy(false); setBackgroundBusy(false) }
      }
    }, searching ? 80 : 0)
    return () => { clearTimeout(timer); searchVersion.current++ }
  }, [query, kind, revision, pluginMode, searching, composing])

  useEffect(() => {
    const off = shellApi.onEvent?.((event) => {
      if (event.type === 'quick-plugin-mode') {
        const revision = ++inputRevision.current
        pluginInputRef.current = null; setPluginInput(null)
        modeRef.current = event.mode
        setPluginMode(event.mode)
        setQuery(event.mode ? '' : pendingGlobalQuery.current ?? '')
        pendingGlobalQuery.current = null
        resetResults()
        setKind(undefined)
        setCategoriesOpen(false)
        setError('')
        setOpening(null)
        requestAnimationFrame(() => focusSearch())
        if (event.mode) void shellApi.quickInput?.().then(state => {
          if (revision === inputRevision.current && state && typeof state === 'object' && modeRef.current?.pluginId === state.pluginId) {
            pluginInputRef.current = state; setPluginInput(state); setQuery(state.value)
          }
        }).catch(() => undefined)
      } else if (event.type === 'quick-input') {
        if (event.state && modeRef.current?.pluginId !== event.state.pluginId) return
        inputRevision.current++
        pluginInputRef.current = event.state; setPluginInput(event.state)
        if (event.state) setQuery(event.state.value)
      } else if (event.type === 'plugin-ready' && modeRef.current?.pluginId === event.pluginId) {
        setPluginMode(current => current ? { ...current, loading: false } : current)
      } else if (event.type === 'plugin-error' && modeRef.current?.pluginId === event.pluginId) {
        setPluginMode(current => current ? { ...current, loading: false } : current)
        setError(event.message)
      } else if (event.type === 'quick-focus-search') {
        focusSearch(true)
      } else if (event.type === 'plugins-changed') setRevision((v) => v + 1)
    })
    const offShown = shellApi.onQuickShown?.(() => {
      setQuery(pluginInputRef.current?.value ?? '')
      setKind(undefined)
      setCategoriesOpen(false)
      resetResults()
      setRevision((v) => v + 1)
      setShown((v) => v + 1)
      requestAnimationFrame(() => focusSearch())
    })
    focusSearch()
    return () => { off?.(); offShown?.() }
  }, [resetResults, focusSearch])

  // Keep the bar anchored at y=0 so its lower edge stays joined to native content.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ctx = gsap.context(() => {
      gsap.fromTo('.quick-search-bar .search-box', { opacity: 0 }, { opacity: 1, duration: d(0.25), ease: ease('power2.out') })
    }, root)
    return () => ctx.revert()
  }, [shown])

  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el || pluginMode) return
    const ctx = gsap.context(() => {
      gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: d(0.28), ease: ease('power2.out') })
    }, el)
    return () => ctx.revert()
  }, [showResults, searching, kind, shown])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel || pluginMode || themeReady) return
    let frame = 0
    let lastHeight = 0
    const measure = () => {
      frame = 0
      const style = getComputedStyle(panel)
      const results = panel.querySelector<HTMLElement>('.quick-results')
      const root = rootRef.current
      if (results && root) {
        // Share the real list edge, including native scrollbar gutters, with the header.
        const inset = `${results.getBoundingClientRect().left - panel.getBoundingClientRect().left}px`
        if (root.style.getPropertyValue('--quick-content-inset') !== inset) root.style.setProperty('--quick-content-inset', inset)
      }
      const grid = results?.querySelector<HTMLElement>('.quick-group-items')
      if (grid) {
        const nextColumns = getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(track => track && track !== 'none').length
        if (nextColumns && nextColumns !== columns) {
          setColumns(nextColumns)
          return // Re-fold with the actual CSS tracks before requesting native resize.
        }
      }
      // Measure intrinsic children, including the disclosure: the viewport clips
      // the panel before native resize. The host owns screen/maximum-height caps.
      const contentHeight = Array.from(panel.children).reduce((height, child) => height + child.getBoundingClientRect().height, 0)
      const height = searching
        ? Math.ceil(panel.getBoundingClientRect().top + contentHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 1)
        : QUICK_HOME_HEIGHT
      if (height !== lastHeight) {
        lastHeight = height
        void shellApi.quickResize?.(height)
      }
    }
    const scheduleMeasure = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(panel)
    for (const child of panel.children) observer.observe(child)
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [pluginMode, searching, shown, visibleItems.length, columns, resultsExpanded, overflowCount, showMarketEmpty, themeReady])

  useLayoutEffect(() => {
    // Restore by ID before paint: inserted match groups must not move selection
    // to a different command, even when providers finished before enrichment.
    const nextIndex = quickSelectionIndex(visibleItems, selectedIdRef.current, index)
    selectedIdRef.current = visibleItems[nextIndex]?.id ?? null
    if (index !== nextIndex) setIndex(nextIndex)
    panelRef.current?.querySelector<HTMLElement>(`[data-index="${nextIndex}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [index, visibleItems])

  const execute = useCallback(async (request: QuickOpenRequest, id: string) => {
    if (openingRef.current) return false
    openingRef.current = true
    setOpening(id)
    setError('')
    try {
      const result = await shellApi.quickOpen?.(request)
      if (!result?.ok) { setError(result?.error || '无法打开，请稍后重试。'); return false }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法打开，请稍后重试。')
      return false
    } finally { openingRef.current = false; setOpening(null) }
  }, [])

  const escapePlugin = useCallback((): Promise<boolean> => {
    if (escapingRef.current) return escapingRef.current
    const mode = modeRef.current
    if (!mode) return Promise.resolve(true)
    // Returning to search must work even while the opening request is settling.
    const escaping = (async () => {
      try {
        const result = await shellApi.quickOpen?.({ kind: 'plugin-escape', pluginId: mode.pluginId })
        if (!result?.ok) throw new Error(result?.error || '无法返回搜索，请重试。')
        return true
      } catch (err) {
        pendingGlobalQuery.current = null
        setError(err instanceof Error ? err.message : '无法返回搜索，请重试。')
        return false
      } finally { escapingRef.current = null }
    })()
    escapingRef.current = escaping
    return escaping
  }, [])

  const changeQuery = useCallback((value: string) => {
    const input = pluginInputRef.current
    if (input && modeRef.current?.pluginId === input.pluginId) {
      input.value = value; setQuery(value)
      void shellApi.quickInput?.({ pluginId: input.pluginId, generation: input.generation, type: 'change', value })
      return
    }
    resetResults()
    setBusy(true)
    setQuery(value)
    if (modeRef.current) {
      pendingGlobalQuery.current = value
      void escapePlugin()
    }
  }, [escapePlugin, resetResults])

  const openItem = useCallback(async (cmd: QuickCommand, mainWindow = false) => {
    if (busy) return false
    let request: QuickOpenRequest | undefined
    if (cmd.kind === 'app' && cmd.path) request = { kind: 'app', path: cmd.path, query }
    // 缺省不带 container：主进程按「显式 > 每插件启动方式设置 > 跟随入口(quick)」决策；
    // ⌘/Ctrl+Enter 显式指定主窗
    if (cmd.kind === 'plugin' && cmd.pluginId) {
      request = mainWindow
        ? { kind: 'plugin', pluginId: cmd.pluginId, code: cmd.code, type: cmd.type, payload: cmd.payload, query, container: 'shell' }
        : { kind: 'plugin', pluginId: cmd.pluginId, code: cmd.code, type: cmd.type, payload: cmd.payload, query }
    }
    if (cmd.kind === 'action' && cmd.action) request = { kind: 'action', action: cmd.action, query }
    if (!request) return false
    const ok = await execute(request, cmd.id)
    if (ok && cmd.action === 'refresh-apps') setRevision((v) => v + 1)
    return ok
  }, [busy, execute, query])

  const onKeyDown = (event: KeyboardEvent) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    const inInput = event.target === inputRef.current
    const hasSelection = inInput && inputRef.current?.selectionStart !== inputRef.current?.selectionEnd
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); return
    }
    // Tab is reserved for grid/plugin navigation; F6 cycles to the shared toolbar.
    if (event.key === 'F6' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      if (inInput) rootRef.current?.querySelector<HTMLButtonElement>('.quick-access-trigger')?.focus()
      else inputRef.current?.focus()
      return
    }
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (pluginMode) { pendingGlobalQuery.current = null; void escapePlugin() }
      else if (query) changeQuery('')
      else if (categoriesOpen) { setCategoriesOpen(false); inputRef.current?.focus() }
      else if (kind) { setKind(undefined); resetResults() }
      else shellApi.quickHide?.()
      return
    }
    if (showMarketEmpty && !visibleItems.length && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (inInput && !event.shiftKey) {
        if (event.key === 'Enter') {
          event.preventDefault()
          void execute({ kind: 'action', action: 'open-market', query }, 'open-market')
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'Tab') {
          event.preventDefault(); marketButtonRef.current?.focus(); return
        }
      }
      if (event.target === marketButtonRef.current && (event.key === 'Tab' || (event.key === 'ArrowUp' && !event.shiftKey))) {
        event.preventDefault(); inputRef.current?.focus(); return
      }
    }
    if (hasSelection && ['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    if (pluginMode) {
      if (inInput && event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        void shellApi.quickOpen?.({ kind: 'plugin-tab', pluginId: pluginMode.pluginId, shift: event.shiftKey })
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault(); void execute({ kind: 'plugin-pin', pluginId: pluginMode.pluginId }, pluginMode.pluginId)
      } else if (inInput && pluginInput && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
        event.preventDefault()
        void shellApi.quickInput?.({ pluginId: pluginInput.pluginId, generation: pluginInput.generation, type: 'action', action: event.key === 'ArrowDown' ? 'next' : event.key === 'ArrowUp' ? 'previous' : 'submit' })
      }
      return
    }
    if (event.target === moreButtonRef.current && event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      selectIndex(event.shiftKey ? Math.max(0, visibleItems.length - 1) : 0)
      inputRef.current?.focus()
      return
    }
    const inGrid = event.target instanceof Element && Boolean(event.target.closest('[data-quick-command]'))
    if ((!inInput && !inGrid) || busy || !showResults) return
    const navigationKeys: QuickGridKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']
    if (navigationKeys.includes(event.key as QuickGridKey)) {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && event.key !== 'Tab')) return
      // Preserve normal left/right caret editing while the query has text.
      if (inInput && query && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      if (!visibleItems.length) return
      event.preventDefault()
      if (event.key === 'Tab' && moreButtonRef.current && (event.shiftKey ? activeIndex === 0 : activeIndex === visibleItems.length - 1)) {
        moreButtonRef.current.focus()
        return
      }
      selectIndex(moveQuickGridSelection(activeIndex, groups.map(group => group.items.length), columns, event.key as QuickGridKey, event.shiftKey))
      inputRef.current?.focus()
    }
    if (event.key === 'Enter' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      if (visibleItems[activeIndex]) void openItem(visibleItems[activeIndex], event.metaKey || event.ctrlKey)
    }

  }

  const selected = visibleItems[activeIndex]
  const modifier = IS_MAC ? '⌘' : 'Ctrl'
  const handles = useMemo(() => {
    const nonce = crypto.randomUUID()
    return visibleItems.map((command, i) => ({ id: `${nonce}-${i}`, command }))
  }, [visibleItems, query, kind, pluginMode, shown, themeConfig?.key])
  const currentHandles = useRef(handles)
  currentHandles.current = handles
  const publicItems = handles.map(({ id, command }) => ({
    id, kind: command.kind, title: command.title.slice(0, 256),
    subtitle: command.kind === 'app' ? '本机应用' : command.kind === 'plugin' ? '插件指令' : '系统操作',
    group: groups.find(group => group.items.some(item => item.id === command.id))?.title ?? ''
  }))
  const themeSnapshot: QuickThemeSnapshot | null = themeConfig ? {
    version: 1, revision: ++themeSnapshotRevision.current,
    query, filter: kind ?? null, searching, loading: busy || backgroundBusy, busy: Boolean(opening),
    error: error ? '操作暂时无法完成，请重试。' : null,
    items: publicItems, selectedId: handles[activeIndex]?.id ?? null,
    expanded: resultsExpanded, hiddenCount: overflowCount, emptyMarket: showMarketEmpty,
    plugin: pluginMode ? { title: pluginMode.title, loading: pluginMode.loading === true, placeholder: pluginInput?.placeholder?.slice(0, 256) || '搜索其它应用或插件…' } : null,
    appearance: themeConfig.appearance, bounds: themeBounds
  } : null
  const themeKey = useCallback(async (input: { key: string; shift?: boolean; meta?: boolean; ctrl?: boolean; alt?: boolean }, trusted = false) => {
    if (input.key === 'Escape') {
      if (!trusted) return { ok: false }
      if (modeRef.current) { pendingGlobalQuery.current = null; return { ok: await escapePlugin() } }
      if (query) changeQuery('')
      else if (kind) { setKind(undefined); resetResults() }
      else shellApi.quickHide?.()
      return { ok: true }
    }
    if ((input.meta || input.ctrl) && input.key.toLowerCase() === 'k') { focusSearch(true); return { ok: true } }
    if (modeRef.current) {
      const current = modeRef.current
      if (input.key === 'Enter' && (input.meta || input.ctrl)) {
        if (!trusted && !await shellApi.quickAuthorizeTheme?.(themeConfig?.key ?? '')) return { ok: false }
        return { ok: await execute({ kind: 'plugin-pin', pluginId: current.pluginId }, current.pluginId) }
      }
      const currentInput = pluginInputRef.current
      if (currentInput && ['ArrowDown', 'ArrowUp', 'Enter'].includes(input.key)) {
        if (input.key === 'Enter' && !trusted && !await shellApi.quickAuthorizeTheme?.(themeConfig?.key ?? '')) return { ok: false }
        await shellApi.quickInput?.({ pluginId: currentInput.pluginId, generation: currentInput.generation, type: 'action', action: input.key === 'ArrowDown' ? 'next' : input.key === 'ArrowUp' ? 'previous' : 'submit' })
        return { ok: true }
      }
      if (input.key === 'Tab') { await shellApi.quickOpen?.({ kind: 'plugin-tab', pluginId: current.pluginId, shift: input.shift }); return { ok: true } }
      return { ok: true }
    }
    if (busy || composingRef.current) return { ok: false }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(input.key)) {
      if (visibleItems.length) selectIndex(moveQuickGridSelection(activeIndex, groups.map(group => group.items.length), columns, input.key as QuickGridKey, input.shift))
      return { ok: true }
    }
    if (input.key === 'Enter') {
      if (!trusted && !await shellApi.quickAuthorizeTheme?.(themeConfig?.key ?? '')) return { ok: false }
      if (currentHandles.current !== handles) return { ok: false }
      if (selected) return { ok: await openItem(selected, input.meta || input.ctrl) }
      if (showMarketEmpty) return { ok: await execute({ kind: 'action', action: 'open-market', query }, 'open-market') }
      return { ok: false }
    }
    return { ok: true }
  }, [activeIndex, busy, changeQuery, columns, escapePlugin, execute, focusSearch, groups, kind, openItem, query, resetResults, selected, showMarketEmpty, themeConfig?.key, visibleItems.length, handles])
  useEffect(() => shellApi.onQuickThemeKey?.(input => { if (themeReadyRef.current) void themeKey(input, true) }), [themeKey])
  const onThemeAction = async (action: QuickThemeAction): Promise<QuickThemeActionResult> => {
    if (!themeReadyRef.current || !themeConfig) return { ok: false }
    if (action.type === 'query') { if (action.query !== query) changeQuery(action.query); return { ok: true } }
    if (action.type === 'filter') {
      const nextKind = action.kind ?? undefined
      if (nextKind !== kind) { resetResults(); setBusy(true); setKind(nextKind) }
      return { ok: true }
    }
    if (action.type === 'layout') {
      setColumns(Math.max(1, Math.min(8, Math.round(action.columns))))
      if (!modeRef.current) shellApi.quickResize?.(Math.max(QUICK_BAR_AREA_H + 1, Math.min(545, Math.round(action.height))))
      return { ok: true }
    }
    if (action.type === 'expand') { setResultsExpanded(action.expanded); return { ok: true } }
    if (action.type === 'select') {
      const i = handles.findIndex(item => item.id === action.id)
      if (i < 0) return { ok: false }
      selectIndex(i); return { ok: true }
    }
    if (action.type === 'key') return themeKey(action)
    if (!await shellApi.quickAuthorizeTheme?.(themeConfig.key)) return { ok: false, error: '请通过点击或按键执行此操作。' }
    if (!themeReadyRef.current || currentHandles.current !== handles) return { ok: false }
    if (action.type === 'open') {
      const found = handles.find(item => item.id === action.id)
      if (!found || busy || openingRef.current) return { ok: false }
      return { ok: await openItem(found.command, action.container === 'shell') }
    }
    if (action.type === 'open-market') return { ok: await execute({ kind: 'action', action: 'open-market', query }, 'open-market') }
    if (action.type === 'hide') { shellApi.quickHide?.(); return { ok: true } }
    const current = modeRef.current
    if (!current) return { ok: false }
    if (action.type === 'plugin-back') { pendingGlobalQuery.current = null; return { ok: await escapePlugin() } }
    if (action.type === 'plugin-pin') return { ok: await execute({ kind: 'plugin-pin', pluginId: current.pluginId }, current.pluginId) }
    if (action.type === 'plugin-focus') { await shellApi.quickOpen?.({ kind: 'plugin-tab', pluginId: current.pluginId }); return { ok: true } }
    return { ok: false }
  }

  return <div ref={rootRef} className={`quick-root${themeReady ? ' has-quick-theme' : ''}`} data-mode={pluginMode ? 'plugin' : 'list'} data-expanded="true" data-home={!searching && !pluginMode}
    style={{ '--quick-bar-h': `${QUICK_BAR_AREA_H}px`, '--quick-border-w': `${QUICK_BORDER_WIDTH}px`, '--quick-home-h': `${QUICK_HOME_HEIGHT}px`, '--quick-content-max-h': `${QUICK_CONTENT_HEIGHT}px`, '--quick-radius': `${QUICK_CORNER_RADIUS}px`, '--quick-grid-columns': QUICK_GRID_COLUMNS, '--quick-home-rows': QUICK_HOME_ROWS } as CSSProperties} onKeyDown={onKeyDown}>
    <div className="quick-shell">
      <AppBackground />
      <div className="quick-search-bar" role="search" data-tools={pluginMode ? 'plugin' : categoriesOpen ? 'expanded' : 'collapsed'}>
        <SearchField value={query} onChange={changeQuery} inputRef={inputRef}
          placeholder={pluginMode ? pluginInput?.placeholder || '搜索其它应用或插件…' : kind === 'app' ? '搜索软件…' : kind === 'plugin' ? '搜索插件…' : kind === 'action' ? '搜索系统操作…' : '搜索应用、插件与指令…'}
          leading={pluginMode ? <>
            <button type="button" className="quick-search-leading quick-plugin-back" onClick={() => void escapePlugin()} title={`返回全局搜索 · ${pluginMode.title}（Esc）`} aria-label="返回全局搜索"><ChevronLeftIcon size={20} /></button>
            <button type="button" className="quick-plugin-grip" title={`拖出「${pluginMode.title}」成为独立窗口；点击也可分离`} aria-label={`将${pluginMode.title}独立显示`}
              onClick={() => void window.enestWindows?.command({ action: 'detach', pluginId: pluginMode.pluginId }).then(result => { if (!result.ok) setError(result.error || '无法创建独立窗口') }).catch(() => setError('无法创建独立窗口'))}>
              <span aria-hidden="true">⠿</span><span>{pluginMode.title}</span>
            </button>
          </> : <span className="quick-search-leading" aria-hidden><SearchIcon size={19} /></span>}
          accessory={<>
            {!pluginMode && (busy || backgroundBusy) && <span className="quick-input-status"><span className="quick-spinner" aria-label="搜索中" /></span>}
            <span className="quick-inline-tools">
              {pluginMode && <button className="quick-tool quick-pin" type="button" title={`移到主窗口（${modifier} Enter）`} aria-label="移到主窗口" onClick={() => void execute({ kind: 'plugin-pin', pluginId: pluginMode.pluginId }, pluginMode.pluginId)}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3h7v7m0-7-10 10" /><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5" /></svg>
              </button>}
              <QuickAccessMenu key={`${shown}-${pluginMode?.pluginId ?? 'list'}`}
                onMarket={() => void execute({ kind: 'action', action: 'open-market' }, 'open-market')}
                onSettings={() => void execute({ kind: 'action', action: 'open-settings' }, 'open-settings')}
                onDismiss={() => inputRef.current?.focus()}>
                {!pluginMode && <Button className="quick-tool quick-scope-toggle" aria-expanded={categoriesOpen} aria-controls="quick-categories"
                  aria-label={categoriesOpen ? '收起搜索分类' : '展开搜索分类'} data-filtered={Boolean(kind)}
                  title={`${categoriesOpen ? '收起' : '展开'}搜索分类${kind ? ` · 当前：${FILTERS.find(filter => filter.kind === kind)!.label}` : ''}`}
                  onClick={() => { setCategoriesOpen(open => !open); inputRef.current?.focus() }}>
                  {kind ? <CategoryIcon kind={kind} /> : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>}
                </Button>}
              </QuickAccessMenu>
            </span>
          </>}
          inputProps={{ role: 'combobox', 'aria-expanded': showResults, 'aria-controls': showResults ? 'quick-results' : undefined, 'aria-activedescendant': showResults && selected && !busy ? `quick-item-${activeIndex}` : undefined,
            onCompositionStart: () => { composingRef.current = true; setComposing(true) },
            onCompositionEnd: () => { composingRef.current = false; setComposing(false) } }} />
        {!pluginMode && <div className="quick-categories-slot" id="quick-categories" aria-hidden={!categoriesOpen}>
          <div className="quick-categories" aria-label="搜索范围">
            {FILTERS.map(filter => <button key={filter.kind} type="button" className="quick-category" tabIndex={categoriesOpen ? 0 : -1} aria-label={filter.label} aria-pressed={kind === filter.kind}
              title={`${filter.label}${kind === filter.kind ? ' · 点击查看全部' : ''}`} onClick={() => {
                resetResults(); setBusy(true); setKind(current => current === filter.kind ? undefined : filter.kind); setCategoriesOpen(false); inputRef.current?.focus()
              }}><CategoryIcon kind={filter.kind} /></button>)}
          </div>
        </div>}

      </div>
      {error && (showResults || pluginMode) && <div className="quick-error" role="alert">{error}<button type="button" onClick={() => setRevision((v) => v + 1)}>重试</button></div>}
      {pluginMode?.loading && !error && <div className="quick-plugin-loading" role="status" aria-live="polite"><span className="quick-spinner" aria-hidden="true" /><span>正在启动 {pluginMode.title}…</span></div>}
      {showResults && <>
        <div className="quick-panel" data-home={!searching} ref={panelRef}>
          <div id="quick-results" className="quick-results" role="listbox" aria-label={searching ? '搜索结果' : '常用应用与插件'} aria-busy={busy}>
            {groups.map((group) => <div key={group.id} className="quick-result-group" role="group" aria-labelledby={`quick-group-${group.id}`}>
              <div className="quick-section-head"><h2 id={`quick-group-${group.id}`}>{group.title}</h2></div>
              <div className="quick-group-items">
                {group.items.map((cmd, groupIndex) => {
                  const i = group.offset + groupIndex
                  return <button key={cmd.id} id={`quick-item-${i}`} type="button" role="option" aria-selected={activeIndex === i} tabIndex={-1} data-index={i} data-quick-command
                    className={`quick-item quick-result${activeIndex === i ? ' active' : ''}`} title={`${cmd.title} · ${cmd.kind === 'plugin' ? '插件' : cmd.kind === 'app' ? '本机应用' : cmd.subtitle}`}
                    disabled={Boolean(opening)} onMouseEnter={() => selectIndex(i)} onMouseDown={event => event.preventDefault()} onClick={() => void openItem(cmd)}>
                    <ItemIcon cmd={cmd} /><span className="quick-item-copy"><span className="quick-item-title"><HighlightTitle text={cmd.title} query={query} /></span></span>
                    {opening === cmd.id && <span className="quick-item-opening" aria-label="打开中" /> }
                  </button>
                })}
              </div>
            </div>)}
          </div>
          {searching && overflowCount > 0 && <div className="quick-results-disclosure">
            <Button ref={moreButtonRef} className="quick-results-more" variant="ghost" size="sm" aria-expanded={resultsExpanded} aria-controls="quick-results"
              aria-label={resultsExpanded ? '收起搜索结果' : `展开全部搜索结果，另有 ${overflowCount} 项`}
              onClick={() => {
                if (resultsExpanded) {
                  selectIndex(0)
                  if (panelRef.current) panelRef.current.scrollTop = 0
                }
                setResultsExpanded(expanded => !expanded)
                inputRef.current?.focus()
              }}>
              {resultsExpanded ? '收起' : `更多 ${overflowCount}`}
            </Button>
          </div>}
          {showMarketEmpty && <div className="quick-empty">
            <span role="status">没有找到插件或本机应用，可以到插件市场找找</span>
            <Button ref={marketButtonRef} className="quick-empty-market" variant="ghost" size="sm" disabled={Boolean(opening)}
              onClick={() => void execute({ kind: 'action', action: 'open-market', query }, 'open-market')}>去插件市场</Button>
          </div>}
          {!showMarketEmpty && !visibleItems.length && <div className="quick-empty"><span>{busy || backgroundBusy ? '正在查找应用与插件…' : searching ? '没有找到匹配项' : '暂时没有常用应用或插件'}</span><small>{busy || backgroundBusy ? '正在补齐搜索结果，请稍候' : searching ? '试试应用名称、插件名或指令关键词' : '搜索并打开后会显示在这里'}</small>
            {!busy && !backgroundBusy && <button type="button" onClick={() => void execute({ kind: 'action', action: 'refresh-apps' }, 'refresh').then((ok) => { if (ok) setRevision((v) => v + 1) })}>重新扫描应用</button>}</div>}
        </div>
      </>}
    </div>
    {themeConfig && themeSnapshot && <QuickThemeSurface key={themeConfig.key} ref={themeViewRef}
      config={themeConfig} snapshot={themeSnapshot} onAction={onThemeAction}
      onReady={ready => { themeReadyRef.current = ready; setThemeReady(ready) }}
      onFailure={() => { themeReadyRef.current = false; setThemeReady(false); setThemeConfig(null); requestAnimationFrame(() => inputRef.current?.focus()) }} />}
  </div>
}
