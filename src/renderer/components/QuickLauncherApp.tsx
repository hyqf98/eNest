/**
 * QuickLauncherApp — 全局快捷启动小窗 UI
 * 职责：搜索框 + 命令列表；键盘导航；Enter 打开 / Esc 隐藏。
 * 由 App.tsx 在 ?surface=quick 时渲染，不走市场壳子。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuickCommand } from '@shared/types/quick'
import { shellApi } from '../services/shellApi'
import { useTheme } from '../hooks/useTheme'
import './quick.css'

function kindLabel(cmd: QuickCommand): string {
  if (cmd.kind === 'app') return '应用'
  if (cmd.kind === 'plugin') return cmd.form === 'mini' ? '小窗插件' : '插件'
  return '操作'
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

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const openItem = useCallback(async (cmd: QuickCommand) => {
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
  }, [query, search])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // ⌘/Ctrl+Enter：强制在主窗打开插件（骨架阶段与 Enter 相同）
      e.preventDefault()
      const cmd = items[index]
      if (cmd?.kind === 'plugin') void openItem(cmd)
      else if (cmd) void openItem(cmd)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = items[index]
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
        {busy ? <span className="quick-busy">…</span> : null}
      </div>
      <div className="quick-list" ref={listRef} role="listbox">
        {items.length === 0 ? (
          <div className="quick-empty">无匹配结果</div>
        ) : (
          items.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              data-idx={i}
              className={`quick-item${i === index ? ' active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => void openItem(cmd)}
            >
              <span className="quick-item-title">{cmd.title}</span>
              <span className="quick-item-sub">{cmd.subtitle}</span>
              <span className="quick-item-kind">{kindLabel(cmd)}</span>
            </button>
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
