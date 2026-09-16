/**
 * ShellLayout — 壳子主框架布局
 * classic：顶栏 TabStrip；orb：圆轨在左侧透明悬浮窗（主壳不渲染，插件全宽无白条）。
 */
import { useEffect } from 'react'
import { TitleBar } from '@renderer/layout/TitleBar'
import { BottomBar } from '@renderer/layout/BottomBar'
import { AppBackground } from '@renderer/components/AppBackground'
import { MarketPage } from '@renderer/pages/MarketPage'
import { SettingsPage } from '@renderer/pages/SettingsPage'
import { PluginHostChrome } from '@renderer/pages/PluginHostChrome'
import { InstallDropHost } from '@renderer/components/InstallDropOverlay'
import { InstallProgressPanel } from '@renderer/components/InstallProgressPanel'
import { useShellStore } from '@renderer/stores/shellStore'
import { useShellEvents } from '@renderer/hooks/useShellEvents'

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
  const tabStyle = useShellStore((s) => s.tabStyle)

  return (
    <div className={`app${tabStyle === 'orb' ? ' tab-orb' : ''}`}>
      <AppBackground />
      <div className="app-chrome">
        <TitleBar />
        <div className="stage">
          {view === 'home' && <MarketPage />}
          {view === 'settings' && <SettingsPage />}
          {view === 'plugin' && <PluginHostChrome />}
          {/* view === 'dev' 已并入设置页开发者菜单；兼容旧状态回落首页 */}
          {view === 'dev' && <MarketPage />}
          <BottomBar />
        </div>
      </div>
      {/* orb：左侧圆轨在独立透明悬浮窗，主壳不渲染，避免占宽白条 */}
      <InstallDropHost />
      <InstallProgressPanel />
    </div>
  )
}
