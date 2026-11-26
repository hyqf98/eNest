import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { HomeSearchEntry } from '@shared/types/home'
import { useI18n } from '@renderer/hooks/useI18n'
import { SearchBox } from '@renderer/themes/default/workspace/SearchBox'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { SearchIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/Button'
import type { DefaultWorkspaceController, DefaultWorkspaceState, WorkspaceSearchScope } from './WorkspaceController'
import { FileMark, FileSearchResults, useFileResults } from './FileSearchResults'
import { resolveFileSearchKey } from './fileSearchKeys'
import '@renderer/themes/default/workspace/homeSearch.css'

const SCOPES: { id: WorkspaceSearchScope; zh: string; en: string }[] = [
  { id: 'all', zh: '全部', en: 'All' }, { id: 'app', zh: '本机应用', en: 'Applications' },
  { id: 'plugin', zh: '已安装插件', en: 'Installed plugins' },
  { id: 'market', zh: '插件市场', en: 'Marketplace' }, { id: 'action', zh: '快捷操作', en: 'Actions' },
  { id: 'files', zh: '文件', en: 'Files' },
]

/** Workspace owns its selection and paste UI; launch authority stays in native handles. */
export function DefaultWorkspaceSearch({ state, controller, onDetailOrigin }: {
  state: DefaultWorkspaceState
  controller: DefaultWorkspaceController
  onDetailOrigin: (origin: HTMLElement | null) => void
}) {
  const { locale } = useI18n()
  const english = locale === 'en-US'
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const [isComposing, setIsComposing] = useState(false)
  const [fileInput, setFileInput] = useState<string | null>(null)
  const [fileIndex, setFileIndex] = useState(0)
  const filesOnly = state.scope === 'files'
  const files = useFileResults(controller.searchFiles, state.query, Boolean(state.config?.fileSearchEnabled && fileInput === state.query && state.visible && state.route.page === 'catalog' && !isComposing && !state.inputBusy && !state.input.length && (filesOnly || state.scope === 'all')), filesOnly)
  const selectedFile = files.items[fileIndex] ?? files.items[0]
  useEffect(() => { setFileIndex(0) }, [state.query, state.scope])
  useEffect(() => { if (!state.visible) setFileInput(null) }, [state.visible])
  useEffect(() => {
    if (filesOnly && !state.config?.fileSearchEnabled) controller.queueSearch(state.query, 'all')
  }, [controller, filesOnly, state.config?.fileSearchEnabled, state.query])
  const openingRef = useRef(false)
  const [selectedHandle, setSelectedHandle] = useState<string>()
  const [opening, setOpening] = useState<string>()
  const [openError, setOpenError] = useState('')
  const listId = useId()
  const entries = state.results?.items ?? []
  const selectedIndex = Math.max(0, entries.findIndex(item => item.handle === selectedHandle))
  const selected = entries[selectedIndex]
  const searching = filesOnly || Boolean(state.query.trim() || state.input.length)
  const loading = state.searching
  useEffect(() => { setSelectedHandle(undefined); setOpenError('') }, [state.query, state.scope, state.input])

  const browseAll = () => {
    if (state.input.length) void controller.clearInput()
    controller.queueSearch('', 'all')
    controller.setCategory('全部')
    void controller.navigate({ page: 'catalog' })
  }
  const changeScope = (scope: WorkspaceSearchScope) => {
    if (scope === 'files') setFileInput(state.query)
    controller.queueSearch(state.query, scope, composing.current)
    inputRef.current?.focus()
  }
  const choose = (index: number) => {
    setSelectedHandle(entries[index]?.handle)
    resultsRef.current?.querySelector<HTMLElement>(`[data-home-result-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  const open = async (item: HomeSearchEntry, origin?: HTMLElement | null) => {
    if (item.disabled || loading || openingRef.current) return
    openingRef.current = true
    setOpening(item.handle)
    setOpenError('')
    if (item.kind === 'market') onDetailOrigin(origin ?? resultsRef.current?.querySelector<HTMLElement>(`[data-home-result-index="${selectedIndex}"]`) ?? null)
    try { await controller.openSearchResult(item) }
    catch (error) {
      setOpenError(error instanceof Error ? error.message : english ? 'Unable to open this result.' : '暂时无法打开。')
      void controller.runSearch()
    } finally { openingRef.current = false; setOpening(undefined) }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Backspace' && event.target === inputRef.current && !state.query && state.input.length) {
      event.preventDefault(); void controller.clearInput(state.input[state.input.length - 1].id); return
    }
    if (event.key === 'Escape') { event.preventDefault(); browseAll(); inputRef.current?.focus(); return }
    if (!searching || event.altKey || event.shiftKey || ((event.metaKey || event.ctrlKey) && event.key !== 'Enter')) return
    const fileKey = resolveFileSearchKey(event.key, { filesOnly, count: files.items.length, index: fileIndex, regularCount: entries.length, regularIndex: selectedIndex, modified: event.metaKey || event.ctrlKey })
    if (fileKey) {
      event.preventDefault(); const item = files.items[fileKey.index], element = resultsRef.current?.querySelector<HTMLButtonElement>(`[data-file-result="${item.id}"]`)
      if (fileKey.action === 'open') { if (!event.repeat) void files.activate(item.id, 'open') }
      else if (fileKey.action === 'focus') element?.focus()
      else { setFileIndex(fileKey.index); element?.scrollIntoView({ block: 'nearest' }) }
      return
    }
    if (filesOnly) return
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entries.length && !loading) {
      event.preventDefault()
      choose((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length)
      inputRef.current?.focus()
    } else if (event.key === 'Enter' && selected && !loading) {
      event.preventDefault()
      if (!event.repeat) void open(selected)
    }
  }
  const groups = entries.reduce<Array<{ kind: string; items: Array<{ item: HomeSearchEntry; index: number }> }>>((groups, item, index) => {
    const kind = item.kind === 'market' ? 'market' : 'best'
    const last = groups.at(-1)
    if (last?.kind === kind) last.items.push({ item, index })
    else groups.push({ kind, items: [{ item, index }] })
    return groups
  }, [])
  const kindLabel = (item: HomeSearchEntry) => item.kind === 'market'
    ? english ? 'Marketplace' : '市场插件'
    : SCOPES.find(scope => scope.id === item.kind)?.[english ? 'en' : 'zh'] ?? ''

  return <>
    <header className="market-search-header">
      <h1 className="sr-only">{english ? 'Search eNest' : '搜索 eNest'}</h1>
      <SearchBox value={state.query} inputRef={inputRef} onChange={query => { setFileInput(query); controller.queueSearch(query, state.scope, composing.current) }}
        placeholder={filesOnly ? english ? 'Search by file name…' : '按文件名检索…' : state.config?.fileSearchEnabled ? english ? 'Search apps, plugins and files…' : '搜索应用、插件与文件…' : english ? 'Search apps, plugins, marketplace and actions…' : '搜索应用、插件、市场与快捷操作…'}
        leading={<>{state.input.length > 0 && <span className="home-search-input-chips" role="list" aria-label={english ? 'Paste context' : '粘贴内容'}>
          {state.input.slice(0, 4).map(item => <span key={item.id} className="home-search-input-chip" role="listitem" title={item.name ?? (english ? 'Image' : '图片')}>
            <img src={item.thumbnail} alt="" draggable={false} />
            <button type="button" aria-label={`${english ? 'Remove' : '移除'} ${item.name ?? (english ? 'image' : '图片')}`} onClick={() => { void controller.clearInput(item.id); inputRef.current?.focus() }}>×</button>
          </span>)}
          {state.input.length > 4 && <span className="home-search-input-more">+{state.input.length - 4}</span>}
        </span>}<SearchIcon size={19} /></>}
        accessory={state.inputBusy ? <span className="home-search-input-status" role="status">{english ? 'Reading…' : '读取中…'}</span> : !searching && state.config?.fileSearchEnabled ? <Button variant="ghost" size="sm" className="home-search-file-entry" onClick={() => changeScope('files')} aria-label={english ? 'Search files' : '仅检索文件'}><FileMark directory />{english ? 'Files' : '文件'}</Button> : undefined}
        inputProps={{ role: 'combobox', 'aria-expanded': searching, 'aria-controls': searching ? listId : undefined,
          'aria-activedescendant': filesOnly && selectedFile ? `file-result-${selectedFile.id}` : searching && selected && !loading ? `${listId}-${selectedIndex}` : undefined,
          'aria-autocomplete': 'list', onKeyDown,
          onPaste: event => {
            const carriesMedia = Array.from(event.clipboardData.items).some(item => item.kind === 'file') || event.clipboardData.types.includes('Files')
            if (!carriesMedia) return
            event.preventDefault(); void controller.pasteInput()
          },
          onCompositionStart: () => { composing.current = true; setIsComposing(true); controller.queueSearch(state.query, state.scope, true) },
          onCompositionEnd: event => { composing.current = false; setIsComposing(false); setFileInput(event.currentTarget.value); controller.queueSearch(event.currentTarget.value, state.scope) } }} />
    </header>
    {searching && <section className="home-search-results" aria-label={english ? 'Search results' : '搜索结果'}>
      <div className="home-search-scopes" role="group" aria-label={english ? 'Search scope' : '搜索范围'}>
        {SCOPES.filter(scope => scope.id !== 'files' || state.config?.fileSearchEnabled && !state.input.length).map(scope => <button key={scope.id} type="button" className={`chip${state.scope === scope.id ? ' active' : ''}`} aria-pressed={state.scope === scope.id} onClick={() => changeScope(scope.id)}>{scope[english ? 'en' : 'zh']}</button>)}
      </div>
      <div className="home-search-status" role="status">{filesOnly && !state.query.trim() ? english ? 'Type a file or folder name.' : '输入文件或文件夹名称。' : loading ? english ? 'Searching applications and plugins…' : '正在搜索应用与插件…' : files.pending && !entries.length ? english ? 'Looking up file names…' : '正在查找文件名…' : `${entries.length + files.items.length} ${english ? 'results' : '项结果'}`}</div>
      {(openError || state.searchError) && <div className="home-search-error" role="alert"><span>{openError || state.searchError}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpenError(''); void controller.runSearch() }}>{english ? 'Retry' : '重试'}</button></div>}
      <div ref={resultsRef} id={listId} role="listbox" aria-label={english ? 'Search results' : '搜索结果'} aria-busy={loading} className="home-search-list">
        {groups.map((group, groupIndex) => <div key={`${group.kind}:${groupIndex}`} role="group" aria-label={group.kind === 'market' ? english ? 'Plugin marketplace' : '插件市场' : english ? 'Best results' : '最佳结果'} className="home-search-group">
          <h2>{group.kind === 'market' ? english ? 'Plugin marketplace' : '插件市场' : english ? 'Best results' : '最佳结果'}</h2>
          {group.items.map(({ item, index }) => <button key={item.handle} id={`${listId}-${index}`} type="button" role="option" aria-selected={selected?.handle === item.handle}
            className={`home-search-result${selected?.handle === item.handle ? ' is-selected' : ''}`} data-home-result-index={index} data-home-result-id={item.handle}
            disabled={Boolean(opening || item.disabled || loading)} onFocus={() => setSelectedHandle(item.handle)} onPointerMove={() => setSelectedHandle(item.handle)} onKeyDown={onKeyDown} onClick={event => void open(item, event.currentTarget)}>
            <span className="home-search-icon"><PluginIcon src={item.icon || undefined} glyph={item.glyph || Array.from(item.title)[0] || ''} size={38}
              fit={item.kind === 'app' ? 'contain' : undefined} /></span>
            <span className="home-search-copy"><span className="home-search-title">{item.title}</span><span className="home-search-subtitle">{item.subtitle}</span></span>
            <span className="home-search-kind">{kindLabel(item)}</span><span className="home-search-action">{opening === item.handle ? english ? 'Opening…' : '正在打开…' : item.kind === 'market' ? english ? 'View plugin' : '查看插件' : item.kind === 'action' ? english ? 'Run' : '执行' : english ? 'Open' : '打开'}</span>
          </button>)}
        </div>)}
        <FileSearchResults files={files} exclusive={filesOnly} selected={filesOnly ? selectedFile?.id : undefined} more={filesOnly ? undefined : () => changeScope('files')} onSelect={item => setFileIndex(files.items.indexOf(item))} />
      </div>
      {!filesOnly && !files.pending && !files.items.length && !entries.length && !loading && <div className="empty home-search-empty"><strong>{english ? 'No matching apps or plugins' : '没有找到匹配的应用或插件'}</strong><span>{english ? 'Try an application name, plugin name or command.' : '试试应用名称、插件名称或快捷指令。'}</span><button className="btn btn-ghost" type="button" onClick={browseAll}>{english ? 'Browse all plugins' : '查看全部插件'}</button></div>}
      {entries.length > 0 && <p className="home-search-help">{english ? '↑ ↓ Select · Enter Open · Esc Back' : '↑ ↓ 选择 · Enter 打开 · Esc 返回首页'}</p>}
    </section>}
  </>
}
