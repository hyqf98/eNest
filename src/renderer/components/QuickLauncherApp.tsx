/** Quick owns navigation; the native plugin view owns everything below the search bar. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import gsap from 'gsap'
import type { QuickCommand, QuickCommandKind, QuickOpenRequest, QuickPluginModeInfo } from '@shared/types/quick'
import { QUICK_BAR_AREA_H, QUICK_CORNER_RADIUS } from '@shared/constants'
import { d, dy, ease } from '@renderer/gsap/marketMotion'
import { shellApi } from '@renderer/services/shellApi'
import { useAppearanceSync } from '@renderer/hooks/useAppearanceSync'
import { AmbientParticles } from './AmbientParticles'
import { SearchField } from './SearchField'
import { ChevronLeftIcon, HouseIcon, RotateCwIcon, SettingsIcon } from './icons'
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [shown, setShown] = useState(0)
  const [pluginMode, setPluginMode] = useState<QuickPluginModeInfo | null>(null)
  const modeRef = useRef(pluginMode)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchVersion = useRef(0)
  const openingRef = useRef(false)
  const searching = Boolean(query.trim())
  const showResults = searching && !pluginMode
  const groups = useMemo(() => {
    if (!showResults) return []
    const frequent = items.filter((item) => item.kind === 'app' && (item.useCount || item.lastUsedTs))
    return [
      { id: 'frequent', title: '常用软件', items: frequent },
      { id: 'apps', title: frequent.length ? '其它软件' : '软件', items: items.filter((item) => item.kind === 'app' && !item.useCount && !item.lastUsedTs) },
      { id: 'plugins', title: '插件', items: items.filter((item) => item.kind === 'plugin') },
      { id: 'actions', title: '系统操作', items: items.filter((item) => item.kind === 'action') }
    ].filter((group) => group.items.length).map((group, i, all) => ({ ...group, offset: all.slice(0, i).reduce((total, previous) => total + previous.items.length, 0) }))
  }, [items, showResults])
  const visibleItems = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const resetResults = useCallback(() => {
    searchVersion.current++
    setItems([])
    setIndex(0)
    setError('')
    setBusy(false)
  }, [])

  useEffect(() => {
    const version = ++searchVersion.current
    if (pluginMode || !searching) return
    setBusy(true)
    setError('')
    const timer = window.setTimeout(async () => {
      try {
        const result = await shellApi.quickSearch?.(query, 60, kind)
        if (version !== searchVersion.current) return
        setItems(result?.items ?? [])
        setIndex(0)
      } catch {
        if (version === searchVersion.current) { setItems([]); setError('搜索暂时不可用，请重试。') }
      } finally {
        if (version === searchVersion.current) setBusy(false)
      }
    }, 80)
    return () => { clearTimeout(timer); searchVersion.current++ }
  }, [query, kind, revision, pluginMode, searching])

  useEffect(() => {
    const off = shellApi.onEvent?.((event) => {
      if (event.type === 'quick-plugin-mode') {
        modeRef.current = event.mode
        setPluginMode(event.mode)
        if (event.mode) { setQuery(''); resetResults(); setCategoriesOpen(false) }
        setError('')
        setOpening(null)
        requestAnimationFrame(() => inputRef.current?.focus())
      } else if (event.type === 'quick-focus-search') {
        inputRef.current?.focus()
        inputRef.current?.select()
      } else if (event.type === 'plugins-changed') setRevision((v) => v + 1)
    })
    const offShown = shellApi.onQuickShown?.(() => {
      setQuery('')
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

  // Animate content, never the native clipping surface or its plugin bounds.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const ctx = gsap.context(() => {
      gsap.fromTo('.quick-search-bar', { opacity: 0, y: dy(-5) }, { opacity: 1, y: 0, duration: d(0.25), ease: ease('power2.out') })
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
  }, [showResults, kind, shown])

  useLayoutEffect(() => {
    if (pluginMode || !rootRef.current) return
    const root = rootRef.current
    const resize = () => shellApi.quickResize?.(Math.ceil(root.getBoundingClientRect().height), false)
    const observer = new ResizeObserver(resize)
    observer.observe(root)
    resize()
    return () => observer.disconnect()
  }, [pluginMode, shown])

  useEffect(() => {
    if (index >= visibleItems.length) setIndex(Math.max(0, visibleItems.length - 1))
    panelRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
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

  const escapePlugin = useCallback(async () => {
    const mode = modeRef.current
    if (!mode) return true
    const ok = await execute({ kind: 'plugin-escape', pluginId: mode.pluginId }, mode.pluginId)
    if (ok) { modeRef.current = null; setPluginMode(null); requestAnimationFrame(() => inputRef.current?.focus()) }
    return ok
  }, [execute])

  const changeQuery = useCallback((value: string) => {
    resetResults()
    setBusy(Boolean(value.trim()))
    setQuery(value)
    if (modeRef.current && !openingRef.current) void escapePlugin()
  }, [escapePlugin, resetResults])

  const openItem = useCallback(async (cmd: QuickCommand, mainWindow = false) => {
    if (busy) return
    let request: QuickOpenRequest | undefined
    if (cmd.kind === 'app' && cmd.path) request = { kind: 'app', path: cmd.path }
    if (cmd.kind === 'plugin' && cmd.pluginId) request = { kind: 'plugin', pluginId: cmd.pluginId, code: cmd.code, container: !mainWindow && cmd.form === 'mini' ? 'quick' : 'shell' }
    if (cmd.kind === 'action' && cmd.action) request = { kind: 'action', action: cmd.action }
    if (request && await execute(request, cmd.id) && cmd.action === 'refresh-apps') setRevision((v) => v + 1)
  }, [busy, execute])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    const inInput = event.target === inputRef.current
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (pluginMode) void escapePlugin()
      else if (query) changeQuery('')
      else if (categoriesOpen) { setCategoriesOpen(false); inputRef.current?.focus() }
      else if (kind) { setKind(undefined); resetResults() }
      else shellApi.quickHide?.()
      return
    }
    if (pluginMode) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault(); void execute({ kind: 'plugin-pin', pluginId: pluginMode.pluginId }, pluginMode.pluginId)
      }
      return
    }
    if (!inInput || busy || !showResults) return
    let delta = 0
    if (event.key === 'ArrowDown') delta = 1
    if (event.key === 'ArrowUp') delta = -1
    if (delta) { event.preventDefault(); setIndex((i) => Math.max(0, Math.min(visibleItems.length - 1, i + delta))) }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (visibleItems[index]) void openItem(visibleItems[index], event.metaKey || event.ctrlKey)
    }
  }

  const selected = visibleItems[index]
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  const actionHint = selected?.kind === 'plugin' ? selected.form === 'mini' ? '在此展开' : '在主窗口打开' : selected?.kind === 'app' ? '打开应用' : '执行操作'

  return <div ref={rootRef} className="quick-root" data-mode={pluginMode ? 'plugin' : 'list'} data-expanded={showResults || Boolean(pluginMode)}
    style={{ '--quick-bar-h': `${QUICK_BAR_AREA_H}px`, '--quick-radius': `${QUICK_CORNER_RADIUS}px` } as CSSProperties} onKeyDown={onKeyDown}>
    <div className="quick-shell">
      {showResults && <AmbientParticles />}
      <div className="quick-search-bar" role="search" data-tools={pluginMode ? 'plugin' : categoriesOpen ? 'expanded' : 'collapsed'}>
        <SearchField value={query} onChange={changeQuery} inputRef={inputRef}
          placeholder={pluginMode ? '搜索其它应用或插件…' : kind === 'app' ? '搜索软件…' : kind === 'plugin' ? '搜索插件…' : kind === 'action' ? '搜索系统操作…' : '搜索应用、插件与指令…'}
          leading={pluginMode ? <button type="button" className="quick-plugin-chip" onClick={() => void escapePlugin()} title="返回搜索（Esc）"><ChevronLeftIcon size={16} /><span>{pluginMode.title}</span></button> : undefined}
          trailing={<kbd className="search-shortcut">{modifier} K</kbd>}
          accessory={!pluginMode && <>
            {busy && showResults && <span className="quick-spinner" aria-label="搜索中" />}
            <button type="button" className="quick-scope-toggle" aria-expanded={categoriesOpen} aria-controls="quick-categories"
              aria-label={categoriesOpen ? '收起搜索分类' : '展开搜索分类'} data-filtered={Boolean(kind)}
              title={`${categoriesOpen ? '收起' : '展开'}搜索分类${kind ? ` · 当前：${FILTERS.find((filter) => filter.kind === kind)!.label}` : ''}`}
              onClick={() => { setCategoriesOpen((open) => !open); inputRef.current?.focus() }}>
              {kind ? <CategoryIcon kind={kind} /> : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></svg>}
            </button>
          </>}
          inputProps={{ role: 'combobox', 'aria-expanded': showResults, 'aria-controls': showResults ? 'quick-results' : undefined, 'aria-activedescendant': showResults && selected && !busy ? `quick-item-${index}` : undefined }} />
        {pluginMode ? <button className="quick-category quick-pin" type="button" title={`移到主窗口（${modifier} Enter）`} aria-label="移到主窗口" onClick={() => void execute({ kind: 'plugin-pin', pluginId: pluginMode.pluginId }, pluginMode.pluginId)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 3h7v7m0-7-10 10" /><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5" /></svg>
        </button> : <div className="quick-categories-slot" id="quick-categories" aria-hidden={!categoriesOpen}>
          <div className="quick-categories" aria-label="搜索范围">
            {FILTERS.map((filter) => <button key={filter.kind} type="button" className="quick-category" tabIndex={categoriesOpen ? 0 : -1} aria-label={filter.label} aria-pressed={kind === filter.kind}
              title={`${filter.label}${kind === filter.kind ? ' · 点击查看全部' : ''}`} onClick={() => {
                resetResults(); setBusy(searching); setKind((current) => current === filter.kind ? undefined : filter.kind); inputRef.current?.focus()
              }}><CategoryIcon kind={filter.kind} /></button>)}
          </div>
        </div>}
      </div>
      {error && (showResults || pluginMode) && <div className="quick-error" role="alert">{error}<button type="button" onClick={() => setRevision((v) => v + 1)}>重试</button></div>}
      {showResults && <>
        <div className="quick-panel" ref={panelRef}>
          <div id="quick-results" className="quick-results" role="listbox" aria-label="搜索结果" aria-busy={busy}>
            {groups.map((group) => <div key={group.id} className="quick-result-group" role="group" aria-labelledby={`quick-group-${group.id}`}>
              <div className="quick-section-head"><h2 id={`quick-group-${group.id}`}>{group.title}</h2><span className="quick-section-meta">{group.items.length} 项</span></div>
              <div className="quick-group-items">
                {group.items.map((cmd, groupIndex) => {
                  const i = group.offset + groupIndex
                  return <button key={cmd.id} id={`quick-item-${i}`} type="button" role="option" aria-selected={index === i} tabIndex={-1} data-index={i}
                    className={`quick-item quick-result${index === i ? ' active' : ''}`} title={`${cmd.title} · ${cmd.kind === 'plugin' ? cmd.form === 'mini' ? '小窗插件' : '主窗插件' : cmd.kind === 'app' ? '本机应用' : cmd.subtitle}`}
                    disabled={Boolean(opening)} onMouseMove={() => setIndex(i)} onClick={() => void openItem(cmd)}>
                    <ItemIcon cmd={cmd} /><span className="quick-item-copy"><span className="quick-item-title"><HighlightTitle text={cmd.title} query={query} /></span>
                      <span className="quick-item-subtitle">{cmd.kind === 'app' ? '本机应用' : cmd.subtitle}</span></span>
                    <span className="quick-result-type">{opening === cmd.id ? '打开中…' : cmd.kind === 'app' ? '应用' : cmd.kind === 'action' ? '操作' : cmd.form === 'mini' ? '小窗插件' : '主窗插件'}</span>
                  </button>
                })}
              </div>
            </div>)}
          </div>
          {!visibleItems.length && <div className="quick-empty"><span>{busy ? '正在查找应用与插件…' : '没有找到匹配项'}</span><small>{busy ? '首次扫描可能需要片刻' : '试试应用名称、插件名或指令关键词'}</small>
            {!busy && <button type="button" onClick={() => void execute({ kind: 'action', action: 'refresh-apps' }, 'refresh').then((ok) => { if (ok) setRevision((v) => v + 1) })}>重新扫描应用</button>}</div>}
        </div>
        <footer className="quick-footer"><span className="quick-wordmark">eNest <span>Quick</span></span><div><span><kbd>↑ ↓</kbd> 选择</span><span><kbd>↵</kbd> {actionHint}</span><span><kbd>esc</kbd> 清空</span></div></footer>
      </>}
    </div>
  </div>
}
