/**
 * BottomBar — 左下角浮动操作
 * 仅保留「设置」入口；开发者工具已迁入 设置 → 开发者 菜单。
 * Electron 只使用宿主原生 dock，避免 DOM 被 Home/插件 WebContentsView 遮挡。
 * 本组件仅供经典模式的浏览器 mock 使用；圆轨模式的设置位于轨道末尾。
 */
import { useShellStore } from '@renderer/stores/shellStore'
import { SettingsIcon } from '@renderer/components/icons'
import { isMockShell } from '@renderer/services/shellApi'

export function BottomBar() {
  const view = useShellStore((s) => s.view)
  const setView = useShellStore((s) => s.setView)
  const tabStyle = useShellStore((s) => s.tabStyle)

  if (!isMockShell || tabStyle === 'orb') return null

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
