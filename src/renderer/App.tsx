/**
 * App — 应用根组件
 * 启动后初始化 GSAP 默认值、水合主题（useTheme）、字体（useFont）、语言（useI18n.hydrate）、
 * 动画强度与 Tab 样式，并刷新插件列表（shellStore.refreshPlugins）。
 * Splash 结束后恢复上次会话 Tab（hydrateSessionTabs）。
 * ?surface=quick 时渲染快捷启动小窗，不加载市场壳子。
 * 依赖：useTheme、useFont、useI18n、shellStore、marketMotion.initMotion、QuickLauncherApp。
 */
import { useEffect, useRef, useState } from 'react'
import { ShellLayout } from '@renderer/layout/ShellLayout'
import { NotificationHost } from '@renderer/components/NotificationHost'
import { Splash } from '@renderer/components/Splash'
import { QuickLauncherApp } from '@renderer/components/QuickLauncherApp'
import { useThemeStore } from '@renderer/hooks/useTheme'
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
  const hydrateTheme = useThemeStore((state) => state.hydrate)
  const hydrateFont = useFont().hydrate
  const hydrateI18n = useI18n().hydrate
  const hydrateAnimLevel = useAnimationLevel().hydrate
  const refreshPlugins = useShellStore((s) => s.refreshPlugins)
  const hydrateTabStyle = useShellStore((s) => s.hydrateTabStyle)
  const hydrateSessionTabs = useShellStore((s) => s.hydrateSessionTabs)
  const [splashDone, setSplashDone] = useState(false)
  const [previewSplash, setPreviewSplash] = useState(false)
  const bootRef = useRef<HTMLDivElement>(null)
  const previewOpenerRef = useRef<HTMLElement | null>(null)
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

  useEffect(() => {
    const preview = () => {
      previewOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPreviewSplash(true)
    }
    window.addEventListener('enest:preview-splash', preview)
    return () => window.removeEventListener('enest:preview-splash', preview)
  }, [])

  useEffect(() => {
    if (bootRef.current) bootRef.current.inert = previewSplash
    if (!previewSplash) {
      previewOpenerRef.current?.focus()
      previewOpenerRef.current = null
    }
  }, [previewSplash])

  // Splash 结束后：水合 Tab 样式，并恢复会话 Tab
  //（插件列表已由首个 effect 刷新；hydrateSessionTabs 内含 plugins 为空时再刷新的兜底）
  useEffect(() => {
    if (quick || !splashDone) return
    void hydrateTabStyle()
    void hydrateSessionTabs()
  }, [quick, splashDone, hydrateTabStyle, hydrateSessionTabs])

  if (quick) {
    return <QuickLauncherApp />
  }

  return (
    <>
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
      {splashDone && previewSplash && <Splash preview onDone={() => setPreviewSplash(false)} />}
      {/* Mount the workspace after startup so its entrance and background start visibly. */}
      <div ref={bootRef} className={`app-boot${splashDone ? ' ready' : ''}`} aria-hidden={!splashDone || previewSplash}>
        {splashDone && <ShellLayout />}
      </div>
      <NotificationHost />
    </>
  )
}
