/**
 * QuickLauncherApp — eNest 快捷启动小窗
 * 单层表面（无嵌套容器）；无内容时只保留搜索栏，有推荐/结果时撑开并带动画。
 * 插件态：mini 插件挂载 Quick contentView（原生 view 叠在本渲染层之上，占输入条以下
 * 全部区域）——本层只绘 QUICK_BAR_AREA_H 高的顶栏（返回 / 标题 / 固定到主窗），
 * 列表/面板/底栏全部收起；高度由主进程控制（PluginHost 高度自适应），
 * DOM 测量 quickResize 在插件态禁用。动画走 marketMotion 的 d()/dy()/ease() 档位
 * 缩放（CSS data-anim 分档实现，GSAP 时间轴用于顶栏切换）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import type { QuickCommand, QuickPluginModeInfo } from '@shared/types/quick'
import { QUICK_BAR_AREA_H } from '@shared/constants'
import { d, dy, ease, getAnimLevel } from '../gsap/marketMotion'
import { shellApi } from '../services/shellApi'
import { useTheme } from '../hooks/useTheme'
import { useAnimationLevelStore } from '../hooks/useAnimationLevel'
import './quick.css'

function ItemIcon({ cmd, size = 'md' }: { cmd: QuickCommand; size?: 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false)
  const showImg = !!cmd.icon && !failed
  return (
    <span className={`quick-icon-tile kind-${cmd.kind} size-${size}`} aria-hidden>
      {showImg ? (
        <img src={cmd.icon} alt="" onError={() => setFailed(true)} draggable={false} />
      ) : (
        <span className="quick-icon-fallback">{(cmd.title || '?').slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  )
}

function kindTag(cmd: QuickCommand): string {
  if (cmd.kind === 'plugin') return cmd.form === 'mini' ? '小插件' : '插件'
  if (cmd.kind === 'app') return '应用'
  return '操作'
}

export function QuickLauncherApp() {
  const hydrateTheme = useTheme().hydrate
  const hydrateAnim = useAnimationLevelStore((s) => s.hydrate)
  const animLevel = useAnimationLevelStore((s) => s.level)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<QuickCommand[]>([])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [entering, setEntering] = useState(true)
  const [expandKey, setExpandKey] = useState(0)
  /** 插件态信息（quick-plugin-mode 事件）；null = 列表态 */
  const [pluginMode, setPluginMode] = useState<QuickPluginModeInfo | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const searching = query.trim().length > 0
  /** 有结果，或搜索完无结果（给一行提示）时展开；首页无推荐则整块收起 */
  const expanded = items.length > 0 || (searching && !busy)
  /** 插件态：DOM 测量禁用（主进程 PluginHost 控高），顶栏恒 QUICK_BAR_AREA_H */
  const inPluginMode = pluginMode !== null

  useEffect(() => {
    void hydrateTheme()
    void hydrateAnim()
  }, [hydrateTheme, hydrateAnim])

  const search = useCallback(async (q: string) => {
    if (!shellApi.quickSearch) {
      setItems([])
      return
    }
    setBusy(true)
    try {
      const result = await shellApi.quickSearch(q, 24)
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

  // 主进程推送插件态切换（挂载 / Esc / 固定 / crash 均会推 null 或新值）
  useEffect(() => {
    const off = shellApi.onEvent?.((payload) => {
      if (payload.type === 'quick-plugin-mode') {
        setPluginMode(payload.mode)
      }
    })
    return () => off?.()
  }, [])

  // 插件态顶栏入场：GSAP 档位缩放（marketMotion d()/dy()/ease()）
  useEffect(() => {
    if (!pluginMode || !barRef.current) return
    const level = getAnimLevel()
    gsap.fromTo(
      barRef.current,
      { autoAlpha: 0, y: dy(-10) },
      {
        autoAlpha: 1,
        y: 0,
        duration: d(0.26),
        ease: ease('power2.out'),
        overwrite: true,
        ...(level === 'low' ? { duration: 0.01 } : {})
      }
    )
    // 插件态切顶栏后焦点回输入框（原生 view 可能持焦）
    window.setTimeout(() => inputRef.current?.focus(), 40)
  }, [pluginMode])

  // 回列表态时重播列表动画
  useEffect(() => {
    if (inPluginMode) return
    setExpandKey((k) => k + 1)
  }, [inPluginMode])

  useEffect(() => {
    const off = shellApi.onQuickShown?.(() => {
      setQuery('')
      setEntering(true)
      // 呼出保持插件态（若挂载中，主进程已重推 quick-plugin-mode）；列表态则重播动画
      if (!pluginMode) {
        setExpandKey((k) => k + 1)
        void search('')
      }
      window.setTimeout(() => inputRef.current?.focus(), 30)
    })
    window.setTimeout(() => inputRef.current?.focus(), 50)
    return off
  }, [search, pluginMode])

  useEffect(() => {
    const t = window.setTimeout(() => setEntering(false), 520)
    return () => window.clearTimeout(t)
  }, [expandKey])

  // 展开状态变化时重播面板动画
  useEffect(() => {
    if (inPluginMode) return
    setExpandKey((k) => k + 1)
  }, [expanded, searching, inPluginMode])

  // 测量内容高度 → 主进程调整小窗（收起/撑开）；插件态高度由主进程管，跳过
  useLayoutEffect(() => {
    if (inPluginMode) return
    const el = rootRef.current
    if (!el) return
    const apply = (): void => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      if (h > 0) shellApi.quickResize?.(h, true)
    }
    apply()
    // 动画帧内再量一次，捕获 tile 入场后的最终高度
    const raf = requestAnimationFrame(apply)
    return () => cancelAnimationFrame(raf)
  }, [items, searching, expanded, busy, inPluginMode])

  useEffect(() => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index, items])

  /** 插件态 Esc：回列表（view 隐藏保留进程）；列表态沿用清空/隐藏语义 */
  const escapePlugin = useCallback(() => {
    if (!pluginMode) return
    void shellApi.quickOpen?.({ kind: 'plugin-escape', pluginId: pluginMode.pluginId })
  }, [pluginMode])

  /** 固定到主窗：view 迁主窗 + Quick 收起 + 主窗前置 */
  const pinPlugin = useCallback(() => {
    if (!pluginMode) return
    void shellApi.quickOpen?.({ kind: 'plugin-pin', pluginId: pluginMode.pluginId })
  }, [pluginMode])

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
          code: cmd.code,
          // mini → Quick 内嵌（主进程有 form 兜底，此处显式声明意图）
          container: cmd.form === 'mini' ? 'quick' : 'shell'
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
    if (inPluginMode) {
      // 插件态顶栏键盘：Esc 回列表 / ⌘Enter 固定（原生 view 区域的同类键由主进程拦截）
      if (e.key === 'Escape') {
        e.preventDefault()
        escapePlugin()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        pinPlugin()
      }
      return
    }
    const total = items.length
    const cols = searching ? 1 : 6
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (total === 0 ? 0 : Math.min(total - 1, i + cols)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - cols))
    } else if (e.key === 'ArrowRight' && !searching) {
      e.preventDefault()
      setIndex((i) => (total === 0 ? 0 : Math.min(total - 1, i + 1)))
    } else if (e.key === 'ArrowLeft' && !searching) {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = items[index]
      if (cmd) void openItem(cmd)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (searching) setQuery('')
      else shellApi.quickHide?.()
    }
  }

  const animClass = `anim-${animLevel}`

  return (
    <div
      ref={rootRef}
      className={`quick-root ${animClass}${entering ? ' is-entering' : ''}`}
      data-mode={inPluginMode ? 'plugin' : searching ? 'search' : 'home'}
      data-expanded={expanded && !inPluginMode ? '1' : '0'}
      /* 插件态根高钉死 QUICK_BAR_AREA_H（含内边距）：主进程据此计算原生插件 view 起点 y，
         两端必须在同一条 64px 分割线上，否则 view 会盖住顶栏或留缝 */
      style={inPluginMode ? { height: QUICK_BAR_AREA_H, boxSizing: 'border-box' } : undefined}
    >
      <div className="quick-shell">
        {inPluginMode ? (
          /* 插件态顶栏：flex 撑满钉死的根高（QUICK_BAR_AREA_H），下方区域由原生插件 view 覆盖 */
          <div className="quick-plugin-bar" ref={barRef}>
            <button
              type="button"
              className="quick-plugin-back"
              onClick={escapePlugin}
              aria-label="返回列表"
              title="返回列表 (Esc)"
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>返回</span>
            </button>
            <span className="quick-plugin-title" title={pluginMode.title}>
              {pluginMode.title}
            </span>
            <button
              type="button"
              className="quick-plugin-pin"
              onClick={pinPlugin}
              aria-label="固定到主窗"
              title="固定到主窗 (⌘Enter)"
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M12 3v10M7 9l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 17.5h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span>固定到主窗</span>
            </button>
          </div>
        ) : (
          <div className="quick-search">
            <div className="quick-field">
              <svg className="quick-search-glyph" viewBox="0 0 24 24" aria-hidden>
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                className="quick-input"
                value={query}
                onChange={(e) => {
                  // 清空输入 → 回列表态（若在插件态）
                  const next = e.target.value
                  setQuery(next)
                }}
                onKeyDown={onKeyDown}
                placeholder="搜索应用与插件，或输入触发词…"
                spellCheck={false}
                autoComplete="off"
              />
              {busy ? (
                <span className="quick-spinner" title="搜索中" aria-hidden />
              ) : searching ? (
                <button type="button" className="quick-clear" onClick={() => setQuery('')} aria-label="清空">
                  ×
                </button>
              ) : (
                <span className="quick-esc">esc</span>
              )}
            </div>
          </div>
        )}

        {!inPluginMode ? (
          <div
            className={`quick-panel${expanded ? ' is-open' : ''}`}
            ref={bodyRef}
            role="listbox"
          >
            <div className="quick-panel-inner">
              {items.length > 0 ? (
                searching ? (
                  <div className="quick-list">
                    {items.map((cmd, i) => (
                      <button
                        key={cmd.id}
                        type="button"
                        data-idx={i}
                        className={`quick-row${i === index ? ' active' : ''}${cmd.keywordHit ? ' hit' : ''}`}
                        style={{ animationDelay: `${Math.min(i, 10) * 22}ms` }}
                        onMouseEnter={() => setIndex(i)}
                        onClick={() => void openItem(cmd)}
                      >
                        <ItemIcon cmd={cmd} />
                        <span className="quick-row-body">
                          <span className="quick-row-title">
                            {cmd.title}
                            {cmd.keywordHit ? (
                              <span className="quick-kw">
                                <span className="quick-kw-label">触发</span>
                                {cmd.keywordHit}
                              </span>
                            ) : null}
                          </span>
                          <span className="quick-row-sub">{cmd.subtitle}</span>
                        </span>
                        <span className="quick-row-kind">{kindTag(cmd)}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="quick-home-head">
                      <span className="quick-home-title">最近使用</span>
                    </div>
                    <div className="quick-grid">
                      {items.map((cmd, i) => (
                        <button
                          key={cmd.id}
                          type="button"
                          data-idx={i}
                          className={`quick-tile${i === index ? ' active' : ''}`}
                          style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                          onMouseEnter={() => setIndex(i)}
                          onClick={() => void openItem(cmd)}
                        >
                          <ItemIcon cmd={cmd} size="lg" />
                          <span className="quick-tile-label">{cmd.title}</span>
                          {cmd.form === 'mini' ? <span className="quick-tile-dot" title="小插件" /> : null}
                        </button>
                      ))}
                    </div>
                  </>
                )
              ) : searching && !busy ? (
                <div className="quick-empty">
                  <span>无匹配，试试触发词</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {!inPluginMode && items.length > 0 ? (
          <div className="quick-footer">
            <span>↑↓←→</span>
            <span>Enter 打开</span>
            <span>{searching ? 'Esc 清空' : 'Esc'}</span>
            <span className="quick-brand">eNest</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
