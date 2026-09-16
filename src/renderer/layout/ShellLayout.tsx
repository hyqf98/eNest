/**
 * ShellLayout — 壳子主框架布局
 * 底层 AppBackground（z-index 0）+ TitleBar / 舞台内容（z-index 1）+ BottomBar。
 * 视图切换由 shellStore.view 驱动；挂载时通过 useShellEvents 订阅主进程 IPC 事件。
 * 同时挂载拖拽安装遮罩（InstallDropHost）与右上安装进度面板（InstallProgressPanel）。
 * 依赖：shellStore、useShellEvents、AppBackground、useShellScale、InstallDropHost、InstallProgressPanel。
 */
import { useEffect } from 'react'
import { TitleBar } from './TitleBar'
import { BottomBar } from './BottomBar'
import { AppBackground } from '../components/AppBackground'
import { MarketPage } from '../pages/MarketPage'
import { SettingsPage } from '../pages/SettingsPage'
import { DevConsolePage } from '../pages/DevConsolePage'
import { PluginHostChrome } from '../pages/PluginHostChrome'
import { InstallDropHost } from '../components/InstallDropOverlay'
import { InstallProgressPanel } from '../components/InstallProgressPanel'
import { useShellStore } from '../stores/shellStore'
import { useShellEvents } from '../hooks/useShellEvents'

/** 按窗口宽度写入 --shell-scale（0.85–1.1），供 clamp/calc 微调密度；标题栏 48px 固定不缩放 */
function useShellScale(): void {
  useEffect(() => {
    const root = document.documentElement
    const update = () => {
      const w = root.clientWidth || window.innerWidth
      const t = Math.min(1, Math.max(0, (w - 900) / 700))
      const scale = 0.85 + t * 0.25
      root.style.setProperty('--shell-scale', scale.toFixed(3))
    }
    update()
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update)
      ro.observe(root)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
}

export function ShellLayout() {
  useShellEvents()
  useShellScale()
  const view = useShellStore((s) => s.view)

  return (
    <div className="app">
      <AppBackground />
      <div className="app-chrome">
        <TitleBar />
        <div className="stage">
          {view === 'home' && <MarketPage />}
          {view === 'settings' && <SettingsPage />}
          {view === 'dev' && <DevConsolePage />}
          {view === 'plugin' && <PluginHostChrome />}
          <BottomBar />
        </div>
      </div>
      {/* 拖拽安装：全窗遮罩 + window 级 drop 监听 */}
      <InstallDropHost />
      {/* 安装进度：右上浮动卡片，队列空时自动卸载 */}
      <InstallProgressPanel />
    </div>
  )
}
