import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileSearchItem, FileSearchResult, SearchFiles } from '@shared/types/fileSearch'
import { useI18n } from '@renderer/hooks/useI18n'
import { Button } from '@renderer/components/ui/Button'
import './fileSearch.css'

export function useFileResults(search: SearchFiles | undefined, query: string, active: boolean, filesOnly: boolean) {
  const [visible, setVisible] = useState(() => !document.hidden)
  const [reply, setReply] = useState<{ key: string; result: FileSearchResult }>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false), sequence = useRef(0)
  const key = active && visible && query.trim() ? `${filesOnly ? 'files' : 'mixed'}:${query.trim()}` : ''
  useEffect(() => {
    const change = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  useLayoutEffect(() => {
    const revision = ++sequence.current
    setError(false); setReply(undefined); setBusy(false); busyRef.current = false
    if (!key || !search) return
    const timer = setTimeout(() => {
      if (document.hidden || revision !== sequence.current) return
      void search({ operation: 'query', query: query.trim(), scope: filesOnly ? 'files' : 'mixed' })
        .then(result => { if (revision === sequence.current) setReply({ key, result }) })
        .catch(() => { if (revision === sequence.current) setReply({ key, result: { status: 'unavailable' } }) })
    }, 160)
    return () => { ++sequence.current; clearTimeout(timer); void search({ operation: 'cancel' }).catch(() => undefined) }
  }, [key, search, filesOnly, query])
  const result = key && reply?.key === key ? reply.result : undefined
  const activate = useCallback(async (id: string, operation: 'open' | 'reveal') => {
    if (document.hidden || busyRef.current || !result?.items?.some(item => item.id === id) || !search) return false
    const revision = sequence.current
    busyRef.current = true; setBusy(true); setError(false)
    try {
      const opened = await search({ operation, id })
      if (revision === sequence.current && opened.status !== 'ready') setError(true)
      return opened.status === 'ready'
    } catch { if (revision === sequence.current) setError(true); return false }
    finally { if (revision === sequence.current) { busyRef.current = false; setBusy(false) } }
  }, [result, search])
  return { result, items: result?.items ?? [], pending: !!key && !result, active: !!key, activate, busy, error }
}

export function FileMark({ directory = false }: { directory?: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{directory
    ? <path d="M3 6.5h6l2 2H21v9.8a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 18.3ZM3 9V5.5A1.5 1.5 0 0 1 4.5 4H9l2.5 2.5H19" />
    : <><path d="M6 3h8l4.5 4.5V21H6zM14 3v5h4.5" /><path d="M9 12h6m-6 3h5" /></>}</svg>
}

export function FileSearchResults({ files, more, selected, onOpen, onSelect, exclusive = false }: {
  files: ReturnType<typeof useFileResults>; more?: () => void; selected?: string; exclusive?: boolean
  onOpen?: () => void; onSelect?: (item: FileSearchItem) => void
}) {
  const { locale } = useI18n(), english = locale === 'en-US'
  const source = files.result?.provider, unavailable = files.result?.status === 'unavailable'
  if (!files.active || !exclusive && !files.items.length && !unavailable) return null
  return <section className="file-search-group" aria-label={english ? 'Files' : '文件'} aria-busy={files.pending}>
    <header><strong>{english ? 'Files' : '文件'}</strong><small>{source === 'selected-folders' ? english ? 'Selected folders' : '备用目录' : source}</small>
      {more && !unavailable && <Button variant="ghost" size="sm" onClick={more}>{files.result?.more ? english ? 'More files' : '更多文件' : english ? 'Files only' : '仅看文件'} ›</Button>}
    </header>
    {files.items.map(item => <div key={item.id} className="file-search-row" data-selected={selected === item.id}>
      <button type="button" id={`file-result-${item.id}`} data-file-result={item.id} role={exclusive ? 'option' : undefined} aria-selected={exclusive ? selected === item.id : undefined} disabled={files.busy} onFocus={() => onSelect?.(item)} title={`${item.name} — ${item.parent}`} onClick={() => void files.activate(item.id, 'open').then(ok => { if (ok) onOpen?.() })}>
        <span className="file-search-icon"><FileMark directory={item.kind === 'directory'} /></span><span className="file-search-copy"><b>{item.name}</b><small dir="auto">{item.parent}</small></span>
      </button>
      <button type="button" className="file-search-reveal" disabled={files.busy} aria-label={`${english ? 'Reveal' : '定位'} ${item.name}`} onClick={() => void files.activate(item.id, 'reveal')}>{english ? 'Reveal' : '定位'}</button>
    </div>)}
    {(!files.items.length || files.error || files.result?.limited) && <p role="status">{files.error ? english ? 'This result changed or could not be opened. Search again.' : '文件可能已变更或无法打开，请重新搜索。' : unavailable ? english ? 'File index unavailable. Choose a fallback folder in General settings.' : '文件索引不可用，可在通用设置中选择备用目录。' : files.pending ? english ? 'Looking up file names…' : '正在查找文件名…' : files.result?.limited ? english ? 'Showing a bounded snapshot of selected folders.' : '仅显示备用目录限额内的结果。' : english ? 'No matching files.' : '没有匹配的文件。'}</p>}
  </section>
}
