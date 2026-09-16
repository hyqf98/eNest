/**
 * TabStrip — 标题栏内的多插件 Tab 条
 * 渲染「首页」固定 Tab + shellStore.tabs 中的插件 Tab；点击切换/关闭插件。
 * 依赖：shellStore（view/tabs/activeTabId/goHome/activateTab/closeTab）、animateTabIn。
 */
import { useEffect, useRef } from 'react'
import { useShellStore } from '../stores/shellStore'
import { animateTabIn } from '../gsap/marketMotion'

export function TabStrip() {
  const view = useShellStore((s) => s.view)
  const tabs = useShellStore((s) => s.tabs)
  const activeTabId = useShellStore((s) => s.activeTabId)
  const goHome = useShellStore((s) => s.goHome)
  const activateTab = useShellStore((s) => s.activateTab)
  const closeTab = useShellStore((s) => s.closeTab)
  const prevCount = useRef(0)

  const homeActive = view === 'home' || view === 'settings' || view === 'dev'

  // 仅在 tabs 增加时对新 Tab 播放入场动画，避免重渲染/关闭时误触发
  useEffect(() => {
    if (tabs.length > prevCount.current) {
      const last = tabs[tabs.length - 1]
      const node = document.querySelector(`[data-tab="${last.id}"]`) as HTMLElement | null
      animateTabIn(node)
    }
    prevCount.current = tabs.length
  }, [tabs])

  return (
    <div className="tab-strip">
      <button className={`home-tab${homeActive ? ' active' : ''}`} type="button" title="首页" onClick={goHome}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" />
        </svg>
        首页
      </button>
      {tabs.map((tab) => {
        const active = tab.id === activeTabId && view === 'plugin'
        return (
          <button
            key={tab.id}
            type="button"
            data-tab={tab.id}
            className={`tab${active ? ' active' : ''}`}
            onClick={() => void activateTab(tab.id)}
          >
            <span className="ico" style={{ background: tab.color }}>
              {tab.glyph}
            </span>
            <span>{tab.title}</span>
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation()
                void closeTab(tab.id)
              }}
            >
              <svg width="9" height="9" viewBox="0 0 10 10">
                <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </span>
          </button>
        )
      })}
    </div>
  )
}
