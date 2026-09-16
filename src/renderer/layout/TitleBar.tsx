/**
 * TitleBar — 顶部标题栏（macOS 风格 traffic lights + 窗口控制）
 * 位于壳子最上方；包含装饰性红绿灯、中间 TabStrip、右侧最小化/最大化/关闭按钮。
 * 窗口操作经 shellApi 转发到 preload / main。
 * 依赖：shellApi；子组件：TabStrip。
 */
import { TabStrip } from './TabStrip'
import { shellApi } from '../services/shellApi'

export function TitleBar() {
  return (
    <header className="titlebar">
      <div className="traffic" aria-hidden="true">
        <i className="r" />
        <i className="y" />
        <i className="g" />
      </div>
      <TabStrip />
      <div className="win-controls">
        <button className="win-btn" type="button" aria-label="最小化" onClick={() => shellApi.minimizeWindow?.()}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button className="win-btn" type="button" aria-label="最大化" onClick={() => shellApi.maximizeWindow?.()}>
          <svg width="11" height="11" viewBox="0 0 12 12">
            <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        <button className="win-btn x" type="button" aria-label="关闭" onClick={() => shellApi.closeWindow?.()}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  )
}
