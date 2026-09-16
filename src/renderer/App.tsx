/**
 * App — 应用根组件
 * 启动后初始化 GSAP 默认值、水合主题（useTheme）、语言（useI18n），并刷新插件列表。
 * ?surface=quick 时渲染快捷启动小窗，不加载市场壳子。
 * 依赖：useTheme、useI18n、shellStore、marketMotion.initMotion、QuickLauncherApp。
 */
import { useEffect, useState } from 'react'
import { ShellLayout } from './layout/ShellLayout'
import { Toast } from './components/Toast'
import { Splash } from './components/Splash'
import { QuickLauncherApp } from './components/QuickLauncherApp'
import { useTheme } from './hooks/useTheme'
import { useI18n } from './hooks/useI18n'
import { useShellStore } from './stores/shellStore'
import { initMotion } from './gsap/marketMotion'

function isQuickSurface(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('surface') === 'quick'
}

export default function App() {
  const hydrateTheme = useTheme().hydrate
  const hydrateI18n = useI18n().hydrate
  const refreshPlugins = useShellStore((s) => s.refreshPlugins)
  const [splashDone, setSplashDone] = useState(false)
  const quick = isQuickSurface()

  useEffect(() => {
    if (quick) return
    initMotion()
    void hydrateTheme()
    void hydrateI18n()
    void refreshPlugins()
  }, [quick, hydrateTheme, hydrateI18n, refreshPlugins])

  if (quick) {
    return <QuickLauncherApp />
  }

  return (
    <>
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
      <ShellLayout />
      <Toast />
    </>
  )
}
