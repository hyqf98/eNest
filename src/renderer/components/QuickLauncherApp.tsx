/** Quick owns navigation; the native plugin view owns everything below the search bar. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import gsap from 'gsap'
import type { QuickCommand, QuickCommandKind, QuickOpenRequest, QuickPluginModeInfo } from '@shared/types/quick'
import { QUICK_BAR_AREA_H, QUICK_CORNER_RADIUS, QUICK_GRID_COLUMNS, QUICK_HOME_HEIGHT, QUICK_HOME_ROWS } from '@shared/constants'
import { IS_MAC } from '@shared/platform'
import { d, dy, ease } from '@renderer/gsap/marketMotion'
import { shellApi } from '@renderer/services/shellApi'
import enestIcon from '@renderer/assets/enest-icon.png'
import { useAppearanceSync } from '@renderer/hooks/useAppearanceSync'
import { AmbientParticles } from './AmbientParticles'
import { SearchField } from './SearchField'
import { ChevronLeftIcon, HouseIcon, RotateCwIcon, SearchIcon, SettingsIcon } from './icons'
import { appendQuickProviders, groupQuickCommands, mergeQuickEnriched, moveQuickGridSelection, quickSelectionIndex, type QuickGridKey } from './quickGrid'
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
  useAppearanceSync()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<QuickCommandKind>()
  const [items, setItems] = useState<QuickCommand[]>([])
  const [index, setIndex] = useState(0)
  const selectedIdRef = useRef<string | null>(null)
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
  const searching = Boolean(query.trim())
  const showResults = !pluginMode
  const groups = useMemo(() => showResults ? groupQuickCommands(items, searching || kind === 'action', QUICK_GRID_COLUMNS * QUICK_HOME_ROWS) : [], [items, searching, showResults, kind])
  const visibleItems = useMemo(() => groups.flatMap((group) => group.items), [groups])
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
        await Promise.allSettled(phases.map(async phase => {
          const additional = await shellApi.quickSearch?.(query, limit, kind, phase)
          if (version !== searchVersion.current) return
          setItems(current => {
            if (version !== searchVersion.current) return current
            return phase === 'enriched'
              ? mergeQuickEnriched(current, additional?.items ?? [])
              : appendQuickProviders(current, additional?.items ?? [])
          })
        }))
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
        requestAnimationFrame(() => inputRef.current?.focus())
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
      } else if (event.type === 'quick-focus-search') {
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (event.type === 'plugins-changed') setRevision((v) => v + 1)
    })
    const offShown = shellApi.onQuickShown?.(() => {
      setQuery(pluginInputRef.current?.value ?? '')
      setKind(undefined)
      setCategoriesOpen(false)
      resetResults()
      setRevision((v) => v + 1)
      setShown((v) => v + 1)
      requestAnimationFrame(() => inputRef.current?.focus())
    })
    inputRef.current?.focus()
    return () => { off?.(); offShown?.() }
  }, [resetResults])

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
      gsap.fromTo(el, { opacity: 0, y: dy(7) }, { opacity: 1, y: 0, duration: d(0.28), ease: ease('power2.out') })
    }, el)
    return () => ctx.revert()
  }, [showResults, searching, kind, shown])

  useLayoutEffect(() => {
    if (pluginMode || !rootRef.current) return
    const root = rootRef.current
    const resize = () => shellApi.quickResize?.(Math.ceil(root.getBoundingClientRect().height), false)
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    resize()
    return () => observer.disconnect()
  }, [pluginMode, shown])

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
    if (busy) return
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
    if (request && await execute(request, cmd.id) && cmd.action === 'refresh-apps') setRevision((v) => v + 1)
  }, [busy, execute, query])

  const onKeyDown = (event: KeyboardEvent) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    const inInput = event.target === inputRef.current
    const hasSelection = inInput && inputRef.current?.selectionStart !== inputRef.current?.selectionEnd
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); return
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
    const inGrid = event.target instanceof Element && Boolean(event.target.closest('[data-quick-command]'))
    if ((!inInput && !inGrid) || busy || !showResults) return
    const navigationKeys: QuickGridKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']
    if (navigationKeys.includes(event.key as QuickGridKey)) {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && event.key !== 'Tab')) return
      // Preserve normal left/right caret editing while the query has text.
      if (inInput && query && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      if (!visibleItems.length) return
      event.preventDefault()
      const grid = panelRef.current?.querySelector<HTMLElement>('.quick-group-items')
      const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : QUICK_GRID_COLUMNS
      selectIndex(moveQuickGridSelection(index, groups.map(group => group.items.length), columns, event.key as QuickGridKey, event.shiftKey))
      inputRef.current?.focus()
    }
    if (event.key === 'Enter' && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      if (visibleItems[index]) void openItem(visibleItems[index], event.metaKey || event.ctrlKey)
    }

  }

  const selected = visibleItems[index]
  const modifier = IS_MAC ? '⌘' : 'Ctrl'

  return <div ref={rootRef} className="quick-root" data-mode={pluginMode ? 'plugin' : 'list'} data-expanded="true" data-home={!searching && !pluginMode}
    style={{ '--quick-bar-h': `${QUICK_BAR_AREA_H}px`, '--quick-radius': `${QUICK_CORNER_RADIUS}px`, '--quick-home-h': `${QUICK_HOME_HEIGHT}px`, '--quick-grid-columns': QUICK_GRID_COLUMNS, '--quick-home-rows': QUICK_HOME_ROWS } as CSSProperties} onKeyDown={onKeyDown}>
    <div className="quick-shell">
      {showResults && <AmbientParticles />}
      <div className="quick-search-bar" role="search" data-tools={pluginMode ? 'plugin' : categoriesOpen ? 'expanded' : 'collapsed'}>
        <SearchField value={query} onChange={changeQuery} inputRef={inputRef}
          placeholder={pluginMode ? pluginInput?.placeholder || '搜索其它应用或插件…' : kind === 'app' ? '搜索软件…' : kind === 'plugin' ? '搜索插件…' : kind === 'action' ? '搜索系统操作…' : '搜索应用、插件与指令…'}
          leading={pluginMode ? <button type="button" className="quick-search-leading quick-plugin-back" onClick={() => void escapePlugin()} title={`返回全局搜索 · ${pluginMode.title}（Esc）`} aria-label="返回全局搜索"><ChevronLeftIcon size={20} /></button> : <span className="quick-search-leading" aria-hidden><SearchIcon size={19} /></span>}
          trailing={<span className="search-shortcut" aria-hidden />}
          accessory={<span className="quick-input-status">{!pluginMode && (busy || backgroundBusy) && <span className="quick-spinner" aria-label="搜索中" />}</span>}
          inputProps={{ role: 'combobox', 'aria-expanded': showResults, 'aria-controls': showResults ? 'quick-results' : undefined, 'aria-activedescendant': showResults && selected && !busy ? `quick-item-${index}` : undefined,
            onCompositionStart: () => { composingRef.current = true; setComposing(true) },
            onCompositionEnd: () => { composingRef.current = false; setComposing(false) } }} />
        <div className="quick-toolbar">
          {pluginMode ? <button className="quick-tool quick-pin" type="button" title={`移到主窗口（${modifier} Enter）`} aria-label="移到主窗口" onClick={() => void execute({ kind: 'plugin-pin', pluginId: pluginMode.pluginId }, pluginMode.pluginId)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3h7v7m0-7-10 10" /><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5" /></svg>
          </button> : <button type="button" className="quick-tool quick-scope-toggle" aria-expanded={categoriesOpen} aria-controls="quick-categories"
            aria-label={categoriesOpen ? '收起搜索分类' : '展开搜索分类'} data-filtered={Boolean(kind)}
            title={`${categoriesOpen ? '收起' : '展开'}搜索分类${kind ? ` · 当前：${FILTERS.find(filter => filter.kind === kind)!.label}` : ''}`}
            onClick={() => { setCategoriesOpen(open => !open); inputRef.current?.focus() }}>
            {kind ? <CategoryIcon kind={kind} /> : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>}
          </button>}
          <button type="button" className="quick-market" title="打开插件市场" aria-label="打开插件市场" onClick={() => void execute({ kind: 'action', action: 'open-market' }, 'open-market')}>
            <img src={enestIcon} alt="eNest" draggable={false} />
          </button>
        </div>
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
      {showResults && <>
        <div className="quick-panel" data-home={!searching} ref={panelRef}>
          <div id="quick-results" className="quick-results" role="listbox" aria-label={searching ? '搜索结果' : '常用应用与插件'} aria-busy={busy}>
            {groups.map((group) => <div key={group.id} className="quick-result-group" role="group" aria-labelledby={`quick-group-${group.id}`}>
              <div className="quick-section-head"><h2 id={`quick-group-${group.id}`}>{group.title}</h2></div>
              <div className="quick-group-items">
                {group.items.map((cmd, groupIndex) => {
                  const i = group.offset + groupIndex
                  return <button key={cmd.id} id={`quick-item-${i}`} type="button" role="option" aria-selected={index === i} tabIndex={-1} data-index={i} data-quick-command
                    className={`quick-item quick-result${index === i ? ' active' : ''}`} title={`${cmd.title} · ${cmd.kind === 'plugin' ? '插件' : cmd.kind === 'app' ? '本机应用' : cmd.subtitle}`}
                    disabled={Boolean(opening)} onMouseEnter={() => selectIndex(i)} onMouseDown={event => event.preventDefault()} onClick={() => void openItem(cmd)}>
                    <ItemIcon cmd={cmd} /><span className="quick-item-copy"><span className="quick-item-title"><HighlightTitle text={cmd.title} query={query} /></span></span>
                    {opening === cmd.id && <span className="quick-item-opening" aria-label="打开中" /> }
                  </button>
                })}
              </div>
            </div>)}
          </div>
          {!visibleItems.length && <div className="quick-empty"><span>{busy || backgroundBusy ? '正在查找应用与插件…' : searching ? '没有找到匹配项' : '暂时没有常用应用或插件'}</span><small>{busy || backgroundBusy ? '正在补齐搜索结果，请稍候' : searching ? '试试应用名称、插件名或指令关键词' : '搜索并打开后会显示在这里'}</small>
            {!busy && !backgroundBusy && <button type="button" onClick={() => void execute({ kind: 'action', action: 'refresh-apps' }, 'refresh').then((ok) => { if (ok) setRevision((v) => v + 1) })}>重新扫描应用</button>}</div>}
        </div>
      </>}
    </div>
  </div>
}
