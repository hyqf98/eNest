import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserPreviewApp } from './BrowserPreviewApp'
import { configureLocalePersistence } from '@renderer/i18n'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import '@renderer/styles/tokens.css'
import '@renderer/styles/base.css'
import '@renderer/styles/app.css'
import '@renderer/themes/default/workspace/detail.css'
import '@renderer/themes/default/splash.css'
import '@renderer/themes/default/workspace/market.css'
import '@renderer/styles/appearance.css'

if (!import.meta.env.DEV || !isMockShell) throw new Error('Browser fixtures require a development browser without native preload')
const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

configureLocalePersistence({
  read: async () => ((await shellApi.getSettings()).general as { locale?: unknown } | undefined)?.locale,
  write: async locale => { await shellApi.setSettings({ general: { locale } }) }
})

createRoot(container).render(<React.StrictMode><BrowserPreviewApp /></React.StrictMode>)
