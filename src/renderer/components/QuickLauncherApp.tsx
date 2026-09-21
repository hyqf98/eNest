/**
 * QuickLauncherApp — eNest 快捷启动小窗
 * 视觉复刻参考稿：大号输入条（无放大镜 / 无胶囊底）+ 右上品牌圆标；
 * 首页「最近使用」九列图标网格 + 展开(N)；搜索结果分「最佳搜索结果 / 匹配推荐」
 * 两组网格，选中项浅蓝高亮，命中词橙色前缀高亮，搜索态右侧「切换选中 Tab」提示。
 * 插件态：mini 插件挂载 Quick contentView（原生 view 叠在本渲染层之上，占输入条以下
 * 全部区域）——本层只绘 QUICK_BAR_AREA_H 高的顶栏（返回 / 标题 / 固定到主窗），
 * 列表/网格全部收起；高度由主进程控制（PluginHost 高度自适应），
 * DOM 测量 quickResize 在插件态禁用。动画走 marketMotion 档位（CSS data-anim 分档）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import type { QuickCommand, QuickPluginModeInfo } from '@shared/types/quick'
import { QUICK_BAR_AREA_H } from '@shared/constants'
import { d, dy, ease, getAnimLevel } from '@renderer/gsap/marketMotion'
import { shellApi } from '@renderer/services/shellApi'
import { useTheme, useThemeStore } from '@renderer/hooks/useTheme'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import './quick.css'

/** 网格列数（参考稿九列） */
const GRID_COLS = 9
/** 首页收起时显示的条目数（两行） */
const HOME_COLLAPSED_COUNT = GRID_COLS * 2

/**
 * 结构性背景场：中/高档渲染，low 关闭。
 * 极坐标点阵 + 两枚软光斑，相位错拍呼吸；非上浮气泡。
 * 样式由 quick.css [data-anim] 分档。
 */
