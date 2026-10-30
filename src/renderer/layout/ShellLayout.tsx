/**
 * ShellLayout — 壳子主框架布局
 * classic 使用顶部标签与左下角头像入口；orb 使用首页、插件、设置合一的左侧圆轨。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { TitleBar } from '@renderer/layout/TitleBar'
import { AppBackground } from '@renderer/components/AppBackground'
import { HomeRecovery } from '@renderer/components/HomeRecovery'
import { shellApi } from '@renderer/services/shellApi'
import { PluginHostChrome } from '@renderer/pages/PluginHostChrome'
import { InstallDropHost } from '@renderer/components/InstallDropOverlay'
import { InstallProgressPanel } from '@renderer/components/InstallProgressPanel'
import { UpdateDialog } from '@renderer/components/UpdateDialog'
import { TITLEBAR_HEIGHT, TITLEBAR_REVEAL_HEIGHT } from '@shared/constants'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { useShellStore } from '@renderer/stores/shellStore'
import { useShellEvents } from '@renderer/hooks/useShellEvents'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useI18n } from '@renderer/hooks/useI18n'

const SettingsPage = lazy(() => import('@renderer/components/SettingsSurfaceController').then(module => ({ default: module.SettingsSurfaceController })))

/** 按窗口宽度写入 --shell-scale（0.85–1.1）；标题栏 36px 固定不缩放。 */
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
  const { t } = useI18n()
  const view = useShellStore((s) => s.view)
  const tabStyle = useShellStore((s) => s.tabStyle)
  const appearanceTabStyle = useAppearanceStore((s) => s.appearance.layout.tabStyle)
  const appearanceTabAutoHide = useAppearanceStore((s) => s.appearance.layout.tabAutoHide)
  const [titleBarRevealed, setTitleBarRevealed] = useState(false)
  const [chromeSyncFailed, setChromeSyncFailed] = useState(false)
  const [titlebarHeight, setTitlebarHeight] = useState(TITLEBAR_HEIGHT)
  const [nativeTitlebarReady, setNativeTitlebarReady] = useState(true)
  const nativeLayoutQueue = useRef(Promise.resolve())
  const layoutVersion = useRef(0)
  const mounted = useRef(true)
  const motionHidden = useRef(false)
  const autoHide = appearanceTabStyle !== 'orb' && appearanceTabAutoHide === true && !chromeSyncFailed
  const requested = useRef({ autoHide, revealed: titleBarRevealed })
  requested.current = { autoHide, revealed: titleBarRevealed }
  const revealed = !autoHide || (titleBarRevealed && nativeTitlebarReady)
  const collapsed = autoHide && !revealed
  const revealTitlebar = useCallback(() => {
    if (!requested.current.revealed) layoutVersion.current++
    requested.current.revealed = true
    setTitleBarRevealed(true)
  }, [])
  const collapseTitlebar = useCallback(() => {
    requested.current.revealed = false
    setTitleBarRevealed(false)
  }, [])

  useEffect(() => {
    useShellStore.getState().applyTabStyle(appearanceTabStyle === 'orb' ? 'orb' : 'classic', appearanceTabAutoHide === true)
  }, [appearanceTabStyle, appearanceTabAutoHide])

  useEffect(() => {
    if (!autoHide) setTitleBarRevealed(false)
  }, [autoHide])

  const syncTitlebarHeight = useCallback((height: number) => {
    const version = ++layoutVersion.current
    nativeLayoutQueue.current = nativeLayoutQueue.current.then(async () => {
      if (!mounted.current || version !== layoutVersion.current) return
      if (!shellApi.setPluginTopInset && height !== TITLEBAR_HEIGHT) throw new Error('Titlebar layout unavailable')
      if (height !== TITLEBAR_HEIGHT) setNativeTitlebarReady(false)
      await shellApi.setPluginTopInset?.(TITLEBAR_HEIGHT - height)
      if (mounted.current && version === layoutVersion.current) {
        setTitlebarHeight(height)
        setNativeTitlebarReady(height === TITLEBAR_HEIGHT)
      }
    }).catch(() => {
      if (mounted.current && version === layoutVersion.current) {
        setChromeSyncFailed(true)
        setTitlebarHeight(TITLEBAR_HEIGHT)
        setNativeTitlebarReady(true)
      }
    })
  }, [])

  // 先让原生视图空出标题栏，再进场；退场完成后才能把空间交还内容。
  useEffect(() => {
    if (!autoHide || titleBarRevealed) syncTitlebarHeight(TITLEBAR_HEIGHT)
    else if (motionHidden.current) syncTitlebarHeight(TITLEBAR_REVEAL_HEIGHT)
  }, [autoHide, titleBarRevealed, syncTitlebarHeight])

  const onTitlebarMotionStart = useCallback(() => { layoutVersion.current++; motionHidden.current = false }, [])
  const onTitlebarMotionComplete = useCallback((shown: boolean) => {
    motionHidden.current = !shown
    if (!shown && requested.current.autoHide && !requested.current.revealed) syncTitlebarHeight(TITLEBAR_REVEAL_HEIGHT)
  }, [syncTitlebarHeight])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      layoutVersion.current++
      void nativeLayoutQueue.current.then(() => shellApi.setPluginTopInset?.(0)).catch(() => undefined)
    }
  }, [])

  return (
    <div className={`app${tabStyle === 'orb' ? ' tab-orb' : ''}`} data-shell-view={view} data-titlebar-state={collapsed ? 'collapsed' : 'expanded'}
      style={{ '--shell-titlebar-height': `${titlebarHeight}px`, '--titlebar-reveal-height': `${TITLEBAR_REVEAL_HEIGHT}px` } as CSSProperties}>
      <AppBackground paused={view === 'home'} />
      <div className="app-chrome">
        <TitleBar
          autoHide={autoHide}
          revealed={revealed}
          onReveal={revealTitlebar}
          onCollapse={collapseTitlebar}
          onMotionStart={onTitlebarMotionStart}
          onMotionComplete={onTitlebarMotionComplete}
        />
        <div className="stage">
          <Suspense fallback={<div className="page" role="status" aria-busy="true"><div className="empty">{t('common.loading')}</div></div>}>
            {view === 'home' && <HomeRecovery />}
            {/* 设置由原生壳渲染层独占；主题 Workspace 不再提供设置页 */}
            {view === 'settings' && <SettingsPage />}
          </Suspense>
          {view === 'plugin' && <PluginHostChrome />}
        </div>
      </div>
      {/* 原生 dock / 可选圆轨在内容上方浮动，不挤占内容宽度。可见性只由 App 门禁控制。 */}
      <InstallDropHost />
      <InstallProgressPanel />
      {/* 应用更新弹框（available/downloaded 状态由设置页入口触发打开） */}
      <UpdateDialog />
      {view !== 'plugin' && <ConfirmDialog key={view} />}
    </div>
  )
}
