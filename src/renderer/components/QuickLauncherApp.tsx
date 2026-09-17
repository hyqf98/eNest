/**
 * QuickLauncherApp — 全局快捷启动小窗 UI
 * 职责：搜索框 + 分区命令列表；键盘导航；Enter 打开 / Esc 隐藏。
 * 由 App.tsx 在 ?surface=quick 时渲染，不走市场壳子。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QuickCommand, QuickCommandKind } from '@shared/types/quick'
import { shellApi } from '../services/shellApi'
import { useTheme } from '../hooks/useTheme'
import './quick.css'

const KIND_LABEL: Record<QuickCommandKind, string> = {
  app: '应用',
  plugin: '插件',
  action: '操作'
}

const SECTION_ORDER: Array<'recent' | QuickCommandKind> = [
  'recent',
  'app',
  'plugin',
  'action'
]

function sectionLabel(key: 'recent' | QuickCommandKind): string {
  return key === 'recent' ? '最近' : KIND_LABEL[key]
}

function kindLabel(cmd: QuickCommand): string {
  if (cmd.kind === 'plugin' && cmd.form === 'mini') return '小窗插件'
  return KIND_LABEL[cmd.kind]
}

/** 结果按「最近 → 应用 → 插件 → 操作」分区；index 为展示顺序（键盘导航用） */
function buildSections(items: QuickCommand[]): Array<{
  key: string
  label: string
  rows: Array<{ cmd: QuickCommand; index: number }>
}> {
  const buckets = new Map<string, QuickCommand[]>()
  items.forEach((cmd) => {
    const key = cmd.lastUsedTs ? 'recent' : cmd.kind
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(cmd)
  })
  let cursor = 0
  return SECTION_ORDER.filter((k) => buckets.has(k)).map((k) => ({
    key: k,
    label: sectionLabel(k),
    rows: buckets.get(k)!.map((cmd) => ({ cmd, index: cursor++ }))
  }))
}

function ItemIcon({ cmd }: { cmd: QuickCommand }) {
  const [failed, setFailed] = useState(false)
  const showImg = !!cmd.icon && !failed
  return (
    <span className={`quick-item-icon kind-${cmd.kind}`} aria-hidden>
      {showImg ? (
        <img src={cmd.icon} alt="" onError={() => setFailed(true)} draggable={false} />
      ) : (
        <span className="quick-item-fallback">{(cmd.title || '?').slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  )
}

export function QuickLauncherApp() {
  const hydrateTheme = useTheme().hydrate
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<QuickCommand[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void hydrateTheme()
  }, [hydrateTheme])

  const search = useCallback(async (q: string) => {
    if (!shellApi.quickSearch) {
      setItems([])
      return
    }
    setBusy(true)
    try {
      const result = await shellApi.quickSearch(q, 20)
      setItems(result.items)
      setIndex(0)
    } catch {
      setItems([])
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void search(query)
  }, [query, search])

  useEffect(() => {
    const off = shellApi.onQuickShown?.(() => {
      setQuery('')
      void search('')
      window.setTimeout(() => inputRef.current?.focus(), 30)
    })
    // 首次挂载也聚焦
    window.setTimeout(() => inputRef.current?.focus(), 50)
    return off
  }, [search])

  const sections = useMemo(() => buildSections(items), [items])
  /** 展示顺序压平后的列表；index 指向该数组 */
  const flat = useMemo(() => sections.flatMap((s) => s.rows.map((r) => r.cmd)), [sections])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index, flat])

  const openItem = useCallback(
    async (cmd: QuickCommand) => {
      if (!shellApi.quickOpen) return
      if (cmd.kind === 'app' && cmd.path) {
        await shellApi.quickOpen({ kind: 'app', path: cmd.path })
        return
      }
      if (cmd.kind === 'plugin' && cmd.pluginId) {
        await shellApi.quickOpen({
          kind: 'plugin',
          pluginId: cmd.pluginId,
          code: cmd.code
        })
        return
      }
      if (cmd.kind === 'action' && cmd.action) {
        await shellApi.quickOpen({ kind: 'action', action: cmd.action })
        if (cmd.action === 'refresh-apps') void search(query)
      }
    },
    [query, search]
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    const total = flat.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (total === 0 ? 0 : Math.min(total - 1, i + 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = flat[index]
      if (cmd) void openItem(cmd)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      shellApi.quickHide?.()
    }
  }

  return (
    <div className="quick-root">
      <div className="quick-drag" />
      <div className="quick-input-wrap">
        <span className="quick-icon" aria-hidden>
          ⌘
        </span>
        <input
          ref={inputRef}
          className="quick-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜索应用、插件指令…"
          spellCheck={false}
          autoComplete="off"
        />
        {busy ? (
          <span className="quick-busy" title="搜索中">
            <span className="quick-spinner" aria-hidden />
            <span className="quick-busy-text">搜索中</span>
          </span>
        ) : null}
      </div>
      <div className="quick-list" ref={listRef} role="listbox">
        {flat.length === 0 ? (
          <div className="quick-empty">{busy ? '搜索中…' : '无匹配结果'}</div>
        ) : (
          sections.map((section) => (
            <div key={section.key} className="quick-section" role="group">
              <div className="quick-section-title">{section.label}</div>
              {section.rows.map(({ cmd, index: i }) => (
                <button
                  key={cmd.id}
                  type="button"
                  data-idx={i}
                  className={`quick-item${i === index ? ' active' : ''}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => void openItem(cmd)}
                >
                  <ItemIcon cmd={cmd} />
                  <span className="quick-item-body">
                    <span className="quick-item-title">{cmd.title}</span>
                    <span className="quick-item-sub">{cmd.subtitle}</span>
                  </span>
                  <span className="quick-item-kind">{kindLabel(cmd)}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="quick-footer">
        <span>↑↓ 选择</span>
        <span>Enter 打开</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  )
}
