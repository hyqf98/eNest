/**
 * App — 应用根组件
 * 启动后初始化 GSAP 默认值、水合主题（useTheme）与语言（useI18n.hydrate，同步 documentElement.lang），
 * 并刷新插件列表（shellStore.refreshPlugins）。
 * 渲染 ShellLayout（壳子框架）与全局 Toast 层。
 * 依赖：useTheme、useI18n、shellStore、marketMotion.initMotion。
 */
import { useEffect, useState } from 'react'
import { ShellLayout } from './layout/ShellLayout'
import { Toast } from './components/Toast'
import { Splash } from './components/Splash'
import { useTheme } from './hooks/useTheme'
import { useI18n } from './hooks/useI18n'
import { useShellStore } from './stores/shellStore'
import { initMotion } from './gsap/marketMotion'

export default function App() {
  const hydrateTheme = useTheme().hydrate
  const hydrateI18n = useI18n().hydrate
  const refreshPlugins = useShellStore((s) => s.refreshPlugins)
  const [splashDone, setSplashDone] = useState(false)

  useEffect(() => {
    initMotion()
    void hydrateTheme()
    void hydrateI18n()
    void refreshPlugins()
  }, [hydrateTheme, hydrateI18n, refreshPlugins])

  return (
    <>
      {!splashDone && <Splash onDone={() => setSplashDone(true)} />}
      <ShellLayout />
      <Toast />
    </>
  )
}
