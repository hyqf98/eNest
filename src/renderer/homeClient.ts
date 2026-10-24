import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { EnestWorkspaceApi } from '@shared/types/home'
import { useI18nStore } from '@renderer/i18n'
import { applyAppearanceToDom, releaseAppearanceResources } from '@renderer/services/appearanceDom'
import { DefaultWorkspace } from '@renderer/themes/default/DefaultWorkspace'
import { createDefaultWorkspaceController } from '@renderer/themes/default/WorkspaceController'
import '@renderer/styles/tokens.css'
import '@renderer/styles/base.css'
import '@renderer/styles/app.css'
import '@renderer/themes/default/workspace/detail.css'
import '@renderer/themes/default/workspace/market.css'
import '@renderer/styles/appearance.css'

const container = document.getElementById('home-root')
if (!container) throw new Error('#home-root not found')
const root = document.documentElement
root.dataset.surface = 'workspace'
const bridge = (window as Window & { enestWorkspace?: EnestWorkspaceApi }).enestWorkspace

if (!bridge) {
  container.textContent = 'Workspace bridge is unavailable. Open eNest to use the default theme.'
} else {
  const view = createRoot(container)
  const afterPaint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const controller = createDefaultWorkspaceController(bridge, {
    applyAppearance: snapshot => applyAppearanceToDom({ ...snapshot.appearance, resources: snapshot.resources }),
    applyConfig: config => {
      root.lang = config.locale
      useI18nStore.setState({ locale: config.locale, hydrated: true })
    },
    afterPaint,
  })
  const syncVisibility = controller.subscribe(() => {
    const state = controller.getState()
    root.dataset.homeVisible = String(state.visible)
    root.dataset.workspaceRoute = state.route.page
  })
  const syncScale = () => {
    const width = root.clientWidth || window.innerWidth
    const ratio = Math.min(1, Math.max(0, (width - 900) / 700))
    root.style.setProperty('--shell-scale', (0.85 + ratio * 0.25).toFixed(3))
  }
  syncScale()
  window.addEventListener('resize', syncScale)
  view.render(createElement(DefaultWorkspace, { controller }))
  window.addEventListener('pagehide', () => {
    controller.dispose()
    syncVisibility()
    window.removeEventListener('resize', syncScale)
    view.unmount()
    releaseAppearanceResources()
  }, { once: true })
  void controller.start().catch(controller.reportError)
}
