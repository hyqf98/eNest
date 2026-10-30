/** Source-bundled default Quick provider; no shell API, launch paths or plugin payloads. */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import gsap from 'gsap'
import type { QuickCommandKind } from '@shared/types/quick'
import type { QuickThemeAction, QuickThemeActionResult, QuickThemeItem, QuickThemeSnapshot } from '@shared/types/quickTheme'
import { QUICK_BAR_AREA_H, QUICK_BORDER_WIDTH, QUICK_CONTENT_HEIGHT, QUICK_CORNER_RADIUS, QUICK_GRID_COLUMNS, QUICK_HOME_HEIGHT, QUICK_HOME_ROWS } from '@shared/constants'
import { IS_MAC } from '@shared/platform'
import { normalizeSearchText } from '@shared/search'
import { d, ease } from '@renderer/gsap/marketMotion'
import { Button } from '@renderer/components/ui/Button'
import { SearchField } from '@renderer/components/SearchField'
import { ChevronLeftIcon, HouseIcon, RotateCwIcon, SearchIcon, SettingsIcon } from '@renderer/components/icons'
import { DefaultQuickBackground } from './DefaultQuickBackground'
import { QuickAccessMenu } from './QuickAccessMenu'
import { groupQuickCommands, moveQuickGridSelection, quickSelectionIndex, type QuickGridKey } from './grid'
import { getQuickSearchResults } from './searchResults'
import { assembleDefaultQuickResults, matchDefaultQuickMedia, rankDefaultQuickHome } from './catalogPolicy'
import { useQuickNameSearch } from './useQuickNameSearch'
import { useQuickContentMatches } from './useQuickContentMatches'
import { defaultQuickPreferredKey, projectDefaultQuickUsage, type DefaultQuickOpened } from './usagePolicy'
import type { DefaultQuickStateClient } from './usageState'
import { useQuickUsage } from './useQuickUsage'
import './quick.css'

export interface DefaultQuickSurfaceProps {
  snapshot: QuickThemeSnapshot
  active: boolean
  /** Compatibility policy for v1 themes which only replace presentation. */
  searchActive?: boolean
  /** Internal retry/source invalidation only, never a public theme protocol field. */
  retryRevision?: number
  privateState: DefaultQuickStateClient
  onAction(action: QuickThemeAction): Promise<QuickThemeActionResult>
}
export interface DefaultQuickSurfaceHandle {
  focus(selectAll?: boolean): void
  /** Display-only v1 providers delegate their legacy grid keys to the default policy. */
  navigate(key: string, shift?: boolean): string | null
  layout(columns: number): void
  recordOpened(opened: DefaultQuickOpened): void
}

const FILTERS: { kind: QuickCommandKind; label: string }[] = [
  { kind: 'app', label: '应用' }, { kind: 'plugin', label: '插件' }, { kind: 'action', label: '操作' }
]

function CategoryIcon({ kind }: { kind: QuickCommandKind }) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {kind === 'app' ? <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" /></> : kind === 'plugin' ? <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></> : <><path d="m5 7 5 5-5 5M13 17h6" /></>}
  </svg>
}

function ItemIcon({ item }: { item: QuickThemeItem }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [item.icon])
  return <span className={`quick-icon-tile kind-${item.kind}${item.icon && !failed ? ' has-icon' : ''}`} aria-hidden>
    {item.icon && !failed ? <img src={item.icon} alt="" onError={() => setFailed(true)} draggable={false} /> :
      item.kind === 'action' ? item.action === 'open-settings' ? <SettingsIcon size={25} /> : item.action === 'refresh-apps' ? <RotateCwIcon size={25} /> : <HouseIcon size={25} /> :
        <span>{Array.from(item.title || '?')[0].toUpperCase()}</span>}
  </span>
}

