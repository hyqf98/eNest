/**
 * TitleBar — 顶部标题栏（macOS 风格）
 * 36px：红绿灯 + 中间拖拽区。classic 显示文字 Tab；orb 的 Tab 在左侧圆轨
 * （主窗口内顶层 WebContentsView，悬浮于插件之上），顶栏不重复渲染圆球。
 * 依赖：shellApi、shellStore；子组件：TabStrip。
 */
import { TabStrip } from '@renderer/layout/TabStrip'
import { shellApi } from '@renderer/services/shellApi'
import { useShellStore } from '@renderer/stores/shellStore'

export function TitleBar() {
  const tabStyle = useShellStore((s) => s.tabStyle)

  return (
    <header className="titlebar">
      <div className="traffic" role="group" aria-label="窗口控制">
        <button
          type="button"
          className="traffic-btn r"
          aria-label="关闭"
          onClick={() => shellApi.closeWindow?.()}
        >
          <svg viewBox="0 0 12 12" width="8" height="8" aria-hidden>
            <path d="M3.2 3.2l5.6 5.6M8.8 3.2L3.2 8.8" stroke="rgba(0,0,0,0.35)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="traffic-btn y"
          aria-label="最小化"
          onClick={() => shellApi.minimizeWindow?.()}
        >
          <svg viewBox="0 0 12 12" width="8" height="8" aria-hidden>
            <path d="M3 6h6" stroke="rgba(0,0,0,0.35)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="traffic-btn g"
          aria-label="最大化"
          onClick={() => shellApi.maximizeWindow?.()}
        >
          <svg viewBox="0 0 12 12" width="8" height="8" aria-hidden>
            <path d="M4 8V4h4" stroke="rgba(0,0,0,0.35)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
      </div>
      {tabStyle === 'classic' ? <TabStrip /> : <div className="titlebar-spacer" aria-hidden="true" />}
    </header>
  )
}
