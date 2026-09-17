/**
 * App — 应用根组件
 * 启动后初始化 GSAP 默认值、水合主题（useTheme）、字体（useFont）、语言（useI18n.hydrate）、
 * 动画强度与 Tab 样式，并刷新插件列表（shellStore.refreshPlugins）。
 * Splash 结束后恢复上次会话 Tab（hydrateSessionTabs）。
 * ?surface=quick 时渲染快捷启动小窗，不加载市场壳子。
 * 依赖：useTheme、useFont、useI18n、shellStore、marketMotion.initMotion、QuickLauncherApp。
 */
import { useEffect, useState } from 'react'
import { ShellLayout } from '@renderer/layout/ShellLayout'
import { NotificationHost } from '@renderer/components/NotificationHost'
import { Splash } from '@renderer/components/Splash'
import { QuickLauncherApp } from '@renderer/components/QuickLauncherApp'
import { useTheme } from '@renderer/hooks/useTheme'
import { useFont } from '@renderer/hooks/useFont'
import { useI18n } from '@renderer/hooks/useI18n'
import { useAnimationLevel } from '@renderer/hooks/useAnimationLevel'
import { useShellStore } from '@renderer/stores/shellStore'
import { initMotion } from '@renderer/gsap/marketMotion'

function isQuickSurface(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('surface') === 'quick'
}

export default function App() {
  const hydrateTheme = useTheme().hydrate
  const hydrateFont = useFont().hydrate
  const hydrateI18n = useI18n().hydrate
  const hydrateAnimLevel = useAnimationLevel().hydrate
  const refreshPlugins = useShellStore((s) => s.refreshPlugins)
  const hydrateTabStyle = useShellStore((s) => s.hydrateTabStyle)
  const hydrateSessionTabs = useShellStore((s) => s.hydrateSessionTabs)
  const [splashDone, setSplashDone] = useState(false)
  const quick = isQuickSurface()

  useEffect(() => {
    if (quick) return
    initMotion()
    // 主题最先水合，减少首屏色相跳变；Tab 样式（圆轨悬浮窗）等 Splash 结束后再同步
    void (async () => {
      await hydrateTheme()
      void hydrateFont()
      void hydrateI18n()
      void hydrateAnimLevel()
      void refreshPlugins()
    })()
  }, [quick, hydrateTheme, hydrateFont, hydrateI18n, hydrateAnimLevel, refreshPlugins])

  // Splash 结束后：水合 Tab 样式，并在插件列表就绪后恢复会话 Tab
  useEffect(() => {
    if (quick || !splashDone) return
    void hydrateTabStyle()
    void (async () => {
      await refreshPlugins()
      await hydrateSessionTabs()
    })()
  }, [quick, splashDone, hydrateTabStyle, hydrateSessionTabs, refreshPlugins])

  if (quick) {
    return <QuickLauncherApp />
  }

  return (
    <>
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
      {/* Splash 未结束时壳子先不参与交互，减少叠影 */}
      <div className={`app-boot${splashDone ? ' ready' : ''}`} aria-hidden={!splashDone}>
        <ShellLayout />
      </div>
      <NotificationHost />
    </>
  )
}
