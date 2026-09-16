/**
 * App — 应用根组件
 * 启动后初始化 GSAP 默认值、水合主题（useTheme）、字体（useFont）、语言（useI18n.hydrate）、
 * 动画强度与 Tab 样式，并刷新插件列表（shellStore.refreshPlugins）。
 * 渲染 ShellLayout（壳子框架）与全局 NotificationHost 通知层。
 * 依赖：useTheme、useFont、useI18n、shellStore、marketMotion.initMotion。
 */
import { useEffect, useState } from 'react'
import { ShellLayout } from '@renderer/layout/ShellLayout'
import { NotificationHost } from '@renderer/components/NotificationHost'
import { Splash } from '@renderer/components/Splash'
import { useTheme } from '@renderer/hooks/useTheme'
import { useFont } from '@renderer/hooks/useFont'
import { useI18n } from '@renderer/hooks/useI18n'
import { useAnimationLevel } from '@renderer/hooks/useAnimationLevel'
import { useShellStore } from '@renderer/stores/shellStore'
import { initMotion } from '@renderer/gsap/marketMotion'

export default function App() {
  const hydrateTheme = useTheme().hydrate
  const hydrateFont = useFont().hydrate
  const hydrateI18n = useI18n().hydrate
  const hydrateAnimLevel = useAnimationLevel().hydrate
  const refreshPlugins = useShellStore((s) => s.refreshPlugins)
  const hydrateTabStyle = useShellStore((s) => s.hydrateTabStyle)
  const [splashDone, setSplashDone] = useState(false)

  useEffect(() => {
    initMotion()
    // 主题最先水合，减少首屏色相跳变
    void (async () => {
      await hydrateTheme()
      void hydrateFont()
      void hydrateI18n()
      void hydrateAnimLevel()
      void hydrateTabStyle()
      void refreshPlugins()
    })()
  }, [hydrateTheme, hydrateFont, hydrateI18n, hydrateAnimLevel, hydrateTabStyle, refreshPlugins])

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
