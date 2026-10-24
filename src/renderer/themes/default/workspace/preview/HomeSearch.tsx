import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { PluginSummary } from '@shared/types/plugin'
import type { QuickCommand } from '@shared/types/quick'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import { SearchBox } from '@renderer/themes/default/workspace/SearchBox'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { homeSearchEntries, homeSearchOpenRequest, searchHomeCommands, type HomeSearchEntry, type HomeSearchScope } from '@renderer/themes/default/quick/legacyHomeSearchModel'
import '@renderer/themes/default/workspace/homeSearch.css'

interface Props {
  value: string
  onChange: (value: string) => void
  plugins: PluginSummary[]
  onDetail: (id: string, origin?: HTMLElement | null) => void
  onBrowseAll: () => void
}

interface ResultsState {
  query: string
  scope: HomeSearchScope
  items: QuickCommand[]
  loading: boolean
  enriching: boolean
  error?: 'static' | 'partial'
}

const SCOPES: { id: HomeSearchScope; zh: string; en: string }[] = [
  { id: 'all', zh: '全部', en: 'All' },
  { id: 'app', zh: '本机应用', en: 'Applications' },
  { id: 'plugin', zh: '已安装插件', en: 'Installed plugins' },
  { id: 'market', zh: '插件市场', en: 'Marketplace' },
  { id: 'action', zh: '快捷操作', en: 'Actions' },
]

