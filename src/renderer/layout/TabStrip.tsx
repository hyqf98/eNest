/**
 * TabStrip — 标题栏内的多插件 Tab 条
 * 渲染「首页」固定 Tab + shellStore.tabs 中的插件 Tab；点击切换/关闭插件。
 * Tab 态：
 * - 普通激活/后台：常规样式
 * - lazy（惰性会话恢复占位）：半透明 + 骨架呼吸效果，title 提示「点击加载」
 * - crashed（渲染进程崩溃且不再自动重启）：红色小点 + 重试图标，点击重新 openPlugin
 * 依赖：shellStore（view/tabs/activeTabId/goHome/activateTab/closeTab）、animateTabIn。
 */
import { useEffect, useRef } from 'react'
import { useShellStore } from '@renderer/stores/shellStore'
import { animateTabIn } from '@renderer/gsap/marketMotion'
import { HouseIcon, RotateCwIcon, XIcon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { PLUGIN_ICON_DISPLAY_TAB } from '@shared/constants'

export function TabStrip() {
  const view = useShellStore((s) => s.view)
  const tabs = useShellStore((s) => s.tabs)
  const activeTabId = useShellStore((s) => s.activeTabId)
  const goHome = useShellStore((s) => s.goHome)
  const activateTab = useShellStore((s) => s.activateTab)
  const closeTab = useShellStore((s) => s.closeTab)
  const prevCount = useRef(0)

  // 首页高亮：仅 market；设置/开发者打开时不高亮首页
  const homeActive = view === 'home'

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
      <div className="tab-strip-scroll">
        <button className={`home-tab${homeActive ? ' active' : ''}`} type="button" title="首页" onClick={goHome}>
          <HouseIcon size={13} strokeWidth={1.7} />
          首页
        </button>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId && view === 'plugin'
          // 惰性恢复占位 / 崩溃态附加样式
          const stateClass = tab.lazy ? ' lazy' : tab.crashed ? ' crashed' : ''
          const hint = tab.lazy
            ? `${tab.title} — 点击加载（上次会话，未启动）`
            : tab.crashed
              ? `${tab.title} — 已崩溃，点击重试`
              : tab.title
          return (
            <button
              key={tab.id}
              type="button"
              data-tab={tab.id}
              title={hint}
              className={`tab${active ? ' active' : ''}${stateClass}`}
              onClick={() => void activateTab(tab.id)}
            >
              {tab.crashed ? (
                <span className="crash-dot" aria-hidden="true" />
              ) : (
                <PluginIcon
                  className="ico"
                  src={undefined}
                  glyph={tab.glyph}
                  slot="tab"
                  size={PLUGIN_ICON_DISPLAY_TAB}
                  style={{ background: tab.color }}
                />
              )}
              <span>{tab.title}</span>
              {tab.lazy && <span className="lazy-hint">点击加载</span>}
              {tab.crashed && (
                <span className="retry" aria-hidden="true">
                  <RotateCwIcon size={10} strokeWidth={2.2} />
                </span>
              )}
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(tab.id)
                }}
              >
                <XIcon size={9} strokeWidth={1.7} />
              </span>
            </button>
          )
        })}
      </div>
      <div className="titlebar-drag-fill" aria-hidden="true" />
    </div>
  )
}
