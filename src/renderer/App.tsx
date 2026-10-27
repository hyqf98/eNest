/** The bundled appearance loads directly; native Home readiness gates the launch animation handoff. */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ShellLayout } from '@renderer/layout/ShellLayout'
import { NotificationHost } from '@renderer/components/NotificationHost'
import { Splash } from '@renderer/components/Splash'
import { AppBackground } from '@renderer/components/AppBackground'
import { Button } from '@renderer/components/ui/Button'
import { useI18n } from '@renderer/hooks/useI18n'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useAppearanceSync } from '@renderer/hooks/useAppearanceSync'
import { useDuplicatePluginNotice } from '@renderer/hooks/useDuplicatePluginNotice'
import { useShellStore } from '@renderer/stores/shellStore'
import { initMotion } from '@renderer/gsap/marketMotion'
import { shellApi } from '@renderer/services/shellApi'

const QuickLauncherApp = lazy(() => import('@renderer/components/QuickLauncherApp').then(module => ({ default: module.QuickLauncherApp })))

function isQuickSurface(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('surface') === 'quick'
}

function shouldSkipSplash(): boolean {
  return new URLSearchParams(window.location.search).get('splash') === 'none'
}

export default function App() {
  useAppearanceSync()
  const { hydrate: hydrateI18n, t } = useI18n()
  const hydrateAppearance = useAppearanceStore((state) => state.hydrate)
  const hydrated = useAppearanceStore((state) => state.hydrated)
  const hydrateSessionTabs = useShellStore((s) => s.hydrateSessionTabs)
  const [splashDone, setSplashDone] = useState(shouldSkipSplash)
  const [previewSplash, setPreviewSplash] = useState(false)
  const [startupStatus, setStartupStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [startupError, setStartupError] = useState<string>()
  const [workspacePrepared, setWorkspacePrepared] = useState(false)
  const [bootAttempt, setBootAttempt] = useState(0)
  const bootRef = useRef<HTMLDivElement>(null)
  const previewOpenerRef = useRef<HTMLElement | null>(null)
  const settingsReadRef = useRef<ReturnType<typeof shellApi.getSettings> | null>(null)
  const sessionPluginIdsRef = useRef<string[]>([])
  const quick = isQuickSurface()
  const view = useShellStore((s) => s.view)
  const workspaceReady = startupStatus === 'ready' && workspacePrepared && splashDone
  useDuplicatePluginNotice(!quick && workspaceReady)

  useEffect(() => {
    const openLink = (event: MouseEvent): void => {
      if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return
      const anchor = event.target.closest<HTMLAnchorElement>('a[target="_blank"]')
      if (!anchor) return
      event.preventDefault()
      void shellApi.openExternal(anchor.href).catch(error => console.warn('[enest] external link rejected', error instanceof Error ? error.message : 'invalid URL'))
    }
    document.addEventListener('click', openLink)
    return () => document.removeEventListener('click', openLink)
  }, [])

  useEffect(() => {
    if (quick) return
    useShellStore.getState().setNativeChromeSyncEnabled(workspaceReady && !previewSplash)
    return () => useShellStore.getState().setNativeChromeSyncEnabled(false)
  }, [quick, workspaceReady, previewSplash])

  useEffect(() => {
    if (quick) return
    void shellApi.setHomeVisible?.(workspaceReady && !previewSplash && view === 'home')
      .catch(() => undefined)
    if (!workspaceReady) void shellApi.hidePlugins?.().catch(() => undefined)
  }, [quick, workspaceReady, previewSplash, view])

  useEffect(() => {
    let cancelled = false
    initMotion()
    if (!quick) { setStartupStatus('loading'); setStartupError(undefined); setWorkspacePrepared(false) }
    void (async () => {
      try {
        if (!quick && !settingsReadRef.current) {
          settingsReadRef.current = shellApi.getSettings().finally(() => { settingsReadRef.current = null })
        }
        const [, settings] = await Promise.all([hydrateAppearance(), settingsReadRef.current])
        void hydrateI18n().catch(() => undefined)
        if (cancelled || quick || !settings) return
        sessionPluginIdsRef.current = (settings.general?.sessionTabs ?? []).map(tab => tab.pluginId).filter(Boolean)
        setStartupStatus('ready')
      } catch {
        if (!cancelled && !quick) {
          setStartupError('无法读取外观或启动设置，请重试。')
          setStartupStatus('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [quick, bootAttempt, hydrateAppearance, hydrateI18n])

  useEffect(() => {
    const preview = () => {
      if (!workspaceReady) return
      previewOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setPreviewSplash(true)
    }
    window.addEventListener('enest:preview-splash', preview)
    return () => window.removeEventListener('enest:preview-splash', preview)
  }, [workspaceReady])

  useEffect(() => {
    if (bootRef.current) bootRef.current.inert = previewSplash
    if (!previewSplash) {
      previewOpenerRef.current?.focus()
      previewOpenerRef.current = null
    }
  }, [previewSplash])

  // Prepare behind the launch animation; only ready + route ACK permits handoff.
  useEffect(() => {
    if (quick || startupStatus !== 'ready') return
    let cancelled = false
    void (async () => {
      try {
        void hydrateSessionTabs(sessionPluginIdsRef.current).catch(() => undefined)
        await shellApi.hidePlugins?.()
        await shellApi.navigateWorkspace?.({ page: 'catalog' })
        if (cancelled) return
        useShellStore.getState().applyView('home')
        setWorkspacePrepared(true)
      } catch {
        if (!cancelled) {
          setStartupError('首页暂时无法打开，请重试。')
          setStartupStatus('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [quick, startupStatus, hydrateSessionTabs])

  if (quick) return <Suspense fallback={<div role="status">{t('common.loading')}</div>}><QuickLauncherApp /></Suspense>

  return (
    <>
      {startupStatus !== 'error' && hydrated && !splashDone
        ? <Splash ready={workspacePrepared} onDone={() => setSplashDone(true)} />
        : !workspaceReady && <AppBackground />}
      {startupStatus === 'error' && <section className="home-recovery" aria-label="启动恢复" role="alert">
        <span className="home-recovery-mark" aria-hidden="true">eNest</span>
        <h1>暂时无法启动首页</h1>
        <p>{startupError}</p>
        <div className="home-recovery-actions"><Button onClick={() => setBootAttempt(attempt => attempt + 1)}>重新加载</Button></div>
      </section>}
      {workspaceReady && previewSplash && <Splash preview onDone={() => setPreviewSplash(false)} />}
      <div ref={bootRef} className={`app-boot${workspaceReady ? ' ready' : ''}`} aria-hidden={!workspaceReady || previewSplash}>
        {workspaceReady && <ShellLayout />}
      </div>
      <NotificationHost />
    </>
  )
}
