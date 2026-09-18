/**
 * BottomBar — 左下角浮动操作
 * 仅保留「设置」入口；开发者工具已迁入 设置 → 开发者 菜单。
 * orb 模式下不渲染：设置入口为左下角常驻 dock 视图圆钮，避免与圆轨双份叠放。
 * 依赖：shellStore（view / setView / tabStyle）。
 */
import { useShellStore } from '@renderer/stores/shellStore'
import { SettingsIcon } from '@renderer/components/icons'

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
        <SettingsIcon size={18} />
        <span className="float-tip">设置</span>
      </button>
    </div>
  )
}
