/**
 * 首页自绘 Tab 条（classic 模式）。
 *
 * 为什么首页要自己画一条：首页是铺满整窗的原生 WebContentsView，会把主壳 DOM
 * 标题栏整个盖住。两种替代方案都不成立——把主壳标题栏浮上来（原生视图永远盖住
 * DOM），或让首页顶部切掉 36px（那条没有首页背景动效，接缝可见）。所以这里
 * 照主壳 classic Tab 条的样子复刻一条，数据由宿主同一份投影下发。
 *
 * 与主壳那排的差异只在定位：首页没有标题栏容器，这条自己是绝对定位的浮层。
 * 视觉规则（宽度跟随内容、active 描边、hover、省略号）与 classicTabs.css 对齐。
 */
import type { HomeTabsSnapshot } from '@shared/types/home'
import { HouseIcon, RotateCwIcon, XIcon } from '@renderer/components/icons'
import { PluginIcon } from '@renderer/components/PluginIcon'

const PLUGIN_ICON_DISPLAY_TAB = 20

export function HomeTabStrip({ tabs, english, onActivate, onClose, onHome }: {
  tabs: HomeTabsSnapshot
  english: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onHome: () => void
}) {
  const homeActive = tabs.view === 'home'
  return (
    <div className="home-tab-strip" role="tablist" aria-label={english ? 'Workspace tabs' : '工作区标签'}>
      <button type="button" className={`home-strip-tab${homeActive ? ' active' : ''}`}
        title={english ? 'Home' : '首页'} onClick={onHome}>
        <HouseIcon size={13} strokeWidth={1.7} />
        <span>{english ? 'Home' : '首页'}</span>
      </button>
      {tabs.tabs.map(tab => {
        const active = tab.id === tabs.activeTabId && tabs.view === 'plugin'
        const hint = tab.lazy
          ? (english ? `${tab.title} — click to load` : `${tab.title} — 点击加载（上次会话，未启动）`)
          : tab.crashed
            ? (english ? `${tab.title} — crashed, click to retry` : `${tab.title} — 已崩溃，点击重试`)
            : tab.title
        return (
          <button key={tab.id} type="button" title={hint}
            className={`home-strip-tab${active ? ' active' : ''}${tab.crashed ? ' crashed' : ''}`}
            onClick={() => onActivate(tab.id)}>
            {tab.crashed
              ? <span className="crash-dot" aria-hidden="true" />
              : <PluginIcon className="ico" src={tab.icon ?? undefined} glyph={tab.glyph}
                  slot="tab" size={PLUGIN_ICON_DISPLAY_TAB} style={{ background: tab.color }} />}
            <span>{tab.title}</span>
            {tab.badge && <span className="tab-badge" aria-label={`${english ? 'Badge' : '角标'} ${tab.badge}`}>{tab.badge}</span>}
            {tab.crashed && <span className="retry" aria-hidden="true"><RotateCwIcon size={10} strokeWidth={2.2} /></span>}
            <span className="close" role="button" tabIndex={-1} aria-label={english ? 'Close' : '关闭'}
              onClick={event => { event.stopPropagation(); onClose(tab.id) }}>
              <XIcon size={9} strokeWidth={1.7} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