export function HomeSearch({ value, onChange, plugins, onDetail, onBrowseAll }: Props) {
  const { locale } = useI18n()
  const english = locale === 'en-US'
  const [scope, setScope] = useState<HomeSearchScope>('all')
  const [revision, setRevision] = useState(0)
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const requestVersion = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const [results, setResults] = useState<ResultsState>({ query: '', scope: 'all', items: [], loading: false, enriching: false })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const openingRef = useRef(false)
  const failedEntryRef = useRef<HomeSearchEntry | null>(null)
  const [openError, setOpenError] = useState('')
  const listId = useId()
  const searching = Boolean(value.trim())
  const currentResults = results.query === value && results.scope === scope && !composing
  const loading = searching && scope !== 'market' && (!currentResults || results.loading)
  const entries = useMemo(() => homeSearchEntries(currentResults ? results.items : [], plugins, value, scope), [currentResults, results.items, plugins, value, scope])
  const selectedIndex = Math.max(0, entries.findIndex((entry) => entry.id === selectedId))
  const selected = entries[selectedIndex]

  useEffect(() => {
    const version = ++requestVersion.current
    if (!searching || composing || scope === 'market') return
    let alive = true
    const current = () => alive && version === requestVersion.current
    setResults({ query: value, scope, items: [], loading: true, enriching: false })
    const timer = window.setTimeout(async () => {
      try {
        const request = shellApi.quickSearch
        if (!request) throw new Error('Search unavailable')
        const partialFailure = await searchHomeCommands(value, scope === 'all' ? undefined : scope, request,
          (items, initial) => {
            if (!current()) return
            if (initial) setSelectedId(items[0]?.id ?? null)
            setResults({ query: value, scope, items, loading: false, enriching: true })
          }, current)
        if (current()) setResults((state) => ({ ...state, enriching: false, error: partialFailure ? 'partial' : undefined }))
      } catch {
        if (current()) setResults({ query: value, scope, items: [], loading: false, enriching: false, error: 'static' })
      }
    }, 80)
    return () => { alive = false; clearTimeout(timer); requestVersion.current++ }
  }, [value, scope, revision, composing, searching])

  useEffect(() => shellApi.onEvent((event) => {
    if (event.type === 'plugins-changed') setRevision((current) => current + 1)
  }), [])

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  const changeQuery = (next: string) => {
    requestVersion.current++
    failedEntryRef.current = null
    setSelectedId(null)
    setOpenError('')
    onChange(next)
  }
  const browseAll = () => {
    requestVersion.current++
    failedEntryRef.current = null
    setScope('all')
    setSelectedId(null)
    setOpenError('')
    onBrowseAll()
  }
  const changeScope = (next: HomeSearchScope) => {
    if (next === scope) { inputRef.current?.focus(); return }
    requestVersion.current++
    failedEntryRef.current = null
    setSelectedId(null)
    setOpenError('')
    setScope(next)
    inputRef.current?.focus()
  }
  const choose = (index: number) => {
    setSelectedId(entries[index]?.id ?? null)
    resultsRef.current?.querySelector<HTMLElement>(`[data-home-result-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  const open = async (entry: HomeSearchEntry, origin?: HTMLElement | null) => {
    if (openingRef.current || (entry.kind === 'command' && loading)) return
    if (entry.kind === 'market') {
      const index = entries.findIndex(item => item.id === entry.id)
      onDetail(entry.plugin.id, origin ?? resultsRef.current?.querySelector<HTMLElement>(`[data-home-result-index="${index}"]`) ?? null)
      return
    }
    const request = homeSearchOpenRequest(entry.command, value)
    if (!request) return
    openingRef.current = true
    failedEntryRef.current = null
    const version = requestVersion.current
    setOpening(entry.id)
    setOpenError('')
    try {
      const result = await shellApi.quickOpen?.(request)
      if (!result?.ok) throw new Error(result?.error || (english ? 'Unable to open this result. Please try again.' : '暂时无法打开，请重试。'))
      if (entry.command.action === 'refresh-apps') setRevision((current) => current + 1)
      if (entry.command.action === 'open-market') browseAll()
    } catch (error) {
      if (version === requestVersion.current) {
        failedEntryRef.current = entry
        setOpenError(error instanceof Error ? error.message : english ? 'Unable to open this result.' : '暂时无法打开。')
      }
    } finally {
      openingRef.current = false
      setOpening(null)
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); browseAll(); inputRef.current?.focus(); return }
    if (!searching || event.altKey || event.shiftKey || ((event.metaKey || event.ctrlKey) && event.key !== 'Enter')) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!entries.length || loading) return
      event.preventDefault()
      choose((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length)
      inputRef.current?.focus()
    } else if (event.key === 'Enter' && selected && !loading) {
      event.preventDefault()
      if (!event.repeat) void open(selected)
    }
  }

  const sections: { id: string; title: string; entries: { entry: HomeSearchEntry; index: number }[] }[] = []
  const titles: Record<string, string> = english
    ? { best: 'Best results', match: 'Matches', recommendation: 'Suggested matches', provider: 'Plugin results', market: 'Plugin marketplace' }
    : { best: '最佳结果', match: '匹配结果', recommendation: '相关推荐', provider: '插件搜索结果', market: '插件市场' }
  entries.forEach((entry, index) => {
    const group = entry.kind === 'market' ? 'market' : entry.command.group ?? 'best'
    const previous = sections.at(-1)
    if (previous?.id.startsWith(`${group}:`)) previous.entries.push({ entry, index })
    else sections.push({ id: `${group}:${sections.length}`, title: titles[group], entries: [{ entry, index }] })
  })
  const kindLabel = (entry: HomeSearchEntry) => entry.kind === 'market'
    ? entry.plugin.installed
      ? entry.plugin.enabled === false ? english ? 'Disabled plugin' : '已停用插件' : english ? 'Installed plugin' : '已安装插件'
      : english ? 'Marketplace' : '市场插件'
    : SCOPES.find((item) => item.id === entry.command.kind)?.[english ? 'en' : 'zh'] ?? ''

  return <>
    <header className="market-search-header">
      <h1 className="sr-only">{english ? 'Search eNest' : '搜索 eNest'}</h1>
      <SearchBox value={value} onChange={changeQuery} inputRef={inputRef}
        placeholder={english ? 'Search apps, plugins, marketplace and actions…' : '搜索应用、插件、市场与快捷操作…'}
        inputProps={{ role: 'combobox', 'aria-expanded': searching, 'aria-controls': searching ? listId : undefined,
          'aria-activedescendant': searching && selected && !loading ? `${listId}-${selectedIndex}` : undefined,
          'aria-autocomplete': 'list', onKeyDown,
          onCompositionStart: () => { composingRef.current = true; requestVersion.current++; setComposing(true) },
          onCompositionEnd: () => { composingRef.current = false; setComposing(false) } }} />
    </header>
    {searching && <section className="home-search-results" aria-label={english ? 'Search results' : '搜索结果'}>
      <div className="home-search-scopes" role="group" aria-label={english ? 'Search scope' : '搜索范围'}>
        {SCOPES.map((item) => <button key={item.id} type="button" className={`chip${scope === item.id ? ' active' : ''}`} aria-pressed={scope === item.id}
          onClick={() => changeScope(item.id)}>{item[english ? 'en' : 'zh']}</button>)}
      </div>
      <div className="home-search-status" role="status">{loading
        ? english ? 'Searching applications and plugins…' : '正在搜索应用与插件…'
        : `${entries.length} ${english ? 'results' : '项结果'}${currentResults && results.enriching ? english ? ' · Adding live results…' : ' · 正在补充结果…' : ''}`}</div>
      {(openError || (currentResults && results.error)) && <div className="home-search-error" role="alert">
        <span>{openError || (results.error === 'partial'
          ? english ? 'Some live results are unavailable. You can still open the results below.' : '部分即时结果暂不可用，仍可打开下方结果。'
          : english ? 'Application and command search is unavailable. Marketplace results are still shown.' : '应用与快捷搜索暂不可用，仍可查看市场结果。')}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
          const failedEntry = failedEntryRef.current
          if (failedEntry) void open(failedEntry)
          else { setOpenError(''); setRevision((current) => current + 1) }
        }}>{english ? 'Retry' : '重试'}</button>
      </div>}
      <div ref={resultsRef} id={listId} role="listbox" aria-label={english ? 'Search results' : '搜索结果'} aria-busy={loading} className="home-search-list">
        {sections.map((section) => <div key={section.id} role="group" aria-label={section.title} className="home-search-group">
          <h2>{section.title}</h2>
          {section.entries.map(({ entry, index }) => {
            const title = entry.kind === 'market' ? entry.plugin.name : entry.command.title
            const subtitle = entry.kind === 'market' ? entry.plugin.description : entry.command.subtitle
            const icon = entry.kind === 'market' ? entry.plugin.icon : entry.command.icon
            const action = entry.kind === 'market' ? english ? 'View plugin' : '查看插件' : entry.command.kind === 'action' ? english ? 'Run' : '执行' : english ? 'Open' : '打开'
            return <button key={entry.id} id={`${listId}-${index}`} type="button" role="option" aria-selected={selected?.id === entry.id}
              className={`home-search-result${selected?.id === entry.id ? ' is-selected' : ''}`} data-home-result-index={index} data-home-result-id={entry.id}
              tabIndex={0} disabled={opening !== null} onFocus={() => setSelectedId(entry.id)} onPointerMove={() => setSelectedId(entry.id)}
              onKeyDown={onKeyDown} onClick={(event) => void open(entry, event.currentTarget)}>
              <span className="home-search-icon"><PluginIcon src={icon} glyph={Array.from(title)[0]} size={38} /></span>
              <span className="home-search-copy"><span className="home-search-title">{title}</span><span className="home-search-subtitle">{subtitle}</span></span>
              <span className="home-search-kind">{kindLabel(entry)}</span>
              <span className="home-search-action">{opening === entry.id ? english ? 'Opening…' : '正在打开…' : action}</span>
            </button>
          })}
        </div>)}
      </div>
      {!entries.length && !loading && <div className="empty home-search-empty">
        <strong>{english ? 'No matching apps or plugins' : '没有找到匹配的应用或插件'}</strong>
        <span>{english ? 'Try an application name, plugin name or command.' : '试试应用名称、插件名称或快捷指令。'}</span>
        <button className="btn btn-ghost" type="button" onClick={browseAll}>{english ? 'Browse all plugins' : '查看全部插件'}</button>
      </div>}
      {entries.length > 0 && <p className="home-search-help">{english ? '↑ ↓ Select · Enter Open · Esc Back' : '↑ ↓ 选择 · Enter 打开 · Esc 返回首页'}</p>}
    </section>}
  </>
}
