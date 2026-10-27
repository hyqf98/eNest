import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QuickLauncherApp } from '@renderer/components/QuickLauncherApp'
import { useAppearanceSync } from '@renderer/hooks/useAppearanceSync'
import { useI18n } from '@renderer/hooks/useI18n'
import { configureLocalePersistence } from '@renderer/i18n'
import { shellApi } from '@renderer/services/shellApi'
import { initMotion } from '@renderer/gsap/marketMotion'
import '@renderer/styles/tokens.css'
import '@renderer/styles/base.css'
import '@renderer/styles/windowFrame.css'
import '@renderer/styles/shellWidgets.css'
import '@renderer/styles/controlMotion.css'
import '@renderer/styles/standardControlMotion.css'
import '@renderer/styles/highControlMotion.css'
import '@renderer/styles/controlGlow.css'
import '@renderer/styles/reducedMotion.css'
import '@renderer/styles/appearance.css'

configureLocalePersistence({
  read: async () => ((await shellApi.getSettings()).general as { locale?: unknown } | undefined)?.locale,
  write: async locale => { await shellApi.setSettings({ general: { locale } }) }
})

function QuickEntry() {
  useAppearanceSync()
  const { hydrate } = useI18n()
  useEffect(() => { initMotion(); void hydrate().catch(() => undefined) }, [hydrate])
  return <QuickLauncherApp />
}

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(<StrictMode><QuickEntry /></StrictMode>)
