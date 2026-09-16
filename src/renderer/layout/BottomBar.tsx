/**
 * BottomBar — 左下角浮动操作
 * 仅保留「设置」入口；开发者工具已迁入 设置 → 开发者 菜单。
 * orb 模式下不渲染：设置入口迁至 FloatingTabRail 底部圆钮，避免与圆轨双份叠放。
 * 依赖：shellStore（view / setView / tabStyle）。
 */
import { useShellStore } from '@renderer/stores/shellStore'

export function BottomBar() {
  const view = useShellStore((s) => s.view)
  const setView = useShellStore((s) => s.setView)
  const tabStyle = useShellStore((s) => s.tabStyle)

  // orb：设置由圆轨底部固定圆钮承担
  if (tabStyle === 'orb') return null

  return (
    <div className="bottom-bar">
      <button
        className={`float-btn${view === 'settings' ? ' active' : ''}`}
        type="button"
        title="设置"
        aria-label="设置"
        onClick={() => setView('settings')}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .4 1.1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.37.36.7.65.96.3.25.67.4 1.06.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.64Z" />
        </svg>
        <span className="float-tip">设置</span>
      </button>
    </div>
  )
}