function HighlightTitle({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLocaleLowerCase(), index = q ? text.toLocaleLowerCase().indexOf(q) : -1
  return index < 0 ? <>{text}</> : <>{text.slice(0, index)}<mark>{text.slice(index, index + q.length)}</mark>{text.slice(index + q.length)}</>
}

export const DefaultQuickSurface = forwardRef<DefaultQuickSurfaceHandle, DefaultQuickSurfaceProps>(function DefaultQuickSurface(
  { snapshot, active, searchActive = active, retryRevision = 0, privateState, onAction }, ref
) {
  const rootRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null), panelRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null), marketRef = useRef<HTMLButtonElement>(null)
  const actionRef = useRef(onAction)
  actionRef.current = onAction
  const dispatch = useCallback((action: QuickThemeAction) => actionRef.current(action), [])
  const { usage, recordOpened, refreshUsage } = useQuickUsage(privateState)
  useEffect(() => { if (searchActive) refreshUsage() }, [searchActive, snapshot.shown, refreshUsage])
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [columns, setColumns] = useState(QUICK_GRID_COLUMNS)
  const composing = useRef(false)
  const plugin = snapshot.plugin
  const showResults = !plugin
  const query = snapshot.query, kind = snapshot.filter
  const hasQuery = Boolean(query.trim())
  const inputItems = snapshot.input?.items ?? []
  const media = useMemo(() => matchDefaultQuickMedia(snapshot.catalog, snapshot.input?.items), [snapshot.catalog, snapshot.input])
  const searching = snapshot.searching || (media.mediaPresent && media.matches.size > 0)
  const focus = useCallback((selectAll = false) => { inputRef.current?.focus(); if (selectAll) inputRef.current?.select() }, [])
  useLayoutEffect(() => {
    if (rootRef.current) rootRef.current.inert = !active
    if (active) focus()
  }, [active, focus])
  useEffect(() => { setCategoriesOpen(false) }, [snapshot.shown, Boolean(plugin)])
  useLayoutEffect(() => { if (panelRef.current) panelRef.current.scrollTop = 0 }, [snapshot.queryRevision])

  const usageCatalog = useMemo(() => projectDefaultQuickUsage(snapshot.catalog, usage, ''), [snapshot.catalog, usage])
  const policyEnabled = searchActive && !plugin
  const names = useQuickNameSearch(usageCatalog, query, kind, policyEnabled, snapshot.composing, retryRevision, defaultQuickPreferredKey(usage, query))
  const content = useQuickContentMatches(snapshot.catalog, query, policyEnabled && !snapshot.composing, retryRevision)
  const policyPending = names.pending
  const displayError = snapshot.error || (hasQuery ? names.error : null)
  const ranked = useMemo(() => {
    const limit = searching || media.mediaPresent ? 60 : QUICK_GRID_COLUMNS * QUICK_HOME_ROWS
    if (!hasQuery) return rankDefaultQuickHome(usageCatalog, kind, limit, media.matches)
    const named = normalizeSearchText(query).length <= 32 || !media.mediaPresent ? names.matches : names.matches.filter(item => item.prefix)
    return assembleDefaultQuickResults(usageCatalog, named, kind, limit, content.matches, media.matches, media.mediaPresent)
  }, [usageCatalog, query, kind, searching, content.matches, media, hasQuery, names.matches])
  const allGroups = useMemo(() => showResults ? groupQuickCommands(ranked, searching || kind === 'action', QUICK_GRID_COLUMNS * QUICK_HOME_ROWS) : [], [ranked, searching, kind, showResults])
  const { groups, visibleItems, overflowCount } = useMemo(() => getQuickSearchResults(allGroups, columns, searching, snapshot.expanded), [allGroups, columns, searching, snapshot.expanded])
  const index = quickSelectionIndex(visibleItems, snapshot.selectedId)
  const selected = visibleItems[index]
  const busy = snapshot.loading || policyPending || content.pending
  const showMarketEmpty = searching && !kind && showResults && !busy && !snapshot.composing && !displayError
    && !ranked.some(item => item.kind === 'app' || item.kind === 'plugin')

  useImperativeHandle(ref, () => ({
    focus,
    recordOpened,
    layout: value => setColumns(Math.max(1, Math.min(8, Math.round(value)))),
    navigate: (key, shift) => {
      if (!searchActive || plugin || snapshot.busy || !visibleItems.length
        || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(key)
        || shift && key !== 'Tab' || query && ['ArrowLeft', 'ArrowRight'].includes(key)) return null
      const next = moveQuickGridSelection(index, groups.map(group => group.items.length), columns, key as QuickGridKey, shift)
      return visibleItems[next].id
    }
  }), [focus, recordOpened, searchActive, plugin, snapshot.busy, visibleItems, query, index, groups, columns])

  useEffect(() => {
    if (!searchActive || plugin || snapshot.composing || hasQuery && policyPending) return
    void dispatch({ type: 'results', catalogRevision: snapshot.catalogRevision, queryRevision: snapshot.queryRevision,
      items: visibleItems.map(item => ({ id: item.id, title: item.title, group: item.group })), hiddenCount: overflowCount,
      emptyMarket: showMarketEmpty, expanded: snapshot.expanded })
  }, [searchActive, Boolean(plugin), snapshot.composing, hasQuery, policyPending, visibleItems, overflowCount, showMarketEmpty, snapshot.expanded, snapshot.catalogRevision, snapshot.queryRevision, dispatch])

  useLayoutEffect(() => {
    panelRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [index, visibleItems])
  useLayoutEffect(() => {
    if (!active || !rootRef.current) return
    const context = gsap.context(() => {
      gsap.fromTo('.quick-search-bar .search-box', { opacity: 0 }, { opacity: 1, duration: d(0.25), ease: ease('power2.out') })
    }, rootRef.current)
    return () => context.revert()
  }, [active, snapshot.shown])
  useLayoutEffect(() => {
    if (!active || !panelRef.current || plugin) return
    const context = gsap.context(() => {
      gsap.fromTo(panelRef.current, { opacity: 0 }, { opacity: 1, duration: d(0.28), ease: ease('power2.out') })
    }, panelRef.current)
    return () => context.revert()
  }, [active, showResults, searching, kind, snapshot.shown])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!active || !panel || plugin) return
    let frame = 0, previousHeight = 0
    const measure = () => {
      frame = 0
      const style = getComputedStyle(panel), results = panel.querySelector<HTMLElement>('.quick-results')
      if (results && rootRef.current) rootRef.current.style.setProperty('--quick-content-inset', `${results.getBoundingClientRect().left - panel.getBoundingClientRect().left}px`)
      const grid = results?.querySelector<HTMLElement>('.quick-group-items')
      if (grid) {
        const width = getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(track => track && track !== 'none').length
        if (width && width !== columns) { setColumns(width); return }
      }
      const intrinsic = Array.from(panel.children).reduce((height, child) => height + child.getBoundingClientRect().height, 0)
      const height = searching ? Math.ceil(panel.getBoundingClientRect().top + intrinsic + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 1) : QUICK_HOME_HEIGHT
      if (height !== previousHeight) { previousHeight = height; void dispatch({ type: 'layout', columns, height }) }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(panel)
    for (const child of panel.children) observer.observe(child)
    measure()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [active, Boolean(plugin), searching, visibleItems.length, columns, snapshot.expanded, overflowCount, showMarketEmpty, snapshot.shown, dispatch])

  const select = (next: number) => { if (visibleItems[next]) void dispatch({ type: 'select', id: visibleItems[next].id }) }
  const open = (item: QuickThemeItem, mainWindow = false) => dispatch({ type: 'open', id: item.id, ...(mainWindow ? { container: 'shell' as const } : {}) })
  const changeQuery = (value: string) => { void dispatch({ type: 'query', query: value }) }
  const onPaste = (event: { clipboardData: DataTransfer | null; preventDefault(): void }) => {
    if (plugin || !searchActive) return
    // 文本粘贴保持默认插入行为；仅在剪贴板携带图片/文件时拦截并交给宿主上下文。
    const carriesMedia = Array.from(event.clipboardData?.items ?? []).some(item =>
      item.kind === 'file' && (item.type.startsWith('image/') || item.type === 'Files' || item.type === 'text/uri-list' || !item.type))
    if (!carriesMedia) return
    event.preventDefault()
    void dispatch({ type: 'paste' })
  }
  const nativeKey = (event: KeyboardEvent) => dispatch({ type: 'key', key: event.key, shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey })
  const onKeyDown = (event: KeyboardEvent) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    const inInput = event.target === inputRef.current
    const hasSelection = inInput && inputRef.current?.selectionStart !== inputRef.current?.selectionEnd
    if (event.key === 'Backspace' && inInput && !query && !hasSelection && inputItems.length) {
      event.preventDefault()
      void dispatch({ type: 'input-clear', id: inputItems[inputItems.length - 1].id })
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); focus(true); return }
    if (event.key === 'F6' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      if (inInput) rootRef.current?.querySelector<HTMLButtonElement>('.quick-access-trigger')?.focus()
      else focus()
      return
    }
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (!plugin && !query && categoriesOpen) { setCategoriesOpen(false); focus() }
      else void nativeKey(event)
      return
    }
    if (showMarketEmpty && !visibleItems.length && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (inInput && !event.shiftKey) {
        if (event.key === 'Enter') { event.preventDefault(); void dispatch({ type: 'open-market' }); return }
        if (event.key === 'ArrowDown' || event.key === 'Tab') { event.preventDefault(); marketRef.current?.focus(); return }
      }
      if (event.target === marketRef.current && (event.key === 'Tab' || event.key === 'ArrowUp' && !event.shiftKey)) { event.preventDefault(); focus(); return }
    }
    if (hasSelection && ['Enter', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    if (plugin) {
      if (inInput && event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey || event.key === 'Enter' && (event.metaKey || event.ctrlKey)
        || inInput && plugin.acceptsInput && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) { event.preventDefault(); void nativeKey(event) }
      return
    }
    if (event.target === moreRef.current && event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); select(event.shiftKey ? Math.max(0, visibleItems.length - 1) : 0); focus(); return
    }
    const inGrid = event.target instanceof Element && Boolean(event.target.closest('[data-quick-command]'))
    if ((!inInput && !inGrid) || snapshot.busy || !showResults) return
    const navigation: QuickGridKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']
    if (navigation.includes(event.key as QuickGridKey)) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey && event.key !== 'Tab' || inInput && query && ['ArrowLeft', 'ArrowRight'].includes(event.key) || !visibleItems.length) return
      event.preventDefault()
      if (event.key === 'Tab' && moreRef.current && (event.shiftKey ? index === 0 : index === visibleItems.length - 1)) { moreRef.current.focus(); return }
      select(moveQuickGridSelection(index, groups.map(group => group.items.length), columns, event.key as QuickGridKey, event.shiftKey)); focus()
    }
    if (event.key === 'Enter' && !event.altKey && !event.shiftKey) { event.preventDefault(); if (selected) void open(selected, event.metaKey || event.ctrlKey) }
  }
  const modifier = IS_MAC ? '⌘' : 'Ctrl'

  return <div ref={rootRef} className="quick-root" data-mode={plugin ? 'plugin' : 'list'} data-expanded="true" data-home={!searching && !plugin}
    style={{ '--quick-bar-h': `${QUICK_BAR_AREA_H}px`, '--quick-border-w': `${QUICK_BORDER_WIDTH}px`, '--quick-home-h': `${QUICK_HOME_HEIGHT}px`, '--quick-content-max-h': `${QUICK_CONTENT_HEIGHT}px`, '--quick-radius': `${QUICK_CORNER_RADIUS}px`, '--quick-grid-columns': QUICK_GRID_COLUMNS, '--quick-home-rows': QUICK_HOME_ROWS } as CSSProperties} onKeyDown={onKeyDown}>
    <div className="quick-shell">
      <DefaultQuickBackground active={active} />
      <div className="quick-search-bar" role="search" data-tools={plugin ? 'plugin' : categoriesOpen ? 'expanded' : 'collapsed'}>
        <SearchField value={query} onChange={changeQuery} inputRef={inputRef}
          placeholder={plugin ? plugin.placeholder : kind === 'app' ? '搜索软件…' : kind === 'plugin' ? '搜索插件…' : kind === 'action' ? '搜索系统操作…' : '搜索应用、插件与指令…'}
          leading={plugin ? <>
            <button type="button" className="quick-search-leading quick-plugin-back" onClick={() => void dispatch({ type: 'plugin-back' })} title={`返回全局搜索 · ${plugin.title}（Esc）`} aria-label="返回全局搜索"><ChevronLeftIcon size={20} /></button>
            <button type="button" className="quick-plugin-grip" data-quick-native-drag title={`拖出「${plugin.title}」成为独立窗口；点击也可分离`} aria-label={`将${plugin.title}独立显示`} onClick={() => void dispatch({ type: 'plugin-detach' })}>
              <span aria-hidden="true">⠿</span><span>{plugin.title}</span>
            </button>
          </> : <>
            {inputItems.length > 0 && <span className="quick-input-chips" role="list" aria-label="粘贴内容">
              {inputItems.slice(0, 4).map(chip => <span key={chip.id} className={`quick-input-chip kind-${chip.kind}`} role="listitem" title={chip.name ?? (chip.kind === 'image' ? '图片' : '文件')}>
                <img src={chip.thumbnail} alt="" draggable={false} />
                <button type="button" aria-label={`移除${chip.name ?? (chip.kind === 'image' ? '图片' : '文件')}`} onClick={() => { void dispatch({ type: 'input-clear', id: chip.id }); focus() }}>×</button>
              </span>)}
              {inputItems.length > 4 && <span className="quick-input-chip more" role="listitem">+{inputItems.length - 4}</span>}
            </span>}
            <span className="quick-search-leading" aria-hidden><SearchIcon size={19} /></span>
          </>}
          accessory={<>
            {!plugin && busy && <span className="quick-input-status"><span className="quick-spinner" aria-label="搜索中" /></span>}
            <span className="quick-inline-tools">
              {plugin && <button className="quick-tool quick-pin" type="button" title={`移到主窗口（${modifier} Enter）`} aria-label="移到主窗口" onClick={() => void dispatch({ type: 'plugin-pin' })}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3h7v7m0-7-10 10" /><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5" /></svg>
              </button>}
              <QuickAccessMenu key={`${snapshot.shown}-${Boolean(plugin)}`} onMarket={() => void dispatch({ type: 'open-market' })} onSettings={() => void dispatch({ type: 'open-settings' })} onDismiss={() => focus()}>
                {!plugin && <Button className="quick-tool quick-scope-toggle" aria-expanded={categoriesOpen} aria-controls="quick-categories" aria-label={categoriesOpen ? '收起搜索分类' : '展开搜索分类'} data-filtered={Boolean(kind)}
                  title={`${categoriesOpen ? '收起' : '展开'}搜索分类${kind ? ` · 当前：${FILTERS.find(filter => filter.kind === kind)!.label}` : ''}`} onClick={() => { setCategoriesOpen(value => !value); focus() }}>
                  {kind ? <CategoryIcon kind={kind} /> : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>}
                </Button>}
              </QuickAccessMenu>
            </span>
          </>}
          inputProps={{ role: 'combobox', readOnly: Boolean(plugin && !plugin.acceptsInput), 'aria-expanded': showResults, 'aria-controls': showResults ? 'quick-results' : undefined, 'aria-activedescendant': showResults && selected && !snapshot.busy ? `quick-item-${index}` : undefined,
            onPaste: event => onPaste(event),
            onCompositionStart: () => { composing.current = true; void dispatch({ type: 'composition', active: true }) },
            onCompositionEnd: () => { composing.current = false; void dispatch({ type: 'composition', active: false }) } }} />
        {!plugin && <div className="quick-categories-slot" id="quick-categories" aria-hidden={!categoriesOpen}><div className="quick-categories" aria-label="搜索范围">
          {FILTERS.map(filter => <button key={filter.kind} type="button" className="quick-category" tabIndex={categoriesOpen ? 0 : -1} aria-label={filter.label} aria-pressed={kind === filter.kind}
            title={`${filter.label}${kind === filter.kind ? ' · 点击查看全部' : ''}`} onClick={() => { void dispatch({ type: 'filter', kind: kind === filter.kind ? null : filter.kind }); setCategoriesOpen(false); focus() }}><CategoryIcon kind={filter.kind} /></button>)}
        </div></div>}
      </div>
      {displayError && <div className="quick-error" role="alert">{displayError}<button type="button" onClick={() => void dispatch({ type: 'retry' })}>重试</button></div>}
      {plugin?.loading && !displayError && <div className="quick-plugin-loading" role="status" aria-live="polite"><span className="quick-spinner" aria-hidden="true" /><span>正在启动 {plugin.title}…</span></div>}
      {showResults && <div className="quick-panel" data-home={!searching} ref={panelRef}>
        <div id="quick-results" className="quick-results" role="listbox" aria-label={searching ? '搜索结果' : '常用应用与插件'} aria-busy={busy}>
          {groups.map(group => <div key={group.id} className="quick-result-group" role="group" aria-labelledby={`quick-group-${group.id}`}>
            <div className="quick-section-head"><h2 id={`quick-group-${group.id}`}>{group.title}</h2></div>
            <div className="quick-group-items">{group.items.map((item, offset) => {
              const position = group.offset + offset
              return <button key={item.id} id={`quick-item-${position}`} type="button" role="option" aria-selected={index === position} tabIndex={-1} data-index={position} data-quick-command
                className={`quick-item quick-result${index === position ? ' active' : ''}`} title={`${item.title} · ${item.subtitle}`} disabled={snapshot.busy}
                onMouseEnter={() => select(position)} onMouseDown={event => event.preventDefault()} onClick={() => void open(item)}>
                <ItemIcon item={item} /><span className="quick-item-copy"><span className="quick-item-title"><HighlightTitle text={item.title} query={query} /></span></span>
                {snapshot.busy && selected?.id === item.id && <span className="quick-item-opening" aria-label="打开中" />}
              </button>
            })}</div>
          </div>)}
        </div>
        {searching && overflowCount > 0 && <div className="quick-results-disclosure"><Button ref={moreRef} className="quick-results-more" variant="ghost" size="sm" aria-expanded={snapshot.expanded} aria-controls="quick-results"
          aria-label={snapshot.expanded ? '收起搜索结果' : `展开全部搜索结果，另有 ${overflowCount} 项`} onClick={() => {
            if (snapshot.expanded) { select(0); if (panelRef.current) panelRef.current.scrollTop = 0 }
            void dispatch({ type: 'expand', expanded: !snapshot.expanded }); focus()
          }}>{snapshot.expanded ? '收起' : `更多 ${overflowCount}`}</Button></div>}
        {showMarketEmpty && <div className="quick-empty"><span role="status">没有找到插件或本机应用，可以到插件市场找找</span><Button ref={marketRef} className="quick-empty-market" variant="ghost" size="sm" disabled={snapshot.busy} onClick={() => void dispatch({ type: 'open-market' })}>去插件市场</Button></div>}
        {!displayError && !showMarketEmpty && !visibleItems.length && <div className="quick-empty"><span>{busy ? '正在查找应用与插件…' : searching ? '没有找到匹配项' : '暂时没有常用应用或插件'}</span><small>{busy ? '正在补齐搜索结果，请稍候' : searching ? '试试应用名称、插件名或指令关键词' : '搜索并打开后会显示在这里'}</small>
          {!busy && <button type="button" onClick={() => void dispatch({ type: 'refresh-apps' })}>重新扫描应用</button>}</div>}
      </div>}
    </div>
  </div>
})
