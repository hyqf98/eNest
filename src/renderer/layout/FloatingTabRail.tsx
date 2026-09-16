/**
 * FloatingTabRail — 左侧悬浮圆形 Tab 轨道（orb 模式）
 * 收起时仅露出一条细玻璃胶囊把手；悬停展开为竖排圆形 Tab（首页 + 插件），
 * 支持关闭角标、激活光环、标签浮层与入列弹簧动画。
 * 底部固定设置圆钮（与 Tab 圆球同风格），替代 classic 的 float-btn。
 * 首页永远第一、无关闭钮、不可被关。
 * 依赖：shellStore（view/tabs/activeTabId/goHome/activateTab/closeTab/setView/tabStyle）。
 */
import { useEffect, useRef, useState } from 'react'
import { ORB_RAIL_INSET } from '@shared/constants'
import { useShellStore } from '@renderer/stores/shellStore'
import { shellApi } from '@renderer/services/shellApi'
import { animateTabIn } from '@renderer/gsap/marketMotion'

export function FloatingTabRail() {
  const view = useShellStore((s) => s.view)
  const tabs = useShellStore((s) => s.tabs)
  const activeTabId = useShellStore((s) => s.activeTabId)
  const tabStyle = useShellStore((s) => s.tabStyle)
  const goHome = useShellStore((s) => s.goHome)
  const activateTab = useShellStore((s) => s.activateTab)
  const closeTab = useShellStore((s) => s.closeTab)
  const setView = useShellStore((s) => s.setView)

  const [expanded, setExpanded] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<number | null>(null)
  const prevCount = useRef(0)
  const expandTimer = useRef<number | null>(null)

  const homeActive = view === 'home' || view === 'settings' || view === 'dev'
  const settingsActive = view === 'settings'

  // orb 模式下：挂载时短暂亮起把手，提示可交互
  useEffect(() => {
    if (tabStyle !== 'orb') return
    expandTimer.current = window.setTimeout(() => {
      setExpanded(true)
      window.setTimeout(() => setExpanded(false), 1600)
    }, 900)
    return () => {
      if (expandTimer.current) window.clearTimeout(expandTimer.current)
    }
  }, [tabStyle])

  // 新 Tab 入列动画
  useEffect(() => {
    if (tabs.length > prevCount.current && expanded) {
      const last = tabs[tabs.length - 1]
      const node = document.querySelector(`[data-orb-tab="${last.id}"]`) as HTMLElement | null
      animateTabIn(node)
    }
    prevCount.current = tabs.length
  }, [tabs, expanded])

  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  /** 离开后延迟收起，给鼠标从把手滑向圆球留缓冲，避免“稍微往右就收回” */
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setExpanded(false), 420)
  }

  const handleEnter = () => {
    cancelClose()
    setExpanded(true)
  }

  const handleLeave = () => scheduleClose()

  // orb：固定 52px 通道，展开只切换圆球显隐，不改 inset，避免推挤插件
  const railVisible = tabStyle === 'orb'

  useEffect(() => {
    if (tabStyle !== 'orb') {
      document.documentElement.style.setProperty('--orb-rail-inset', '0px')
      void shellApi.setPluginInset?.(0).catch(() => undefined)
      return
    }
    document.documentElement.style.setProperty('--orb-rail-inset', `${ORB_RAIL_INSET}px`)
    void shellApi.setPluginInset?.(ORB_RAIL_INSET).catch(() => undefined)
  }, [tabStyle])

  // 点击轨道外区域收起；扩展命中区左侧缓冲条避免误判
  useEffect(() => {
    if (!expanded) return
    const onDoc = (e: MouseEvent) => {
      const root = rootRef.current
      if (root && !root.contains(e.target as Node)) setExpanded(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [expanded])

  if (!railVisible) return null

  return (
    <>
      <div
        ref={rootRef}
        className={`orb-rail${expanded ? ' expanded' : ''}`}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocusCapture={handleEnter}
        onBlurCapture={scheduleClose}
        role="navigation"
        aria-label="打开的标签"
      >
        {/* 左侧透明桥接区：把手到圆球之间不触发 leave */}
        <div className="orb-bridge" aria-hidden="true" />

        {/* 收起态把手：细胶囊 + 若干缩略圆点 */}
        <button
          type="button"
          className="orb-handle"
          aria-label={expanded ? '收起标签栏' : '展开标签栏'}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="orb-handle-grip" />
          <span className="orb-handle-dots" aria-hidden="true">
            <i style={{ background: homeActive ? 'var(--accent)' : 'var(--text-3)' }} />
            {tabs.slice(0, 3).map((tab) => (
              <i key={tab.id} style={{ background: tab.color }} />
            ))}
          </span>
        </button>

        {/* 展开：无容器底，圆形贴左叠出 */}
        <div className="orb-panel" aria-hidden={!expanded}>
          {/* 首页永远第一、无关闭钮 */}
          <button
            type="button"
            className={`orb-item orb-home${homeActive ? ' active' : ''}`}
            style={{ transitionDelay: expanded ? '20ms' : '0ms' }}
            onClick={() => {
              goHome()
              setExpanded(false)
            }}
            tabIndex={expanded ? 0 : -1}
            title="首页"
          >
            <span className="orb-face">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" />
              </svg>
            </span>
            <span className="orb-tip">首页</span>
          </button>

          {tabs.map((tab, i) => {
            const active = tab.id === activeTabId && view === 'plugin'
            const delay = expanded ? `${40 + i * 32}ms` : '0ms'
            return (
              <div
                key={tab.id}
                data-orb-tab={tab.id}
                className={`orb-item orb-tab${active ? ' active' : ''}`}
                style={{ transitionDelay: delay }}
              >
                <button
                  type="button"
                  className="orb-face"
                  style={{ background: tab.color }}
                  onClick={() => {
                    void activateTab(tab.id)
                    setExpanded(false)
                  }}
                  tabIndex={expanded ? 0 : -1}
                  title={tab.title}
                >
                  <span className="orb-glyph">{tab.glyph}</span>
                </button>
                <button
                  type="button"
                  className="orb-close"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTab(tab.id)
                  }}
                  tabIndex={expanded ? 0 : -1}
                >
                  <svg width="8" height="8" viewBox="0 0 10 10">
                    <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
                <span className="orb-tip">{tab.title}</span>
              </div>
            )
          })}

          {tabs.length === 0 && (
            <p className="orb-empty" style={{ opacity: expanded ? 1 : 0, transitionDelay: expanded ? '60ms' : '0ms' }}>
              暂无打开的插件
            </p>
          )}
        </div>
      </div>

      {/* 底部固定设置圆钮：与 Tab 圆球同风格，贴左通道内；设置页内仍可展开圆轨切换 */}
      <div className="orb-dock">
        <button
          type="button"
          className={`orb-face orb-settings${settingsActive ? ' active' : ''}`}
          title="设置"
          aria-label="设置"
          aria-current={settingsActive ? 'page' : undefined}
          onClick={() => setView('settings')}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .4 1.1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.65.96.3.25.67.4 1.06.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.64Z" />
          </svg>
        </button>
        <span className="orb-tip">设置</span>
      </div>
    </>
  )
}