function QuickParticles({ level }: { level: string }) {
  if (level !== 'medium' && level !== 'high') return null
  const rings = level === 'high' ? 4 : 3
  const dots: { left: string; top: string; delay: string; size: number; hue: 'link' | 'ok' }[] = []
  for (let ring = 1; ring <= rings; ring++) {
    const count = 6 + ring * 4
    const rr = (ring / rings) * 42
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + ring * 0.2
      dots.push({
        left: `${50 + Math.cos(ang) * rr * 1.35}%`,
        top: `${52 + Math.sin(ang) * rr}%`,
        delay: `${(ring * 0.4 + i * 0.08).toFixed(2)}s`,
        size: level === 'high' ? 2 + (4 - ring) * 0.4 : 1.6 + (3 - ring) * 0.3,
        hue: ring % 2 === 0 ? 'ok' : 'link',
      })
    }
  }
  return (
    <div className="quick-particles" aria-hidden>
      <span className="quick-field-orb quick-field-orb-a" />
      <span className="quick-field-orb quick-field-orb-b" />
      {/* 点阵整体极缓慢旋转（high 档开启），中心恒定不飘 */}
      <div className="quick-field-spin">
        {dots.map((d, i) => (
          <span
            key={i}
            className={`quick-field-dot hue-${d.hue}`}
            style={{
              left: d.left,
              top: d.top,
              width: `${d.size}px`,
              height: `${d.size}px`,
              animationDelay: d.delay,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function ItemIcon({ cmd }: { cmd: QuickCommand }) {
  const [failed, setFailed] = useState(false)
  const showImg = !!cmd.icon && !failed
  return (
    <span className={`quick-icon-tile kind-${cmd.kind}${showImg ? ' has-icon' : ''}`} aria-hidden>
      {showImg ? (
        <img src={cmd.icon} alt="" onError={() => setFailed(true)} draggable={false} />
      ) : (
        <span className="quick-icon-fallback">{(cmd.title || '?').slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  )
}

/** 命中前缀高亮：query 在标题中的子串橙色显示（参考稿「Clash Verge」样式） */
function HighlightTitle({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase()
  if (q.length > 0) {
    const i = text.toLowerCase().indexOf(q)
    if (i >= 0) {
      return (
        <>
          {text.slice(0, i)}
          <span className="quick-hit-text">{text.slice(i, i + q.length)}</span>
          {text.slice(i + q.length)}
        </>
      )
    }
  }
  return <>{text}</>
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
  /** 首页「展开(N)」状态；收起时只显示前 HOME_COLLAPSED_COUNT 个 */
  const [homeExpanded, setHomeExpanded] = useState(false)
  /** 插件态信息（quick-plugin-mode 事件）；null = 列表态 */
  const [pluginMode, setPluginMode] = useState<QuickPluginModeInfo | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const searching = query.trim().length > 0
  /** 当前渲染出的条目（首页收起时截断；搜索态全量，分组只是视图切分） */
  const visibleItems = useMemo(
    () => (searching || homeExpanded ? items : items.slice(0, HOME_COLLAPSED_COUNT)),
    [items, searching, homeExpanded]
  )
  /** 插件态：DOM 测量禁用（主进程 PluginHost 控高），顶栏恒 QUICK_BAR_AREA_H */
  const inPluginMode = pluginMode !== null

  useEffect(() => {
    void hydrateTheme()
    void hydrateAnim()
  }, [hydrateTheme, hydrateAnim])

  // 主窗改主题/动画档时 Quick 同步：theme-changed 到达后重拉 token（Quick 独立
  // WebContents，事件经 createQuickWindow 的 quickEventSink 转发到本页面）
  useEffect(() => {
    const off = shellApi.onEvent?.((payload) => {
      if (payload.type === 'theme-changed') {
        void useThemeStore.getState().hydrate()
      }
    })
    return () => off?.()
  }, [])

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
      setHomeExpanded(false)
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
  }, [items, searching, homeExpanded, inPluginMode])

  // 渲染集变化后回收越界的选中位（首页收起等场景）
  useEffect(() => {
    if (index > visibleItems.length - 1) setIndex(Math.max(0, visibleItems.length - 1))
  }, [index, visibleItems.length])

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
  }, [items, searching, visibleItems.length, busy, inPluginMode])

  useEffect(() => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [index, visibleItems])

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
    const total = visibleItems.length
    const cols = GRID_COLS
    if (e.key === 'Tab') {
      // Tab / Shift+Tab 环形切换选中（对齐参考稿「切换选中 Tab」）
      e.preventDefault()
      if (total > 0) setIndex((i) => (i + (e.shiftKey ? -1 : 1) + total) % total)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (total === 0 ? 0 : Math.min(total - 1, i + cols)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - cols))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setIndex((i) => (total === 0 ? 0 : Math.min(total - 1, i + 1)))
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = visibleItems[index]
      if (cmd) void openItem(cmd)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (searching) setQuery('')
      else shellApi.quickHide?.()
    }
  }

  /** 网格 tile（分组渲染共用；offset = 该组在可见列表中的起始下标） */
  const renderTiles = (list: QuickCommand[], offset: number) =>
    list.map((cmd, k) => {
      const i = offset + k
      return (
        <button
          key={cmd.id}
          type="button"
          data-idx={i}
          className={`quick-tile${i === index ? ' active' : ''}`}
          style={{ animationDelay: `${Math.min(i, 17) * 20}ms` }}
          onMouseEnter={() => setIndex(i)}
          onClick={() => void openItem(cmd)}
        >
          <ItemIcon cmd={cmd} />
          <span className="quick-tile-label">
            <HighlightTitle text={cmd.title} query={query} />
          </span>
          {cmd.form === 'mini' ? <span className="quick-tile-dot" title="小插件" /> : null}
        </button>
      )
    })

  const animClass = `anim-${animLevel}`

  return (
    <div
      ref={rootRef}
      className={`quick-root ${animClass}${entering ? ' is-entering' : ''}`}
      data-mode={inPluginMode ? 'plugin' : 'list'}
      /* 插件态根高钉死 QUICK_BAR_AREA_H（含内边距）：主进程据此计算原生插件 view 起点 y，
         两端必须在同一条 64px 分割线上，否则 view 会盖住顶栏或留缝 */
      style={inPluginMode ? { height: QUICK_BAR_AREA_H, boxSizing: 'border-box' } : undefined}
    >
      <div className="quick-shell">
        {/* 浮动粒子层：玻璃壳内、内容之下（low 档 null；中 9 颗 / 高 18 颗） */}
        <QuickParticles level={animLevel} />
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
          <>
            {/* 输入条：大号输入文字，无放大镜；右侧 busy→spinner / 搜索态→Tab 提示 / 品牌圆标 */}
            <div className="quick-search">
              <div className="quick-field">
                <input
                  ref={inputRef}
                  className="quick-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="搜索应用和指令 / 粘贴文件或图片"
                  spellCheck={false}
                  autoComplete="off"
                />
                {busy ? (
                  <span className="quick-spinner" title="搜索中" aria-hidden />
                ) : searching ? (
                  <span className="quick-hint">
                    切换选中
                    <span className="quick-hint-key">Tab</span>
                  </span>
                ) : null}
                <span className="quick-brand-orb" aria-hidden>
                  <svg viewBox="0 0 24 24">
                    <polygon
                      points="12,3 19.8,7.5 19.8,16.5 12,21 4.2,16.5 4.2,7.5"
                      fill="none"
                      stroke="#ffffff"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                    <rect x="4.9" y="9.5" width="5.4" height="4.2" rx="1.1" fill="#3fe0a4" transform="rotate(-16 7.6 11.6)" />
                    <rect x="13.7" y="10.3" width="5.4" height="4.2" rx="1.1" fill="#3fe0a4" transform="rotate(16 16.4 12.4)" />
                    <circle cx="12" cy="12" r="1.25" fill="#f5b83d" />
                  </svg>
                </span>
              </div>
            </div>

            {/* 内容面板：搜索分「最佳搜索结果 / 匹配推荐」；首页「最近使用」+ 展开(N) */}
            <div
              className={`quick-panel${visibleItems.length > 0 || (searching && !busy) ? ' is-open' : ''}`}
              ref={bodyRef}
              role="listbox"
            >
              <div className="quick-panel-inner">
                {searching ? (
                  items.length > 0 ? (
                    <>
                      <div className="quick-section">
                        <div className="quick-section-head">
                          <span className="quick-section-title">最佳搜索结果</span>
                        </div>
                        <div className="quick-grid">{renderTiles(items.slice(0, 1), 0)}</div>
                      </div>
                      {items.length > 1 ? (
                        <div className="quick-section">
                          <div className="quick-section-head">
                            <span className="quick-section-title">匹配推荐</span>
                          </div>
                          <div className="quick-grid">{renderTiles(items.slice(1), 1)}</div>
                        </div>
                      ) : null}
                    </>
                  ) : !busy ? (
                    <div className="quick-empty">
                      <span>无匹配，试试触发词</span>
                    </div>
                  ) : null
                ) : items.length > 0 ? (
                  <div className="quick-section">
                    <div className="quick-section-head">
                      <span className="quick-section-title">最近使用</span>
                      {items.length > HOME_COLLAPSED_COUNT ? (
                        <button
                          type="button"
                          className="quick-expand"
                          onClick={() => setHomeExpanded((v) => !v)}
                        >
                          {homeExpanded ? '收起' : `展开 (${items.length})`}
                        </button>
                      ) : null}
                    </div>
                    <div className="quick-grid">{renderTiles(visibleItems, 0)}</div>
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
