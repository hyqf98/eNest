import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SearchFiles } from '@shared/types/fileSearch'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { ChevronLeftIcon } from '@renderer/components/icons'
import { useI18n } from '@renderer/hooks/useI18n'
import { FileMark, FileSearchResults, useFileResults } from '@renderer/themes/default/FileSearchResults'
import { resolveFileSearchKey } from '@renderer/themes/default/fileSearchKeys'

export function QuickFileSearch({ initial, search, resize, back, hide }: {
  initial: string; search?: SearchFiles; resize?: (height: number) => void; back(): void; hide(): void
}) {
  const english = useI18n().locale === 'en-US', input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState(initial), [composing, setComposing] = useState(false), [index, setIndex] = useState(0)
  const files = useFileResults(search, query, !composing, true), selected = files.items[index] ?? files.items[0]
  useLayoutEffect(() => { input.current?.focus() }, [])
  useLayoutEffect(() => { resize?.(Math.min(495, 140 + Math.max(1, files.items.length) * 40)) }, [files.items.length, resize])
  useEffect(() => { setIndex(0) }, [query])
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); back(); return }
    const key = resolveFileSearchKey(event.key, { filesOnly: true, count: files.items.length, index, modified: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey })
    if (!key) return
    event.preventDefault()
    const item = files.items[key.index]
    if (key.action === 'open') { if (!event.repeat) void files.activate(item.id, 'open').then(ok => { if (ok) hide() }) }
    else { setIndex(key.index); document.querySelector(`[data-file-result="${item.id}"]`)?.scrollIntoView({ block: 'nearest' }) }
  }
  return <section className="trusted-file-quick" aria-label={english ? 'File search' : '文件检索'} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) back() }}>
    <div className="file-search-input"><Button variant="ghost" size="sm" aria-label={english ? 'All results' : '返回全部搜索'} onClick={back}><ChevronLeftIcon size={18} /></Button><FileMark />
      <Input ref={input} role="combobox" aria-expanded={!!query.trim()} aria-controls={listId} aria-activedescendant={selected ? `file-result-${selected.id}` : undefined} aria-label={english ? 'File name' : '文件名'} placeholder={english ? 'Search by file name…' : '按文件名检索…'} maxLength={128} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onPaste={event => { if (event.clipboardData.types.includes('Files')) event.preventDefault() }} />
    </div><div className="file-search-body" id={listId} role={query.trim() ? 'listbox' : undefined} aria-label={query.trim() ? english ? 'Files' : '文件' : undefined}>{query.trim() ? <FileSearchResults files={files} selected={selected?.id} onSelect={item => setIndex(files.items.indexOf(item))} onOpen={hide} exclusive /> : <p>{english ? 'Type a file or folder name. This search stays on your device.' : '输入文件或文件夹名称，仅在本机检索。'}</p>}</div>
  </section>
}
