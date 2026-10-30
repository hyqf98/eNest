/** Explicit browser-only composition; native views and security flows are not simulated acceptance. */
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { TitleBar } from '@renderer/layout/TitleBar'
import { AppBackground } from '@renderer/components/AppBackground'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { NotificationHost } from '@renderer/components/NotificationHost'
import { Splash } from '@renderer/components/Splash'
import { UpdateDialog } from '@renderer/components/UpdateDialog'
import { PluginHostChrome } from '@renderer/pages/PluginHostChrome'
import { useAppearanceSync } from '@renderer/hooks/useAppearanceSync'
import { useAppearanceStore } from '@renderer/hooks/useAppearance'
import { useShellEvents } from '@renderer/hooks/useShellEvents'
import { useI18n } from '@renderer/hooks/useI18n'
import { useShellStore } from '@renderer/stores/shellStore'
import { initMotion } from '@renderer/gsap/marketMotion'
import { MarketPage } from '@test/fixtures/browser-preview/workspace/MarketPage'
import { BottomBar } from '@test/fixtures/browser-preview/workspace/BottomBar'

const SettingsPage = lazy(() => import('@renderer/components/SettingsSurfaceController').then(module => ({ default: module.SettingsSurfaceController })))
const QuickPage = lazy(() => import('@renderer/components/QuickLauncherApp').then(module => ({ default: module.QuickLauncherApp })))

export function BrowserPreviewApp() {
  useAppearanceSync()
  useShellEvents()
  const { hydrate, t } = useI18n()
  const hydrated = useAppearanceStore(state => state.hydrated)
  const tabStyle = useAppearanceStore(state => state.appearance.layout.tabStyle)
  const view = useShellStore(state => state.view)
  const [previewSplash, setPreviewSplash] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const quick = new URLSearchParams(window.location.search).get('surface') === 'quick'

  useEffect(() => { initMotion(); void hydrate().catch(() => undefined) }, [hydrate])
  useEffect(() => { useShellStore.getState().applyTabStyle(tabStyle === 'orb' ? 'orb' : 'classic') }, [tabStyle])
  useEffect(() => {
    const preview = () => { opener.current = document.activeElement as HTMLElement | null; setPreviewSplash(true) }
    window.addEventListener('enest:preview-splash', preview)
    return () => window.removeEventListener('enest:preview-splash', preview)
  }, [])
  useEffect(() => {
    if (content.current) content.current.inert = previewSplash
    if (!previewSplash) { opener.current?.focus(); opener.current = null }
  }, [previewSplash])

  const loading = <div className="page" role="status">{t('common.loading')}</div>
  if (!hydrated) return loading
  if (quick) return <Suspense fallback={loading}><QuickPage /></Suspense>
  return <>
    {previewSplash && <Splash preview onDone={() => setPreviewSplash(false)} />}
    <div ref={content} className={`app${tabStyle === 'orb' ? ' tab-orb' : ''}`} data-shell-view={view} aria-hidden={previewSplash || undefined}>
      <AppBackground />
      <div className="app-chrome">
        <TitleBar />
        <div className="stage">
          <Suspense fallback={loading}>
            {view === 'home' && <MarketPage />}
            {view === 'settings' && <SettingsPage />}
            {view === 'plugin' && <PluginHostChrome />}
          </Suspense>
          <BottomBar />
        </div>
      </div>
      <UpdateDialog />
      {view !== 'plugin' && <ConfirmDialog key={view} />}
    </div>
    <NotificationHost />
  </>
}
