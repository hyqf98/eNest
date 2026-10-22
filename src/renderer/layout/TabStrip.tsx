/**
 * TabStrip — 标题栏内的多插件 Tab 条
 * 渲染「首页」固定 Tab + shellStore.tabs 中的插件 Tab；点击切换/关闭插件。
 * Tab 态：
 * - 普通激活/后台：常规样式
 * - lazy（惰性会话恢复占位）：半透明 + 骨架呼吸效果，title 提示「点击加载」
 * - crashed（渲染进程崩溃且不再自动重启）：红色小点 + 重试图标，点击重新 openPlugin
 * 依赖：shellStore（view/tabs/activeTabId/goHome/activateTab/closeTab）、animateTabIn。
 * 标题栏的自动隐藏与透明度由 TitleBar 统一处理，这里只负责 Tab 本身。
 */
import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { useShellStore } from '@renderer/stores/shellStore'
import { animateTabIn } from '@renderer/gsap/marketMotion'
import { HouseIcon, RotateCwIcon, XIcon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { PLUGIN_ICON_DISPLAY_TAB } from '@shared/constants'
import { bindPluginDragSource, bindPluginDropTarget } from '@renderer/services/pluginWindowDrag'
import '@renderer/styles/plugin-window-drag.css'

export function TabStrip() {
  const view = useShellStore((s) => s.view)
  const tabs = useShellStore((s) => s.tabs)
  const activeTabId = useShellStore((s) => s.activeTabId)
  const goHome = useShellStore((s) => s.goHome)
  const activateTab = useShellStore((s) => s.activateTab)
  const closeTab = useShellStore((s) => s.closeTab)
  const previousIds = useRef(new Set<string>())
  const stripRef = useRef<HTMLDivElement>(null)

  // 首页高亮：仅 market；设置/开发者打开时不高亮首页
  const homeActive = view === 'home'

  useEffect(() => {
    const root = stripRef.current
    const scroller = root?.querySelector<HTMLElement>('.tab-strip-scroll')
    if (!root || !scroller) return
    const source = bindPluginDragSource(root, target => {
      if (target.closest('.close')) return null
      const element = target.closest<HTMLElement>('[data-plugin-id]')
      return element?.dataset.pluginId ? { element, pluginId: element.dataset.pluginId } : null
    })
    const target = bindPluginDropTarget(root, {
      kind: 'shell', scroller,
      items: () => Array.from(scroller.querySelectorAll<HTMLElement>('[data-plugin-id]'))
    })
    return () => { source(); target.dispose() }
  }, [])

  // 仅在 tabs 增加时对新 Tab 播放入场动画，避免重渲染/关闭时误触发
  useEffect(() => {
    const ctx = gsap.context(() => {
      for (const tab of tabs.filter(item => !previousIds.current.has(item.id))) {
        const node = Array.from(stripRef.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])
          .find((item) => item.dataset.tab === tab.id)
        animateTabIn(node ?? null)
      }
    }, stripRef)
    previousIds.current = new Set(tabs.map(tab => tab.id))
    return () => ctx.revert()
  }, [tabs])

  return (
    <div className="tab-strip" ref={stripRef}>
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
              data-plugin-id={tab.pluginId}
              title={hint}
              className={`tab${active ? ' active' : ''}${stateClass}`}
              onClick={() => void activateTab(tab.id)}
            >
              {tab.crashed ? (
                <span className="crash-dot" aria-hidden="true" />
              ) : (
                <PluginIcon
                  className="ico"
                  src={tab.icon ?? undefined}
                  glyph={tab.glyph}
                  slot="tab"
                  size={PLUGIN_ICON_DISPLAY_TAB}
                  style={{ background: tab.color }}
                />
              )}
              <span>{tab.title}</span>
              {tab.badge && <span className="tab-badge" aria-label={`角标 ${tab.badge}`}>{tab.badge}</span>}
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
